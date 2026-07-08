from __future__ import annotations

import uuid

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Exam, ExamSection, ExamStatus, ExamType, Question, QuestionPool, RoleEnum, User
from app.schemas import QuestionBase
from app.api.routes.question_pools import create_pool_question, seed_exam_from_pool


def _session():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _user(db):
    u = User(user_id="a1", email="a@e.com", name="A", hashed_password="h", role=RoleEnum.ADMIN, is_active=True)
    db.add(u)
    db.flush()
    return u


def _mcq(text):
    return QuestionBase(text=text, question_type="MCQ", options=["A", "B"], correct_answer="A", points=1.0, order=0)


def test_seed_exam_from_pool_assigns_general_section() -> None:
    """Legacy random-seed must still land questions in a section so they show in the learner hub."""
    db = _session()
    try:
        admin = _user(db)
        pool = QuestionPool(id=uuid.uuid4(), name="P", created_by_id=admin.id)
        db.add(pool)
        db.flush()
        create_pool_question(pool_id=str(pool.id), body=_mcq("Q1"), db=db, current=admin)
        exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ,
                    status=ExamStatus.CLOSED, created_by_id=admin.id)
        db.add(exam)
        db.flush()

        seed_exam_from_pool(pool_id=str(pool.id), exam_id=str(exam.id), count=1, db=db, current=admin)

        seeded = db.scalars(select(Question).where(Question.exam_id == exam.id)).all()
        assert len(seeded) == 1
        assert seeded[0].section_id is not None
        db.refresh(exam)
        assert [s.title for s in exam.sections] == ["General"]
    finally:
        db.close()
