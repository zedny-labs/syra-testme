from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, status

from ...core.config import get_settings
from ...models import Attempt, ProctoringEvent, RoleEnum, SeverityEnum
from ...schemas import Message
from ...services.testing_seed_service import reset_seed as reset_seed_service
from ..deps import get_current_user, get_db_dep, parse_uuid_param

router = APIRouter()
settings = get_settings()


@router.post("/testing/reset-seed")
def reset_seed(
    db=Depends(get_db_dep),
):
    return reset_seed_service(db)


@router.post("/testing/attempts/{attempt_id}/video", response_model=Message)
def seed_attempt_video(
    attempt_id: str,
    payload: dict = Body(default_factory=dict),
    db=Depends(get_db_dep),
    current=Depends(get_current_user),
):
    if not settings.E2E_SEED_ENABLED:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="E2E seed endpoints are disabled")

    attempt_pk = parse_uuid_param(attempt_id, detail="Attempt not found")
    attempt = db.get(Attempt, attempt_pk)
    if not attempt:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attempt not found")
    if current.role == RoleEnum.LEARNER and attempt.user_id != current.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")

    source = str(payload.get("source") or "camera").strip().lower()
    if source not in {"camera", "screen"}:
        source = "camera"
    session_id = str(payload.get("session_id") or f"e2e-{uuid4().hex}")
    now = datetime.now(timezone.utc)
    filename = str(payload.get("filename") or f"{attempt_id}-{source}.webm")
    file_info = {
        "provider": "supabase",
        "session_id": session_id,
        "source": source,
        "extension": "webm",
        "name": filename,
        "url": str(payload.get("url") or f"https://example.invalid/e2e/{filename}"),
        "playback_url": str(payload.get("playback_url") or f"https://example.invalid/e2e/{filename}"),
        "playback_type": "external",
        "status": "ready",
        "ready_to_stream": True,
        "size": int(payload.get("size") or 1),
        "created_at": now.isoformat(),
        "recording_started_at": str(payload.get("recording_started_at") or now.isoformat()),
        "recording_stopped_at": str(payload.get("recording_stopped_at") or now.isoformat()),
    }
    db.add(
        ProctoringEvent(
            attempt_id=attempt.id,
            event_type="VIDEO_SAVED",
            severity=SeverityEnum.LOW,
            detail=f"Seeded E2E proctoring {source} video",
            meta=file_info,
            occurred_at=now,
        )
    )
    db.commit()
    return Message(detail="video seeded")
