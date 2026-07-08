from __future__ import annotations

import uuid

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import (
    Course,
    CourseStatus,
    Exam,
    ExamStatus,
    ExamType,
    Node,
    Question,
    QuestionPool,
    RoleEnum,
    User,
)
from app.schemas import QuestionBase
from app.api.routes.question_pools import (
    create_pool_question,
    list_pool_questions,
    seed_exam_from_pool,
)


def _new_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _create_user(db: Session, role: RoleEnum = RoleEnum.ADMIN) -> User:
    user = User(
        user_id=f"u-{uuid.uuid4().hex[:8]}",
        email=f"u-{uuid.uuid4().hex[:8]}@example.com",
        name="User",
        hashed_password="hashed",
        role=role,
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def _create_pool(db: Session, owner: User) -> QuestionPool:
    pool = QuestionPool(name=f"Pool {uuid.uuid4().hex[:6]}", description=None, created_by_id=owner.id)
    db.add(pool)
    db.commit()
    db.refresh(pool)
    return pool


def _create_exam(db: Session, owner: User) -> Exam:
    """A normal, seedable (non-published) exam the owner can seed pool questions into."""
    course = Course(title=f"Course {uuid.uuid4().hex[:6]}", status=CourseStatus.DRAFT, created_by_id=owner.id)
    db.add(course)
    db.flush()
    node = Node(course_id=course.id, title="Node", order=0)
    db.add(node)
    db.flush()
    exam = Exam(
        node_id=node.id,
        title=f"Exam {uuid.uuid4().hex[:6]}",
        type=ExamType.MCQ,
        status=ExamStatus.CLOSED,
        max_attempts=1,
        created_by_id=owner.id,
    )
    db.add(exam)
    db.commit()
    db.refresh(exam)
    return exam


def _mcq(text: str) -> QuestionBase:
    return QuestionBase(text=text, question_type="MCQ", options=["a", "b"], correct_answer="a", points=1)


def test_seeding_pool_into_exam_does_not_duplicate_pool_questions() -> None:
    """A pool question that has been seeded into a real exam must still appear
    exactly once in the pool's own question list — the seeded copy keeps
    ``pool_id`` (for re-seed dedup) but belongs to the target exam, not the pool."""
    db = _new_session()
    try:
        admin = _create_user(db)
        pool = _create_pool(db, admin)

        create_pool_question(pool_id=str(pool.id), body=_mcq("Q1"), db=db, current=admin)
        assert len(list_pool_questions(pool_id=str(pool.id), db=db, current=admin)) == 1

        exam = _create_exam(db, admin)
        seed_exam_from_pool(
            pool_id=str(pool.id), exam_id=str(exam.id), count=1, db=db, current=admin
        )

        # Sanity: seeding really happened — a copy now lives in the target exam.
        seeded_into_exam = db.scalars(select(Question).where(Question.exam_id == exam.id)).all()
        assert len(seeded_into_exam) == 1

        # The pool itself must NOT show the seeded copy as a duplicate.
        stored = list_pool_questions(pool_id=str(pool.id), db=db, current=admin)
        assert [q.text for q in stored] == ["Q1"]
    finally:
        db.close()
