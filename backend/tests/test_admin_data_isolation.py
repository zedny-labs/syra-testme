"""Regression tests: categories, grading scales, and user groups must be
isolated per owning admin. A new admin must never see another admin's rows.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import CategoryType, RoleEnum, User
from app.schemas import CategoryBase, GradingScaleBase, UserGroupCreate
from app.api.routes import categories as categories_routes
from app.api.routes import grading_scales as grading_routes
from app.api.routes import user_groups as user_groups_routes


_REQ = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
_BANDS = [
    {"label": "Pass", "min_score": 50, "max_score": 100},
    {"label": "Fail", "min_score": 0, "max_score": 49},
]


def _new_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _admin(db: Session, label: str) -> User:
    admin = User(
        user_id=f"{label}-{uuid.uuid4().hex[:8]}",
        email=f"{label}-{uuid.uuid4().hex[:8]}@example.com",
        name=label,
        hashed_password="hashed",
        role=RoleEnum.ADMIN,
        is_active=True,
    )
    db.add(admin)
    db.flush()
    return admin


def test_categories_are_isolated_per_admin():
    db = _new_session()
    admin_a = _admin(db, "adminA")
    admin_b = _admin(db, "adminB")

    created = categories_routes.create_category(
        body=CategoryBase(name="A-Only Category", type=CategoryType.TEST, description=None),
        request=_REQ,
        db=db,
        current=admin_a,
    )

    names_b = {c.name for c in categories_routes.list_categories(db=db, current=admin_b)}
    assert "A-Only Category" not in names_b, "admin B leaked admin A's category"

    names_a = {c.name for c in categories_routes.list_categories(db=db, current=admin_a)}
    assert "A-Only Category" in names_a, "admin A cannot see its own category"

    with pytest.raises(HTTPException) as exc:
        categories_routes.get_category(str(created.id), db=db, current=admin_b)
    assert exc.value.status_code == 404

    # Same name is allowed for a different admin (per-owner uniqueness).
    mine = categories_routes.create_category(
        body=CategoryBase(name="A-Only Category", type=CategoryType.TEST, description=None),
        request=_REQ,
        db=db,
        current=admin_b,
    )
    assert mine.id != created.id


def test_grading_scales_are_isolated_per_admin():
    db = _new_session()
    admin_a = _admin(db, "adminA")
    admin_b = _admin(db, "adminB")

    created = grading_routes.create_scale(
        body=GradingScaleBase(name="A-Only Scale", labels=_BANDS),
        request=_REQ,
        db=db,
        current=admin_a,
    )

    names_b = {s.name for s in grading_routes.list_scales(db=db, current=admin_b)}
    assert "A-Only Scale" not in names_b, "admin B leaked admin A's grading scale"

    names_a = {s.name for s in grading_routes.list_scales(db=db, current=admin_a)}
    assert "A-Only Scale" in names_a

    with pytest.raises(HTTPException) as exc:
        grading_routes.get_scale(str(created.id), db=db, current=admin_b)
    assert exc.value.status_code == 404


def test_user_groups_are_isolated_per_admin():
    db = _new_session()
    admin_a = _admin(db, "adminA")
    admin_b = _admin(db, "adminB")

    created = user_groups_routes.create_group(
        body=UserGroupCreate(name="A-Only Group", description=None, member_ids=[]),
        db=db,
        current=admin_a,
    )

    names_b = {g.name for g in user_groups_routes.list_groups(db=db, current=admin_b)}
    assert "A-Only Group" not in names_b, "admin B leaked admin A's user group"

    names_a = {g.name for g in user_groups_routes.list_groups(db=db, current=admin_a)}
    assert "A-Only Group" in names_a

    with pytest.raises(HTTPException) as exc:
        user_groups_routes.get_group(str(created.id), db=db, current=admin_b)
    assert exc.value.status_code == 404
