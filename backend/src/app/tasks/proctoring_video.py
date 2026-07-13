from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from celery import Task

from ..core.celery_app import celery_app
from ..core.config import get_settings
from ..db.session import SessionLocal
from ..models import ProctoringEvent, SeverityEnum
from ..services.cloudflare_media import get_cloudflare_video_details, upload_video_to_cloudflare
from ..services.vimeo_media import get_vimeo_video_details, upload_video_to_vimeo

logger = logging.getLogger(__name__)


def _run_async(coro):
    """Run an async coroutine from synchronous Celery task code.

    Falls back to a thread-pool approach if an event loop is already running
    (e.g. gevent/eventlet worker pools).
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(asyncio.run, coro).result()


BASE_STORAGE_DIR = Path(__file__).resolve().parent.parent.parent.parent / "storage"
VIDEO_UPLOAD_SPOOL_DIR = BASE_STORAGE_DIR / "video_uploads"

_CLOUDFLARE_REFRESH_ATTEMPTS = 6
_CLOUDFLARE_REFRESH_DELAY_SECONDS = 5
_INVALID_VIDEO_STATUSES = {"error", "failed"}
_UPLOAD_RETRY_LIMIT = 3


def _safe_int(value: object, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _safe_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _normalize_file_info(file_info: Mapping[str, Any] | None) -> dict[str, Any]:
    data = dict(file_info or {})
    return {
        **data,
        "provider": str(data.get("provider") or "").strip().lower(),
        "source": str(data.get("source") or "camera").strip().lower() or "camera",
        "session_id": str(data.get("session_id") or "").strip(),
        "name": str(data.get("name") or "").strip(),
        "uid": str(data.get("uid") or "").strip(),
        "status": str(data.get("status") or "").strip().lower(),
        "size": max(0, _safe_int(data.get("size"))),
        "duration": _safe_float(data.get("duration"), 0.0),
        "ready_to_stream": bool(data.get("ready_to_stream")),
    }


def _normalize_upload_request(payload: Mapping[str, Any] | None) -> dict[str, Any]:
    data = dict(payload or {})
    return {
        "provider": str(data.get("provider") or "").strip().lower() or None,
        "session_id": str(data.get("session_id") or "").strip(),
        "source": str(data.get("source") or "camera").strip().lower() or "camera",
        "filename": str(data.get("filename") or "").strip(),
        "extension": str(data.get("extension") or "").replace(".", "").strip().lower() or "webm",
        "spool_path": str(data.get("spool_path") or "").strip(),
        "size": max(0, _safe_int(data.get("size"))),
        "content_type": str(data.get("content_type") or "application/octet-stream").strip() or "application/octet-stream",
        "recording_started_at": str(data.get("recording_started_at") or "").strip() or None,
        "recording_stopped_at": str(data.get("recording_stopped_at") or "").strip() or None,
        "upload_ip": str(data.get("upload_ip") or "").strip() or None,
    }


def _resolve_spool_path(raw_path: str) -> Path:
    candidate = Path(str(raw_path or "")).expanduser()
    if not candidate.is_absolute():
        candidate = (VIDEO_UPLOAD_SPOOL_DIR / candidate).resolve()
    else:
        candidate = candidate.resolve()

    spool_root = VIDEO_UPLOAD_SPOOL_DIR.resolve()
    if candidate != spool_root and spool_root not in candidate.parents:
        raise ValueError("Queued upload spool path is outside the allowed storage directory")
    return candidate


def _build_uploaded_file_info(*, remote: Mapping[str, Any], upload_request: Mapping[str, Any]) -> dict[str, Any]:
    source = str(upload_request.get("source") or "camera").strip().lower() or "camera"
    provider = str(remote.get("provider") or upload_request.get("provider") or "cloudflare").strip().lower() or "cloudflare"
    file_info: dict[str, Any] = {
        "provider": provider,
        "session_id": str(upload_request.get("session_id") or "").strip(),
        "source": source,
        "extension": str(upload_request.get("extension") or "webm").replace(".", "").strip().lower() or "webm",
        "name": str(remote.get("name") or upload_request.get("filename") or "").strip(),
        "url": remote.get("url") or remote.get("playback_url"),
        "playback_url": remote.get("playback_url") or remote.get("url"),
        "playback_type": remote.get("playback_type"),
        "thumbnail": remote.get("thumbnail"),
        "uid": remote.get("uid"),
        "uri": remote.get("uri"),
        "hash": remote.get("hash"),
        "status": remote.get("status"),
        "ready_to_stream": remote.get("ready_to_stream"),
        "duration": remote.get("duration"),
        "size": remote.get("size") or max(0, _safe_int(upload_request.get("size"))),
        "created_at": remote.get("created_at"),
        "recording_started_at": upload_request.get("recording_started_at"),
        "recording_stopped_at": upload_request.get("recording_stopped_at"),
        "remote": remote.get("remote") if isinstance(remote.get("remote"), dict) else dict(remote),
    }
    upload_ip = str(upload_request.get("upload_ip") or "").strip()
    if upload_ip:
        file_info["upload_ip"] = upload_ip
    return {key: value for key, value in file_info.items() if value not in (None, "")}


def _queue_video_batch_event(*, attempt_id: str, file_info: dict[str, Any], job_id: str) -> None:
    meta = {
        "job_id": str(job_id),
        "status": "QUEUED",
        "detail": "Batch video analysis queued.",
        "analysis_status_url": f"/api/proctoring/{attempt_id}/jobs/{job_id}/status",
        "session_id": str(file_info.get("session_id") or ""),
        "source": str(file_info.get("source") or "camera"),
        "file": file_info,
    }
    _record_event(
        attempt_id=attempt_id,
        event_type="VIDEO_BATCH_ANALYSIS_QUEUED",
        severity=SeverityEnum.LOW,
        detail=f"Batch analysis queued for {str(file_info.get('source') or 'video').title()} recording",
        meta=meta,
    )


def _refresh_cloudflare_info(file_info: dict[str, Any]) -> dict[str, Any]:
    current = dict(file_info)
    uid = str(current.get("uid") or "").strip()
    name = str(current.get("name") or "").strip()
    source = str(current.get("source") or "camera").strip().lower() or "camera"
    size = max(0, _safe_int(current.get("size")))

    for attempt in range(_CLOUDFLARE_REFRESH_ATTEMPTS):
        try:
            refreshed = _run_async(
                get_cloudflare_video_details(
                    uid=uid or None,
                    filename=name or None,
                    source=source,
                    fallback_size=size,
                )
            )
        except Exception as exc:
            logger.warning("Cloudflare metadata refresh failed for %s: %s", uid or name or source, exc)
            break

        if refreshed:
            current.update(refreshed)
            current = _normalize_file_info(current)
            if current.get("ready_to_stream"):
                return current
        if attempt < _CLOUDFLARE_REFRESH_ATTEMPTS - 1:
            time.sleep(_CLOUDFLARE_REFRESH_DELAY_SECONDS)
    return current


def _refresh_vimeo_info(file_info: dict[str, Any]) -> dict[str, Any]:
    current = dict(file_info)
    uid = str(current.get("uid") or "").strip()
    uri = str(current.get("uri") or "").strip()
    source = str(current.get("source") or "camera").strip().lower() or "camera"
    size = max(0, _safe_int(current.get("size")))

    for attempt in range(_CLOUDFLARE_REFRESH_ATTEMPTS):
        try:
            refreshed = _run_async(
                get_vimeo_video_details(uid=uid or None, uri=uri or None, source=source)
            )
        except Exception as exc:
            logger.warning("Vimeo metadata refresh failed for %s: %s", uid or uri or source, exc)
            break

        if refreshed:
            # Vimeo detail responses omit byte size; keep the known upload size.
            if not refreshed.get("size") and size:
                refreshed["size"] = size
            current.update(refreshed)
            current = _normalize_file_info(current)
            if current.get("ready_to_stream"):
                return current
        if attempt < _CLOUDFLARE_REFRESH_ATTEMPTS - 1:
            time.sleep(_CLOUDFLARE_REFRESH_DELAY_SECONDS)
    return current


def _build_findings(file_info: dict[str, Any]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    provider = str(file_info.get("provider") or "").strip().lower()
    source = str(file_info.get("source") or "camera").strip().lower() or "camera"
    status = str(file_info.get("status") or "").strip().lower()
    size = max(0, _safe_int(file_info.get("size")))
    duration = _safe_float(file_info.get("duration"), 0.0)
    ready_to_stream = bool(file_info.get("ready_to_stream"))

    if status in _INVALID_VIDEO_STATUSES:
        findings.append({
            "code": "VIDEO_STREAM_ERROR",
            "severity": "MEDIUM",
            "detail": f"{source.title()} recording upload reached storage, but playback processing failed.",
        })
    elif size <= 0:
        findings.append({
            "code": "VIDEO_UPLOAD_EMPTY",
            "severity": "MEDIUM",
            "detail": f"{source.title()} recording uploaded with zero bytes.",
        })
    else:
        findings.append({
            "code": "VIDEO_UPLOAD_CAPTURED",
            "severity": "LOW",
            "detail": f"{source.title()} recording captured successfully ({size} bytes).",
        })

    if duration > 0 and duration < 5:
        findings.append({
            "code": "VIDEO_DURATION_SHORT",
            "severity": "LOW",
            "detail": f"{source.title()} recording is short ({duration:.1f}s).",
        })

    if provider == "cloudflare":
        if status in _INVALID_VIDEO_STATUSES:
            findings.append({
                "code": "VIDEO_STREAM_UNAVAILABLE",
                "severity": "MEDIUM",
                "detail": f"{source.title()} Cloudflare stream is unavailable because processing failed.",
            })
        else:
            findings.append({
                "code": "VIDEO_STREAM_READY" if ready_to_stream else "VIDEO_TRANSCODING_PENDING",
                "severity": "LOW",
                "detail": (
                    f"{source.title()} Cloudflare stream is ready for playback."
                    if ready_to_stream
                    else f"{source.title()} Cloudflare stream is still processing."
                ),
            })

    return findings


def _build_summary(file_info: dict[str, Any], findings: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "provider": file_info.get("provider"),
        "source": file_info.get("source"),
        "session_id": file_info.get("session_id"),
        "size_bytes": max(0, _safe_int(file_info.get("size"))),
        "duration_seconds": _safe_float(file_info.get("duration"), 0.0),
        "ready_to_stream": bool(file_info.get("ready_to_stream")),
        "playback_type": file_info.get("playback_type"),
        "finding_count": len(findings),
    }


def _event_severity(findings: list[dict[str, Any]]) -> SeverityEnum:
    severities = {str(item.get("severity") or "").upper() for item in findings}
    if "MEDIUM" in severities or "HIGH" in severities or "CRITICAL" in severities:
        return SeverityEnum.MEDIUM
    return SeverityEnum.LOW


def _record_event(
    *,
    attempt_id: str,
    event_type: str,
    severity: SeverityEnum,
    detail: str,
    meta: dict[str, Any],
) -> None:
    db = SessionLocal()
    try:
        event = ProctoringEvent(
            attempt_id=attempt_id,
            event_type=event_type,
            severity=severity,
            detail=detail,
            meta=meta,
            occurred_at=datetime.now(timezone.utc),
        )
        db.add(event)
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.warning("Failed to record %s event for attempt %s: %s", event_type, attempt_id, exc)
    finally:
        db.close()


def _video_batch_analysis_enabled() -> bool:
    settings = get_settings()
    return bool(
        settings.PROCTORING_BATCH_ANALYSIS_ENABLED
        and settings.celery_broker_url
        and settings.celery_result_backend
    )


def _video_batch_dispatch_delay_seconds() -> int:
    settings = get_settings()
    return max(0, int(getattr(settings, "PROCTORING_BATCH_ANALYSIS_DISPATCH_DELAY_SECONDS", 0) or 0))


@celery_app.task(
    bind=True,
    name="upload_proctoring_video_capture",
    queue="proctoring-batch",
)
def upload_proctoring_video_capture(self: Task, attempt_id: str, upload_request: dict[str, Any]) -> dict[str, Any]:
    job_id = str(self.request.id or "")
    normalized_request = _normalize_upload_request(upload_request)
    source = str(normalized_request.get("source") or "camera")
    provider = str(normalized_request.get("provider") or get_settings().PROCTORING_VIDEO_STORAGE_PROVIDER or "cloudflare").strip().lower()
    spool_path = _resolve_spool_path(str(normalized_request.get("spool_path") or ""))

    if not spool_path.is_file():
        raise FileNotFoundError(f"Queued upload file not found: {spool_path}")

    filename = str(normalized_request.get("filename") or spool_path.name)
    try:
        if provider == "vimeo":
            remote = _run_async(upload_video_to_vimeo(spool_path, filename=filename, source=source))
        else:
            remote = _run_async(upload_video_to_cloudflare(spool_path, filename=filename, source=source))
    except Exception as exc:
        retries = int(self.request.retries or 0)
        if retries < _UPLOAD_RETRY_LIMIT:
            countdown = min(30, 5 * (2 ** retries))
            raise self.retry(exc=exc, countdown=countdown) from exc

        failure_meta = {
            "job_id": job_id,
            "status": "FAILED",
            "detail": str(exc)[:500] or f"Queued {provider} upload failed.",
            "session_id": str(normalized_request.get("session_id") or ""),
            "source": source,
            "filename": filename,
            "size": max(0, _safe_int(normalized_request.get("size"))),
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
        _record_event(
            attempt_id=attempt_id,
            event_type="VIDEO_UPLOAD_FAILED",
            severity=SeverityEnum.MEDIUM,
            detail=f"Queued {provider} upload failed for {source} recording",
            meta=failure_meta,
        )
        spool_path.unlink(missing_ok=True)
        raise

    file_info = _build_uploaded_file_info(remote=remote, upload_request=normalized_request)
    _record_event(
        attempt_id=attempt_id,
        event_type="VIDEO_SAVED",
        severity=SeverityEnum.LOW,
        detail=f"Proctoring {source} video saved",
        meta=file_info,
    )

    result = {
        "job_id": job_id,
        "status": "COMPLETED",
        "detail": "Video uploaded successfully.",
        "session_id": str(file_info.get("session_id") or ""),
        "source": source,
        "file": file_info,
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }

    if _video_batch_analysis_enabled():
        dispatch_delay = _video_batch_dispatch_delay_seconds()
        batch_task = process_uploaded_proctoring_video.apply_async(
            kwargs={"attempt_id": str(attempt_id), "file_info": dict(file_info or {})},
            queue="proctoring-batch",
            countdown=dispatch_delay,
        )
        _queue_video_batch_event(attempt_id=attempt_id, file_info=file_info, job_id=str(batch_task.id))

    spool_path.unlink(missing_ok=True)
    return result


@celery_app.task(
    bind=True,
    name="process_uploaded_proctoring_video",
    queue="proctoring-batch",
)
def process_uploaded_proctoring_video(self: Task, attempt_id: str, file_info: dict[str, Any]) -> dict[str, Any]:
    job_id = str(self.request.id or "")
    normalized_file = _normalize_file_info(file_info)

    try:
        if normalized_file.get("provider") == "cloudflare":
            normalized_file = _refresh_cloudflare_info(normalized_file)
        elif normalized_file.get("provider") == "vimeo":
            normalized_file = _refresh_vimeo_info(normalized_file)

        findings = _build_findings(normalized_file)
        summary = _build_summary(normalized_file, findings)
        result = {
            "job_id": job_id,
            "status": "COMPLETED",
            "detail": "Batch video analysis completed.",
            "session_id": normalized_file.get("session_id"),
            "source": normalized_file.get("source"),
            "findings": findings,
            "summary": summary,
            "file": normalized_file,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }

        _record_event(
            attempt_id=attempt_id,
            event_type="VIDEO_BATCH_ANALYSIS_COMPLETED",
            severity=_event_severity(findings),
            detail=f"Batch analysis completed for {normalized_file.get('source', 'video')} recording",
            meta=result,
        )
        return result
    except Exception as exc:
        logger.exception("Batch analysis failed for attempt %s: %s", attempt_id, exc)
        failure = {
            "job_id": job_id,
            "status": "FAILED",
            "detail": str(exc)[:500] or "Batch analysis failed.",
            "session_id": normalized_file.get("session_id"),
            "source": normalized_file.get("source"),
            "findings": [],
            "summary": {
                "provider": normalized_file.get("provider"),
                "source": normalized_file.get("source"),
                "session_id": normalized_file.get("session_id"),
            },
            "file": normalized_file,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
        _record_event(
            attempt_id=attempt_id,
            event_type="VIDEO_BATCH_ANALYSIS_FAILED",
            severity=SeverityEnum.MEDIUM,
            detail=f"Batch analysis failed for {normalized_file.get('source', 'video')} recording",
            meta=failure,
        )
        raise
