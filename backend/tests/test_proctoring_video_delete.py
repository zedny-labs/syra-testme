from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import (
    AttemptStatus,
    AuditLog,
    Course,
    CourseStatus,
    Exam,
    ExamStatus,
    ExamType,
    Node,
    ProctoringEvent,
    RoleEnum,
    SeverityEnum,
    User,
)
from app.models import Attempt
from app.modules.proctoring import routes_admin, routes_public
from app.services import cloudflare_media, supabase_storage, vimeo_media


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _new_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _create_user(db: Session, *, role: RoleEnum) -> User:
    user = User(
        user_id=f"{role.value.lower()}-{uuid.uuid4().hex[:8]}",
        email=f"{role.value.lower()}-{uuid.uuid4().hex[:8]}@example.com",
        name=role.value.title(),
        hashed_password="hashed",
        role=role,
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def _create_exam(db: Session, *, owner: User) -> Exam:
    now = _now()
    course = Course(
        title="General", description="General course", status=CourseStatus.DRAFT,
        created_by_id=owner.id, created_at=now, updated_at=now,
    )
    db.add(course)
    db.flush()
    node = Node(course_id=course.id, title="Module 1", order=0, created_at=now, updated_at=now)
    db.add(node)
    db.flush()
    exam = Exam(
        node_id=node.id, title="Proctored Exam", type=ExamType.MCQ, status=ExamStatus.OPEN,
        time_limit=60, max_attempts=1, created_by_id=owner.id, created_at=now, updated_at=now,
    )
    db.add(exam)
    db.flush()
    return exam


def _create_attempt(db: Session, *, exam: Exam, learner: User) -> Attempt:
    attempt = Attempt(
        exam_id=exam.id, user_id=learner.id, status=AttemptStatus.SUBMITTED,
        started_at=_now(), submitted_at=_now(),
    )
    db.add(attempt)
    db.flush()
    return attempt


def _create_video_event(db: Session, *, attempt: Attempt, meta: dict) -> ProctoringEvent:
    event = ProctoringEvent(
        attempt_id=attempt.id, event_type="VIDEO_SAVED", severity=SeverityEnum.LOW,
        detail="camera saved", meta=meta, occurred_at=_now(),
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


# ---- _delete_video_storage_object dispatch ---------------------------------


def test_dispatches_to_cloudflare_delete(monkeypatch):
    calls = []

    async def fake_delete(uid, **kwargs):
        calls.append(uid)
        return True

    monkeypatch.setattr(cloudflare_media, "delete_cloudflare_video", fake_delete)

    ok = asyncio.run(routes_public._delete_video_storage_object({"provider": "cloudflare", "uid": "abc123"}))

    assert ok is True
    assert calls == ["abc123"]


def test_dispatches_to_vimeo_delete(monkeypatch):
    calls = []

    async def fake_delete(*, uid=None, uri=None, **kwargs):
        calls.append((uid, uri))
        return True

    monkeypatch.setattr(vimeo_media, "delete_vimeo_video", fake_delete)

    ok = asyncio.run(
        routes_public._delete_video_storage_object({"provider": "vimeo", "uid": "999", "uri": "/videos/999"})
    )

    assert ok is True
    assert calls == [("999", "/videos/999")]


def test_dispatches_to_supabase_delete(monkeypatch):
    calls = []

    async def fake_delete(path, **kwargs):
        calls.append(path)
        return True

    monkeypatch.setattr(supabase_storage, "delete_object", fake_delete)

    ok = asyncio.run(routes_public._delete_video_storage_object({"provider": "supabase", "path": "videos/cam.webm"}))

    assert ok is True
    assert calls == ["videos/cam.webm"]


def test_unrecognized_provider_is_a_noop_success():
    assert asyncio.run(routes_public._delete_video_storage_object({"provider": "unknown"})) is True


def test_missing_identifier_is_a_noop_success():
    assert asyncio.run(routes_public._delete_video_storage_object({"provider": "cloudflare"})) is True


def test_non_dict_meta_is_a_noop_success():
    assert asyncio.run(routes_public._delete_video_storage_object(None)) is True


def test_provider_failure_propagates_false(monkeypatch):
    async def fake_delete(uid, **kwargs):
        return False

    monkeypatch.setattr(cloudflare_media, "delete_cloudflare_video", fake_delete)

    ok = asyncio.run(routes_public._delete_video_storage_object({"provider": "cloudflare", "uid": "abc"}))

    assert ok is False


# ---- admin delete-video endpoint --------------------------------------------


def test_admin_deletes_video_event_and_writes_audit_log(monkeypatch):
    db = _new_session()
    try:
        admin = _create_user(db, role=RoleEnum.ADMIN)
        learner = _create_user(db, role=RoleEnum.LEARNER)
        exam = _create_exam(db, owner=admin)
        attempt = _create_attempt(db, exam=exam, learner=learner)
        event = _create_video_event(
            db, attempt=attempt, meta={"provider": "cloudflare", "uid": "vid-1", "url": "https://x/vid-1"}
        )

        calls = []

        async def fake_delete(uid, **kwargs):
            calls.append(uid)
            return True

        monkeypatch.setattr(cloudflare_media, "delete_cloudflare_video", fake_delete)

        result = asyncio.run(
            routes_admin.delete_proctoring_video(
                str(attempt.id), str(event.id), current=admin, db=db,
            )
        )

        assert result["deleted"] is True
        assert result["storage_deleted"] is True
        assert calls == ["vid-1"]
        assert db.get(ProctoringEvent, event.id) is None

        audit_rows = db.scalars(select(AuditLog).where(AuditLog.action == "PROCTORING_VIDEO_DELETED")).all()
        assert len(audit_rows) == 1
        assert audit_rows[0].resource_id == str(attempt.id)
        assert audit_rows[0].user_id == admin.id
    finally:
        db.close()


def test_admin_delete_reports_storage_failure_but_still_removes_reference(monkeypatch):
    db = _new_session()
    try:
        admin = _create_user(db, role=RoleEnum.ADMIN)
        learner = _create_user(db, role=RoleEnum.LEARNER)
        exam = _create_exam(db, owner=admin)
        attempt = _create_attempt(db, exam=exam, learner=learner)
        event = _create_video_event(db, attempt=attempt, meta={"provider": "cloudflare", "uid": "vid-2"})

        async def fake_delete(uid, **kwargs):
            return False

        monkeypatch.setattr(cloudflare_media, "delete_cloudflare_video", fake_delete)

        result = asyncio.run(
            routes_admin.delete_proctoring_video(str(attempt.id), str(event.id), current=admin, db=db)
        )

        assert result["deleted"] is True
        assert result["storage_deleted"] is False
        assert db.get(ProctoringEvent, event.id) is None
    finally:
        db.close()


def test_admin_delete_404s_for_wrong_attempt(monkeypatch):
    db = _new_session()
    try:
        admin = _create_user(db, role=RoleEnum.ADMIN)
        learner = _create_user(db, role=RoleEnum.LEARNER)
        exam = _create_exam(db, owner=admin)
        attempt_a = _create_attempt(db, exam=exam, learner=learner)
        attempt_b = _create_attempt(db, exam=exam, learner=learner)
        event = _create_video_event(db, attempt=attempt_a, meta={"provider": "cloudflare", "uid": "vid-3"})

        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(
                routes_admin.delete_proctoring_video(str(attempt_b.id), str(event.id), current=admin, db=db)
            )
        assert exc_info.value.status_code == 404
        assert db.get(ProctoringEvent, event.id) is not None
    finally:
        db.close()


def test_admin_delete_404s_for_non_video_event(monkeypatch):
    db = _new_session()
    try:
        admin = _create_user(db, role=RoleEnum.ADMIN)
        learner = _create_user(db, role=RoleEnum.LEARNER)
        exam = _create_exam(db, owner=admin)
        attempt = _create_attempt(db, exam=exam, learner=learner)
        other_event = ProctoringEvent(
            attempt_id=attempt.id, event_type="TAB_BLUR", severity=SeverityEnum.LOW,
            detail="tab blurred", meta={}, occurred_at=_now(),
        )
        db.add(other_event)
        db.commit()
        db.refresh(other_event)

        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(
                routes_admin.delete_proctoring_video(str(attempt.id), str(other_event.id), current=admin, db=db)
            )
        assert exc_info.value.status_code == 404
    finally:
        db.close()


def test_admin_delete_rejects_non_owning_admin(monkeypatch):
    db = _new_session()
    try:
        owner_admin = _create_user(db, role=RoleEnum.ADMIN)
        other_admin = _create_user(db, role=RoleEnum.ADMIN)
        learner = _create_user(db, role=RoleEnum.LEARNER)
        exam = _create_exam(db, owner=owner_admin)
        attempt = _create_attempt(db, exam=exam, learner=learner)
        event = _create_video_event(db, attempt=attempt, meta={"provider": "cloudflare", "uid": "vid-4"})

        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(
                routes_admin.delete_proctoring_video(str(attempt.id), str(event.id), current=other_admin, db=db)
            )
        assert exc_info.value.status_code == 404
        assert db.get(ProctoringEvent, event.id) is not None
    finally:
        db.close()
