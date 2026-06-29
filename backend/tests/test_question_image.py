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
