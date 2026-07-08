from __future__ import annotations

import uuid

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Exam, ExamSection, ExamStatus, ExamType, Question, QuestionPool, RoleEnum, User
from app.schemas import ExamSectionFromPool, QuestionBase
from app.api.routes.question_pools import create_pool_question
from app.api.routes.exam_sections import create_section_from_pool


def _session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _user(db, role=RoleEnum.ADMIN):
    u = User(user_id=f"u-{uuid.uuid4().hex[:8]}", email=f"{uuid.uuid4().hex[:8]}@e.com",
             name="U", hashed_password="h", role=role, is_active=True)
    db.add(u); db.flush(); return u


def _mcq(text):
    return QuestionBase(text=text, question_type="MCQ", options=["A", "B"], correct_answer="A", points=1.0, order=0)


def test_section_from_pool_copies_only_picked_questions() -> None:
    db = _session()
    try:
        admin = _user(db)
        pool = QuestionPool(id=uuid.uuid4(), name="Algebra", created_by_id=admin.id)
        db.add(pool); db.flush()
        q1 = create_pool_question(pool_id=str(pool.id), body=_mcq("Q1"), db=db, current=admin)
        create_pool_question(pool_id=str(pool.id), body=_mcq("Q2"), db=db, current=admin)

        exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ,
                    status=ExamStatus.CLOSED, created_by_id=admin.id)
        db.add(exam); db.flush()

        section = create_section_from_pool(
            exam_id=str(exam.id),
            body=ExamSectionFromPool(pool_id=pool.id, question_ids=[q1.id], title=None),
            db=db, current=admin,
        )
        assert section.title == "Algebra"  # defaults to pool name
        copied = db.scalars(select(Question).where(Question.exam_id == exam.id)).all()
        assert [q.text for q in copied] == ["Q1"]  # only the picked question
        assert copied[0].section_id == section.id
        assert copied[0].pool_id == pool.id  # origin retained
    finally:
        db.close()
