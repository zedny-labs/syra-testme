from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import AccessMode, Exam, ExamSection, ExamStatus, ExamType, RoleEnum, Schedule, User
from app.api.routes.exam_sections import list_sections_for_learner


def _session():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def test_learner_sees_sections_in_order() -> None:
    db = _session()
    try:
        learner = User(
            user_id="l1", email="l@e.com", name="L",
            hashed_password="h", role=RoleEnum.LEARNER, is_active=True,
        )
        db.add(learner)
        db.flush()

        exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ, status=ExamStatus.OPEN)
        db.add(exam)
        db.flush()

        # learner_can_access_exam requires a Schedule entry with scheduled_at in the past
        schedule = Schedule(
            id=uuid.uuid4(),
            exam_id=exam.id,
            user_id=learner.id,
            scheduled_at=datetime(2020, 1, 1, tzinfo=timezone.utc),
            access_mode=AccessMode.OPEN,
        )
        db.add(schedule)
        db.flush()

        db.add_all([
            ExamSection(id=uuid.uuid4(), exam_id=exam.id, title="B", order=1),
            ExamSection(id=uuid.uuid4(), exam_id=exam.id, title="A", order=0),
        ])
        db.flush()

        out = list_sections_for_learner(exam_id=str(exam.id), db=db, current=learner)
        assert [s.title for s in out] == ["A", "B"]
    finally:
        db.close()
