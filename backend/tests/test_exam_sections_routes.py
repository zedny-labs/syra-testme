from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Exam, ExamSection, ExamStatus, ExamType, Question, RoleEnum, User
from app.schemas import ExamSectionCreate, ExamSectionUpdate
from app.api.routes.exam_sections import (
    create_section, list_sections, update_section, delete_section,
)


def _session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _user(db: Session, role=RoleEnum.ADMIN) -> User:
    u = User(user_id=f"u-{uuid.uuid4().hex[:8]}", email=f"{uuid.uuid4().hex[:8]}@e.com",
             name="U", hashed_password="h", role=role, is_active=True)
    db.add(u); db.flush(); return u


def _exam(db: Session, owner: User) -> Exam:
    e = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ,
             status=ExamStatus.CLOSED, created_by_id=owner.id)
    db.add(e); db.flush(); return e


def test_create_and_list_sections() -> None:
    db = _session()
    try:
        admin = _user(db)
        exam = _exam(db, admin)
        create_section(exam_id=str(exam.id), body=ExamSectionCreate(title="Intro"), db=db, current=admin)
        sections = list_sections(exam_id=str(exam.id), db=db, current=admin)
        assert [s.title for s in sections] == ["Intro"]
    finally:
        db.close()


def test_update_and_delete_section() -> None:
    db = _session()
    try:
        admin = _user(db)
        exam = _exam(db, admin)
        created = create_section(exam_id=str(exam.id), body=ExamSectionCreate(title="A"), db=db, current=admin)
        update_section(section_id=str(created.id), body=ExamSectionUpdate(title="B"), db=db, current=admin)
        assert db.get(ExamSection, created.id).title == "B"
        delete_section(section_id=str(created.id), db=db, current=admin)
        assert db.get(ExamSection, created.id) is None
    finally:
        db.close()


def test_non_owner_cannot_create_section() -> None:
    db = _session()
    try:
        owner = _user(db)
        other = _user(db, role=RoleEnum.INSTRUCTOR)
        exam = _exam(db, owner)
        with pytest.raises(HTTPException) as exc:
            create_section(exam_id=str(exam.id), body=ExamSectionCreate(title="X"), db=db, current=other)
        assert exc.value.status_code == 403
    finally:
        db.close()
