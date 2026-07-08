import uuid

from app.schemas import ExamSectionFromPool, ExamSectionRead, ExamSectionUpdate


def test_from_pool_requires_pool_and_ids() -> None:
    body = ExamSectionFromPool(pool_id=uuid.uuid4(), question_ids=[uuid.uuid4()], title="Algebra")
    assert body.title == "Algebra"
    assert len(body.question_ids) == 1


def test_section_read_from_attributes() -> None:
    assert ExamSectionRead.model_config.get("from_attributes") is True
    assert ExamSectionUpdate(title="X").title == "X"
