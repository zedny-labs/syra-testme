import logging
import mimetypes
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from ..core.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

_CLOUDFLARE_NOT_READY_STATUSES = {"queued", "pending", "uploading", "processing", "inprogress", "error", "failed"}
_CF_STREAM_URL_RE = re.compile(
    r"(https://[^/]+\.cloudflarestream\.com/)([a-f0-9]{32})(/.*)",
)


def _signing_available() -> bool:
    return bool(settings.CLOUDFLARE_STREAM_SIGNING_KEY and settings.CLOUDFLARE_STREAM_KEY_ID)


def generate_signed_token(video_uid: str, *, expires_in: int = 3600) -> str | None:
    """Generate a Cloudflare Stream signed JWT for a video UID.

    Requires CLOUDFLARE_STREAM_SIGNING_KEY (PEM RSA private key, base64 or raw)
    and CLOUDFLARE_STREAM_KEY_ID to be configured.
    Returns None if signing is not configured.
    """
    if not _signing_available():
        return None
    try:
        from jose import jwt as jose_jwt
        import base64

        key_raw = settings.CLOUDFLARE_STREAM_SIGNING_KEY
        # The signing key from Cloudflare is base64-encoded PEM
        if not key_raw.startswith("-----"):
            key_raw = base64.b64decode(key_raw).decode("utf-8")

        token = jose_jwt.encode(
            {
                "sub": video_uid,
                "kid": settings.CLOUDFLARE_STREAM_KEY_ID,
                "exp": int(time.time()) + expires_in,
            },
            key_raw,
            algorithm="RS256",
            headers={"kid": settings.CLOUDFLARE_STREAM_KEY_ID},
        )
        return token
    except Exception as exc:
        logger.warning("Failed to generate Cloudflare signed token: %s", exc)
        return None


def sign_cloudflare_playback_url(url: str) -> str:
    """Replace the video UID in a Cloudflare Stream URL with a signed JWT token.

    Input:  https://customer-xxx.cloudflarestream.com/<video-uid>/manifest/video.m3u8
    Output: https://customer-xxx.cloudflarestream.com/<signed-token>/manifest/video.m3u8
    """
    match = _CF_STREAM_URL_RE.match(url or "")
    if not match:
        return url
    video_uid = match.group(2)
    token = generate_signed_token(video_uid)
    if not token:
        return url
    return f"{match.group(1)}{token}{match.group(3)}"


def cloudflare_video_storage_enabled() -> bool:
    return bool(str(settings.CLOUDFLARE_MEDIA_API_BASE_URL or "").strip())


def _base_url() -> str:
    return str(settings.CLOUDFLARE_MEDIA_API_BASE_URL or "").rstrip("/")


def _extract_video_payload(payload: object) -> dict:
    if not isinstance(payload, dict):
        return {}

    for key in ("video", "data", "result"):
        candidate = payload.get(key)
        if isinstance(candidate, dict) and candidate:
            return candidate

    return payload


def infer_cloudflare_ready_to_stream(*, status: object, ready_to_stream: object, playback_url: object) -> bool:
    normalized_status = str(status or "").strip().lower()
    if normalized_status in _CLOUDFLARE_NOT_READY_STATUSES:
        return False
    if ready_to_stream is not None:
        return bool(ready_to_stream)
    return bool(str(playback_url or "").strip())


def _normalize_remote_video(
    payload: dict,
    *,
    filename: str,
    source: str,
    fallback_size: int,
    fallback_created_at: datetime,
) -> dict:
    playback_url = str(payload.get("playback_url") or payload.get("url") or "").strip()
    created_at = payload.get("created") or fallback_created_at.astimezone(timezone.utc).isoformat()
    raw_status = str(payload.get("status") or "").strip().lower()
    ready_to_stream = infer_cloudflare_ready_to_stream(
        status=raw_status,
        ready_to_stream=payload.get("ready_to_stream"),
        playback_url=playback_url,
    )
    return {
        "provider": "cloudflare",
        "name": str(payload.get("name") or filename),
        "url": playback_url,
        "playback_url": playback_url,
        "playback_type": "hls" if playback_url.endswith(".m3u8") else "direct",
        "thumbnail": payload.get("thumbnail"),
        "uid": payload.get("uid"),
        "status": raw_status or ("ready" if ready_to_stream else "processing"),
        "ready_to_stream": bool(ready_to_stream),
        "duration": payload.get("duration"),
        "size": int(payload.get("size") or fallback_size or 0),
        "source": source,
        "created_at": created_at,
        "remote": payload,
    }


async def _lookup_video_by_name(filename: str, source: str, fallback_size: int) -> dict:
    params = {"search": filename}
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.get(f"{_base_url()}/videos", params=params)
        response.raise_for_status()
        payload = response.json()

    if not isinstance(payload, dict):
        return {}

    videos = payload.get("videos")
    if not isinstance(videos, list):
        return {}

    exact_matches = [item for item in videos if isinstance(item, dict) and str(item.get("name") or "") == filename]
    if not exact_matches:
        return {}

    best = sorted(exact_matches, key=lambda item: str(item.get("created") or ""), reverse=True)[0]
    return _normalize_remote_video(
        best,
        filename=filename,
        source=source,
        fallback_size=fallback_size,
        fallback_created_at=datetime.now(timezone.utc),
    )


async def get_cloudflare_video_details(
    *,
    uid: str | None = None,
    filename: str | None = None,
    source: str = "camera",
    fallback_size: int = 0,
) -> dict:
    normalized_source = str(source or "camera").strip().lower() or "camera"

    if uid:
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                response = await client.get(f"{_base_url()}/videos/{uid}")
                response.raise_for_status()
                payload = response.json()
            normalized = _normalize_remote_video(
                _extract_video_payload(payload),
                filename=str(filename or uid),
                source=normalized_source,
                fallback_size=fallback_size,
                fallback_created_at=datetime.now(timezone.utc),
            )
            if normalized:
                return normalized
        except Exception as exc:
            logger.warning("Failed to fetch Cloudflare video %s: %s", uid, exc)

    if filename:
        return await _lookup_video_by_name(str(filename), normalized_source, fallback_size)

    return {}


async def delete_cloudflare_video(uid: str, *, client: httpx.AsyncClient | None = None) -> bool:
    """Permanently delete a video from the Cloudflare media gateway. Returns True
    on success (including if the video was already gone), False if the delete
    call failed."""
    if not str(uid or "").strip():
        return False

    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=60)
    try:
        response = await client.delete(f"{_base_url()}/videos/{uid}")
        if response.status_code == 404:
            return True
        response.raise_for_status()
        return True
    except Exception as exc:
        logger.warning("Failed to delete Cloudflare video %s: %s", uid, exc)
        return False
    finally:
        if owns_client:
            await client.aclose()


async def upload_video_to_cloudflare(file_path: Path, *, filename: str, source: str) -> dict:
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    file_size = file_path.stat().st_size if file_path.exists() else 0
    params = {
        "require_signed_urls": settings.CLOUDFLARE_MEDIA_REQUIRE_SIGNED_URLS,
    }
    if settings.CLOUDFLARE_MEDIA_WATERMARK_UID:
        params["watermark_uid"] = settings.CLOUDFLARE_MEDIA_WATERMARK_UID

    async with httpx.AsyncClient(timeout=300) as client:
        with file_path.open("rb") as handle:
            response = await client.post(
                f"{_base_url()}/upload/single",
                params=params,
                files={"file": (filename, handle, content_type)},
            )
            response.raise_for_status()
            payload = response.json()

    normalized = _normalize_remote_video(
        _extract_video_payload(payload),
        filename=filename,
        source=source,
        fallback_size=file_size,
        fallback_created_at=datetime.now(timezone.utc),
    )
    if normalized.get("url"):
        return normalized

    looked_up = await _lookup_video_by_name(filename, source, normalized.get("size") or file_size)
    if looked_up.get("url"):
        return looked_up

    raise RuntimeError("Cloudflare upload succeeded but no playback URL was returned")


async def upload_video_content_to_cloudflare(
    content: bytes,
    *,
    filename: str,
    source: str,
    content_type: str = "application/octet-stream",
) -> dict:
    params = {
        "require_signed_urls": settings.CLOUDFLARE_MEDIA_REQUIRE_SIGNED_URLS,
    }
    if settings.CLOUDFLARE_MEDIA_WATERMARK_UID:
        params["watermark_uid"] = settings.CLOUDFLARE_MEDIA_WATERMARK_UID

    async with httpx.AsyncClient(timeout=300) as client:
        response = await client.post(
            f"{_base_url()}/upload/single",
            params=params,
            files={"file": (filename, content, content_type)},
        )
        response.raise_for_status()
        payload = response.json()

    normalized = _normalize_remote_video(
        _extract_video_payload(payload),
        filename=filename,
        source=source,
        fallback_size=len(content or b""),
        fallback_created_at=datetime.now(timezone.utc),
    )
    if normalized.get("url"):
        return normalized

    looked_up = await _lookup_video_by_name(filename, source, normalized.get("size") or 0)
    if looked_up.get("url"):
        return looked_up

    raise RuntimeError("Cloudflare upload succeeded but no playback URL was returned")
