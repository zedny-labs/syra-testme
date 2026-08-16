from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import uuid

import pytest
from sqlalchemy import String, cast, create_engine, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import (
    AccessMode,
    Course,
    CourseStatus,
    Exam,
    ExamStatus,
    ExamType,
    Node,
    Question,
    QuestionPool,
    RoleEnum,
    Schedule,
    User,
)
from app.modules.tests.enums import TestStatus
from app.modules.tests.repository import TestListRow as AdminTestListRow, TestRepository as AdminTestRepository
from app.modules.tests.schemas import TestUpdateDTO as AdminTestUpdateDTO
from app.modules.tests.service import ServiceActor, TestService as AdminTestService, TestServiceError
from app.services import exam_compat_service, schedule_service
from app.services.normalized_relations import exam_proctoring, mutate_exam_admin_meta, set_exam_certificate
from app.utils.pagination import PaginationParams
from app.api.routes.question_pools import _cleanup_pool_library_resources, _ensure_pool_library_exam
from app.api.routes.courses import list_courses


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _new_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _create_admin(db: Session) -> User:
    admin = User(
        user_id=f"admin-{uuid.uuid4().hex[:8]}",
        email=f"admin-{uuid.uuid4().hex[:8]}@example.com",
        name="Admin",
        hashed_password="hashed",
        role=RoleEnum.ADMIN,
        is_active=True,
    )
    db.add(admin)
    db.flush()
    return admin


def _create_learner(db: Session) -> User:
    learner = User(
        user_id=f"learner-{uuid.uuid4().hex[:8]}",
        email=f"learner-{uuid.uuid4().hex[:8]}@example.com",
        name="Learner",
        hashed_password="hashed",
        role=RoleEnum.LEARNER,
        is_active=True,
    )
    db.add(learner)
    db.flush()
    return learner


def _create_exam(db: Session, *, owner: User) -> Exam:
    now = _now()
    course = Course(
        title="General",
        description="General course",
        status=CourseStatus.DRAFT,
        created_by_id=owner.id,
        created_at=now,
        updated_at=now,
    )
    db.add(course)
    db.flush()
    node = Node(
        course_id=course.id,
        title="Module 1",
        order=0,
        created_at=now,
        updated_at=now,
    )
    db.add(node)
    db.flush()
    exam = Exam(
        node_id=node.id,
        title="Draft Exam",
        description="Draft description",
        type=ExamType.MCQ,
        status=ExamStatus.CLOSED,
        time_limit=60,
        max_attempts=1,
        created_by_id=owner.id,
        created_at=now,
        updated_at=now,
    )
    db.add(exam)
    db.flush()
    return exam


def _list_learner_catalog(db: Session, *, learner: User):
    return exam_compat_service.list_tests(
        db=db,
        current=learner,
        page=None,
        page_size=None,
        search=None,
        sort=None,
        order=None,
        skip=0,
        limit=50,
    )


def _create_pool(db: Session, *, owner: User, name: str) -> QuestionPool:
    pool = QuestionPool(
        name=name,
        description=f"{name} description",
        created_by_id=owner.id,
        created_at=_now(),
        updated_at=_now(),
    )
    db.add(pool)
    db.flush()
    return pool


def _insert_invalid_exam(
    db: Session,
    *,
    owner: User,
    title: str,
    raw_type: str = "BROKEN",
    raw_status: str = "CLOSED",
    archived: bool = False,
) -> uuid.UUID:
    now = _now()
    course = Course(
        title=f"{title} Course",
        description=f"{title} course",
        status=CourseStatus.DRAFT,
        created_by_id=owner.id,
        created_at=now,
        updated_at=now,
    )
    db.add(course)
    db.flush()
    node = Node(
        course_id=course.id,
        title=f"{title} Node",
        order=0,
        created_at=now,
        updated_at=now,
    )
    db.add(node)
    db.flush()

    exam_id = uuid.uuid4()
    settings = {"_admin_test": {"archived_at": now.isoformat()}} if archived else None
    db.execute(
        Exam.__table__.insert().values(
            id=str(exam_id),
            node_id=str(node.id),
            title=title,
            type=raw_type,
            status=raw_status,
            max_attempts=1,
            settings=settings,
            created_by_id=str(owner.id),
            created_at=now,
            updated_at=now,
        )
    )
    db.commit()
    return exam_id


def test_update_test_allows_explicit_certificate_clear() -> None:
    db = _new_session()
    try:
        admin = _create_admin(db)
        exam = _create_exam(db, owner=admin)
        set_exam_certificate(
            exam,
            {
                "title": "Certificate of Completion",
                "issuer": "SYRA",
                "signer": "Admin",
                "issue_rule": "ON_PASS",
            },
        )
        db.commit()

        service = AdminTestService(AdminTestRepository(db))
        response = service.update_test(
            test_id=str(exam.id),
            body=AdminTestUpdateDTO(certificate=None),
            actor=ServiceActor(id=admin.id, role=RoleEnum.ADMIN),
            request_ip=None,
        )

        db.refresh(exam)
        assert response.certificate is None
        assert exam.certificate is None
        assert exam.certificate_config_rel is None
    finally:
        db.close()


def test_update_test_allows_proctoring_config_change_when_published() -> None:
    db = _new_session()
    try:
        admin = _create_admin(db)
        exam = _create_exam(db, owner=admin)
        exam.status = ExamStatus.OPEN
        mutate_exam_admin_meta(exam, published_at=_now())
        db.commit()

        service = AdminTestService(AdminTestRepository(db))
        response = service.update_test(
            test_id=str(exam.id),
            body=AdminTestUpdateDTO(proctoring_config={"eye_deviation_deg": 15, "object_confidence_threshold": 0.5}),
            actor=ServiceActor(id=admin.id, role=RoleEnum.ADMIN),
            request_ip=None,
        )

        db.refresh(exam)
        assert response.proctoring_config.get("eye_deviation_deg") == 15
        assert exam_proctoring(exam).get("eye_deviation_deg") == 15
    finally:
        db.close()


def test_update_test_still_blocks_all_fields_when_archived() -> None:
    db = _new_session()
    try:
        admin = _create_admin(db)
        exam = _create_exam(db, owner=admin)
        mutate_exam_admin_meta(exam, archived_at=_now())
        db.commit()

        service = AdminTestService(AdminTestRepository(db))
        with pytest.raises(TestServiceError) as exc_info:
            service.update_test(
                test_id=str(exam.id),
                body=AdminTestUpdateDTO(name="New name"),
                actor=ServiceActor(id=admin.id, role=RoleEnum.ADMIN),
                request_ip=None,
            )
        assert exc_info.value.code == "LOCKED_FIELDS"
    finally:
        db.close()


def test_update_test_retries_transient_certificate_insert_conflict() -> None:
    db = _new_session()
    try:
        admin = _create_admin(db)
        exam = _create_exam(db, owner=admin)
        db.commit()

        class FlakyRepository(AdminTestRepository):
            def __init__(self, session: Session):
                super().__init__(session)
                self.commit_calls = 0

            def commit(self) -> None:
                self.commit_calls += 1
                if self.commit_calls == 1:
                    raise IntegrityError(
                        "insert into exam_certificate_configs",
                        params=None,
                        orig=Exception('duplicate key value violates unique constraint "exam_certificate_configs_pkey"'),
                    )
                return super().commit()

        repository = FlakyRepository(db)
        service = AdminTestService(repository)

        response = service.update_test(
            test_id=str(exam.id),
            body=AdminTestUpdateDTO(
                certificate={
                    "template": "Classic",
                    "orientation": "landscape",
                    "title": "Certificate of Completion",
                    "signer": "Admin",
                    "description": "Completed successfully.",
                    "issue_rule": "ON_PASS",
                }
            ),
            actor=ServiceActor(id=admin.id, role=RoleEnum.ADMIN),
            request_ip=None,
        )

        db.refresh(exam)
        assert repository.commit_calls == 2
        assert response.certificate is not None
        assert response.certificate["title"] == "Certificate of Completion"
        assert exam.certificate is not None
        assert exam.certificate["title"] == "Certificate of Completion"
    finally:
        db.close()


def test_cleanup_pool_library_resources_removes_hidden_exam_and_scaffolding() -> None:
    db = _new_session()
    try:
        admin = _create_admin(db)
        pool = _create_pool(db, owner=admin, name="Pool A")
        exam = _ensure_pool_library_exam(db, admin, pool)
        db.add(
            Question(
                exam_id=exam.id,
                pool_id=pool.id,
                text="What is 2 + 2?",
                type="MCQ",
                options=["4", "5"],
                correct_answer="4",
                points=1.0,
                order=1,
                created_at=_now(),
                updated_at=_now(),
            )
        )
        db.commit()

        _cleanup_pool_library_resources(db, pool.id)
        db.commit()

        assert db.get(Exam, exam.id) is None
        assert db.scalar(select(Question).where(Question.pool_id == pool.id)) is None
        assert db.scalar(select(Node).where(Node.title == "Shared Pool Questions")) is None
        assert db.scalar(select(Course).where(Course.title == "Question Pool Library")) is None
    finally:
        db.close()


def test_cleanup_pool_library_resources_preserves_shared_library_scaffolding() -> None:
    db = _new_session()
    try:
        admin = _create_admin(db)
        first_pool = _create_pool(db, owner=admin, name="Pool One")
        second_pool = _create_pool(db, owner=admin, name="Pool Two")
        first_exam = _ensure_pool_library_exam(db, admin, first_pool)
        second_exam = _ensure_pool_library_exam(db, admin, second_pool)
        db.commit()

        shared_node_id = first_exam.node_id
        shared_course_id = first_exam.node.course_id

        _cleanup_pool_library_resources(db, first_pool.id)
        db.commit()

        assert db.get(Exam, first_exam.id) is None
        assert db.get(Exam, second_exam.id) is not None
        assert db.get(Node, shared_node_id) is not None
        assert db.get(Course, shared_course_id) is not None
    finally:
        db.close()


def test_list_tests_recovers_from_invalid_legacy_exam_enums() -> None:
    db = _new_session()
    try:
        admin = _create_admin(db)
        broken_draft_id = _insert_invalid_exam(db, owner=admin, title="Broken Draft", raw_type="BROKEN")
        broken_archived_id = _insert_invalid_exam(
            db,
            owner=admin,
            title="Broken Archived",
            raw_type="BROKEN",
            raw_status="UNKNOWN_STATUS",
            archived=True,
        )
        service = AdminTestService(AdminTestRepository(db))
        actor = ServiceActor(id=admin.id, role=RoleEnum.ADMIN)
        pagination = PaginationParams(page=1, page_size=20, sort="created_at", order="desc")

        default_payload = service.list_tests(actor=actor, pagination=pagination)
        archived_payload = service.list_tests(actor=actor, pagination=pagination, status=(TestStatus.ARCHIVED,))

        assert any(
            item["name"] == "Broken Draft"
            and item["type"] == "MCQ"
            and item["status"] == TestStatus.DRAFT.value
            for item in default_payload["items"]
        )
        assert any(
            item["name"] == "Broken Archived"
            and item["type"] == "MCQ"
            and item["status"] == TestStatus.ARCHIVED.value
            for item in archived_payload["items"]
        )

        repaired_draft = db.execute(
            select(
                cast(Exam.__table__.c.type, String).label("type"),
                cast(Exam.__table__.c.status, String).label("status"),
            ).where(Exam.__table__.c.id == broken_draft_id)
        ).mappings().one()
        repaired_archived = db.execute(
            select(
                cast(Exam.__table__.c.type, String).label("type"),
                cast(Exam.__table__.c.status, String).label("status"),
            ).where(Exam.__table__.c.id == broken_archived_id)
        ).mappings().one()

        assert repaired_draft["type"] == ExamType.MCQ.value
        assert repaired_draft["status"] == ExamStatus.CLOSED.value
        assert repaired_archived["type"] == ExamType.MCQ.value
        assert repaired_archived["status"] == ExamStatus.CLOSED.value
    finally:
        db.close()


def test_list_tests_reads_fresh_status_on_back_to_back_requests() -> None:
    exam_id = uuid.uuid4()

    class FlippingRepository:
        def __init__(self) -> None:
            self.calls = 0

        def list_tests(self, query):
            self.calls += 1
            runtime_status = ExamStatus.CLOSED.value if self.calls == 1 else ExamStatus.OPEN.value
            row = AdminTestListRow(
                id=exam_id,
                name="Fresh Status Exam",
                code="FRESH1",
                raw_type=ExamType.MCQ.value,
                raw_runtime_status=runtime_status,
                is_archived=False,
                category_id=None,
                category_name=None,
                time_limit_minutes=60,
                certificate=None,
                certificate_title=None,
                certificate_subtitle=None,
                certificate_issuer=None,
                certificate_signer=None,
                created_at=_now(),
                updated_at=_now(),
            )
            return [row], 1, {exam_id: 0}, {exam_id: 1}

    repository = FlippingRepository()
    service = AdminTestService(repository)
    actor = ServiceActor(id=uuid.uuid4(), role=RoleEnum.ADMIN)
    pagination = PaginationParams(page=1, page_size=20, sort="created_at", order="desc")

    first_payload = service.list_tests(actor=actor, pagination=pagination)
    second_payload = service.list_tests(actor=actor, pagination=pagination)

    assert first_payload["items"][0]["status"] == TestStatus.DRAFT.value
    assert second_payload["items"][0]["status"] == TestStatus.PUBLISHED.value
    assert repository.calls == 2


def test_postgres_list_query_uses_safe_json_path_extraction_for_legacy_settings() -> None:
    fake_db = SimpleNamespace(bind=SimpleNamespace(dialect=SimpleNamespace(name="postgresql")))
    repository = AdminTestRepository(fake_db)

    archived_sql = str(
        repository._archived_expression().compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    )
    code_sql = str(
        repository._code_expression().compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    )
    pool_sql = str(
        repository._legacy_settings_text("_pool_library").compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    )

    assert "jsonb_extract_path_text" in archived_sql
    assert "jsonb_extract_path_text" in code_sql
    assert "jsonb_extract_path_text" in pool_sql


def test_list_courses_hides_internal_pool_library_from_learners() -> None:
    db = _new_session()
    try:
        admin = _create_admin(db)
        learner = _create_learner(db)
        now = _now()
        db.add_all([
            Course(
                title="Visible Biology",
                description="Core learner training",
                status=CourseStatus.PUBLISHED,
                created_by_id=admin.id,
                created_at=now,
                updated_at=now,
            ),
            Course(
                title="Question Pool Library",
                description="Hidden library course for question pool storage",
                status=CourseStatus.PUBLISHED,
                created_by_id=admin.id,
                created_at=now,
                updated_at=now,
            ),
        ])
        db.commit()

        courses = list_courses(db=db, current=learner)

        assert [course.title for course in courses] == ["Visible Biology"]
    finally:
        db.close()


def test_learner_catalog_returns_only_due_scheduled_open_tests_sorted_by_update() -> None:
    db = _new_session()
    try:
        admin = _create_admin(db)
        learner = _create_learner(db)
        now = _now()

        newest = _create_exam(db, owner=admin)
        newest.title = "Visible newest"
        newest.status = ExamStatus.OPEN
        newest.updated_at = now

        older = _create_exam(db, owner=admin)
        older.title = "Visible older"
        older.status = ExamStatus.OPEN
        older.updated_at = now - timedelta(hours=1)

        future = _create_exam(db, owner=admin)
        future.title = "Future schedule"
        future.status = ExamStatus.OPEN

        unscheduled = _create_exam(db, owner=admin)
        unscheduled.title = "No schedule"
        unscheduled.status = ExamStatus.OPEN

        closed = _create_exam(db, owner=admin)
        closed.title = "Closed scheduled"
        closed.status = ExamStatus.CLOSED

        db.add_all([
            Schedule(
                exam_id=newest.id,
                user_id=learner.id,
                scheduled_at=now - timedelta(hours=2),
                access_mode=AccessMode.OPEN,
                created_at=now,
                updated_at=now,
            ),
            Schedule(
                exam_id=older.id,
                user_id=learner.id,
                scheduled_at=now - timedelta(hours=3),
                access_mode=AccessMode.OPEN,
                created_at=now,
                updated_at=now,
            ),
            Schedule(
                exam_id=future.id,
                user_id=learner.id,
                scheduled_at=now + timedelta(hours=1),
                access_mode=AccessMode.OPEN,
                created_at=now,
                updated_at=now,
            ),
            Schedule(
                exam_id=closed.id,
                user_id=learner.id,
                scheduled_at=now - timedelta(hours=1),
                access_mode=AccessMode.OPEN,
                created_at=now,
                updated_at=now,
            ),
        ])
        db.commit()

        payload = _list_learner_catalog(db, learner=learner)

        assert payload["total"] == 2
        assert [item.title for item in payload["items"]] == ["Visible newest", "Visible older"]
    finally:
        db.close()


def test_delete_schedule_invalidates_learner_catalog_cache() -> None:
    db = _new_session()
    try:
        admin = _create_admin(db)
        learner = _create_learner(db)
        exam = _create_exam(db, owner=admin)
        exam.title = "Assigned later"
        exam.status = ExamStatus.OPEN
        now = _now()
        schedule = Schedule(
            exam_id=exam.id,
            user_id=learner.id,
            scheduled_at=now - timedelta(minutes=5),
            access_mode=AccessMode.OPEN,
            created_at=now,
            updated_at=now,
        )
        db.add(schedule)
        db.commit()

        first_payload = _list_learner_catalog(db, learner=learner)
        assert first_payload["total"] == 1
        assert [item.title for item in first_payload["items"]] == ["Assigned later"]

        schedule_service.delete_schedule(db=db, schedule_id=str(schedule.id), actor=admin)

        second_payload = _list_learner_catalog(db, learner=learner)

        assert second_payload["total"] == 0
        assert second_payload["items"] == []
    finally:
        db.close()
