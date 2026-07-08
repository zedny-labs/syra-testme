from __future__ import annotations

import uuid

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Exam, ExamStatus, ExamType, RoleEnum, User
from app.schemas import QuestionCreate
from app.api.routes.questions import create_question


def _session():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def test_manual_question_lands_in_general_section() -> None:
    db = _session()
    try:
        admin = User(user_id="a1", email="a@e.com", name="A", hashed_password="h", role=RoleEnum.ADMIN, is_active=True)
        db.add(admin); db.flush()
        exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ,
                    status=ExamStatus.CLOSED, created_by_id=admin.id)
        db.add(exam); db.flush()
        q = create_question(
            body=QuestionCreate(exam_id=exam.id, text="Q", question_type="MCQ", options=["A", "B"], correct_answer="A", points=1.0, order=0),
            db=db, current=admin,
        )
        assert q.section_id is not None
        db.refresh(exam)
        assert [s.title for s in exam.sections] == ["General"]
    finally:
        db.close()
