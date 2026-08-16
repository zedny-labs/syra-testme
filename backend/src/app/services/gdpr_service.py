from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from fastapi import HTTPException, Response, status
from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload, selectinload

from ..core.i18n import translate as _t
from ..api.deps import parse_uuid_param
from ..models import Attempt, AttemptAnswer, Notification, RoleEnum, Schedule, User


BASE_STORAGE_DIR = Path(__file__).resolve().parent.parent.parent.parent / "storage"
EVIDENCE_DIR = BASE_STORAGE_DIR / "evidence"


def export_user_data(*, db: Session, current: User, user_id: str) -> Response:
    user_pk = parse_uuid_param(user_id, detail=_t("user_not_found"))
    target_user = db.get(User, user_pk)
    if not target_user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_t("user_not_found"))
    ensure_export_access(current, target_user)

    attempts = db.scalars(
        select(Attempt)
        .options(
            joinedload(Attempt.events),
            joinedload(Attempt.exam),
            selectinload(Attempt.answers).joinedload(AttemptAnswer.question),
        )
        .where(Attempt.user_id == target_user.id)
        .order_by(Attempt.created_at.asc())
    ).unique().all()
    schedules = db.scalars(
        select(Schedule)
        .options(joinedload(Schedule.exam))
        .where(Schedule.user_id == target_user.id)
        .order_by(Schedule.created_at.asc())
    ).all()
    notifications = db.scalars(
        select(Notification)
        .where(Notification.user_id == target_user.id)
        .order_by(Notification.created_at.asc())
    ).all()

    payload = {
        "generated_at": datetime.now(timezone.utc),
        "user": {
            "id": target_user.id,
            "user_id": target_user.user_id,
            "email": target_user.email,
            "name": target_user.name,
            "role": target_user.role,
            "is_active": target_user.is_active,
            "created_at": target_user.created_at,
            "updated_at": target_user.updated_at,
        },
        "attempts": [
            {
                "id": attempt.id,
                "exam_id": attempt.exam_id,
                "exam_title": attempt.exam.title if attempt.exam else None,
                "status": attempt.status,
                "score": attempt.score,
                "grade": attempt.grade,
                "started_at": attempt.started_at,
                "submitted_at": attempt.submitted_at,
                "created_at": attempt.created_at,
                "updated_at": attempt.updated_at,
                "answers": [
                    {
                        "question_id": answer.question_id,
                        "question_text": answer.question.text if answer.question else None,
                        "answer": answer.answer,
                        "is_correct": answer.is_correct,
                        "points_earned": answer.points_earned,
                    }
                    for answer in attempt.answers
                ],
                "proctoring_events": [
                    {
                        "event_type": event.event_type,
                        "severity": event.severity,
                        "detail": event.detail,
                        "ai_confidence": event.ai_confidence,
                        "occurred_at": event.occurred_at,
                    }
                    for event in sorted(attempt.events, key=lambda item: item.occurred_at or datetime.min.replace(tzinfo=timezone.utc))
                ],
                "proctoring_media": collect_attempt_media(attempt),
            }
            for attempt in attempts
        ],
        "schedules": [
            {
                "id": schedule.id,
                "exam_id": schedule.exam_id,
                "test_id": schedule.exam_id,
                "test_title": schedule.exam.title if schedule.exam else None,
                "scheduled_at": schedule.scheduled_at,
                "access_mode": schedule.access_mode,
                "notes": schedule.notes,
                "created_at": schedule.created_at,
                "updated_at": schedule.updated_at,
            }
            for schedule in schedules
        ],
        "notifications": [
            {
                "id": notification.id,
                "title": notification.title,
                "message": notification.message,
                "is_read": notification.is_read,
                "link": notification.link,
                "created_at": notification.created_at,
            }
            for notification in notifications
        ],
    }

    file_name = f"user-export-{target_user.user_id or target_user.id}.json"
    return Response(
        content=json.dumps(jsonable_encoder(payload), indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{file_name}"'},
    )


def ensure_export_access(current: User, target_user: User) -> None:
    if current.role == RoleEnum.ADMIN:
        return
    if current.id != target_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_t("not_allowed"))


def file_metadata_from_path(value: str | None) -> dict | None:
    if not value:
        return None
    file_path = Path(value)
    metadata = {"filename": file_path.name}
    if file_path.exists():
        metadata["recorded_at"] = datetime.fromtimestamp(file_path.stat().st_mtime, tz=timezone.utc)
    return metadata


def collect_attempt_files(directory: Path, attempt_id) -> list[dict]:
    if not directory.exists():
        return []
    prefix = f"{attempt_id}_"
    items: list[dict] = []
    for file_path in sorted(directory.glob(f"{prefix}*")):
        if not file_path.is_file():
            continue
        items.append(
            {
                "filename": file_path.name,
                "recorded_at": datetime.fromtimestamp(file_path.stat().st_mtime, tz=timezone.utc),
            }
        )
    return items


def is_absolute_http_url(value: str | None) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    parsed = urlparse(raw)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def collect_attempt_media(attempt: Attempt) -> dict:
    evidence: list[dict] = []
    videos: list[dict] = []
    seen_videos: set[tuple[str, str]] = set()
    for event in sorted(attempt.events, key=lambda item: item.occurred_at or datetime.min.replace(tzinfo=timezone.utc)):
        meta = event.meta if isinstance(event.meta, dict) else {}
        if event.event_type == "VIDEO_SAVED":
            video_name = str(meta.get("name") or "").strip()
            video_url = str(meta.get("playback_url") or meta.get("url") or "").strip()
            video_path = str(meta.get("path") or meta.get("object_path") or "").strip()
            video_provider = str(meta.get("provider") or "").strip().lower()
            if (
                (is_absolute_http_url(video_url) and video_provider in {"", "cloudflare", "supabase", "vimeo"})
                or (video_provider == "supabase" and video_path)
            ):
                video_source = str(meta.get("source") or "camera")
                video_key = (str(meta.get("session_id") or video_path or video_name or video_url), video_source)
                if video_key not in seen_videos:
                    seen_videos.add(video_key)
                    videos.append(
                        {
                            "filename": video_name or Path(video_path).name or video_url.rstrip("/").rsplit("/", 1)[-1],
                            "recorded_at": meta.get("created_at") or event.occurred_at,
                            "provider": video_provider or "cloudflare",
                            "source": video_source,
                            "url": video_url or None,
                            "path": video_path or None,
                        }
                    )
        evidence_path = meta.get("evidence")
        if evidence_path:
            evidence.append(
                {
                    "filename": Path(str(evidence_path)).name,
                    "event_type": event.event_type,
                    "occurred_at": event.occurred_at,
                }
            )

    return {
        "videos": videos,
        "evidence": evidence or collect_attempt_files(EVIDENCE_DIR, attempt.id),
        "identity_documents": [
            item
            for item in (
                file_metadata_from_path(attempt.id_doc_path),
                file_metadata_from_path(attempt.selfie_path),
            )
            if item
        ],
    }
