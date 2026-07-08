from __future__ import annotations

import uuid

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Exam, ExamRuntimeConfig, ExamStatus, ExamType
from app.services.normalized_relations import exam_runtime_settings, set_exam_runtime_settings


def _session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def test_section_toggles_roundtrip_through_settings() -> None:
    db = _session()
    try:
        exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ, status=ExamStatus.CLOSED)
        db.add(exam)
        db.flush()
        set_exam_runtime_settings(exam, {"sequential_sections": True, "allow_revisit_sections": False})
        db.flush()
        db.refresh(exam)
        settings = exam_runtime_settings(exam)
        assert settings["sequential_sections"] is True
        assert settings["allow_revisit_sections"] is False
    finally:
        db.close()
