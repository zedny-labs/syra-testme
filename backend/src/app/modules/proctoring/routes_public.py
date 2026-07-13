import base64
import asyncio
import contextlib
import json
import logging
import tempfile
import time
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from starlette.websockets import WebSocketState
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload, load_only

from ...api.deps import ensure_exam_owner, ensure_permission, get_current_user, get_db_dep, require_permission, parse_uuid_param
from ...core.security import verify_token
from ...core.config import get_settings
from ...models import Attempt, AttemptStatus, Exam, Notification, ProctoringEvent, RoleEnum, SeverityEnum, SystemSettings, User
from ...services.normalized_relations import exam_proctoring
from ...schemas import (
    AttemptProctoringSummaryRead,
    ProctoringEventRead,
    Message,
    ProctoringPingResponse,
    ProctoringVideoUploadResponse,
    ProctoringJobStatusResponse,
)
from ...reporting.report_generator import generate_html_report, generate_pdf_report
from ...services.integrations import send_proctoring_integration_event
from ...services.proctoring_inference import get_proctoring_inference_gateway
from ...services.proctoring_video_batch import (
    enqueue_video_batch_analysis,
    get_proctoring_video_job_status,
    video_batch_analysis_enabled,
    video_job_queue_enabled,
)
from ...tasks.proctoring_video import upload_proctoring_video_capture
from ...services.audit import write_audit_log
from ...services.notifications import notify_proctoring_event, notify_user
from ...services.cloudflare_media import (
    cloudflare_video_storage_enabled,
    get_cloudflare_video_details,
    infer_cloudflare_ready_to_stream,
    sign_cloudflare_playback_url,
    upload_video_to_cloudflare,
)
from ...services.supabase_storage import create_signed_url as create_supabase_signed_url
from ...services.supabase_storage import upload_bytes as upload_bytes_to_supabase
from ...services.vimeo_media import (
    get_vimeo_video_details,
    upload_video_to_vimeo,
    vimeo_video_storage_enabled,
)
from ...core.i18n import translate as _t
from ...utils.request_ip import get_request_ip, get_websocket_ip
from ...utils.response_cache import TimedSingleFlightCache
from ...modules.tests.proctoring_requirements import get_proctoring_requirements
from ...services import live_bus

router = APIRouter()
BASE_STORAGE_DIR = Path(__file__).resolve().parent.parent.parent.parent.parent / "storage"
EVIDENCE_DIR = BASE_STORAGE_DIR / "evidence"
VIDEO_UPLOAD_SPOOL_DIR = BASE_STORAGE_DIR / "video_uploads"
HEARTBEAT_INTERVAL_SECONDS = 10
INACTIVITY_TIMEOUT_SECONDS = 60
ADMIN_PROCTORING_NOTIFICATION_WINDOW = timedelta(minutes=5)
logger = logging.getLogger(__name__)
_INVALID_SAVED_VIDEO_STATUSES = {"error", "failed"}

SEVERITY_MAP = {
    "CRITICAL": SeverityEnum.HIGH,
    "HIGH": SeverityEnum.HIGH,
    "MEDIUM": SeverityEnum.MEDIUM,
    "LOW": SeverityEnum.LOW,
}
settings = get_settings()
VIDEO_UPLOAD_STATUS_CACHE_TTL_SECONDS = 3.0
_video_upload_status_cache: TimedSingleFlightCache[list[dict[str, object]]] = TimedSingleFlightCache(
    ttl_seconds=VIDEO_UPLOAD_STATUS_CACHE_TTL_SECONDS
)

# Live monitoring state is stored in Redis (see services/live_bus.py) so it is
# shared across all Gunicorn workers. Student WebSockets publish to Redis;
# admin WebSockets subscribe to Redis and receive events on any worker.


def _normalize_video_source(value: object) -> str:
    normalized = str(value or "camera").strip().lower()
    if normalized in {"camera", "screen"}:
        return normalized
    return "camera"


def _video_filename(attempt_id: str, session_id: str, source: str, extension: str) -> str:
    safe_source = _normalize_video_source(source)
    return f"{attempt_id}_{safe_source}_{session_id}.{extension}"


def _video_storage_provider() -> str:
    provider = get_settings().PROCTORING_VIDEO_STORAGE_PROVIDER
    if provider == "cloudflare":
        if not cloudflare_video_storage_enabled():
            raise HTTPException(
                status_code=503,
                detail=_t("cloudflare_not_properly_configured"),
            )
        return "cloudflare"
    if provider == "supabase":
        from ...services.supabase_storage import supabase_video_storage_enabled
        if not supabase_video_storage_enabled():
            raise HTTPException(
                status_code=503,
                detail=_t("supabase_not_configured"),
            )
        return "supabase"
    if provider == "vimeo":
        if not vimeo_video_storage_enabled():
            raise HTTPException(
                status_code=503,
                detail=_t("vimeo_not_configured"),
            )
        return "vimeo"
    raise HTTPException(
        status_code=503,
        detail=_t("unsupported_video_provider", provider=provider),
    )


def _require_cloudflare_video_storage() -> None:
    provider = str(get_settings().PROCTORING_VIDEO_STORAGE_PROVIDER or "").strip().lower()
    if provider != "cloudflare":
        raise HTTPException(status_code=503, detail=_t("cloudflare_must_be_enabled"))
    if not cloudflare_video_storage_enabled():
        raise HTTPException(status_code=503, detail=_t("cloudflare_not_configured"))


def _cloudflare_upload_queue_enabled() -> bool:
    provider = str(get_settings().PROCTORING_VIDEO_STORAGE_PROVIDER or "").strip().lower()
    return provider == "cloudflare" and video_job_queue_enabled()


def _queued_upload_enabled(provider: str) -> bool:
    # Cloudflare and Vimeo uploads are slow (transcode / resumable tus), so they run
    # through the spool -> Celery path when a job queue is configured. Supabase writes
    # bytes synchronously and does not use the queue.
    return str(provider or "").strip().lower() in {"cloudflare", "vimeo"} and video_job_queue_enabled()


def _is_absolute_http_url(value: object) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    parsed = urlparse(raw)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


async def _hydrate_video_file_info(item: dict[str, object]) -> dict[str, object]:
    hydrated = dict(item or {})
    provider = str(hydrated.get("provider") or "").strip().lower()

    if provider == "cloudflare":
        status = str(hydrated.get("status") or "").strip().lower()
        if (
            hydrated.get("ready_to_stream") is False
            or status in {"queued", "pending", "uploading", "processing", "inprogress"}
        ):
            refreshed = await get_cloudflare_video_details(
                uid=str(hydrated.get("uid") or "").strip() or None,
                filename=str(hydrated.get("name") or "").strip() or None,
                source=_normalize_video_source(hydrated.get("source")),
                fallback_size=_coerce_non_negative_int(hydrated.get("size")),
            )
            if refreshed:
                preserved_fields = (
                    "session_id",
                    "recording_started_at",
                    "recording_stopped_at",
                    "source",
                )
                merged = {**hydrated, **refreshed}
                for key in preserved_fields:
                    if merged.get(key) in (None, "") and hydrated.get(key) not in (None, ""):
                        merged[key] = hydrated.get(key)
                hydrated = merged
        # Sign Cloudflare Stream URLs so videos with require_signed_urls work
        for key in ("url", "playback_url"):
            raw_url = str(hydrated.get(key) or "").strip()
            if raw_url:
                hydrated[key] = sign_cloudflare_playback_url(raw_url)
        return hydrated

    if provider == "vimeo":
        status = str(hydrated.get("status") or "").strip().lower()
        if hydrated.get("ready_to_stream") is not True or status in {"processing", "uploading", "pending", "queued", "inprogress"}:
            refreshed = await get_vimeo_video_details(
                uid=str(hydrated.get("uid") or "").strip() or None,
                uri=str(hydrated.get("uri") or "").strip() or None,
                source=_normalize_video_source(hydrated.get("source")),
            )
            if refreshed:
                merged = {**hydrated, **refreshed}
                # Vimeo detail responses omit byte size and some capture context; keep ours.
                if not merged.get("size") and hydrated.get("size"):
                    merged["size"] = hydrated.get("size")
                for key in ("session_id", "recording_started_at", "recording_stopped_at", "source"):
                    if merged.get(key) in (None, "") and hydrated.get(key) not in (None, ""):
                        merged[key] = hydrated.get(key)
                hydrated = merged
        return hydrated

    if provider != "supabase":
        return hydrated

    object_path = str(hydrated.get("path") or hydrated.get("object_path") or "").strip()
    if not object_path:
        return hydrated

    signed_url = await create_supabase_signed_url(object_path)
    hydrated["url"] = signed_url
    hydrated["playback_url"] = signed_url
    hydrated.setdefault("playback_type", "direct")
    hydrated["ready_to_stream"] = True
    hydrated.setdefault("status", "ready")
    return hydrated


def _normalize_saved_video_meta(meta: object, occurred_at: datetime | None = None) -> dict[str, object] | None:
    if not isinstance(meta, dict):
        return None

    url = str(meta.get("playback_url") or meta.get("url") or "").strip()
    path = str(meta.get("path") or meta.get("object_path") or "").strip()
    name = str(meta.get("name") or "").strip()
    provider = str(meta.get("provider") or "").strip().lower()
    if not provider:
        provider = "supabase" if path.startswith("videos/") else "cloudflare"
    if provider not in {"cloudflare", "supabase", "vimeo"}:
        return None
    if provider == "cloudflare" and not _is_absolute_http_url(url):
        return None
    if provider == "vimeo" and not _is_absolute_http_url(url):
        return None
    if provider == "supabase" and not (path or _is_absolute_http_url(url)):
        return None

    created_at = meta.get("created_at")
    if not created_at and occurred_at:
        created_at = occurred_at.isoformat()
    status = str(meta.get("status") or "").strip().lower()
    explicit_ready = meta.get("ready_to_stream") if isinstance(meta, dict) and "ready_to_stream" in meta else None
    if provider == "cloudflare":
        ready_to_stream = infer_cloudflare_ready_to_stream(status=status, ready_to_stream=explicit_ready, playback_url=url)
    elif provider == "vimeo":
        # Vimeo transcodes asynchronously; it is only playable once marked ready.
        ready_to_stream = (explicit_ready is True) or status == "ready"
    else:
        ready_to_stream = bool(path or _is_absolute_http_url(url))

    resolved_name = name or (Path(path).name if path else "") or (str(meta.get("uid") or "").strip() or url.rstrip("/").rsplit("/", 1)[-1] or "recording")
    item: dict[str, object] = {
        "name": resolved_name,
        "size": int(meta.get("size") or 0),
        "source": _normalize_video_source(meta.get("source")),
        "created_at": created_at,
        "provider": provider,
        "ready_to_stream": ready_to_stream,
    }
    if path:
        item["path"] = path
    if _is_absolute_http_url(url):
        item["url"] = url
        item["playback_url"] = str(meta.get("playback_url") or url).strip()

    for key in ("uid", "uri", "hash", "status", "thumbnail", "duration", "session_id", "playback_type", "recording_started_at", "recording_stopped_at", "bucket"):
        if meta.get(key) not in (None, ""):
            item[key] = meta.get(key)

    return item


def _saved_video_meta_is_valid(meta: object) -> bool:
    if not isinstance(meta, dict):
        return False
    status = str(meta.get("status") or "").strip().lower()
    if status in _INVALID_SAVED_VIDEO_STATUSES:
        return False
    if meta.get("ready_to_stream") is True:
        return True
    return _coerce_non_negative_int(meta.get("size")) > 0


def _saved_video_events(db: Session, attempt_id: str) -> list[ProctoringEvent]:
    return list(
        db.scalars(
            select(ProctoringEvent)
            .where(
                ProctoringEvent.attempt_id == parse_uuid_param(attempt_id, detail=_t("attempt_not_found")),
                ProctoringEvent.event_type == "VIDEO_SAVED",
            )
            .order_by(ProctoringEvent.occurred_at.desc())
        )
    )


def _video_upload_progress_events(db: Session, attempt_id: str) -> list[ProctoringEvent]:
    return list(
        db.scalars(
            select(ProctoringEvent)
            .where(
                ProctoringEvent.attempt_id == parse_uuid_param(attempt_id, detail=_t("attempt_not_found")),
                ProctoringEvent.event_type == "VIDEO_UPLOAD_PROGRESS",
            )
            .order_by(ProctoringEvent.occurred_at.desc())
        )
    )


def _coerce_non_negative_int(value: object) -> int:
    try:
        numeric = int(float(value))
    except (TypeError, ValueError):
        return 0
    return max(0, numeric)


def _clamp_progress_percent(value: object, *, default: int = 0) -> int:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = float(default)
    return max(0, min(100, int(round(numeric))))


def _normalize_video_upload_status(value: object) -> str:
    normalized = str(value or "uploading").strip().lower()
    if normalized in {"not_started", "queued", "uploading", "processing", "complete", "error"}:
        return normalized
    return "uploading"


def _normalize_video_upload_progress_meta(meta: object, occurred_at: datetime | None = None) -> dict[str, object] | None:
    if not isinstance(meta, dict):
        return None

    session_id = str(meta.get("session_id") or "").strip()
    source = _normalize_video_source(meta.get("source"))
    uploaded_bytes = _coerce_non_negative_int(meta.get("uploaded_bytes"))
    total_bytes = _coerce_non_negative_int(meta.get("total_bytes"))
    if total_bytes > 0 and uploaded_bytes > total_bytes:
        uploaded_bytes = total_bytes

    progress_percent = meta.get("progress_percent")
    if progress_percent in (None, "") and total_bytes > 0:
        progress_percent = (uploaded_bytes / total_bytes) * 100
    normalized_status = _normalize_video_upload_status(meta.get("status"))
    normalized_percent = _clamp_progress_percent(progress_percent, default=0)

    if normalized_status == "complete":
        normalized_percent = 100
    elif normalized_status in {"uploading", "processing"}:
        normalized_percent = min(99, normalized_percent)

    created_at = meta.get("created_at")
    if not created_at and occurred_at:
        created_at = occurred_at.isoformat()

    return {
        "session_id": session_id,
        "source": source,
        "uploaded_bytes": uploaded_bytes,
        "total_bytes": total_bytes,
        "progress_percent": normalized_percent,
        "status": normalized_status,
        "created_at": created_at,
    }


def _expected_video_sources(attempt: Attempt) -> list[str]:
    if not attempt.exam:
        return []

    requirements = get_proctoring_requirements(exam_proctoring(attempt.exam))
    sources: list[str] = []
    if requirements.get("camera_required"):
        sources.append("camera")
    if requirements.get("screen_required"):
        sources.append("screen")
    return sources


def _build_attempt_video_upload_summary(
    attempt: Attempt,
    *,
    saved_by_source: Mapping[str, dict[str, object]] | None = None,
    progress_by_source: Mapping[str, dict[str, object]] | None = None,
) -> dict[str, object]:
    saved_items = dict(saved_by_source or {})
    progress_items = dict(progress_by_source or {})
    required_sources = _expected_video_sources(attempt)
    available_sources = set(required_sources) | set(saved_items.keys()) | set(progress_items.keys())
    ordered_sources = [source for source in ("camera", "screen") if source in available_sources]
    ordered_sources.extend(sorted(source for source in available_sources if source not in {"camera", "screen"}))

    source_summaries: list[dict[str, object]] = []
    for source in ordered_sources:
        saved_item = saved_items.get(source)
        progress_item = progress_items.get(source)
        if saved_item and _saved_video_meta_is_valid(saved_item):
            size = _coerce_non_negative_int(saved_item.get("size"))
            source_summaries.append({
                "source": source,
                "label": source.title(),
                "session_id": str(saved_item.get("session_id") or ""),
                "progress_percent": 100,
                "remaining_percent": 0,
                "status": "complete",
                "uploaded_bytes": size,
                "total_bytes": size,
                "has_saved_video": True,
            })
            continue
        if saved_item:
            size = _coerce_non_negative_int(saved_item.get("size"))
            source_summaries.append({
                "source": source,
                "label": source.title(),
                "session_id": str(saved_item.get("session_id") or ""),
                "progress_percent": 100 if size > 0 else 0,
                "remaining_percent": 0 if size > 0 else 100,
                "status": "error",
                "uploaded_bytes": size,
                "total_bytes": size,
                "has_saved_video": False,
            })
            continue

        progress_percent = _clamp_progress_percent(progress_item.get("progress_percent") if progress_item else 0, default=0)
        status = _normalize_video_upload_status(progress_item.get("status") if progress_item else "not_started")
        if status in {"uploading", "processing"}:
            progress_percent = min(99, progress_percent)
        if status == "complete":
            progress_percent = 100

        source_summaries.append({
            "source": source,
            "label": source.title(),
            "session_id": str(progress_item.get("session_id") or "") if progress_item else "",
            "progress_percent": progress_percent,
            "remaining_percent": max(0, 100 - progress_percent),
            "status": status,
            "uploaded_bytes": _coerce_non_negative_int(progress_item.get("uploaded_bytes")) if progress_item else 0,
            "total_bytes": _coerce_non_negative_int(progress_item.get("total_bytes")) if progress_item else 0,
            "has_saved_video": False,
        })

    upload_percent = (
        int(round(sum(int(item["progress_percent"]) for item in source_summaries) / len(source_summaries)))
        if source_summaries else 0
    )
    remaining_percent = max(0, 100 - upload_percent)
    failed = any(item["status"] == "error" for item in source_summaries)
    uploading = any(item["status"] in {"queued", "uploading", "processing"} for item in source_summaries)
    has_video = any(bool(item["has_saved_video"]) for item in source_summaries)
    completed_sources = [item["source"] for item in source_summaries if item["status"] == "complete"]
    all_required_uploaded = bool(required_sources) and all(source in completed_sources for source in required_sources)

    if source_summaries and len(completed_sources) == len(source_summaries):
        summary_status = "complete"
        status_label = "Upload complete"
    elif failed:
        summary_status = "error"
        status_label = "Upload failed"
    elif uploading or upload_percent > 0:
        summary_status = "uploading"
        status_label = "Uploading in background"
    elif attempt.status in {AttemptStatus.SUBMITTED, AttemptStatus.GRADED}:
        summary_status = "waiting"
        status_label = "Waiting to upload"
    else:
        summary_status = "not_started"
        status_label = "Not started"

    return {
        "attempt_id": str(attempt.id),
        "has_video": has_video,
        "saved_video_count": len(completed_sources),
        "required_sources": required_sources,
        "completed_sources": completed_sources,
        "upload_percent": upload_percent,
        "remaining_percent": remaining_percent,
        "uploading": uploading and not all_required_uploaded,
        "all_required_uploaded": all_required_uploaded,
        "status": summary_status,
        "status_label": status_label,
        "sources": source_summaries,
    }


def _read_cached_exam_video_upload_status(exam_id: str) -> list[dict[str, object]] | None:
    return _video_upload_status_cache.read(exam_id)


def _write_cached_exam_video_upload_status(exam_id: str, rows: list[dict[str, object]]) -> None:
    _video_upload_status_cache.write(exam_id, rows)


def _find_saved_video_file_info(db: Session, attempt_id: str, session_id: str, source: str) -> dict[str, object] | None:
    normalized_source = _normalize_video_source(source)
    for event in _saved_video_events(db, attempt_id):
        info = _normalize_saved_video_meta(event.meta, event.occurred_at)
        if not info:
            continue
        if str(info.get("session_id") or "") == session_id and _normalize_video_source(info.get("source")) == normalized_source:
            return info
    return None


def _candidate_recovery_filenames(attempt_id: str, session_id: str, source: str, preferred_filename: str | None = None) -> list[str]:
    candidates: list[str] = []
    normalized_preferred = Path(str(preferred_filename or "").strip()).name
    if normalized_preferred:
        candidates.append(normalized_preferred)
    for extension in ("webm", "mp4"):
        candidate = _video_filename(attempt_id, session_id, source, extension)
        if candidate not in candidates:
            candidates.append(candidate)
    return candidates


async def _recover_missing_cloudflare_videos(db: Session, attempt_id: str) -> None:
    provider = str(settings.PROCTORING_VIDEO_STORAGE_PROVIDER or "").strip().lower()
    if provider != "cloudflare" or not cloudflare_video_storage_enabled():
        return

    saved_keys = {
        (
            str(item.get("session_id") or ""),
            _normalize_video_source(item.get("source")),
        )
        for item in (
            _normalize_saved_video_meta(event.meta, event.occurred_at)
            for event in _saved_video_events(db, attempt_id)
        )
        if item
    }
    progress_events = _video_upload_progress_events(db, attempt_id)
    latest_progress_by_key: dict[tuple[str, str], dict[str, object]] = {}
    for event in progress_events:
        item = _normalize_video_upload_progress_meta(event.meta, event.occurred_at)
        if not item:
            continue
        session_id = str(item.get("session_id") or "").strip()
        if not session_id:
            continue
        source = _normalize_video_source(item.get("source"))
        key = (session_id, source)
        if key in latest_progress_by_key:
            continue
        latest_progress_by_key[key] = item

    recovered_any = False
    for (session_id, source), progress_item in latest_progress_by_key.items():
        if (session_id, source) in saved_keys:
            continue

        status = _normalize_video_upload_status(progress_item.get("status"))
        progress_percent = _clamp_progress_percent(progress_item.get("progress_percent"), default=0)
        if status not in {"processing", "error", "complete"} and progress_percent < 90:
            continue

        filename = str(progress_item.get("filename") or "").strip()
        total_bytes = _coerce_non_negative_int(progress_item.get("total_bytes"))
        recovered_info: dict[str, object] | None = None
        for candidate_filename in _candidate_recovery_filenames(attempt_id, session_id, source, filename):
            try:
                remote_info = await get_cloudflare_video_details(
                    filename=candidate_filename,
                    source=source,
                    fallback_size=total_bytes,
                )
            except Exception as exc:
                logger.warning(
                    "Failed to reconcile Cloudflare video for attempt %s source %s filename %s: %s",
                    attempt_id,
                    source,
                    candidate_filename,
                    exc,
                )
                continue

            if not remote_info or not str(remote_info.get("url") or "").strip():
                continue

            recovered_payload = {
                **remote_info,
                "provider": "cloudflare",
                "session_id": session_id,
                "source": source,
                "size": int(remote_info.get("size") or total_bytes or 0),
            }
            recovered_info = _build_registered_video_info(
                attempt_id,
                recovered_payload,
                session_id=session_id,
                source=source,
            )
            break

        if not recovered_info:
            continue

        event = ProctoringEvent(
            attempt_id=attempt_id,
            event_type="VIDEO_SAVED",
            severity=SeverityEnum.LOW,
            detail=f"Proctoring {source} video recovered",
            meta=recovered_info,
            occurred_at=datetime.now(timezone.utc),
        )
        db.add(event)
        saved_keys.add((session_id, source))
        recovered_any = True

    if recovered_any:
        db.commit()


_VIDEO_BATCH_EVENT_TYPES = (
    "VIDEO_BATCH_ANALYSIS_QUEUED",
    "VIDEO_BATCH_ANALYSIS_COMPLETED",
    "VIDEO_BATCH_ANALYSIS_FAILED",
)
_PROCTORING_SUMMARY_EXCLUDED_EVENT_TYPES = {
    "ATTEMPT_PAUSED",
    "ATTEMPT_RESUMED",
    "CERTIFICATE_REVIEW_APPROVED",
    "CERTIFICATE_REVIEW_REJECTED",
    "FACE_REAPPEARED",
    "FACE_MATCH_RECOVERED",
}


def _build_video_job_status_url(attempt_id: str, job_id: str) -> str:
    return f"/api/proctoring/{attempt_id}/jobs/{job_id}/status"


def _normalize_video_batch_meta(meta: object, occurred_at: datetime | None = None) -> dict[str, object] | None:
    if not isinstance(meta, dict):
        return None
    job_id = str(meta.get("job_id") or "").strip()
    if not job_id:
        return None
    summary = dict(meta.get("summary") or {}) if isinstance(meta.get("summary"), dict) else {}
    file_info = dict(meta.get("file") or {}) if isinstance(meta.get("file"), dict) else None
    normalized = {
        "job_id": job_id,
        "status": str(meta.get("status") or "QUEUED").strip().upper() or "QUEUED",
        "detail": str(meta.get("detail") or "").strip(),
        "session_id": str(meta.get("session_id") or summary.get("session_id") or (file_info or {}).get("session_id") or "").strip(),
        "source": _normalize_video_source(meta.get("source") or summary.get("source") or (file_info or {}).get("source")),
        "analysis_status_url": str(meta.get("analysis_status_url") or "").strip(),
        "completed_at": meta.get("completed_at") or (occurred_at.isoformat() if occurred_at else None),
        "findings": list(meta.get("findings") or []),
        "summary": summary,
        "file": file_info,
    }
    return normalized


def _find_video_batch_info(db: Session, attempt_id: str, session_id: str, source: str) -> dict[str, object] | None:
    normalized_source = _normalize_video_source(source)
    events = db.scalars(
        select(ProctoringEvent)
        .where(
            ProctoringEvent.attempt_id == parse_uuid_param(attempt_id, detail=_t("attempt_not_found")),
            ProctoringEvent.event_type.in_(_VIDEO_BATCH_EVENT_TYPES),
        )
        .order_by(ProctoringEvent.occurred_at.desc())
    ).all()
    for event in events:
        info = _normalize_video_batch_meta(event.meta, event.occurred_at)
        if not info:
            continue
        if str(info.get("session_id") or "") == str(session_id or "").strip() and _normalize_video_source(info.get("source")) == normalized_source:
            return info
    return None


def _find_video_batch_info_by_job_id(db: Session, attempt_id: str, job_id: str) -> dict[str, object] | None:
    events = db.scalars(
        select(ProctoringEvent)
        .where(
            ProctoringEvent.attempt_id == parse_uuid_param(attempt_id, detail=_t("attempt_not_found")),
            ProctoringEvent.event_type.in_(_VIDEO_BATCH_EVENT_TYPES),
        )
        .order_by(ProctoringEvent.occurred_at.desc())
    ).all()
    for event in events:
        info = _normalize_video_batch_meta(event.meta, event.occurred_at)
        if info and str(info.get("job_id") or "") == str(job_id or "").strip():
            return info
    return None


def _queue_video_batch_event(
    db: Session,
    *,
    attempt_id: str,
    file_info: dict[str, object],
    job_info: dict[str, object],
) -> None:
    meta = {
        **job_info,
        "session_id": str(file_info.get("session_id") or ""),
        "source": _normalize_video_source(file_info.get("source")),
        "file": file_info,
    }
    event = ProctoringEvent(
        attempt_id=attempt_id,
        event_type="VIDEO_BATCH_ANALYSIS_QUEUED",
        severity=SeverityEnum.LOW,
        detail=f"Batch analysis queued for {_normalize_video_source(file_info.get('source')).title()} recording",
        meta=meta,
        occurred_at=datetime.now(timezone.utc),
    )
    db.add(event)
    db.commit()


async def _build_video_upload_response(
    attempt_id: str,
    *,
    detail: str,
    file_info: dict[str, object],
    job_info: dict[str, object] | None = None,
    status_code: int = 200,
) -> JSONResponse:
    payload: dict[str, object] = {
        "detail": detail,
        "file": await _hydrate_video_file_info(file_info),
    }
    if job_info:
        payload["job_id"] = str(job_info.get("job_id") or "")
        payload["status"] = str(job_info.get("status") or "QUEUED").upper()
        payload["analysis_status_url"] = (
            str(job_info.get("analysis_status_url") or "").strip()
            or _build_video_job_status_url(attempt_id, str(job_info.get("job_id") or ""))
        )
    return JSONResponse(status_code=status_code, content=payload)


def _build_registered_video_info(
    attempt_id: str,
    payload: Mapping[str, object] | None,
    *,
    session_id: str,
    source: str,
) -> dict[str, object]:
    raw = dict(payload or {})
    remote = raw.get("remote")
    remote = remote if isinstance(remote, dict) else {}
    provider = str(raw.get("provider") or remote.get("provider") or _video_storage_provider()).strip().lower()
    if provider and provider != "cloudflare":
        raise HTTPException(status_code=400, detail=_t("provider_must_be_cloudflare"))

    name = str(raw.get("name") or remote.get("name") or "").strip()
    if not name:
        extension = str(raw.get("extension") or "webm").replace(".", "").lower() or "webm"
        name = _video_filename(attempt_id, session_id, source, extension)

    created_at = raw.get("created_at") or remote.get("created_at") or remote.get("created")
    if not created_at:
        created_at = datetime.now(timezone.utc).isoformat()

    recording_started_at = _normalize_iso_datetime(raw.get("recording_started_at"))
    recording_stopped_at = _normalize_iso_datetime(raw.get("recording_stopped_at"))

    playback_url = str(raw.get("playback_url") or raw.get("url") or remote.get("playback_url") or remote.get("url") or "").strip()
    uid = str(raw.get("uid") or remote.get("uid") or "").strip()
    if not playback_url:
        raise HTTPException(status_code=400, detail=_t("playback_url_required"))
    if not _is_absolute_http_url(playback_url):
        raise HTTPException(status_code=400, detail=_t("playback_url_invalid"))

    playback_type = str(raw.get("playback_type") or "").strip().lower()
    if not playback_type:
        playback_type = "hls" if playback_url.endswith(".m3u8") else "direct"

    status = str(raw.get("status") or remote.get("status") or "").strip().lower()
    ready_to_stream = infer_cloudflare_ready_to_stream(
        status=status,
        ready_to_stream=raw.get("ready_to_stream", remote.get("ready_to_stream")),
        playback_url=playback_url,
    )

    file_info = {
        "provider": "cloudflare",
        "name": name,
        "url": playback_url,
        "playback_url": playback_url,
        "playback_type": playback_type,
        "size": int(raw.get("size") or remote.get("size") or 0),
        "source": source,
        "session_id": session_id,
        "created_at": created_at,
        "ready_to_stream": bool(ready_to_stream),
        "status": status or ("ready" if ready_to_stream else "processing"),
    }

    thumbnail = raw.get("thumbnail") or remote.get("thumbnail")
    duration = raw.get("duration") or remote.get("duration")
    if uid:
        file_info["uid"] = uid
    if thumbnail:
        file_info["thumbnail"] = thumbnail
    if duration not in (None, ""):
        file_info["duration"] = duration
    if recording_started_at:
        file_info["recording_started_at"] = recording_started_at
    if recording_stopped_at:
        file_info["recording_stopped_at"] = recording_stopped_at
    if remote:
        file_info["remote"] = remote
    return file_info


async def _build_supabase_video_info(
    attempt_id: str,
    *,
    session_id: str,
    source: str,
    filename: str,
    content: bytes,
    content_type: str,
    recording_started_at: str | None,
    recording_stopped_at: str | None,
) -> dict[str, object]:
    safe_filename = Path(filename).name
    if not safe_filename:
        raise HTTPException(status_code=400, detail=_t("valid_video_filename_required"))

    try:
        uploaded = await upload_bytes_to_supabase(
            "videos",
            safe_filename,
            bytes(content or b""),
            content_type=content_type or "application/octet-stream",
        )
    except Exception as exc:
        logger.exception("Supabase video upload failed for attempt %s", attempt_id)
        raise HTTPException(status_code=502, detail=_t("supabase_upload_failed")) from exc

    playback_url = str(uploaded.get("url") or "").strip()
    object_path = str(uploaded.get("path") or "").strip()
    if not playback_url and not object_path:
        raise HTTPException(status_code=502, detail=_t("supabase_no_file_ref"))

    return {
        "provider": "supabase",
        "name": str(uploaded.get("name") or safe_filename),
        "path": object_path,
        "url": playback_url,
        "playback_url": playback_url,
        "playback_type": "direct",
        "size": int(uploaded.get("size") or len(content or b"")),
        "source": _normalize_video_source(source),
        "session_id": session_id,
        "created_at": str(uploaded.get("created_at") or datetime.now(timezone.utc).isoformat()),
        "ready_to_stream": True,
        "status": "ready",
        "recording_started_at": recording_started_at,
        "recording_stopped_at": recording_stopped_at,
        "bucket": uploaded.get("bucket"),
    }


async def _build_vimeo_video_info(
    attempt_id: str,
    *,
    session_id: str,
    source: str,
    filename: str,
    file_path: Path,
    recording_started_at: str | None,
    recording_stopped_at: str | None,
) -> dict[str, object]:
    safe_filename = Path(filename).name
    if not safe_filename:
        raise HTTPException(status_code=400, detail=_t("valid_video_filename_required"))

    try:
        remote = await upload_video_to_vimeo(
            file_path,
            filename=safe_filename,
            source=_normalize_video_source(source),
        )
    except Exception as exc:
        logger.exception("Vimeo video upload failed for attempt %s", attempt_id)
        raise HTTPException(status_code=502, detail=_t("vimeo_upload_failed")) from exc

    playback_url = str(remote.get("playback_url") or remote.get("url") or "").strip()
    if not playback_url:
        raise HTTPException(status_code=502, detail=_t("vimeo_no_playback_url"))

    fallback_size = file_path.stat().st_size if file_path.exists() else 0
    file_info: dict[str, object] = {
        "provider": "vimeo",
        "name": str(remote.get("name") or safe_filename),
        "uid": remote.get("uid"),
        "uri": remote.get("uri"),
        "hash": remote.get("hash"),
        "url": playback_url,
        "playback_url": playback_url,
        "playback_type": "vimeo_embed",
        "thumbnail": remote.get("thumbnail"),
        "size": int(remote.get("size") or fallback_size),
        "source": _normalize_video_source(source),
        "session_id": session_id,
        "created_at": str(remote.get("created_at") or datetime.now(timezone.utc).isoformat()),
        "ready_to_stream": bool(remote.get("ready_to_stream")),
        "status": str(remote.get("status") or "processing"),
        "duration": remote.get("duration"),
        "recording_started_at": recording_started_at,
        "recording_stopped_at": recording_stopped_at,
        "remote": remote.get("remote") if isinstance(remote.get("remote"), dict) else remote,
    }
    return {key: value for key, value in file_info.items() if value not in (None, "")}


def _normalize_iso_datetime(value: object) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        normalized = raw.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_t("invalid_recording_timestamp")) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _load_integrations_config(db: Session) -> dict:
    config_row = db.scalar(select(SystemSettings).where(SystemSettings.key == "integrations_config"))
    if not config_row or not config_row.value:
        return {}
    try:
        return json.loads(config_row.value)
    except Exception:
        return {}


async def _save_evidence(attempt_id: str, frame_bytes: bytes, event_type: str) -> str | None:
    """Save screenshot evidence for proctoring events."""
    import secrets
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
    token = secrets.token_hex(8)
    filename = f"{attempt_id}_{event_type}_{ts}_{token}.jpg"
    if settings.MEDIA_STORAGE_PROVIDER == "supabase":
        await upload_bytes_to_supabase("evidence", filename, frame_bytes, content_type="image/jpeg")
        return f"/api/media/evidence/{filename}"

    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    filepath = EVIDENCE_DIR / filename
    filepath.write_bytes(frame_bytes)
    return f"/api/media/evidence/{filename}"


def _attempt_or_forbidden(attempt_id: str, db: Session, current):
    attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    attempt = db.scalars(
        select(Attempt)
        .options(
            load_only(
                Attempt.id,
                Attempt.exam_id,
                Attempt.user_id,
                Attempt.status,
                Attempt.started_at,
                Attempt.precheck_passed_at,
                Attempt.face_signature,
            ),
            joinedload(Attempt.user).load_only(User.id, User.name),
            joinedload(Attempt.exam).load_only(Exam.id, Exam.title, Exam.proctoring_config),
        )
        .where(Attempt.id == attempt_pk)
    ).unique().first()
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    if current.role == RoleEnum.LEARNER and attempt.user_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))
    if current.role != RoleEnum.LEARNER:
        ensure_permission(db, current, "View Attempt Analysis")
    return attempt


def _event_label(event_type: str) -> str:
    return str(event_type or "alert").replace("_", " ").title()


def _action_label(action: str) -> str:
    labels = {
        "FLAG_REVIEW": "Flag for review",
        "WARN": "Warn learner",
        "AUTO_SUBMIT": "Auto-submit exam",
    }
    return labels.get(str(action or "").upper(), "Warn learner")


async def _write_video_upload_to_temp_file(request: Request, *, suffix: str) -> tuple[Path, int]:
    upload_limit_bytes = settings.MAX_VIDEO_UPLOAD_MB * 1024 * 1024
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    temp_path = Path(temp_file.name)
    total_size = 0

    try:
        async for chunk in request.stream():
            if not chunk:
                continue
            total_size += len(chunk)
            if total_size > upload_limit_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=_t("video_upload_exceeds_limit", limit_mb=settings.MAX_VIDEO_UPLOAD_MB),
                )
            temp_file.write(chunk)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    finally:
        temp_file.close()

    if total_size == 0:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=_t("empty_video_upload"))

    return temp_path, total_size


async def _write_video_upload_to_spool_file(request: Request, *, suffix: str) -> tuple[Path, int]:
    upload_limit_bytes = settings.MAX_VIDEO_UPLOAD_MB * 1024 * 1024
    VIDEO_UPLOAD_SPOOL_DIR.mkdir(parents=True, exist_ok=True)
    spool_path = (VIDEO_UPLOAD_SPOOL_DIR / f"{uuid4().hex}{suffix}").resolve()
    total_size = 0

    try:
        with spool_path.open("wb") as spool_file:
            async for chunk in request.stream():
                if not chunk:
                    continue
                total_size += len(chunk)
                if total_size > upload_limit_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail=_t("video_upload_exceeds_limit", limit_mb=settings.MAX_VIDEO_UPLOAD_MB),
                    )
                spool_file.write(chunk)
    except Exception:
        spool_path.unlink(missing_ok=True)
        raise

    if total_size == 0:
        spool_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=_t("empty_video_upload"))

    return spool_path, total_size


def _ping_event_detail(event_type: str) -> str:
    details = {
        "FOCUS_LOSS": "Test window lost focus or became hidden",
        "FULLSCREEN_EXIT": "Fullscreen mode was exited during the test",
        "CAMERA_COVERED": "Camera view is blocked or too dark",
    }
    return details.get(event_type, f"{_event_label(event_type)} detected")


def _ping_event_meta(*, focus: bool, visibility: str, blurs: int, fullscreen: bool, camera_dark: bool) -> dict[str, object]:
    return {
        "focus": bool(focus),
        "visibility": str(visibility),
        "blurs": int(blurs),
        "fullscreen": bool(fullscreen),
        "camera_dark": bool(camera_dark),
        "source": "client_ping",
    }


def _runtime_proctoring_enabled(exam_cfg: Mapping[str, object] | None, requirements: Mapping[str, bool]) -> bool:
    config = exam_cfg or {}
    return bool(
        config.get("face_detection")
        or config.get("multi_face")
        or config.get("audio_detection")
        or config.get("object_detection")
        or config.get("eye_tracking")
        or config.get("head_pose_detection")
        or config.get("mouth_detection")
        or config.get("tab_switch_detect")
        or requirements.get("camera_required")
        or requirements.get("mic_required")
        or requirements.get("fullscreen_required")
        or requirements.get("lighting_required")
        or requirements.get("screen_required")
        or requirements.get("identity_required")
        or bool(config.get("alert_rules"))
    )


def _is_serious_alert(raw_severity: str | None, severity: SeverityEnum) -> bool:
    return str(raw_severity or getattr(severity, "value", severity) or "").upper() in {"HIGH", "CRITICAL"}


def _release_db_session(db: Session) -> None:
    with contextlib.suppress(Exception):
        db.close()


def _notify_admin_monitors_for_event(db: Session, attempt: Attempt, event: ProctoringEvent) -> None:
    occurred_at = event.occurred_at or datetime.now(timezone.utc)
    event_type = event.event_type or "UNKNOWN"
    exam_title = attempt.exam.title if attempt.exam else "Exam"
    link = f"/admin/attempt-analysis?id={attempt.id}"
    title = f"Proctoring Alert: {_event_label(event_type)}"
    message = f"High-severity proctoring event on '{exam_title}': {event.detail or _event_label(event_type)}"
    logger.warning("High-severity proctoring event for attempt %s: %s", attempt.id, message)
    owner_id = attempt.exam.created_by_id if attempt.exam else None
    if not owner_id:
        logger.debug("No exam owner found for attempt %s; skipping admin notification", attempt.id)
        return
    admin_ids = [owner_id]
    for admin_id in admin_ids:
        existing = db.scalar(
            select(Notification.id)
            .where(
                Notification.user_id == admin_id,
                Notification.title == title,
                Notification.link == link,
                Notification.created_at >= occurred_at - ADMIN_PROCTORING_NOTIFICATION_WINDOW,
            )
            .limit(1)
        )
        if existing:
            continue
        notify_user(db, admin_id, title, message, link)


def _handle_serious_proctoring_event(db: Session, attempt: Attempt, event: ProctoringEvent) -> None:
    if event.severity != SeverityEnum.HIGH:
        return
    notify_proctoring_event(
        db,
        attempt.id,
        {
            "event_type": event.event_type,
            "detail": event.detail or "A proctoring event was detected.",
        },
    )
    _notify_admin_monitors_for_event(db, attempt, event)


def _auto_submit_attempt(
    db: Session,
    attempt: Attempt,
    *,
    violation_count: int,
    reason: str,
    occurred_at: datetime | None = None,
    actor_user_id=None,
    request_ip: str | None = None,
) -> None:
    timestamp = occurred_at or datetime.now(timezone.utc)
    from ...db.session import SessionLocal
    from ..attempts.routes_public import _auto_score_attempt, _invalidate_attempt_list_cache

    should_notify = False
    exam_title = attempt.exam.title if attempt.exam else "Exam"

    with SessionLocal() as submit_db:
        fresh_attempt = submit_db.scalar(
            select(Attempt)
            .where(Attempt.id == attempt.id)
            .with_for_update()
        )
        if not fresh_attempt:
            return

        should_notify = fresh_attempt.status not in {AttemptStatus.SUBMITTED, AttemptStatus.GRADED}
        should_score = should_notify or (
            fresh_attempt.status == AttemptStatus.SUBMITTED and fresh_attempt.score is None
        )

        if should_notify:
            fresh_attempt.status = AttemptStatus.SUBMITTED
            fresh_attempt.submitted_at = timestamp
        elif fresh_attempt.submitted_at is None and fresh_attempt.status == AttemptStatus.SUBMITTED:
            fresh_attempt.submitted_at = timestamp

        if should_score:
            try:
                score_result = _auto_score_attempt(fresh_attempt, submit_db)
                if score_result.get("score") is not None:
                    fresh_attempt.score = score_result["score"]
                    fresh_attempt.grade = score_result.get("grade")
            except Exception as score_err:
                logger.warning("Auto-score failed during forced submit for attempt %s: %s", fresh_attempt.id, score_err)

        if should_notify or should_score:
            submit_db.add(fresh_attempt)
            submit_db.commit()
            submit_db.refresh(fresh_attempt)
            _invalidate_attempt_list_cache()

        attempt.status = fresh_attempt.status
        attempt.submitted_at = fresh_attempt.submitted_at
        attempt.score = fresh_attempt.score
        attempt.grade = fresh_attempt.grade
        if fresh_attempt.exam and fresh_attempt.exam.title:
            exam_title = fresh_attempt.exam.title

        if not should_notify:
            return

        notify_user(
            submit_db,
            fresh_attempt.user_id,
            "Exam Auto-Submitted",
            f"Your attempt for '{exam_title}' was auto-submitted due to multiple proctoring violations.",
            f"/attempts/{fresh_attempt.id}",
        )
        try:
            write_audit_log(
                submit_db,
                actor_user_id,
                "ATTEMPT_AUTO_SUBMITTED",
                "attempt",
                str(fresh_attempt.id),
                f"Auto-submitted due to {violation_count} violations. {reason}".strip(),
                request_ip,
            )
        except Exception as exc:
            logger.warning("Failed to write auto-submit audit log for attempt %s: %s", fresh_attempt.id, exc)


def _load_attempt_events(db: Session, attempt_id) -> list[ProctoringEvent]:
    return db.scalars(
        select(ProctoringEvent)
        .where(ProctoringEvent.attempt_id == attempt_id)
        .order_by(ProctoringEvent.occurred_at)
    ).all()


def _load_attempt_events_since(
    db: Session,
    attempt_id,
    *,
    since: datetime,
    event_types: set[str] | None = None,
) -> list[ProctoringEvent]:
    query = (
        select(ProctoringEvent)
        .where(
            ProctoringEvent.attempt_id == attempt_id,
            ProctoringEvent.occurred_at >= since,
        )
        .order_by(ProctoringEvent.occurred_at)
    )
    if event_types:
        query = query.where(ProctoringEvent.event_type.in_(sorted(event_types)))
    return db.scalars(query).all()


def _is_summary_alert_event(event_type: str | None) -> bool:
    normalized = str(event_type or "").strip().upper()
    if not normalized:
        return False
    if normalized.startswith("VIDEO_"):
        return False
    return normalized not in _PROCTORING_SUMMARY_EXCLUDED_EVENT_TYPES


def _saved_recordings_by_source(events: list[ProctoringEvent]) -> dict[str, ProctoringEvent]:
    saved: dict[str, ProctoringEvent] = {}
    for event in sorted(events, key=lambda item: item.occurred_at or datetime.min.replace(tzinfo=timezone.utc), reverse=True):
        if str(event.event_type or "").strip().upper() != "VIDEO_SAVED":
            continue
        if not _saved_video_meta_is_valid(event.meta):
            continue
        source = _normalize_video_source((event.meta or {}).get("source"))
        if source not in saved:
            saved[source] = event
    return saved


def _build_attempt_proctoring_summary(attempt: Attempt, events: list[ProctoringEvent]) -> dict[str, object]:
    filtered_events = [event for event in events if _is_summary_alert_event(event.event_type)]
    severity_counts = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
    for event in filtered_events:
        severity = getattr(event.severity, "value", str(event.severity or "LOW"))
        severity_counts[severity] = severity_counts.get(severity, 0) + 1

    saved_recordings = _saved_recordings_by_source(events)
    recent_events = sorted(
        filtered_events,
        key=lambda item: item.occurred_at or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )[:5]
    expected_recordings = len(_expected_video_sources(attempt))

    return {
        "total_events": len(filtered_events),
        "severity_counts": severity_counts,
        "serious_alerts": int(severity_counts.get("HIGH", 0) + severity_counts.get("MEDIUM", 0)),
        "risk_score": int(
            severity_counts.get("HIGH", 0) * 3
            + severity_counts.get("MEDIUM", 0) * 2
            + severity_counts.get("LOW", 0)
        ),
        "saved_recordings": len(saved_recordings),
        "expected_recordings": expected_recordings,
        "recent_events": recent_events,
    }


AUTO_SUBMIT_EXCLUDED_EVENT_TYPES = {
    "VIDEO_SAVED", "VIDEO_UPLOADED", "FACE_REAPPEARED",
    "ATTEMPT_PAUSED", "ATTEMPT_RESUMED",
    "SCREEN_SHARE_LOST",  # browser fullscreen ↔ screen-share conflict, not cheating
    "TAB_SWITCH",         # browser fires spurious blur events during screen share
}


# Ignore low-confidence AI detections when deciding whether to auto-submit. A
# degraded/unavailable model that slips through and emits noisy detections should
# never be able to force-submit a real student. Deterministic browser events
# (fullscreen exit, etc.) carry no ai_confidence and always count.
AUTO_SUBMIT_MIN_CONFIDENCE = 0.6


def _count_auto_submit_alerts(events: list[ProctoringEvent]) -> int:
    count = 0
    for event in events:
        if event.event_type in AUTO_SUBMIT_EXCLUDED_EVENT_TYPES:
            continue
        confidence = event.ai_confidence
        if confidence is not None and confidence < AUTO_SUBMIT_MIN_CONFIDENCE:
            # Unreliable AI detection (e.g. from a degraded detector) — don't let
            # it count toward force-submitting the attempt.
            continue
        count += 1
    return count


def _maybe_auto_submit_from_history(
    db: Session,
    attempt: Attempt,
    exam_cfg: Mapping[str, object] | None,
    history_events: list[ProctoringEvent],
    *,
    occurred_at: datetime,
    request_ip: str | None = None,
    violation_score: float | int | None = None,
) -> str | None:
    if attempt.status == AttemptStatus.SUBMITTED:
        return None

    config = exam_cfg if isinstance(exam_cfg, Mapping) else {}
    max_auto = config.get("max_alerts_before_autosubmit")
    max_score = config.get("max_score_before_autosubmit")
    violation_count = _count_auto_submit_alerts(history_events)

    auto_by_count = bool(max_auto and violation_count >= int(max_auto))
    auto_by_score = bool(max_score and violation_score is not None and float(violation_score) >= float(max_score))
    if not auto_by_count and not auto_by_score:
        return None

    reason = (
        f"Auto-submitted due to {violation_count} proctoring alerts"
        if auto_by_count
        else f"Auto-submitted due to risk score {float(violation_score):.2f}"
    )
    _auto_submit_attempt(
        db,
        attempt,
        violation_count=violation_count,
        reason=reason,
        occurred_at=occurred_at,
        request_ip=request_ip,
    )
    return reason


def _latest_event_of_type(events: list[ProctoringEvent], event_type: str) -> ProctoringEvent | None:
    for event in reversed(events):
        if event.event_type == event_type:
            return event
    return None


def _rule_already_triggered(events: list[ProctoringEvent], rule_id: str) -> bool:
    for event in reversed(events):
        meta = event.meta if isinstance(event.meta, Mapping) else {}
        if event.event_type == "ALERT_RULE_TRIGGERED" and meta.get("rule_id") == rule_id:
            return True
    return False


def _build_rule_detail(rule: Mapping[str, object], event_type: str, actual_count: int) -> str:
    message = rule.get("message")
    if isinstance(message, str) and message.strip():
        return message.strip()
    conditions = rule.get("conditions")
    if isinstance(conditions, list) and len(conditions) > 0:
        cond_labels = [
            f"{_event_label(str(c.get('event_type', '?')))} >= {c.get('threshold', 1)}"
            for c in conditions if isinstance(c, Mapping)
        ]
        window = rule.get("window_seconds")
        window_str = f" within {int(window)}s" if window else ""
        return (
            f"Compound rule triggered: {' AND '.join(cond_labels)}{window_str}. "
            f"Action: {_action_label(str(rule.get('action') or 'WARN'))}."
        )
    return (
        f"{_event_label(event_type)} reached {actual_count} occurrence(s). "
        f"Action: {_action_label(str(rule.get('action') or 'WARN'))}."
    )


def _apply_alert_rules(
    db: Session,
    attempt: Attempt,
    exam_cfg: Mapping[str, object] | None,
    source_event: ProctoringEvent,
    history_events: list[ProctoringEvent],
    occurred_at: datetime,
    *,
    actor_user_id=None,
    request_ip: str | None = None,
) -> dict[str, object]:
    rules = exam_cfg.get("alert_rules") if isinstance(exam_cfg, Mapping) else []
    if attempt.status != AttemptStatus.IN_PROGRESS or not isinstance(rules, list):
        return {"alerts": [], "forced_submit": False, "submit_reason": None, "created_events": []}

    matching_count = sum(1 for event in history_events if event.event_type == source_event.event_type)
    alerts: list[dict[str, object]] = []
    created_events: list[ProctoringEvent] = []
    forced_submit = False
    submit_reason = None

    for rule in rules:
        if not isinstance(rule, Mapping):
            continue

        # ── AND-logic rules: require multiple conditions to ALL be met ──
        conditions = rule.get("conditions")
        if isinstance(conditions, list) and len(conditions) > 0:
            rule_id = str(rule.get("id") or "compound-" + "-".join(
                str(c.get("event_type", "?")) for c in conditions if isinstance(c, Mapping)
            ))
            if _rule_already_triggered(history_events, rule_id):
                continue
            window_sec = float(rule.get("window_seconds", 0))
            all_met = True
            for cond in conditions:
                if not isinstance(cond, Mapping):
                    all_met = False
                    break
                cond_type = str(cond.get("event_type") or "").upper()
                cond_threshold = max(1, int(cond.get("threshold") or 1))
                if window_sec > 0:
                    cutoff = occurred_at - timedelta(seconds=window_sec)
                    cond_count = sum(
                        1 for e in history_events
                        if e.event_type == cond_type
                        and e.occurred_at is not None
                        and e.occurred_at >= cutoff
                    )
                else:
                    cond_count = sum(1 for e in history_events if e.event_type == cond_type)
                if cond_count < cond_threshold:
                    all_met = False
                    break
            if not all_met:
                continue
            # All conditions met — fall through to action handling below
            matching_count = sum(1 for e in history_events if e.event_type == source_event.event_type)
        else:
            # ── Single event_type rule (original logic) ──
            if str(rule.get("event_type") or "").upper() != source_event.event_type:
                continue
            threshold = max(1, int(rule.get("threshold") or 1))
            rule_id = str(rule.get("id") or f"{source_event.event_type}-{threshold}")
            if matching_count < threshold or _rule_already_triggered(history_events, rule_id):
                continue

        action = str(rule.get("action") or "WARN").upper()
        severity_name = str(rule.get("severity") or "MEDIUM").upper()
        severity = SeverityEnum(severity_name if severity_name in {"LOW", "MEDIUM", "HIGH"} else "MEDIUM")
        is_compound = isinstance(rule.get("conditions"), list)
        threshold_val = int(rule.get("threshold") or 1) if not is_compound else 0
        detail = _build_rule_detail(rule, source_event.event_type, matching_count)
        escalation_event = ProctoringEvent(
            attempt_id=attempt.id,
            event_type="ALERT_RULE_TRIGGERED",
            severity=severity,
            detail=detail,
            meta={
                "source": "alert_rule",
                "rule_id": rule_id,
                "rule_action": action,
                "trigger_event_type": source_event.event_type,
                "threshold": threshold_val,
                "actual_count": matching_count,
                **({"conditions": conditions} if is_compound else {}),
            },
            occurred_at=occurred_at,
        )
        db.add(escalation_event)
        history_events.append(escalation_event)
        created_events.append(escalation_event)

        if action in {"WARN", "AUTO_SUBMIT"}:
            alerts.append({
                "event_type": source_event.event_type,
                "severity": severity,
                "detail": detail,
                "action": action,
                "rule_id": rule_id,
                "threshold": threshold_val,
                "actual_count": matching_count,
            })

        if action == "AUTO_SUBMIT" and attempt.status == AttemptStatus.IN_PROGRESS:
            _auto_submit_attempt(
                db,
                attempt,
                violation_count=matching_count,
                reason=detail,
                occurred_at=occurred_at,
                actor_user_id=actor_user_id,
                request_ip=request_ip,
            )
            forced_submit = True
            submit_reason = detail
            break

    return {
        "alerts": alerts,
        "forced_submit": forced_submit,
        "submit_reason": submit_reason,
        "created_events": created_events,
    }


@router.post("/{attempt_id}/ping", response_model=ProctoringPingResponse)
def proctoring_ping(
    attempt_id: str,
    request: Request,
    payload: dict = Body(...),
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    attempt = _attempt_or_forbidden(attempt_id, db, current)
    exam_cfg = exam_proctoring(attempt.exam) if attempt.exam else {}
    requirements = get_proctoring_requirements(exam_cfg)
    if not _runtime_proctoring_enabled(exam_cfg, requirements):
        return {
            "detail": "ok",
            "alerts": [],
            "forced_submit": False,
            "submit_reason": None,
        }
    focus = payload.get("focus", True)
    visibility = payload.get("visibility", "visible")
    blurs = payload.get("blurs", 0)
    fullscreen = payload.get("fullscreen", True)
    camera_dark = bool(payload.get("camera_dark"))
    events = []
    camera_monitoring_enabled = bool(
        requirements["camera_required"]
        or requirements["lighting_required"]
        or requirements["identity_required"]
        or exam_cfg.get("face_detection")
        or exam_cfg.get("multi_face")
    )
    if (not focus or visibility != "visible") and exam_cfg.get("tab_switch_detect"):
        events.append(("FOCUS_LOSS", SeverityEnum.MEDIUM))
    if not fullscreen and requirements["fullscreen_required"]:
        events.append(("FULLSCREEN_EXIT", SeverityEnum.HIGH))
    if camera_dark and camera_monitoring_enabled:
        events.append(("CAMERA_COVERED", SeverityEnum.HIGH))

    if not events:
        return {
            "detail": "ok",
            "alerts": [],
            "forced_submit": False,
            "submit_reason": None,
        }

    now = datetime.now(timezone.utc)
    has_alert_rules = isinstance(exam_cfg.get("alert_rules"), list) and len(exam_cfg.get("alert_rules")) > 0
    if has_alert_rules:
        history_events = _load_attempt_events(db, attempt.id)
    else:
        history_events = _load_attempt_events_since(
            db,
            attempt.id,
            since=now - timedelta(seconds=35),
            event_types={"FOCUS_LOSS", "FULLSCREEN_EXIT", "CAMERA_COVERED"},
        )
    response_alerts: list[dict[str, object]] = []
    created_events: list[ProctoringEvent] = []
    forced_submit = False
    submit_reason = None
    # Per-type dedup windows: noisy events get longer cooldowns
    _PING_DEDUP_SECONDS = {"FOCUS_LOSS": 30, "FULLSCREEN_EXIT": 8, "CAMERA_COVERED": 8}
    for etype, sev in events:
        recent_same = _latest_event_of_type(history_events, etype)
        if recent_same and recent_same.occurred_at:
            try:
                dedup_s = _PING_DEDUP_SECONDS.get(etype, 8)
                occ = recent_same.occurred_at
                if occ and occ.tzinfo is None:
                    occ = occ.replace(tzinfo=timezone.utc)
                if (now - occ).total_seconds() < dedup_s:
                    continue
            except (AttributeError, TypeError):
                pass
            except Exception as exc:
                logger.warning("Unexpected error in proctoring event dedup: %s", exc)
        detail = _ping_event_detail(etype)
        ev = ProctoringEvent(
            attempt_id=attempt_id,
            event_type=etype,
            severity=sev,
            detail=detail,
            meta=_ping_event_meta(
                focus=focus,
                visibility=visibility,
                blurs=blurs,
                fullscreen=fullscreen,
                camera_dark=camera_dark,
            ),
            occurred_at=now,
        )
        db.add(ev)
        history_events.append(ev)
        created_events.append(ev)
        response_alerts.append({
            "event_type": etype,
            "severity": sev,
            "detail": detail,
        })
        rule_result = _apply_alert_rules(
            db,
            attempt,
            exam_cfg,
            ev,
            history_events,
            now,
            actor_user_id=current.id,
            request_ip=get_request_ip(request),
        )
        response_alerts.extend(rule_result["alerts"])
        created_events.extend(rule_result["created_events"])
        if rule_result["forced_submit"]:
            forced_submit = True
            submit_reason = rule_result["submit_reason"]
            break
    db.commit()
    for event in created_events:
        _handle_serious_proctoring_event(db, attempt, event)
    return {
        "detail": "ok",
        "alerts": response_alerts,
        "forced_submit": forced_submit,
        "submit_reason": submit_reason,
    }


@router.post("/{attempt_id}/video/start")
def start_video_capture(
    attempt_id: str,
    payload: dict = Body(default={}),
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    raise HTTPException(
        status_code=410,
        detail=_t("chunked_capture_removed"),
    )


@router.post("/{attempt_id}/video/chunk", response_model=Message)
def upload_video_chunk(
    attempt_id: str,
    session_id: str = Form(...),
    chunk_index: int = Form(..., ge=0),
    chunk: UploadFile = File(...),
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    raise HTTPException(
        status_code=410,
        detail=_t("chunked_capture_removed"),
    )


@router.post("/{attempt_id}/video/finalize")
def finalize_video_capture(
    attempt_id: str,
    payload: dict = Body(...),
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    raise HTTPException(
        status_code=410,
        detail=_t("local_finalize_removed"),
    )


@router.post("/{attempt_id}/video/upload", response_model=ProctoringVideoUploadResponse)
async def upload_video_capture(
    attempt_id: str,
    request: Request,
    session_id: str,
    source: str = "camera",
    filename: str | None = None,
    recording_started_at: str | None = None,
    recording_stopped_at: str | None = None,
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    _attempt_or_forbidden(attempt_id, db, current)

    normalized_source = _normalize_video_source(source)
    session_id = str(session_id or "").strip()
    if not session_id:
        raise HTTPException(status_code=400, detail=_t("session_id_required"))

    existing_file_info = _find_saved_video_file_info(db, attempt_id, session_id, normalized_source)
    if existing_file_info:
        existing_job = _find_video_batch_info(db, attempt_id, session_id, normalized_source)
        existing_status = str(existing_job.get("status") or "").upper() if existing_job else ""
        return await _build_video_upload_response(
            attempt_id,
            detail="video already uploaded",
            file_info=existing_file_info,
            job_info=existing_job,
            status_code=202 if existing_status in {"QUEUED", "PROCESSING"} else 200,
        )

    content_type = str(request.headers.get("content-type") or "application/octet-stream").split(";", 1)[0].strip().lower()
    if not (content_type.startswith("video/") or content_type == "application/octet-stream"):
        raise HTTPException(status_code=415, detail=_t("invalid_video_content_type"))

    extension = filename.rsplit(".", 1)[-1].lower() if filename and "." in filename else (
        "mp4" if "mp4" in content_type else "webm"
    )
    safe_filename = Path(filename).name if filename else _video_filename(attempt_id, session_id, normalized_source, extension)
    normalized_recording_started_at = _normalize_iso_datetime(recording_started_at)
    normalized_recording_stopped_at = _normalize_iso_datetime(recording_stopped_at)
    provider = _video_storage_provider()

    if _queued_upload_enabled(provider):
        spool_path, upload_size = await _write_video_upload_to_spool_file(request, suffix=f".{extension}")
        try:
            queued_job = upload_proctoring_video_capture.apply_async(
                kwargs={
                    "attempt_id": str(attempt_id),
                    "upload_request": {
                        "provider": provider,
                        "session_id": session_id,
                        "source": normalized_source,
                        "filename": safe_filename,
                        "extension": extension,
                        "spool_path": str(spool_path),
                        "size": upload_size,
                        "content_type": content_type,
                        "recording_started_at": normalized_recording_started_at,
                        "recording_stopped_at": normalized_recording_stopped_at,
                        "upload_ip": get_request_ip(request),
                    },
                },
                queue="proctoring-batch",
            )
        except Exception:
            spool_path.unlink(missing_ok=True)
            logger.exception("Failed to queue %s video upload for attempt %s", provider, attempt_id)
            raise HTTPException(status_code=503, detail=_t("cf_queue_unavailable"))

        return JSONResponse(
            status_code=202,
            content={
                "detail": "video received and cloud upload queued",
                "job_id": str(queued_job.id),
                "status": "QUEUED",
                "analysis_status_url": _build_video_job_status_url(attempt_id, str(queued_job.id)),
            },
        )

    temp_path, upload_size = await _write_video_upload_to_temp_file(request, suffix=f".{extension}")

    file_info: dict[str, object]
    response_detail = "video uploaded"
    try:
        if provider == "cloudflare":
            try:
                remote = await upload_video_to_cloudflare(
                    temp_path,
                    filename=safe_filename,
                    source=normalized_source,
                )
            except Exception as exc:
                logger.exception("Cloudflare video upload failed for attempt %s", attempt_id)
                raise HTTPException(status_code=502, detail=_t("cf_upload_failed")) from exc
            file_info = _build_registered_video_info(
                attempt_id,
                {
                    "provider": "cloudflare",
                    "session_id": session_id,
                    "source": normalized_source,
                    "extension": extension,
                    "name": remote.get("name") or safe_filename,
                    "url": remote.get("url") or remote.get("playback_url"),
                    "playback_url": remote.get("playback_url") or remote.get("url"),
                    "playback_type": remote.get("playback_type"),
                    "thumbnail": remote.get("thumbnail"),
                    "uid": remote.get("uid"),
                    "status": remote.get("status"),
                    "ready_to_stream": remote.get("ready_to_stream"),
                    "duration": remote.get("duration"),
                    "size": remote.get("size") or upload_size,
                    "created_at": remote.get("created_at"),
                    "recording_started_at": normalized_recording_started_at,
                    "recording_stopped_at": normalized_recording_stopped_at,
                    "remote": remote.get("remote") if isinstance(remote.get("remote"), dict) else remote,
                },
                session_id=session_id,
                source=normalized_source,
            )
        elif provider == "supabase":
            file_info = await _build_supabase_video_info(
                attempt_id,
                session_id=session_id,
                source=normalized_source,
                filename=safe_filename,
                content=temp_path.read_bytes(),
                content_type=content_type,
                recording_started_at=normalized_recording_started_at,
                recording_stopped_at=normalized_recording_stopped_at,
            )
        elif provider == "vimeo":
            file_info = await _build_vimeo_video_info(
                attempt_id,
                session_id=session_id,
                source=normalized_source,
                filename=safe_filename,
                file_path=temp_path,
                recording_started_at=normalized_recording_started_at,
                recording_stopped_at=normalized_recording_stopped_at,
            )
        else:
            raise HTTPException(status_code=503, detail=f"Unsupported video storage provider: {provider}")
    finally:
        temp_path.unlink(missing_ok=True)

    file_info["upload_ip"] = get_request_ip(request)
    try:
        event = ProctoringEvent(
            attempt_id=attempt_id,
            event_type="VIDEO_SAVED",
            severity=SeverityEnum.LOW,
            detail=f"Proctoring {normalized_source} video saved",
            meta=file_info,
            occurred_at=datetime.now(timezone.utc),
        )
        db.add(event)
        db.commit()
    except Exception:
        logger.warning("Failed to log VIDEO_SAVED event for attempt %s — video was uploaded successfully", attempt_id)
        db.rollback()
    job_info: dict[str, object] | None = None
    if video_batch_analysis_enabled():
        try:
            queued_job = enqueue_video_batch_analysis(attempt_id, file_info)
            if queued_job:
                queued_job["analysis_status_url"] = _build_video_job_status_url(attempt_id, str(queued_job.get("job_id") or ""))
                _queue_video_batch_event(db, attempt_id=attempt_id, file_info=file_info, job_info=queued_job)
                job_info = queued_job
                response_detail = "video uploaded and batch analysis queued"
        except Exception as exc:
            logger.warning("Failed to queue batch analysis for attempt %s: %s", attempt_id, exc)
            with contextlib.suppress(Exception):
                db.rollback()

    return await _build_video_upload_response(
        attempt_id,
        detail=response_detail,
        file_info=file_info,
        job_info=job_info,
        status_code=202 if job_info else 200,
    )


@router.post("/{attempt_id}/video/register", response_model=ProctoringVideoUploadResponse)
async def register_video_capture(
    attempt_id: str,
    payload: dict = Body(...),
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    _attempt_or_forbidden(attempt_id, db, current)
    _require_cloudflare_video_storage()

    session_id = str(payload.get("session_id") or "").strip()
    if not session_id:
        raise HTTPException(status_code=400, detail=_t("session_id_required"))
    source = _normalize_video_source(payload.get("source"))

    existing_file_info = _find_saved_video_file_info(db, attempt_id, session_id, source)
    if existing_file_info:
        existing_job = _find_video_batch_info(db, attempt_id, session_id, source)
        existing_status = str(existing_job.get("status") or "").upper() if existing_job else ""
        return await _build_video_upload_response(
            attempt_id,
            detail="video already registered",
            file_info=existing_file_info,
            job_info=existing_job,
            status_code=202 if existing_status in {"QUEUED", "PROCESSING"} else 200,
        )

    file_info = _build_registered_video_info(attempt_id, payload, session_id=session_id, source=source)
    event = ProctoringEvent(
        attempt_id=attempt_id,
        event_type="VIDEO_SAVED",
        severity=SeverityEnum.LOW,
        detail=f"Proctoring {source} video saved",
        meta=file_info,
        occurred_at=datetime.now(timezone.utc),
    )
    db.add(event)
    db.commit()
    job_info: dict[str, object] | None = None
    if video_batch_analysis_enabled():
        try:
            queued_job = enqueue_video_batch_analysis(attempt_id, file_info)
            if queued_job:
                queued_job["analysis_status_url"] = _build_video_job_status_url(attempt_id, str(queued_job.get("job_id") or ""))
                _queue_video_batch_event(db, attempt_id=attempt_id, file_info=file_info, job_info=queued_job)
                job_info = queued_job
        except Exception as exc:
            logger.warning("Failed to queue registered video batch analysis for attempt %s: %s", attempt_id, exc)
            with contextlib.suppress(Exception):
                db.rollback()

    return await _build_video_upload_response(
        attempt_id,
        detail="video registered" if not job_info else "video registered and batch analysis queued",
        file_info=file_info,
        job_info=job_info,
        status_code=202 if job_info else 200,
    )


@router.post("/{attempt_id}/video/upload-progress", response_model=Message)
def report_video_upload_progress(
    attempt_id: str,
    payload: dict = Body(...),
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    _attempt_or_forbidden(attempt_id, db, current)

    session_id = str(payload.get("session_id") or "").strip()
    if not session_id:
        raise HTTPException(status_code=400, detail=_t("session_id_required"))

    source = _normalize_video_source(payload.get("source"))
    if _find_saved_video_file_info(db, attempt_id, session_id, source):
        return Message(detail=_t("video_already_saved"))

    uploaded_bytes = _coerce_non_negative_int(payload.get("uploaded_bytes"))
    total_bytes = _coerce_non_negative_int(payload.get("total_bytes"))
    if total_bytes > 0 and uploaded_bytes > total_bytes:
        uploaded_bytes = total_bytes

    status = _normalize_video_upload_status(payload.get("status"))
    progress_percent = payload.get("progress_percent")
    if progress_percent in (None, "") and total_bytes > 0:
        progress_percent = (uploaded_bytes / total_bytes) * 100
    normalized_percent = _clamp_progress_percent(progress_percent, default=0)
    filename = Path(str(payload.get("filename") or "").strip()).name

    if status == "complete":
        normalized_percent = 100
    elif status in {"uploading", "processing"}:
        normalized_percent = min(99, normalized_percent)

    occurred_at = datetime.now(timezone.utc)
    event = ProctoringEvent(
        attempt_id=attempt_id,
        event_type="VIDEO_UPLOAD_PROGRESS",
        severity=SeverityEnum.LOW,
        detail=f"Proctoring {source} video upload {status}",
        meta={
            "session_id": session_id,
            "source": source,
            "uploaded_bytes": uploaded_bytes,
            "total_bytes": total_bytes,
            "progress_percent": normalized_percent,
            "status": status,
            "created_at": occurred_at.isoformat(),
            **({"filename": filename} if filename else {}),
        },
        occurred_at=occurred_at,
    )
    db.add(event)
    db.commit()
    return Message(detail=_t("video_upload_progress_recorded"))


@router.get("/{attempt_id}/jobs/{job_id}/status", response_model=ProctoringJobStatusResponse)
async def get_video_job_status(
    attempt_id: str,
    job_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    _attempt_or_forbidden(attempt_id, db, current)
    if not video_job_queue_enabled():
        raise HTTPException(status_code=503, detail=_t("bg_proctoring_not_enabled"))

    status_payload = get_proctoring_video_job_status(job_id)
    event_payload = _find_video_batch_info_by_job_id(db, attempt_id, job_id)

    if event_payload:
        event_status = str(event_payload.get("status") or "").upper()
        if status_payload.get("status") in {"QUEUED", "PROCESSING"} and event_status in {"COMPLETED", "FAILED"}:
            status_payload["status"] = event_status
            status_payload["detail"] = str(event_payload.get("detail") or status_payload.get("detail") or "")
        if not status_payload.get("file") and event_payload.get("file"):
            status_payload["file"] = event_payload.get("file")
        if not status_payload.get("summary") and event_payload.get("summary"):
            status_payload["summary"] = event_payload.get("summary")
        if not status_payload.get("findings") and event_payload.get("findings"):
            status_payload["findings"] = event_payload.get("findings")
        if not status_payload.get("completed_at") and event_payload.get("completed_at"):
            status_payload["completed_at"] = event_payload.get("completed_at")

    file_info = status_payload.get("file")
    if isinstance(file_info, dict):
        status_payload["file"] = await _hydrate_video_file_info(file_info)

    return ProctoringJobStatusResponse(**status_payload)


@router.post("/{attempt_id}/pause", response_model=Message)
def pause_attempt(
    attempt_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("View Attempt Analysis", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    attempt = _attempt_or_forbidden(attempt_id, db, current)
    if attempt.status != AttemptStatus.IN_PROGRESS:
        raise HTTPException(status_code=400, detail=_t("only_in_progress_pause"))

    event = ProctoringEvent(
        attempt_id=attempt_id,
        event_type="ATTEMPT_PAUSED",
        severity=SeverityEnum.LOW,
        detail=f"Attempt paused by {current.user_id}",
        meta={"paused": True},
        occurred_at=datetime.now(timezone.utc),
    )
    db.add(event)
    db.commit()
    return Message(detail=_t("attempt_paused"))


@router.post("/{attempt_id}/resume", response_model=Message)
def resume_attempt(
    attempt_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("View Attempt Analysis", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    attempt = _attempt_or_forbidden(attempt_id, db, current)
    if attempt.status != AttemptStatus.IN_PROGRESS:
        raise HTTPException(status_code=400, detail=_t("only_in_progress_resume"))

    event = ProctoringEvent(
        attempt_id=attempt_id,
        event_type="ATTEMPT_RESUMED",
        severity=SeverityEnum.LOW,
        detail=f"Attempt resumed by {current.user_id}",
        meta={"paused": False},
        occurred_at=datetime.now(timezone.utc),
    )
    db.add(event)
    db.commit()
    return Message(detail=_t("attempt_resumed"))


@router.get("/{attempt_id}/videos")
async def list_videos(
    attempt_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    _attempt_or_forbidden(attempt_id, db, current)
    await _recover_missing_cloudflare_videos(db, attempt_id)
    result: list[dict[str, object]] = []
    seen_keys: set[tuple[str, str]] = set()

    for event in _saved_video_events(db, attempt_id):
        item = _normalize_saved_video_meta(event.meta, event.occurred_at)
        if not item:
            continue
        key = (
            str(item.get("session_id") or item.get("path") or item.get("name") or item.get("url") or ""),
            str(item.get("source") or "camera"),
        )
        if key in seen_keys:
            continue
        seen_keys.add(key)
        result.append(await _hydrate_video_file_info(item))
    result.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return result


@router.get("/exam/{exam_id}/video-upload-status")
def list_exam_video_upload_status(
    exam_id: str,
    attempt_ids: list[str] | None = Query(default=None),
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("View Attempt Analysis", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    exam_pk = parse_uuid_param(exam_id, detail=_t("exam_not_found"))
    filtered_attempt_pks: list[object] = []
    seen_attempt_ids: set[str] = set()
    for raw_attempt_ids in attempt_ids or []:
        for raw_attempt_id in str(raw_attempt_ids or "").split(","):
            normalized_attempt_id = raw_attempt_id.strip()
            if not normalized_attempt_id or normalized_attempt_id in seen_attempt_ids:
                continue
            seen_attempt_ids.add(normalized_attempt_id)
            filtered_attempt_pks.append(
                parse_uuid_param(
                    normalized_attempt_id,
                    detail=_t("invalid_attempt_id"),
                    status_code=400,
                )
            )

    cache_key = str(exam_pk)
    if filtered_attempt_pks:
        cache_key = f"{cache_key}:{','.join(sorted(str(attempt_pk) for attempt_pk in filtered_attempt_pks))}"

    def _load_rows() -> list[dict[str, object]]:
        attempts_query = (
            select(Attempt)
            .options(
                load_only(
                    Attempt.id,
                    Attempt.exam_id,
                    Attempt.status,
                    Attempt.created_at,
                    Attempt.submitted_at,
                ),
                joinedload(Attempt.exam).load_only(
                    Exam.id,
                    Exam.proctoring_config,
                ),
            )
            .where(Attempt.exam_id == exam_pk)
            .order_by(Attempt.created_at.desc())
        )
        if filtered_attempt_pks:
            attempts_query = attempts_query.where(Attempt.id.in_(filtered_attempt_pks))
        attempts = list(db.scalars(attempts_query).unique())
        if not attempts:
            return []

        attempt_ids = [attempt.id for attempt in attempts]
        relevant_events = list(
            db.scalars(
                select(ProctoringEvent)
                .options(
                    load_only(
                        ProctoringEvent.attempt_id,
                        ProctoringEvent.event_type,
                        ProctoringEvent.meta,
                        ProctoringEvent.occurred_at,
                    )
                )
                .where(
                    ProctoringEvent.attempt_id.in_(attempt_ids),
                    ProctoringEvent.event_type.in_(("VIDEO_SAVED", "VIDEO_UPLOAD_PROGRESS")),
                )
                .order_by(ProctoringEvent.occurred_at.desc())
            )
        )

        saved_by_attempt: dict[str, dict[str, dict[str, object]]] = {}
        progress_by_attempt: dict[str, dict[str, dict[str, object]]] = {}
        for event in relevant_events:
            attempt_key = str(event.attempt_id)
            if event.event_type == "VIDEO_SAVED":
                item = _normalize_saved_video_meta(event.meta, event.occurred_at)
                if not item:
                    continue
                source = _normalize_video_source(item.get("source"))
                saved_by_attempt.setdefault(attempt_key, {}).setdefault(source, item)
                continue
            if event.event_type == "VIDEO_UPLOAD_PROGRESS":
                item = _normalize_video_upload_progress_meta(event.meta, event.occurred_at)
                if not item:
                    continue
                source = _normalize_video_source(item.get("source"))
                progress_by_attempt.setdefault(attempt_key, {}).setdefault(source, item)

        rows = [
            _build_attempt_video_upload_summary(
                attempt,
                saved_by_source=saved_by_attempt.get(str(attempt.id)),
                progress_by_source=progress_by_attempt.get(str(attempt.id)),
            )
            for attempt in attempts
        ]
        return rows

    return _video_upload_status_cache.get_or_compute(cache_key, _load_rows)


@router.websocket("/{attempt_id}/ws")
async def proctoring_ws(websocket: WebSocket, attempt_id: str, token: str):
    try:
        payload = verify_token(token, expected_type="access")
    except Exception:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    await websocket.send_json({"type": "connected"})

    # Get a DB session for writing events
    from ...db.session import SessionLocal
    db = SessionLocal()

    # load attempt/exam for thresholds
    try:
        attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    except HTTPException:
        await websocket.close(code=4404)
        db.close()
        return
    attempt = db.scalars(
        select(Attempt)
        .options(
            load_only(
                Attempt.id,
                Attempt.exam_id,
                Attempt.user_id,
                Attempt.status,
                Attempt.started_at,
                Attempt.precheck_passed_at,
                Attempt.face_signature,
            ),
            joinedload(Attempt.user).load_only(User.id, User.name),
            joinedload(Attempt.exam).load_only(Exam.id, Exam.title, Exam.proctoring_config),
        )
        .where(Attempt.id == attempt_pk)
    ).unique().first()
    if not attempt:
        await websocket.close(code=4404)
        db.close()
        return
    # Optional access check: learners can only access their own attempt
    user_id = payload.get("sub")
    if user_id and str(attempt.user_id) != str(user_id) and payload.get("role") == "LEARNER":
        await websocket.close(code=4403)
        db.close()
        return
    if payload.get("role") in {"ADMIN", "INSTRUCTOR"}:
        try:
            actor_pk = parse_uuid_param(user_id, detail=_t("user_not_found"), status_code=403)
            actor = db.get(User, actor_pk)
            if not actor:
                raise HTTPException(status_code=403, detail=_t("insufficient_permissions"))
            ensure_permission(db, actor, "View Attempt Analysis")
            exam = attempt.exam or db.get(Exam, attempt.exam_id)
            ensure_exam_owner(exam, actor, detail=_t("not_allowed"), status_code=403)
        except HTTPException:
            await websocket.close(code=4403)
            db.close()
            return
    exam_cfg = exam_proctoring(attempt.exam) if attempt and attempt.exam else {}
    exam_cfg = exam_cfg.copy() if exam_cfg else {}
    proctoring_requirements = get_proctoring_requirements(exam_cfg)
    if not _runtime_proctoring_enabled(exam_cfg, proctoring_requirements):
        await websocket.send_json({"type": "disabled"})
        await websocket.close(code=1000)
        db.close()
        return
    if (
        proctoring_requirements["identity_required"]
        and not attempt.precheck_passed_at
    ):
        await websocket.send_json({"type": "alert", "event_type": "PRECHECK_BYPASS_DENIED", "severity": "HIGH", "detail": "Pre-exam checks not completed"})
        await websocket.close(code=4403)
        db.close()
        return

    if getattr(attempt, "face_signature", None):
        exam_cfg["face_signature"] = attempt.face_signature

    # Restore violation score from previous events so reconnects don't reset it
    score_weights = exam_cfg.get("violation_weights") or {"HIGH": 3, "MEDIUM": 2, "LOW": 1}
    historical_violation_score = 0.0
    _prev_events = db.scalars(
        select(ProctoringEvent).where(ProctoringEvent.attempt_id == attempt_id)
    ).all()
    for _prev in _prev_events:
        sev_name = _prev.severity.value if hasattr(_prev.severity, "value") else str(_prev.severity or "LOW")
        historical_violation_score += score_weights.get(sev_name.upper(), 1)
    inference_gateway = get_proctoring_inference_gateway()
    try:
        session_open = await inference_gateway.open_session(
            attempt_id,
            exam_cfg,
            initial_violation_score=historical_violation_score,
        )
    except Exception as exc:
        logger.exception("Failed to open inference session for attempt %s: %s", attempt_id, exc)
        with contextlib.suppress(Exception):
            await websocket.send_json({
                "type": "error",
                "detail": "Proctoring inference service is unavailable",
            })
            await websocket.close(code=1011)
        db.close()
        return
    session_summary = dict(session_open.summary or {})
    session_violation_score = float(session_open.violation_score or historical_violation_score)
    detection_status = dict(session_open.detection_status or {})
    live_session_info = {
        "attempt_id": attempt_id,
        "user_name": attempt.user.name if attempt.user else None,
        "user_id": str(attempt.user_id),
        "exam_title": attempt.exam.title if attempt.exam else None,
        "exam_id": str(attempt.exam_id),
        "started_at": attempt.started_at.isoformat() if attempt.started_at else None,
    }

    # ── Register live monitoring session in Redis ─────────────────────────────
    await live_bus.publish_session_open(attempt_id, live_session_info)

    # ── Model availability checks — run in background after orchestrator init ──
    # These are deferred so the WS connect handshake isn't blocked by model loading.
    async def _send_detection_status():
        try:
            if (exam_cfg.get("face_detection") or exam_cfg.get("multi_face")) and not detection_status.get("face_detection", False):
                logger.error("Face detection model unavailable for attempt %s", attempt_id)
                await websocket.send_json({
                    "type": "error",
                    "detail": "Face detection model unavailable. Face and multiple-face alerts are disabled until the model is restored.",
                })
            if exam_cfg.get("object_detection") and not detection_status.get("object_detection", False):
                logger.error("Object detection model unavailable for attempt %s", attempt_id)
                await websocket.send_json({
                    "type": "error",
                    "detail": "Object detection model unavailable. Forbidden-object alerts (phone, book, etc.) are disabled until the model is restored.",
                })
            await websocket.send_json({"type": "detection_status", **detection_status})
        except Exception as exc:
            logger.debug("Could not send detection_status for attempt %s: %s", attempt_id, exc)
    last_activity = {"monotonic": time.monotonic()}
    heartbeat_task: asyncio.Task | None = None

    async def heartbeat() -> None:
        consecutive_failures = 0
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
            try:
                if websocket.application_state != WebSocketState.CONNECTED:
                    return
                idle_seconds = time.monotonic() - last_activity["monotonic"]
                if idle_seconds >= INACTIVITY_TIMEOUT_SECONDS:
                    logger.info("Closing inactive proctoring websocket for attempt %s after %.1fs", attempt_id, idle_seconds)
                    await websocket.close(code=1001)
                    return
                await websocket.send_json({"type": "ping"})
                consecutive_failures = 0
            except Exception:
                consecutive_failures += 1
                if consecutive_failures >= 3:
                    logger.warning("Heartbeat failed 3 consecutive times for attempt %s, exiting", attempt_id)
                    return

    heartbeat_task = asyncio.create_task(heartbeat())
    # Fire-and-forget: send detection status without blocking the message loop
    asyncio.create_task(_send_detection_status())

    # Append-through event cache: new events appended immediately after commit,
    # full DB refresh only every 60s to catch any events created outside this WS.
    _cached_events: list[ProctoringEvent] = []
    _cache_ts: float = 0.0
    _EVENT_CACHE_FULL_REFRESH_S = 60

    def _get_cached_events() -> list[ProctoringEvent]:
        nonlocal _cached_events, _cache_ts
        now = time.monotonic()
        if now - _cache_ts >= _EVENT_CACHE_FULL_REFRESH_S:
            try:
                _cached_events = _load_attempt_events(db, attempt.id)
                _cache_ts = now
            except Exception as cache_err:
                logger.warning("Failed to refresh event cache for attempt %s: %s", attempt_id, cache_err)
                try:
                    db.rollback()
                except Exception:
                    pass
        return list(_cached_events)

    def _append_cached_event(event: ProctoringEvent) -> None:
        """Append a newly created event to the cache without a full DB refresh."""
        _cached_events.append(event)

    _frame_proc_end = 0.0  # monotonic timestamp of last frame processing completion
    _last_thumb_broadcast = 0.0  # monotonic timestamp of last thumbnail broadcast to admin viewers

    # ── Pause state tracking ─────────────────────────────────────────
    _is_paused = False
    _last_pause_check = 0.0
    _PAUSE_CHECK_INTERVAL = 5.0  # seconds between DB checks for pause state

    def _check_pause_state() -> bool:
        """Check if this attempt is currently paused by querying the latest pause/resume event."""
        nonlocal _is_paused, _last_pause_check
        now_mono = time.monotonic()
        if now_mono - _last_pause_check < _PAUSE_CHECK_INTERVAL:
            return _is_paused
        _last_pause_check = now_mono
        latest = db.scalar(
            select(ProctoringEvent.event_type)
            .where(
                ProctoringEvent.attempt_id == attempt_id,
                ProctoringEvent.event_type.in_(["ATTEMPT_PAUSED", "ATTEMPT_RESUMED"]),
            )
            .order_by(ProctoringEvent.occurred_at.desc())
            .limit(1)
        )
        _is_paused = latest == "ATTEMPT_PAUSED"
        return _is_paused

    async def _async_db_commit():
        """Run db.commit() in executor to avoid blocking the event loop."""
        _loop = asyncio.get_running_loop()
        await _loop.run_in_executor(None, db.commit)

    # ── WebSocket payload size limits ──────────────────────────────────
    _MAX_PAYLOAD_SIZES = {
        "frame": 5 * 1024 * 1024,   # 5 MB
        "audio": 512 * 1024,         # 512 KB
        "screen": 5 * 1024 * 1024,   # 5 MB
    }

    # ── WebSocket rate limiting ──────────────────────────────────────
    _RATE_WINDOW_S = 5.0
    _RATE_GLOBAL_MAX = 30  # max messages per window across all types
    _RATE_TYPE_MAX = {"frame": 20, "audio": 10, "screen": 5, "client_event": 25, "answer_timing": 5, "keystroke_anomaly": 5}
    _rate_global_ts: list[float] = []
    _rate_type_ts: dict[str, list[float]] = {}

    def _rate_limit_ok(msg_type: str) -> bool:
        now_mono = time.monotonic()
        cutoff = now_mono - _RATE_WINDOW_S
        # Global check
        _rate_global_ts[:] = [t for t in _rate_global_ts if t > cutoff]
        if len(_rate_global_ts) >= _RATE_GLOBAL_MAX:
            return False
        # Per-type check
        type_max = _RATE_TYPE_MAX.get(msg_type)
        if type_max is not None:
            bucket = _rate_type_ts.setdefault(msg_type, [])
            bucket[:] = [t for t in bucket if t > cutoff]
            if len(bucket) >= type_max:
                return False
            bucket.append(now_mono)
        _rate_global_ts.append(now_mono)
        return True

    try:
        while True:
            try:
                data = await websocket.receive_json()
                last_activity["monotonic"] = time.monotonic()
            except WebSocketDisconnect:
                logger.info("Proctoring websocket disconnected for attempt %s", attempt_id)
                raise
            except Exception as exc:
                logger.warning("Malformed websocket message for attempt %s: %s", attempt_id, exc)
                if websocket.application_state != WebSocketState.CONNECTED:
                    # WS is dead — break to avoid infinite tight loop
                    logger.info("WebSocket no longer connected for attempt %s, exiting loop", attempt_id)
                    break
                await websocket.send_json({"type": "error", "detail": "Malformed websocket message"})
                continue

            try:
                msg_type = data.get("type")

                if msg_type == "ping":
                    await websocket.send_json({"type": "pong"})
                    continue
                if msg_type == "pong":
                    continue

                if not _rate_limit_ok(msg_type or ""):
                    logger.warning("Rate limit exceeded for attempt %s, msg_type=%s", attempt_id, msg_type)
                    await websocket.send_json({"type": "error", "detail": "Rate limit exceeded"})
                    continue

                # Reject oversized payloads to prevent abuse
                _max_size = _MAX_PAYLOAD_SIZES.get(msg_type)
                if _max_size is not None:
                    _payload = data.get("data", "")
                    if _payload and len(_payload) > _max_size:
                        logger.warning("Oversized %s payload for attempt %s: %d bytes (max %d)", msg_type, attempt_id, len(_payload), _max_size)
                        await websocket.send_json({"type": "error", "detail": f"Payload too large for {msg_type}"})
                        continue

                # Skip AI processing while attempt is paused by admin
                if msg_type in ("frame", "audio", "screen") and _check_pause_state():
                    await websocket.send_json({"type": "paused", "detail": "Attempt is paused by administrator"})
                    continue

                if msg_type == "frame":
                    b64 = data.get("data")
                    if not b64:
                        continue
                    # Gate: skip frames that were buffered during previous processing
                    _recv_mono = time.monotonic()
                    if _recv_mono - _frame_proc_end < 0.03:
                        logger.debug("Dropping buffered frame for attempt %s (%.0fms after last)", attempt_id, (_recv_mono - _frame_proc_end) * 1000)
                        continue
                    try:
                        frame_bytes = base64.b64decode(b64)
                    except Exception:
                        logger.warning("Invalid base64 in frame data for attempt %s", attempt_id)
                        continue
                    # Run CPU-heavy detection in thread pool to avoid blocking event loop
                    frame_result = await inference_gateway.process_frame(attempt_id, frame_bytes)
                    alerts = frame_result.alerts
                    session_summary = dict(frame_result.summary or {})
                    session_violation_score = float(frame_result.violation_score or session_violation_score)
                    _frame_proc_end = time.monotonic()
                    _proc_ms = float(frame_result.latency_ms or 0.0)
                    if _proc_ms > 500:
                        logger.warning("Slow frame processing for attempt %s: %.0fms, %d alerts", attempt_id, _proc_ms, len(alerts))
                        # Tell client to slow down frame capture to avoid queue buildup
                        try:
                            await websocket.send_json({
                                "type": "slow_mode",
                                "interval_ms": min(int(_proc_ms * 1.5), 5000),
                            })
                        except Exception:
                            pass
                    else:
                        logger.debug("Frame processed for attempt %s: %.0fms, %d alerts, score=%d", attempt_id, _proc_ms, len(alerts), int(session_violation_score))
                    if alerts:
                        logger.debug("Alerts: %s", [a.get("event_type") for a in alerts])
                    history_events = _get_cached_events()
                    integrations_config = _load_integrations_config(db)

                    # Collect serious events for post-commit notification
                    _serious_batch: list[ProctoringEvent] = []
                    _integration_batch: list[ProctoringEvent] = []
                    # Collect WebSocket messages to send AFTER successful DB commit
                    _ws_messages: list[dict] = []
                    _forced_submit_msg: dict | None = None

                    for alert in alerts:
                        severity = SEVERITY_MAP.get(alert.get("severity", "LOW"), SeverityEnum.LOW)
                        meta = alert.get("meta") or {}

                        # Save evidence screenshot for every alert (not just HIGH)
                        try:
                            evidence_path = await _save_evidence(attempt_id, frame_bytes, alert["event_type"])
                        except Exception as ev_err:
                            logger.warning("Evidence save failed for attempt %s: %s", attempt_id, ev_err)
                            evidence_path = None
                        if evidence_path:
                            meta["evidence"] = evidence_path

                        event_time = datetime.now(timezone.utc)
                        event = ProctoringEvent(
                            attempt_id=attempt_id,
                            event_type=alert["event_type"],
                            severity=severity,
                            detail=alert.get("detail"),
                            ai_confidence=alert.get("confidence"),
                            meta=meta if meta else None,
                            occurred_at=event_time,
                        )
                        db.add(event)
                        _append_cached_event(event)
                        history_events.append(event)
                        rule_result = _apply_alert_rules(
                            db,
                            attempt,
                            exam_cfg,
                            event,
                            history_events,
                            event_time,
                            request_ip=get_websocket_ip(websocket),
                        )

                        # Collect for post-commit processing (no per-alert commit)
                        if _is_serious_alert(alert.get("severity"), severity):
                            _serious_batch.append(event)
                        for escalated_event in rule_result["created_events"]:
                            _serious_batch.append(escalated_event)
                        _integration_batch.append(event)
                        _integration_batch.extend(rule_result["created_events"])

                        # Queue alert messages for sending after DB commit
                        _ws_messages.append({
                            "type": "alert",
                            "event_type": alert["event_type"],
                            "severity": alert["severity"],
                            "detail": alert.get("detail", ""),
                            "confidence": alert.get("confidence", 0),
                        })
                        for rule_alert in rule_result["alerts"]:
                            _ws_messages.append({
                                "type": "alert",
                                "event_type": rule_alert["event_type"],
                                "severity": rule_alert["severity"].value,
                                "detail": rule_alert["detail"],
                                "action": rule_alert["action"],
                                "rule_id": rule_alert["rule_id"],
                            })
                        if rule_result["forced_submit"]:
                            _forced_submit_msg = {"type": "forced_submit", "detail": rule_result["submit_reason"] or ""}
                            break

                    # Commit to DB BEFORE sending alerts to client
                    _commit_ok = True
                    if alerts:
                        try:
                            await _async_db_commit()
                        except Exception as commit_err:
                            _commit_ok = False
                            logger.warning("DB commit failed for frame alerts (attempt %s): %s", attempt_id, commit_err)
                            try:
                                db.rollback()
                            except Exception:
                                pass

                    # Only send alerts to client after successful DB commit
                    if _commit_ok:
                        for _ws_msg in _ws_messages:
                            await websocket.send_json(_ws_msg)
                        if _forced_submit_msg:
                            await websocket.send_json(_forced_submit_msg)

                    # Broadcast frame thumbnail + alerts to live admin viewers via Redis
                    _thumb_now = time.monotonic()
                    _should_broadcast_thumb = (_thumb_now - _last_thumb_broadcast) >= 1.0
                    if _should_broadcast_thumb:
                        try:
                            import cv2 as _live_cv2
                            import numpy as _live_np
                            _np_arr = _live_np.frombuffer(frame_bytes, _live_np.uint8)
                            _frame_img = _live_cv2.imdecode(_np_arr, _live_cv2.IMREAD_COLOR)
                            if _frame_img is not None:
                                _h, _w = _frame_img.shape[:2]
                                if _w > 320:
                                    _scale = 320 / _w
                                    _frame_img = _live_cv2.resize(_frame_img, (320, int(_h * _scale)))
                                _, _thumb_buf = _live_cv2.imencode('.jpg', _frame_img, [_live_cv2.IMWRITE_JPEG_QUALITY, 50])
                                await live_bus.publish_thumb(attempt_id, _thumb_buf.tobytes(), "frame")
                                _last_thumb_broadcast = _thumb_now
                        except Exception:
                            pass
                    for alert in alerts:
                        await live_bus.publish_json_event(attempt_id, {
                            "type": "alert",
                            "attempt_id": attempt_id,
                            "event_type": alert["event_type"],
                            "severity": alert["severity"],
                            "detail": alert.get("detail", ""),
                            "confidence": alert.get("confidence", 0),
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        })
                    if alerts or int(session_summary.get("face_checks") or 0) % 10 == 0:
                        await live_bus.publish_json_event(attempt_id, {
                            "type": "live_summary",
                            "attempt_id": attempt_id,
                            **session_summary,
                        })

                    # Post-commit: notifications & integrations
                    for _evt in _serious_batch:
                        _handle_serious_proctoring_event(db, attempt, _evt)
                    for _evt in _integration_batch:
                        try:
                            await send_proctoring_integration_event(_evt, integrations_config)
                        except Exception:
                            pass

                    # Send summary every 5th frame or when alerts fired (reduces WS traffic)
                    if alerts or int(session_summary.get("face_checks") or 0) % 5 == 0:
                        await websocket.send_json({"type": "summary", "precheck_passed": bool(attempt.precheck_passed_at), **session_summary})
                    if attempt.status == AttemptStatus.SUBMITTED:
                        break
                    reason = _maybe_auto_submit_from_history(
                        db,
                        attempt,
                        exam_cfg,
                        history_events,
                        occurred_at=datetime.now(timezone.utc),
                        request_ip=get_websocket_ip(websocket),
                        violation_score=session_violation_score,
                    )
                    if reason:
                        await websocket.send_json({"type": "forced_submit", "detail": reason})
                        break
                    continue

                if msg_type == "audio":
                    b64 = data.get("data")
                    if not b64:
                        continue
                    try:
                        audio_bytes = base64.b64decode(b64)
                    except Exception:
                        logger.warning("Invalid base64 in audio data for attempt %s", attempt_id)
                        continue
                    _sr = data.get("sample_rate")
                    logger.info("WS audio chunk for attempt %s (bytes=%d, sr=%s)", attempt_id, len(audio_bytes), _sr)
                    audio_result = await inference_gateway.process_audio(
                        attempt_id,
                        audio_bytes,
                        sample_rate=int(_sr) if _sr else None,
                    )
                    alerts = audio_result.alerts
                    session_summary = dict(audio_result.summary or {})
                    session_violation_score = float(audio_result.violation_score or session_violation_score)
                    if alerts:
                        logger.debug("Audio alerts: %s", [a.get("event_type") for a in alerts])
                    history_events = _get_cached_events()

                    _audio_serious: list[ProctoringEvent] = []
                    _audio_ws_messages: list[dict] = []
                    _audio_forced_submit_msg: dict | None = None

                    for alert in alerts:
                        severity = SEVERITY_MAP.get(alert.get("severity", "LOW"), SeverityEnum.LOW)
                        event_time = datetime.now(timezone.utc)
                        event = ProctoringEvent(
                            attempt_id=attempt_id,
                            event_type=alert["event_type"],
                            severity=severity,
                            detail=alert.get("detail"),
                            ai_confidence=alert.get("confidence"),
                            meta=alert.get("meta"),
                            occurred_at=event_time,
                        )
                        db.add(event)
                        _append_cached_event(event)
                        history_events.append(event)
                        rule_result = _apply_alert_rules(
                            db,
                            attempt,
                            exam_cfg,
                            event,
                            history_events,
                            event_time,
                            request_ip=get_websocket_ip(websocket),
                        )

                        if _is_serious_alert(alert.get("severity"), severity):
                            _audio_serious.append(event)
                        for escalated_event in rule_result["created_events"]:
                            _audio_serious.append(escalated_event)

                        _audio_ws_messages.append({
                            "type": "alert",
                            "event_type": alert["event_type"],
                            "severity": alert["severity"],
                            "detail": alert.get("detail", ""),
                            "confidence": alert.get("confidence", 0),
                        })
                        for rule_alert in rule_result["alerts"]:
                            _audio_ws_messages.append({
                                "type": "alert",
                                "event_type": rule_alert["event_type"],
                                "severity": rule_alert["severity"].value,
                                "detail": rule_alert["detail"],
                                "action": rule_alert["action"],
                                "rule_id": rule_alert["rule_id"],
                            })
                        if rule_result["forced_submit"]:
                            _audio_forced_submit_msg = {"type": "forced_submit", "detail": rule_result["submit_reason"] or ""}
                            break

                    # Commit to DB BEFORE sending alerts to client
                    _commit_ok = True
                    if alerts:
                        try:
                            await _async_db_commit()
                        except Exception as commit_err:
                            _commit_ok = False
                            logger.warning("DB commit failed for audio alerts (attempt %s): %s", attempt_id, commit_err)
                            try:
                                db.rollback()
                            except Exception:
                                pass

                    # Only send alerts to client after successful DB commit
                    if _commit_ok:
                        for _ws_msg in _audio_ws_messages:
                            await websocket.send_json(_ws_msg)
                        if _audio_forced_submit_msg:
                            await websocket.send_json(_audio_forced_submit_msg)

                    for _evt in _audio_serious:
                        _handle_serious_proctoring_event(db, attempt, _evt)

                    await websocket.send_json({"type": "summary", **session_summary})
                    if attempt.status == AttemptStatus.SUBMITTED:
                        break
                    if _audio_forced_submit_msg:
                        break
                    reason = _maybe_auto_submit_from_history(
                        db,
                        attempt,
                        exam_cfg,
                        history_events,
                        occurred_at=datetime.now(timezone.utc),
                        request_ip=get_websocket_ip(websocket),
                        violation_score=session_violation_score,
                    )
                    if reason:
                        await websocket.send_json({"type": "forced_submit", "detail": reason})
                        break
                    continue

                if msg_type == "screen":
                    b64 = data.get("data")
                    if not b64:
                        continue
                    try:
                        frame_bytes = base64.b64decode(b64)
                    except Exception:
                        logger.warning("Invalid base64 in screen data for attempt %s", attempt_id)
                        continue
                    try:
                        await _save_evidence(attempt_id, frame_bytes, "SCREEN")
                    except Exception as ev_err:
                        logger.warning("Screen evidence save failed for attempt %s: %s", attempt_id, ev_err)
                    try:
                        screen_result = await inference_gateway.process_screen(attempt_id, frame_bytes)
                        session_summary = dict(screen_result.summary or {})
                        session_violation_score = float(screen_result.violation_score or session_violation_score)
                        alerts = screen_result.alerts or []
                        history_events = _get_cached_events()

                        _screen_serious: list[ProctoringEvent] = []
                        _screen_ws_messages: list[dict] = []
                        _screen_forced_submit_msg: dict | None = None

                        for alert in alerts:
                            severity = SEVERITY_MAP.get(alert.get("severity", "HIGH"), SeverityEnum.HIGH)
                            event_time = datetime.now(timezone.utc)
                            event = ProctoringEvent(
                                attempt_id=attempt_id,
                                event_type=alert["event_type"],
                                severity=severity,
                                detail=alert.get("detail"),
                                ai_confidence=alert.get("confidence"),
                                meta=alert.get("meta"),
                                occurred_at=event_time,
                            )
                            db.add(event)
                            _append_cached_event(event)
                            history_events.append(event)
                            rule_result = _apply_alert_rules(
                                db,
                                attempt,
                                exam_cfg,
                                event,
                                history_events,
                                event_time,
                                request_ip=get_websocket_ip(websocket),
                            )

                            if _is_serious_alert(alert.get("severity"), severity):
                                _screen_serious.append(event)
                            for escalated_event in rule_result["created_events"]:
                                _screen_serious.append(escalated_event)

                            _screen_ws_messages.append({
                                "type": "alert",
                                "event_type": alert["event_type"],
                                "severity": alert["severity"],
                                "detail": alert.get("detail", ""),
                                "confidence": alert.get("confidence", 0),
                            })
                            for rule_alert in rule_result["alerts"]:
                                _screen_ws_messages.append({
                                    "type": "alert",
                                    "event_type": rule_alert["event_type"],
                                    "severity": rule_alert["severity"].value,
                                    "detail": rule_alert["detail"],
                                    "action": rule_alert["action"],
                                    "rule_id": rule_alert["rule_id"],
                                })
                            if rule_result["forced_submit"]:
                                _screen_forced_submit_msg = {"type": "forced_submit", "detail": rule_result["submit_reason"] or ""}
                                break

                        # Commit to DB BEFORE sending alerts to client
                        _commit_ok = True
                        if alerts:
                            try:
                                await _async_db_commit()
                            except Exception as commit_err:
                                _commit_ok = False
                                logger.warning("DB commit failed for screen alerts (attempt %s): %s", attempt_id, commit_err)
                                try:
                                    db.rollback()
                                except Exception:
                                    pass

                        # Only send alerts to client after successful DB commit
                        if _commit_ok:
                            for _ws_msg in _screen_ws_messages:
                                await websocket.send_json(_ws_msg)
                            if _screen_forced_submit_msg:
                                await websocket.send_json(_screen_forced_submit_msg)

                        # Broadcast screen alerts to live admin viewers via Redis
                        for alert in alerts:
                            await live_bus.publish_json_event(attempt_id, {
                                "type": "alert",
                                "attempt_id": attempt_id,
                                "event_type": alert["event_type"],
                                "severity": alert["severity"],
                                "detail": alert.get("detail", ""),
                                "confidence": alert.get("confidence", 0),
                                "timestamp": datetime.now(timezone.utc).isoformat(),
                            })

                        # Post-commit: serious event notifications
                        for _evt in _screen_serious:
                            _handle_serious_proctoring_event(db, attempt, _evt)

                        screen_history = _get_cached_events()
                        reason = _maybe_auto_submit_from_history(
                            db,
                            attempt,
                            exam_cfg,
                            screen_history,
                            occurred_at=datetime.now(timezone.utc),
                            request_ip=get_websocket_ip(websocket),
                            violation_score=session_violation_score,
                        )
                        if reason:
                            await websocket.send_json({"type": "forced_submit", "detail": reason})
                            break
                        if _screen_forced_submit_msg:
                            break
                    except Exception as _se:
                        logger.debug("Screen OCR analysis error for attempt %s: %s", attempt_id, _se)
                    continue

                if msg_type == "answer_timing":
                    # Frontend reports time-per-question; flag suspiciously fast answers.
                    # Payload: {question_id, elapsed_ms, question_index}
                    elapsed_ms = int(data.get("elapsed_ms") or 0)
                    q_index = int(data.get("question_index") or 0) + 1
                    q_id = str(data.get("question_id") or "")[:64]
                    FAST_ANSWER_THRESHOLD_MS = 3000  # < 3 s is almost certainly random
                    if elapsed_ms > 0 and elapsed_ms < FAST_ANSWER_THRESHOLD_MS:
                        sev = SeverityEnum.MEDIUM
                        detail = (
                            f"Question {q_index} answered in {elapsed_ms} ms "
                            f"(threshold: {FAST_ANSWER_THRESHOLD_MS} ms)"
                        )
                        event = ProctoringEvent(
                            attempt_id=attempt_id,
                            event_type="FAST_ANSWER",
                            severity=sev,
                            detail=detail,
                            ai_confidence=0.85,
                            occurred_at=datetime.now(timezone.utc),
                            meta={"question_id": q_id, "elapsed_ms": elapsed_ms},
                        )
                        db.add(event)
                        _append_cached_event(event)
                        try:
                            await _async_db_commit()
                        except Exception as commit_err:
                            logger.warning("DB commit failed for FAST_ANSWER (attempt %s): %s", attempt_id, commit_err)
                            try:
                                db.rollback()
                            except Exception:
                                pass
                        await websocket.send_json({
                            "type": "alert",
                            "event_type": "FAST_ANSWER",
                            "severity": "MEDIUM",
                            "detail": detail,
                            "confidence": 0.85,
                        })
                        history_events = _get_cached_events()
                        reason = _maybe_auto_submit_from_history(
                            db,
                            attempt,
                            exam_cfg,
                            history_events,
                            occurred_at=event.occurred_at,
                            request_ip=get_websocket_ip(websocket),
                            violation_score=session_violation_score,
                        )
                        if reason:
                            await websocket.send_json({"type": "forced_submit", "detail": reason})
                            break
                    continue

                if msg_type == "keystroke_anomaly":
                    # Frontend reports suspiciously fast inter-key intervals (avg < 50 ms).
                    # Payload: {avg_interval_ms, sample_size}
                    avg_ms = float(data.get("avg_interval_ms") or 0)
                    samples = int(data.get("sample_size") or 0)
                    if avg_ms > 0 and samples >= 5:
                        detail = (
                            f"Abnormal keystroke cadence: avg {avg_ms:.0f} ms between keys "
                            f"({samples} keystrokes) — possible auto-fill or macro"
                        )
                        event = ProctoringEvent(
                            attempt_id=attempt_id,
                            event_type="KEYSTROKE_ANOMALY",
                            severity=SeverityEnum.MEDIUM,
                            detail=detail,
                            ai_confidence=0.80,
                            occurred_at=datetime.now(timezone.utc),
                            meta={"avg_interval_ms": avg_ms, "sample_size": samples},
                        )
                        db.add(event)
                        _append_cached_event(event)
                        try:
                            await _async_db_commit()
                        except Exception as commit_err:
                            logger.warning("DB commit failed for KEYSTROKE_ANOMALY (attempt %s): %s", attempt_id, commit_err)
                            try:
                                db.rollback()
                            except Exception:
                                pass
                        await websocket.send_json({
                            "type": "alert",
                            "event_type": "KEYSTROKE_ANOMALY",
                            "severity": "MEDIUM",
                            "detail": detail,
                            "confidence": 0.80,
                        })
                        history_events = _get_cached_events()
                        reason = _maybe_auto_submit_from_history(
                            db,
                            attempt,
                            exam_cfg,
                            history_events,
                            occurred_at=event.occurred_at,
                            request_ip=get_websocket_ip(websocket),
                            violation_score=session_violation_score,
                        )
                        if reason:
                            await websocket.send_json({"type": "forced_submit", "detail": reason})
                            break
                    continue

                if msg_type == "client_event":
                    # Browser-level violation sent directly by the frontend
                    # (copy/paste, keyboard shortcuts, tab switch, fullscreen exit, etc.)
                    _ALLOWED_CLIENT_EVENT_TYPES = {
                        "TAB_SWITCH", "FULLSCREEN_EXIT", "COPY_PASTE", "RIGHT_CLICK",
                        "KEYBOARD_SHORTCUT", "BROWSER_EVENT", "SCREEN_SHARE_LOST",
                        "DEVTOOLS_OPEN", "WINDOW_BLUR", "WINDOW_FOCUS",
                        "CLIPBOARD_ACCESS", "PRINT_ATTEMPT", "CONTEXT_MENU",
                    }
                    _ALLOWED_CLIENT_SEVERITIES = {"LOW", "MEDIUM"}
                    ce_type = str(data.get("event_type") or "BROWSER_EVENT").upper()[:64]
                    if ce_type not in _ALLOWED_CLIENT_EVENT_TYPES:
                        ce_type = "BROWSER_EVENT"
                    ce_sev_str = str(data.get("severity") or "MEDIUM").upper()
                    # Cap client-reported severity to MEDIUM — only server-side AI can set HIGH/CRITICAL
                    if ce_sev_str not in _ALLOWED_CLIENT_SEVERITIES:
                        ce_sev_str = "MEDIUM"
                    ce_detail = str(data.get("detail") or "Browser-level proctoring event")[:500]
                    ce_severity = SEVERITY_MAP.get(ce_sev_str, SeverityEnum.MEDIUM)
                    event_time = datetime.now(timezone.utc)
                    event = ProctoringEvent(
                        attempt_id=attempt_id,
                        event_type=ce_type,
                        severity=ce_severity,
                        detail=ce_detail,
                        ai_confidence=0.99,
                        occurred_at=event_time,
                    )
                    db.add(event)
                    _append_cached_event(event)
                    history_events = _get_cached_events()
                    rule_result = _apply_alert_rules(
                        db, attempt, exam_cfg, event, history_events,
                        event_time, request_ip=get_websocket_ip(websocket),
                    )
                    try:
                        await _async_db_commit()
                    except Exception as commit_err:
                        logger.warning("DB commit failed for client_event (attempt %s): %s", attempt_id, commit_err)
                        try:
                            db.rollback()
                        except Exception:
                            pass
                    if _is_serious_alert(ce_sev_str, ce_severity):
                        _handle_serious_proctoring_event(db, attempt, event)
                    for escalated_event in rule_result["created_events"]:
                        _handle_serious_proctoring_event(db, attempt, escalated_event)
                    await websocket.send_json({
                        "type": "alert",
                        "event_type": ce_type,
                        "severity": ce_sev_str,
                        "detail": ce_detail,
                        "confidence": 0.99,
                    })
                    for rule_alert in rule_result["alerts"]:
                        await websocket.send_json({
                            "type": "alert",
                            "event_type": rule_alert["event_type"],
                            "severity": rule_alert["severity"].value,
                            "detail": rule_alert["detail"],
                            "action": rule_alert["action"],
                            "rule_id": rule_alert["rule_id"],
                        })
                    if rule_result["forced_submit"]:
                        await websocket.send_json({"type": "forced_submit", "detail": rule_result["submit_reason"] or ""})
                        break
                    reason = _maybe_auto_submit_from_history(
                        db,
                        attempt,
                        exam_cfg,
                        history_events,
                        occurred_at=event_time,
                        request_ip=get_websocket_ip(websocket),
                        violation_score=session_violation_score,
                    )
                    if reason:
                        await websocket.send_json({"type": "forced_submit", "detail": reason})
                        break
                    continue
            except Exception as exc:
                logger.exception("Failed to process websocket message for attempt %s: %s", attempt_id, exc)
                try:
                    db.rollback()
                except Exception:
                    pass
                if websocket.application_state == WebSocketState.CONNECTED:
                    err_detail = str(exc)[:300] if str(exc) else "Unknown processing error"
                    try:
                        await websocket.send_json({
                            "type": "error",
                            "detail": f"Detection processing failed: {err_detail}",
                        })
                    except Exception:
                        pass
            finally:
                pass

    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Unexpected proctoring websocket error for attempt %s", attempt_id)
        if websocket.application_state == WebSocketState.CONNECTED:
            await websocket.close(code=1011)
    finally:
        if heartbeat_task is not None:
            heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat_task
        # Flush any uncommitted events before closing
        try:
            db.commit()
        except Exception:
            with contextlib.suppress(Exception):
                db.rollback()
        # Notify admin viewers that session ended and clean up Redis keys
        await live_bus.publish_session_closed(attempt_id)
        # Notify client of graceful close
        if websocket.application_state == WebSocketState.CONNECTED:
            with contextlib.suppress(Exception):
                await websocket.send_json({"type": "server_shutdown"})
                await websocket.close(code=1001)
        # Close the inference session so any per-attempt resources are released
        with contextlib.suppress(Exception):
            await inference_gateway.close_session(attempt_id)
        _release_db_session(db)


@router.get("/{attempt_id}/events", response_model=list[ProctoringEventRead])
def list_events(
    attempt_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    attempt = _attempt_or_forbidden(attempt_id, db, current)
    events = db.scalars(
        select(ProctoringEvent)
        .where(ProctoringEvent.attempt_id == attempt.id)
        .order_by(ProctoringEvent.occurred_at)
    ).all()
    return events


@router.get("/{attempt_id}/summary", response_model=AttemptProctoringSummaryRead)
def get_attempt_summary(
    attempt_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    attempt = _attempt_or_forbidden(attempt_id, db, current)
    events = _load_attempt_events(db, attempt.id)
    return _build_attempt_proctoring_summary(attempt, events)


@router.post("/{attempt_id}/generate-report")
def generate_report(
    attempt_id: str,
    output_format: str = "html",
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    attempt = _attempt_or_forbidden(attempt_id, db, current)
    normalized_format = str(output_format or "html").strip().lower()
    filename_stub = f"proctoring-report-{str(attempt.id)[:8]}"
    if normalized_format == "pdf":
        pdf_content = generate_pdf_report(db, attempt)
        return StreamingResponse(
            BytesIO(pdf_content),
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename_stub}.pdf"'},
        )
    if normalized_format != "html":
        raise HTTPException(status_code=400, detail=_t("unsupported_report_format"))
    html_content = generate_html_report(db, attempt)
    return HTMLResponse(content=html_content, media_type="text/html")
