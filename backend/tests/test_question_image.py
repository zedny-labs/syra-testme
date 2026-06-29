from __future__ import annotations

from app.schemas import QuestionBase


def test_question_base_accepts_image_url():
    q = QuestionBase(
        text="What is shown?",
        question_type="MCQ",
        options=["Cat", "Dog"],
        correct_answer="A",
        image_url="/api/media/questions/q_abc123.png",
    )
    assert q.image_url == "/api/media/questions/q_abc123.png"


def test_question_base_image_url_defaults_to_none():
    q = QuestionBase(
        text="No image here",
        question_type="MCQ",
        options=["Cat", "Dog"],
        correct_answer="A",
    )
    assert q.image_url is None


from app.services.sanitization import sanitize_question_payload


def test_sanitize_keeps_valid_image_url():
    out = sanitize_question_payload({"text": "Q", "image_url": "/api/media/questions/q_abc123.png"})
    assert out["image_url"] == "/api/media/questions/q_abc123.png"


def test_sanitize_drops_foreign_image_url():
    out = sanitize_question_payload({"text": "Q", "image_url": "https://evil.example.com/x.png"})
    assert out["image_url"] is None


def test_sanitize_drops_blank_image_url():
    out = sanitize_question_payload({"text": "Q", "image_url": "  "})
    assert out["image_url"] is None


import pytest
from fastapi import HTTPException

from app.api.routes.questions import _validate_question_image, QUESTION_IMAGE_MAX_BYTES


def test_validate_image_accepts_png():
    # should not raise
    _validate_question_image("image/png", 1024)


def test_validate_image_rejects_pdf():
    with pytest.raises(HTTPException) as exc:
        _validate_question_image("application/pdf", 1024)
    assert exc.value.status_code == 400


def test_validate_image_rejects_oversized():
    with pytest.raises(HTTPException) as exc:
        _validate_question_image("image/png", QUESTION_IMAGE_MAX_BYTES + 1)
    assert exc.value.status_code == 413


import uuid as _uuid
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as SASession

from app.db.base import Base
from app.models import QuestionPool, RoleEnum, User
from app.schemas import QuestionBase as QB
from app.api.routes.question_pools import create_pool_question, list_pool_questions


def _session():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return SASession(engine, expire_on_commit=False)


def _admin(db):
    u = User(user_id=f"u-{_uuid.uuid4().hex[:8]}", email=f"{_uuid.uuid4().hex[:8]}@e.com",
             name="A", hashed_password="x", role=RoleEnum.ADMIN, is_active=True)
    db.add(u); db.flush(); return u


def _create_pool(db, owner):
    pool = QuestionPool(name=f"Pool {_uuid.uuid4().hex[:6]}", description=None, created_by_id=owner.id)
    db.add(pool)
    db.commit()
    db.refresh(pool)
    return pool


def test_pool_question_persists_image_url():
    db = _session()
    try:
        admin = _admin(db)
        pool = _create_pool(db, admin)
        body = QB(text="See image", question_type="MCQ", options=["A", "B"],
                  correct_answer="A", image_url="/api/media/questions/q_xyz.png")
        created = create_pool_question(pool_id=str(pool.id), body=body, db=db, current=admin)
        assert created.image_url == "/api/media/questions/q_xyz.png"
        stored = list_pool_questions(pool_id=str(pool.id), db=db, current=admin)
        assert stored[0].image_url == "/api/media/questions/q_xyz.png"
    finally:
        db.close()
