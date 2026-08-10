from __future__ import annotations

import uuid

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Attempt, AttemptStatus, Exam, ExamSection, ExamStatus, ExamType, RoleEnum, User
from app.modules.attempts.routes_public import mark_section_finished


def _session():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def test_mark_section_finished_appends_id() -> None:
    db = _session()
    try:
        learner = User(user_id="l1", email="l@e.com", name="L", hashed_password="h", role=RoleEnum.LEARNER, is_active=True)
        db.add(learner); db.flush()
        exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ, status=ExamStatus.OPEN)
        db.add(exam); db.flush()
        section = ExamSection(id=uuid.uuid4(), exam_id=exam.id, title="S1", order=0)
        db.add(section)
        attempt = Attempt(id=uuid.uuid4(), exam_id=exam.id, user_id=learner.id, status=AttemptStatus.IN_PROGRESS)
        db.add(attempt); db.flush()

        result = mark_section_finished(attempt_id=str(attempt.id), section_id=str(section.id), db=db, current=learner)
        assert str(section.id) in (result.sections_finished or [])
    finally:
        db.close()
