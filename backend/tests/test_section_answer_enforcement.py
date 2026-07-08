from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import (
    Attempt, AttemptStatus, Exam, ExamRuntimeConfig, ExamSection, ExamStatus,
    ExamType, Question, RoleEnum, User,
)
from app.schemas import AttemptAnswerBase
from app.modules.attempts.routes_public import submit_answer

# The DEFAULT_PROCTORING config sets identity_required=True for all exams.
# These tests focus on section-lock logic, not identity enforcement, so we
# monkeypatch get_proctoring_requirements to report identity_required=False.
_NO_IDENTITY = {
    "identity_required": False,
    "system_check_required": False,
    "camera_required": False,
    "mic_required": False,
    "fullscreen_required": False,
    "lighting_required": False,
    "screen_required": False,
}


def _session():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _setup(db, *, sequential=False, allow_revisit=True):
    learner = User(user_id="l1", email="l@e.com", name="L", hashed_password="h", role=RoleEnum.LEARNER, is_active=True)
    db.add(learner)
    exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ, status=ExamStatus.OPEN)
    db.add(exam); db.flush()
    db.add(ExamRuntimeConfig(exam_id=exam.id, sequential_sections=sequential, allow_revisit_sections=allow_revisit))
    s1 = ExamSection(id=uuid.uuid4(), exam_id=exam.id, title="S1", order=0)
    s2 = ExamSection(id=uuid.uuid4(), exam_id=exam.id, title="S2", order=1)
    db.add_all([s1, s2]); db.flush()
    q2 = Question(id=uuid.uuid4(), exam_id=exam.id, section_id=s2.id, text="Q", type=ExamType.MCQ, order=0, correct_answer="A", options=["A", "B"])
    db.add(q2)
    attempt = Attempt(id=uuid.uuid4(), exam_id=exam.id, user_id=learner.id, status=AttemptStatus.IN_PROGRESS)
    db.add(attempt); db.flush()
    return learner, exam, s1, s2, q2, attempt


def test_sequential_blocks_answer_in_locked_section(monkeypatch) -> None:
    # Patch identity guard: DEFAULT_PROCTORING has identity_required=True globally;
    # neutralise it so the section-lock check (our target) can be reached.
    monkeypatch.setattr(
        "app.modules.attempts.routes_public.get_proctoring_requirements",
        lambda _cfg: _NO_IDENTITY,
    )
    db = _session()
    try:
        learner, exam, s1, s2, q2, attempt = _setup(db, sequential=True)
        with pytest.raises(HTTPException) as exc:
            submit_answer(attempt_id=str(attempt.id), body=AttemptAnswerBase(question_id=q2.id, answer="A"), db=db, current=learner)
        assert exc.value.status_code == 409
    finally:
        db.close()


def test_revisit_disabled_blocks_answer_in_finished_section(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.modules.attempts.routes_public.get_proctoring_requirements",
        lambda _cfg: _NO_IDENTITY,
    )
    db = _session()
    try:
        learner, exam, s1, s2, q2, attempt = _setup(db, sequential=False, allow_revisit=False)
        attempt.sections_finished = [str(s2.id)]
        db.flush()
        with pytest.raises(HTTPException) as exc:
            submit_answer(attempt_id=str(attempt.id), body=AttemptAnswerBase(question_id=q2.id, answer="A"), db=db, current=learner)
        assert exc.value.status_code == 409
    finally:
        db.close()


def test_answer_allowed_when_section_unlocked(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.modules.attempts.routes_public.get_proctoring_requirements",
        lambda _cfg: _NO_IDENTITY,
    )
    db = _session()
    try:
        learner, exam, s1, s2, q2, attempt = _setup(db, sequential=True)
        attempt.sections_finished = [str(s1.id)]  # s1 finished -> s2 unlocked
        db.flush()
        result = submit_answer(attempt_id=str(attempt.id), body=AttemptAnswerBase(question_id=q2.id, answer="A"), db=db, current=learner)
        assert result is not None  # answer saved, no exception
    finally:
        db.close()
