from __future__ import annotations

import uuid

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Exam, ExamSection, ExamStatus, ExamType, Question


def _session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _exam(db: Session) -> Exam:
    exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ, status=ExamStatus.CLOSED)
    db.add(exam)
    db.flush()
    return exam


def test_section_holds_questions_and_links_to_exam() -> None:
    db = _session()
    try:
        exam = _exam(db)
        section = ExamSection(id=uuid.uuid4(), exam_id=exam.id, title="General", order=0)
        db.add(section)
        db.flush()
        q = Question(id=uuid.uuid4(), exam_id=exam.id, section_id=section.id, text="Q1", type=ExamType.MCQ, order=0)
        db.add(q)
        db.flush()

        db.refresh(exam)
        assert [s.title for s in exam.sections] == ["General"]
        assert [qq.text for qq in section.questions] == ["Q1"]
        assert q.section_id == section.id
    finally:
        db.close()
