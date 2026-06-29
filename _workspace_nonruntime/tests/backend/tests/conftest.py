import os
import sys
from collections.abc import Generator
from datetime import datetime, timezone
from pathlib import Path

os.environ.setdefault("JWT_SECRET", "test-secret-key-with-at-least-32-chars")
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://postgres:password@localhost:5432/syra_lms")
os.environ.setdefault("AUTO_APPLY_MIGRATIONS", "false")
os.environ.setdefault("PRECHECK_ALLOW_TEST_BYPASS", "true")

CURRENT_FILE = Path(__file__).resolve()
REPO_ROOT = next(
    (
        parent
        for parent in CURRENT_FILE.parents
        if (parent / "backend" / "src" / "app" / "main.py").is_file()
        and (parent / "frontend" / "src").is_dir()
    ),
    None,
)
if REPO_ROOT is None:
    raise RuntimeError("Could not resolve repository root for backend tests")

BACKEND_DIR = REPO_ROOT / "backend"
TEST_SUPPORT_DIR = CURRENT_FILE.parents[1]

for import_path in (BACKEND_DIR, TEST_SUPPORT_DIR):
    if str(import_path) not in sys.path:
        sys.path.insert(0, str(import_path))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

import src.app.main as app_main
import src.app.api.deps as deps
import src.app.api.routes.auth as auth_routes
import src.app.db.session as db_session
from src.app.core.security import create_access_token, hash_password
from src.app.db.base import Base
from src.app.main import app
from src.app.models import (
    Attempt,
    AttemptStatus,
    Course,
    CourseStatus,
    Exam,
    ExamStatus,
    ExamType,
    Node,
    RoleEnum,
    SystemSettings,
    User,
)
from tests.postgres_test_utils import create_test_engine, drop_postgres_database


@pytest.fixture()
def session_factory():
    engine = create_test_engine()
    testing_session_local = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
    )
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    try:
        yield testing_session_local
    finally:
        database_url = getattr(engine, "test_database_url", None)
        engine.dispose()
        if database_url:
            drop_postgres_database(database_url)


@pytest.fixture()
def db(session_factory):
    session = session_factory()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def client(session_factory, monkeypatch) -> Generator[TestClient, None, None]:
    async def _noop_email(*args, **kwargs):
        return True

    def override_get_db():
        session = session_factory()
        try:
            yield session
        finally:
            session.close()

    monkeypatch.setattr(auth_routes, "send_welcome_email", _noop_email)
    monkeypatch.setattr(auth_routes, "send_password_reset_email", _noop_email)
    monkeypatch.setattr(auth_routes, "send_admin_setup_email", _noop_email)
    monkeypatch.setattr(auth_routes, "send_password_changed_email", _noop_email)
    monkeypatch.setattr(auth_routes, "get_email_delivery_status", lambda: (True, None))
    monkeypatch.setattr(app_main, "SessionLocal", session_factory)
    monkeypatch.setattr(db_session, "SessionLocal", session_factory)
    app.dependency_overrides[deps.get_db_dep] = override_get_db

    with TestClient(app) as test_client:
        yield test_client

    app.dependency_overrides.clear()


@pytest.fixture()
def make_user(db):
    def _make_user(
        *,
        email: str,
        name: str,
        user_id: str,
        role: RoleEnum,
        password: str = "Password123!",
        is_active: bool = True,
    ) -> User:
        user = User(
            email=email,
            name=name,
            user_id=user_id,
            role=role,
            is_active=is_active,
            hashed_password=hash_password(password),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user

    return _make_user


@pytest.fixture()
def admin_user(make_user) -> User:
    return make_user(
        email="admin@example.com",
        name="Admin User",
        user_id="ADM001",
        role=RoleEnum.ADMIN,
    )


@pytest.fixture()
def learner_user(make_user) -> User:
    return make_user(
        email="learner@example.com",
        name="Learner User",
        user_id="LRN001",
        role=RoleEnum.LEARNER,
    )


@pytest.fixture()
def admin_token(admin_user: User) -> str:
    return create_access_token(
        str(admin_user.id),
        admin_user.user_id,
        admin_user.role.value,
        name=admin_user.name,
        email=admin_user.email,
    )


@pytest.fixture()
def learner_token(learner_user: User) -> str:
    return create_access_token(
        str(learner_user.id),
        learner_user.user_id,
        learner_user.role.value,
        name=learner_user.name,
        email=learner_user.email,
    )


@pytest.fixture()
def admin_headers(admin_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture()
def learner_headers(learner_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {learner_token}"}


@pytest.fixture()
def enable_signup(db):
    setting = SystemSettings(key="allow_signup", value="true")
    db.add(setting)
    db.commit()
    db.refresh(setting)
    return setting


@pytest.fixture()
def link_learner_to_admin(db, admin_user, learner_user):
    """Establish the attempt-based link per-admin data isolation requires.

    Admins/instructors have no global access: ``get_user`` (used by every user
    management endpoint) only resolves a target user when that user has
    attempted an exam the actor created. This fixture creates an admin-owned
    exam and a learner attempt on it so admin↔learner management endpoints are
    reachable in tests that exercise that path.
    """
    now = datetime.now(timezone.utc)
    course = Course(
        title="Linking Course",
        description="Connects the admin and learner for isolation tests",
        status=CourseStatus.DRAFT,
        created_by_id=admin_user.id,
        created_at=now,
        updated_at=now,
    )
    db.add(course)
    db.flush()
    node = Node(course_id=course.id, title="Module 1", order=0, created_at=now, updated_at=now)
    db.add(node)
    db.flush()
    exam = Exam(
        node_id=node.id,
        title="Linking Exam",
        type=ExamType.MCQ,
        status=ExamStatus.OPEN,
        max_attempts=1,
        created_by_id=admin_user.id,
        created_at=now,
        updated_at=now,
    )
    db.add(exam)
    db.flush()
    attempt = Attempt(
        exam_id=exam.id,
        user_id=learner_user.id,
        status=AttemptStatus.SUBMITTED,
        created_at=now,
        updated_at=now,
    )
    db.add(attempt)
    db.commit()
    return exam
