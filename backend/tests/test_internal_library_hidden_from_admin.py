from __future__ import annotations

import uuid

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Course, CourseStatus, Node, RoleEnum, User
from app.api.routes.courses import (
    INTERNAL_POOL_LIBRARY_TITLE,
    INTERNAL_POOL_LIBRARY_DESCRIPTION,
    list_courses,
)
from app.api.routes.nodes import list_nodes

INTERNAL_NODE_TITLE = "Shared Pool Questions"


def _new_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _admin(db: Session) -> User:
    user = User(
        user_id=f"u-{uuid.uuid4().hex[:8]}",
        email=f"u-{uuid.uuid4().hex[:8]}@example.com",
        name="Admin",
        hashed_password="hashed",
        role=RoleEnum.ADMIN,
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def _course(db: Session, owner: User, title: str, description: str | None) -> Course:
    course = Course(
        title=title,
        description=description,
        status=CourseStatus.DRAFT,
        created_by_id=owner.id,
    )
    db.add(course)
    db.flush()
    return course


def _node(db: Session, course: Course, title: str) -> Node:
    node = Node(course_id=course.id, title=title, order=0)
    db.add(node)
    db.flush()
    return node


def test_list_courses_hides_internal_pool_library_from_admin() -> None:
    db = _new_session()
    try:
        admin = _admin(db)
        _course(db, admin, "Safety Basics", "A real course")
        _course(db, admin, INTERNAL_POOL_LIBRARY_TITLE, INTERNAL_POOL_LIBRARY_DESCRIPTION)
        db.commit()

        titles = [c.title for c in list_courses(db=db, current=admin)]

        assert "Safety Basics" in titles
        assert INTERNAL_POOL_LIBRARY_TITLE not in titles
    finally:
        db.close()


def test_list_nodes_hides_shared_pool_questions_from_admin() -> None:
    db = _new_session()
    try:
        admin = _admin(db)
        real = _course(db, admin, "Safety Basics", "A real course")
        _node(db, real, "Module 1")
        library = _course(db, admin, INTERNAL_POOL_LIBRARY_TITLE, INTERNAL_POOL_LIBRARY_DESCRIPTION)
        _node(db, library, INTERNAL_NODE_TITLE)
        db.commit()

        titles = [n.title for n in list_nodes(db=db, current=admin)]

        assert "Module 1" in titles
        assert INTERNAL_NODE_TITLE not in titles
    finally:
        db.close()
