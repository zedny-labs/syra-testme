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
    create_section, list_sections, update_section, delete_section, reorder_sections,
)
from app.schemas import ExamSectionReorder, ExamSectionReorderItem


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


def test_second_section_gets_distinct_order() -> None:
    db = _session()
    try:
        admin = _user(db)
        exam = _exam(db, admin)
        s1 = create_section(exam_id=str(exam.id), body=ExamSectionCreate(title="First"), db=db, current=admin)
        s2 = create_section(exam_id=str(exam.id), body=ExamSectionCreate(title="Second"), db=db, current=admin)
        assert s1.order == 0
        assert s2.order == 1
    finally:
        db.close()


def test_reorder_sections_applies_new_orders() -> None:
    db = _session()
    try:
        admin = _user(db)
        exam = _exam(db, admin)
        s1 = create_section(exam_id=str(exam.id), body=ExamSectionCreate(title="A"), db=db, current=admin)
        s2 = create_section(exam_id=str(exam.id), body=ExamSectionCreate(title="B"), db=db, current=admin)
        # Swap: give s1 order=1, s2 order=0
        payload = ExamSectionReorder(sections=[
            ExamSectionReorderItem(id=s1.id, order=1),
            ExamSectionReorderItem(id=s2.id, order=0),
        ])
        result = reorder_sections(exam_id=str(exam.id), body=payload, db=db, current=admin)
        # Result is sorted by order asc, so s2 (order=0) comes first, then s1 (order=1)
        assert result[0].id == s2.id
        assert result[1].id == s1.id
        assert result[0].order == 0
        assert result[1].order == 1
    finally:
        db.close()


def test_cannot_create_section_on_open_exam() -> None:
    db = _session()
    try:
        admin = _user(db)
        exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="Open", type=ExamType.MCQ,
                    status=ExamStatus.OPEN, created_by_id=admin.id)
        db.add(exam)
        db.flush()
        with pytest.raises(HTTPException) as exc:
            create_section(exam_id=str(exam.id), body=ExamSectionCreate(title="Blocked"), db=db, current=admin)
        assert exc.value.status_code == 409
    finally:
        db.close()
