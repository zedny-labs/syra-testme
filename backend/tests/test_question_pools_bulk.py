from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import QuestionPool, RoleEnum, User
from app.schemas import BulkQuestionsCreate, QuestionBase
from app.api.routes.question_pools import bulk_create_pool_questions, list_pool_questions


def _new_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _create_user(db: Session, role: RoleEnum = RoleEnum.ADMIN) -> User:
    user = User(
        user_id=f"u-{uuid.uuid4().hex[:8]}",
        email=f"u-{uuid.uuid4().hex[:8]}@example.com",
        name="User",
        hashed_password="hashed",
        role=role,
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def _create_pool(db: Session, owner: User) -> QuestionPool:
    pool = QuestionPool(name=f"Pool {uuid.uuid4().hex[:6]}", description=None, created_by_id=owner.id)
    db.add(pool)
    db.commit()
    db.refresh(pool)
    return pool


def _mcq(text: str) -> QuestionBase:
    return QuestionBase(text=text, question_type="MCQ", options=["a", "b"], correct_answer="a", points=1)


def test_bulk_create_inserts_all_questions() -> None:
    db = _new_session()
    try:
        admin = _create_user(db)
        pool = _create_pool(db, admin)
        body = BulkQuestionsCreate(questions=[_mcq("Q1"), _mcq("Q2"), _mcq("Q3")])

        result = bulk_create_pool_questions(pool_id=str(pool.id), body=body, db=db, current=admin)

        assert result.created == 3
        stored = list_pool_questions(pool_id=str(pool.id), db=db, current=admin)
        assert sorted(q.text for q in stored) == ["Q1", "Q2", "Q3"]
    finally:
        db.close()


def test_bulk_create_rejects_non_owner() -> None:
    db = _new_session()
    try:
        owner = _create_user(db)
        other = _create_user(db, role=RoleEnum.INSTRUCTOR)
        pool = _create_pool(db, owner)
        body = BulkQuestionsCreate(questions=[_mcq("Q1")])

        with pytest.raises(HTTPException) as exc:
            bulk_create_pool_questions(pool_id=str(pool.id), body=body, db=db, current=other)
        assert exc.value.status_code == 403
    finally:
        db.close()


def test_bulk_create_unknown_pool_returns_404() -> None:
    db = _new_session()
    try:
        admin = _create_user(db)
        body = BulkQuestionsCreate(questions=[_mcq("Q1")])

        with pytest.raises(HTTPException) as exc:
            bulk_create_pool_questions(pool_id=str(uuid.uuid4()), body=body, db=db, current=admin)
        assert exc.value.status_code == 404
    finally:
        db.close()


def test_bulk_create_empty_list_returns_400() -> None:
    db = _new_session()
    try:
        admin = _create_user(db)
        pool = _create_pool(db, admin)
        body = BulkQuestionsCreate(questions=[])

        with pytest.raises(HTTPException) as exc:
            bulk_create_pool_questions(pool_id=str(pool.id), body=body, db=db, current=admin)
        assert exc.value.status_code == 400
    finally:
        db.close()
