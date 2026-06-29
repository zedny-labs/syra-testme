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
