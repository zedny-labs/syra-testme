"""Admin proctoring routes.

Provides endpoints for admins to:
  - List all proctoring sessions with filtering/pagination
  - Get a proctoring summary for an attempt
  - Export proctoring events as CSV
  - Get aggregate stats across attempts for a test
  - Live monitoring: watch active proctoring sessions in real time
"""
from __future__ import annotations

import asyncio
import contextlib
import csv
import io
import logging
from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from sqlalchemy import func, case, and_
from starlette.websockets import WebSocketState
from sqlalchemy.orm import Session, subqueryload

from ...api.deps import ensure_exam_owner, get_current_user, get_db_dep, require_permission
from ...models import (
    Attempt,
    AttemptStatus,
    Exam,
    ProctoringEvent,
    RoleEnum,
    SeverityEnum,
    User,
)
from ...schemas import PaginatedResponse, ProctoringEventRead
from ...services.audit import write_audit_log
from ...utils.pagination import MAX_PAGE_SIZE, normalize_pagination
from ...core.i18n import translate as _t
from .routes_public import _build_attempt_proctoring_summary, _delete_video_storage_object, _is_summary_alert_event

router = APIRouter()
logger = logging.getLogger(__name__)


class ProctoringSessionSummary:
    """Lightweight DTO built manually (not a Pydantic response_model)."""
    pass


def _owned_exam_or_404(db: Session, exam_id: UUID | str, current: User) -> Exam:
    exam = db.get(Exam, exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail=_t("test_not_found"))
    ensure_exam_owner(exam, current)
    return exam


@router.get("/admin/sessions")
def list_proctoring_sessions(
    exam_id: UUID | None = None,
    user_id: UUID | None = None,
    min_risk: int | None = Query(None, ge=0, le=100),
    severity: str | None = Query(None, description="Filter by max severity: HIGH, MEDIUM, LOW"),
    status: str | None = Query(None, description="Attempt status filter"),
    sort_by: str | None = Query("started_at", description="Sort field"),
    sort_dir: str | None = Query("desc"),
    page: int | None = Query(1, ge=1),
    page_size: int | None = Query(20, ge=1, le=MAX_PAGE_SIZE),
    current: User = Depends(require_permission("proctoring.admin", RoleEnum.ADMIN)),
    db: Session = Depends(get_db_dep),
):
    """List proctoring sessions with event summaries, filterable by exam/user/severity."""
    pag = normalize_pagination(page=page, page_size=page_size)
    offset, limit = pag.offset, pag.limit

    # Base query: attempts that have at least one proctoring event
    q = db.query(Attempt).options(
        subqueryload(Attempt.user),
        subqueryload(Attempt.exam),
    )
    q = q.join(Attempt.exam).filter(Exam.created_by_id == current.id)

    if exam_id:
        q = q.filter(Attempt.exam_id == exam_id)
    if user_id:
        q = q.filter(Attempt.user_id == user_id)
    if status:
        try:
            q = q.filter(Attempt.status == AttemptStatus(status.upper()))
        except ValueError:
            pass

    # Count events per attempt via subquery
    event_counts_sq = (
        db.query(
            ProctoringEvent.attempt_id,
            func.count(ProctoringEvent.id).label("total_events"),
            func.count(case((ProctoringEvent.severity == SeverityEnum.HIGH, 1))).label("high_count"),
            func.count(case((ProctoringEvent.severity == SeverityEnum.MEDIUM, 1))).label("medium_count"),
            func.count(case((ProctoringEvent.severity == SeverityEnum.LOW, 1))).label("low_count"),
        )
        .group_by(ProctoringEvent.attempt_id)
        .subquery()
    )

    q = q.outerjoin(event_counts_sq, Attempt.id == event_counts_sq.c.attempt_id)

    # Only include attempts that have events (proctored attempts)
    q = q.filter(event_counts_sq.c.total_events > 0)

    if severity:
        sev_upper = severity.upper()
        if sev_upper == "HIGH":
            q = q.filter(event_counts_sq.c.high_count > 0)
        elif sev_upper == "MEDIUM":
            q = q.filter((event_counts_sq.c.high_count > 0) | (event_counts_sq.c.medium_count > 0))

    # Filter by minimum risk score in SQL so pagination is accurate
    if min_risk is not None:
        risk_expr = (
            func.coalesce(event_counts_sq.c.high_count, 0) * 3
            + func.coalesce(event_counts_sq.c.medium_count, 0) * 2
            + func.coalesce(event_counts_sq.c.low_count, 0)
        )
        q = q.filter(risk_expr >= min_risk)

    total = q.count()

    # Sorting
    sort_col = {
        "started_at": Attempt.started_at,
        "submitted_at": Attempt.submitted_at,
        "total_events": event_counts_sq.c.total_events,
        "high_count": event_counts_sq.c.high_count,
    }.get(sort_by, Attempt.started_at)
    if sort_dir and sort_dir.lower() == "asc":
        q = q.order_by(sort_col.asc().nullslast())
    else:
        q = q.order_by(sort_col.desc().nullslast())

    rows = q.add_columns(
        event_counts_sq.c.total_events,
        event_counts_sq.c.high_count,
        event_counts_sq.c.medium_count,
        event_counts_sq.c.low_count,
    ).offset(offset).limit(limit).all()

    items = []
    for attempt, total_events, high, medium, low in rows:
        risk_score = (high or 0) * 3 + (medium or 0) * 2 + (low or 0)
        items.append({
            "attempt_id": str(attempt.id),
            "exam_id": str(attempt.exam_id),
            "exam_title": attempt.exam.title if attempt.exam else None,
            "user_id": str(attempt.user_id),
            "user_name": attempt.user.name if attempt.user else None,
            "student_id": attempt.user.user_id if attempt.user else None,
            "status": attempt.status.value if attempt.status else None,
            "score": attempt.score,
            "started_at": attempt.started_at.isoformat() if attempt.started_at else None,
            "submitted_at": attempt.submitted_at.isoformat() if attempt.submitted_at else None,
            "identity_verified": attempt.identity_verified,
            "total_events": total_events or 0,
            "high_severity": high or 0,
            "medium_severity": medium or 0,
            "low_severity": low or 0,
            "risk_score": risk_score,
        })

    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/admin/sessions/{attempt_id}/summary")
def get_session_summary(
    attempt_id: str,
    current: User = Depends(require_permission("proctoring.admin", RoleEnum.ADMIN)),
    db: Session = Depends(get_db_dep),
):
    """Get detailed proctoring summary for a single attempt."""
    from ...api.deps import parse_uuid_param
    pk = parse_uuid_param(attempt_id)
    attempt = db.get(Attempt, pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    _owned_exam_or_404(db, attempt.exam_id, current)

    events = (
        db.query(ProctoringEvent)
        .filter(ProctoringEvent.attempt_id == pk)
        .order_by(ProctoringEvent.occurred_at.asc())
        .all()
    )
    filtered_events = [event for event in events if _is_summary_alert_event(event.event_type)]
    summary = _build_attempt_proctoring_summary(attempt, events)

    # Build summary
    event_type_counts: dict[str, int] = {}
    timeline = []
    for ev in filtered_events:
        et = ev.event_type or "UNKNOWN"
        event_type_counts[et] = event_type_counts.get(et, 0) + 1
        sev = ev.severity.value if ev.severity else "LOW"
        timeline.append({
            "id": str(ev.id),
            "event_type": et,
            "severity": sev,
            "detail": ev.detail,
            "confidence": ev.ai_confidence,
            "occurred_at": ev.occurred_at.isoformat() if ev.occurred_at else None,
            "meta": ev.meta,
        })

    # Duration
    duration_sec = None
    if attempt.started_at and attempt.submitted_at:
        duration_sec = (attempt.submitted_at - attempt.started_at).total_seconds()

    return {
        "attempt_id": str(attempt.id),
        "status": attempt.status.value if attempt.status else None,
        "score": attempt.score,
        "started_at": attempt.started_at.isoformat() if attempt.started_at else None,
        "submitted_at": attempt.submitted_at.isoformat() if attempt.submitted_at else None,
        "duration_seconds": duration_sec,
        "identity_verified": attempt.identity_verified,
        "total_events": summary["total_events"],
        "severity_counts": summary["severity_counts"],
        "event_type_counts": event_type_counts,
        "risk_score": summary["risk_score"],
        "saved_recordings": summary["saved_recordings"],
        "expected_recordings": summary["expected_recordings"],
        "timeline": timeline,
    }


@router.delete("/admin/sessions/{attempt_id}/videos/{event_id}")
async def delete_proctoring_video(
    attempt_id: str,
    event_id: str,
    current: User = Depends(require_permission("proctoring.admin", RoleEnum.ADMIN)),
    db: Session = Depends(get_db_dep),
):
    """Permanently delete a single uploaded proctoring recording: removes the
    file from the configured storage provider (Cloudflare/Vimeo/Supabase) on a
    best-effort basis, then always removes the VIDEO_SAVED event so it stops
    appearing in the admin UI. Irreversible."""
    from ...api.deps import parse_uuid_param

    attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    attempt = db.get(Attempt, attempt_pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    _owned_exam_or_404(db, attempt.exam_id, current)

    event_pk = parse_uuid_param(event_id, detail=_t("not_found"))
    event = db.get(ProctoringEvent, event_pk)
    if not event or event.attempt_id != attempt_pk or event.event_type != "VIDEO_SAVED":
        raise HTTPException(status_code=404, detail=_t("not_found"))

    storage_deleted = await _delete_video_storage_object(event.meta)
    db.delete(event)
    audit_detail = f"Deleted proctoring video (event {event.id}) for attempt {attempt.id}"
    if not storage_deleted:
        audit_detail += " — storage delete failed, DB reference removed only"
    write_audit_log(db, current.id, "PROCTORING_VIDEO_DELETED", "attempt", str(attempt.id), detail=audit_detail)

    return {"deleted": True, "storage_deleted": storage_deleted}


@router.get("/admin/sessions/{attempt_id}/export")
def export_session_events(
    attempt_id: str,
    current: User = Depends(require_permission("proctoring.admin", RoleEnum.ADMIN)),
    db: Session = Depends(get_db_dep),
):
    """Export proctoring events for an attempt as CSV."""
    from ...api.deps import parse_uuid_param
    pk = parse_uuid_param(attempt_id)
    attempt = db.get(Attempt, pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    _owned_exam_or_404(db, attempt.exam_id, current)

    events = (
        db.query(ProctoringEvent)
        .filter(ProctoringEvent.attempt_id == pk)
        .order_by(ProctoringEvent.occurred_at.asc())
        .all()
    )

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["timestamp", "event_type", "severity", "detail", "confidence", "meta"])
    for ev in events:
        writer.writerow([
            ev.occurred_at.isoformat() if ev.occurred_at else "",
            ev.event_type,
            ev.severity.value if ev.severity else "",
            ev.detail or "",
            ev.ai_confidence or "",
            str(ev.meta) if ev.meta else "",
        ])

    output.seek(0)
    filename = f"proctoring_events_{attempt_id[:8]}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/admin/stats/{exam_id}")
def get_exam_proctoring_stats(
    exam_id: str,
    current: User = Depends(require_permission("proctoring.admin", RoleEnum.ADMIN)),
    db: Session = Depends(get_db_dep),
):
    """Get aggregate proctoring statistics for all attempts of a given exam."""
    from ...api.deps import parse_uuid_param
    exam_pk = parse_uuid_param(exam_id)
    _owned_exam_or_404(db, exam_pk, current)

    # All attempts for this exam
    attempts = (
        db.query(Attempt)
        .filter(Attempt.exam_id == exam_pk)
        .all()
    )
    if not attempts:
        return {
            "exam_id": exam_id,
            "total_attempts": 0,
            "proctored_attempts": 0,
            "avg_risk_score": 0,
            "flagged_attempts": 0,
            "event_type_totals": {},
            "severity_totals": {"HIGH": 0, "MEDIUM": 0, "LOW": 0},
        }

    attempt_ids = [a.id for a in attempts]

    # Aggregate events
    rows = (
        db.query(
            ProctoringEvent.event_type,
            ProctoringEvent.severity,
            func.count(ProctoringEvent.id),
        )
        .filter(ProctoringEvent.attempt_id.in_(attempt_ids))
        .group_by(ProctoringEvent.event_type, ProctoringEvent.severity)
        .all()
    )

    event_type_totals: dict[str, int] = {}
    severity_totals = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
    for et, sev, cnt in rows:
        event_type_totals[et] = event_type_totals.get(et, 0) + cnt
        sev_str = sev.value if sev else "LOW"
        severity_totals[sev_str] = severity_totals.get(sev_str, 0) + cnt

    # Per-attempt risk scores
    per_attempt = (
        db.query(
            ProctoringEvent.attempt_id,
            func.count(case((ProctoringEvent.severity == SeverityEnum.HIGH, 1))).label("high"),
            func.count(case((ProctoringEvent.severity == SeverityEnum.MEDIUM, 1))).label("medium"),
            func.count(case((ProctoringEvent.severity == SeverityEnum.LOW, 1))).label("low"),
        )
        .filter(ProctoringEvent.attempt_id.in_(attempt_ids))
        .group_by(ProctoringEvent.attempt_id)
        .all()
    )

    risk_scores = [h * 3 + m * 2 + lo for _, h, m, lo in per_attempt]
    proctored = len(per_attempt)
    avg_risk = round(sum(risk_scores) / max(1, proctored), 1)
    flagged = sum(1 for s in risk_scores if s >= 10)

    return {
        "exam_id": exam_id,
        "total_attempts": len(attempts),
        "proctored_attempts": proctored,
        "avg_risk_score": avg_risk,
        "flagged_attempts": flagged,
        "event_type_totals": event_type_totals,
        "severity_totals": severity_totals,
    }


@router.get("/admin/config-history/{exam_id}")
def get_proctoring_config_history(
    exam_id: str,
    current: User = Depends(require_permission("proctoring.admin", RoleEnum.ADMIN)),
    db: Session = Depends(get_db_dep),
):
    """Get the audit trail of proctoring config changes for a test."""
    from ...api.deps import parse_uuid_param
    from ...models import AuditLog
    pk = parse_uuid_param(exam_id)
    _owned_exam_or_404(db, pk, current)

    logs = (
        db.query(AuditLog)
        .filter(
            AuditLog.resource_type == "test",
            AuditLog.resource_id == str(pk),
            AuditLog.action == "PROCTORING_CONFIG_UPDATED",
        )
        .order_by(AuditLog.created_at.desc())
        .limit(50)
        .all()
    )

    return {
        "exam_id": exam_id,
        "changes": [
            {
                "id": str(log.id),
                "changed_by": str(log.user_id) if log.user_id else None,
                "detail": log.detail,
                "ip_address": log.ip_address,
                "changed_at": log.created_at.isoformat() if log.created_at else None,
            }
            for log in logs
        ],
    }


# ── Force Submit ──────────────────────────────────────────────────────────────

@router.post("/admin/sessions/{attempt_id}/force-submit")
async def force_submit_attempt(
    attempt_id: str,
    current: User = Depends(require_permission("proctoring.admin", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
    db: Session = Depends(get_db_dep),
):
    """Force-submit a learner's attempt. Admin can force any; instructor only their own exams."""
    from ...api.deps import parse_uuid_param
    from ...services import live_bus
    from .routes_public import _auto_submit_attempt

    pk = parse_uuid_param(attempt_id)
    attempt = db.get(Attempt, pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    _owned_exam_or_404(db, attempt.exam_id, current)

    if attempt.status == AttemptStatus.SUBMITTED:
        raise HTTPException(status_code=409, detail=_t("attempt_already_submitted"))

    _auto_submit_attempt(
        db,
        attempt,
        violation_count=0,
        reason=f"Force-submitted by admin {current.name or current.id}",
        actor_user_id=current.id,
    )

    # Notify live viewers that the session was force-submitted
    await live_bus.publish_json_event(str(pk), {
        "type": "force_submitted",
        "detail": "Attempt was force-submitted by an administrator.",
    })

    return {"detail": _t("force_submitted"), "attempt_id": str(pk)}


# ── Live Monitoring ───────────────────────────────────────────────────────────

@router.get("/admin/live")
async def list_active_sessions(
    current: User = Depends(require_permission("proctoring.admin", RoleEnum.ADMIN)),
    db: Session = Depends(get_db_dep),
):
    """List all currently active proctoring sessions (learners with an open WS)."""
    from ...services import live_bus

    all_sessions = await live_bus.get_all_sessions()
    sessions = []
    for info in all_sessions:
        exam_id = info.get("exam_id")
        if not exam_id:
            continue
        exam = db.get(Exam, exam_id)
        if not exam or exam.created_by_id != current.id:
            continue
        attempt_id = info.get("attempt_id", "")
        viewers_count = await live_bus.get_viewer_count(attempt_id)
        sessions.append({**info, "viewers": viewers_count})
    return {"active_sessions": sessions}


@router.websocket("/admin/live/{attempt_id}/ws")
async def live_monitor_ws(websocket: WebSocket, attempt_id: str, token: str):
    """Admin WebSocket: watch a learner's proctoring session in real time.

    Receives:
      - Binary messages: frame thumbnails (type byte + JPEG data)
      - JSON messages: alerts, summaries, session_ended

    Session state and message routing use Redis pub/sub so this handler works
    correctly regardless of which Gunicorn worker the student's WebSocket landed on.
    """
    import base64 as _b64
    from ...core.security import verify_token
    from ...services import live_bus

    # Authenticate admin
    try:
        payload = verify_token(token, expected_type="access")
    except Exception:
        await websocket.close(code=4401)
        return
    if payload.get("role") not in {"ADMIN", "INSTRUCTOR"}:
        await websocket.close(code=4403)
        return

    # Authorise: instructor may only watch exams they own
    session_info_check = await live_bus.get_session_info(attempt_id)
    if session_info_check:
        from ...db.session import get_db
        db_gen = get_db()
        db = next(db_gen)
        try:
            exam = db.get(Exam, session_info_check.get("exam_id"))
            if not exam or str(exam.created_by_id) != payload.get("sub"):
                await websocket.close(code=4403)
                return
        finally:
            try:
                next(db_gen)
            except StopIteration:
                pass

    await websocket.accept()

    session_info = await live_bus.get_session_info(attempt_id)
    if not session_info:
        await websocket.send_json({"type": "error", "detail": "Session not active or not found"})
        await websocket.close(code=4404)
        return

    await websocket.send_json({"type": "connected", **session_info})

    # Send last known thumbnail so the admin sees something immediately
    thumb = await live_bus.get_latest_thumb(attempt_id)
    if thumb:
        with contextlib.suppress(Exception):
            await websocket.send_bytes(b'\x01' + thumb)

    # ── Two concurrent tasks ──────────────────────────────────────────────
    # Task 1: forward Redis pub/sub messages to this admin WebSocket.
    # Task 2: receive messages from the admin (pings, future commands).
    # Whichever finishes first triggers cleanup of the other.

    async def _redis_to_ws() -> None:
        async for msg in live_bus.subscribe(attempt_id):
            msg_type = msg.get("type")
            try:
                if msg_type == "session_ended":
                    with contextlib.suppress(Exception):
                        await websocket.send_json(msg)
                    break
                elif msg_type == "thumb":
                    raw_type = msg.get("msg_type", "frame")
                    type_byte = b'\x01' if raw_type == "frame" else b'\x02'
                    data = _b64.b64decode(msg.get("payload", ""))
                    await websocket.send_bytes(type_byte + data)
                elif msg_type == "json":
                    await websocket.send_json(msg.get("payload", {}))
            except Exception:
                break

    async def _ws_receive() -> None:
        try:
            while True:
                data = await websocket.receive_json()
                if data.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
        except (WebSocketDisconnect, Exception):
            pass

    redis_task = asyncio.create_task(_redis_to_ws())
    ws_task = asyncio.create_task(_ws_receive())
    try:
        _done, pending = await asyncio.wait(
            [redis_task, ws_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
    finally:
        if websocket.application_state == WebSocketState.CONNECTED:
            with contextlib.suppress(Exception):
                await websocket.close(code=1000)
