"""Vimeo storage provider for proctoring recordings.

Mirrors the shape of ``cloudflare_media``/``supabase_storage`` so the proctoring
video pipeline can treat Vimeo as an interchangeable ``PROCTORING_VIDEO_STORAGE_PROVIDER``.

Uploads use Vimeo's resumable ``tus`` approach: create the video resource
(``POST /me/videos``) then stream the file to the returned ``upload_link``. On a
``standard`` Vimeo account progressive/HLS file URLs are not exposed, so playback
is done through the embed player — the normalized ``playback_type`` is
``"vimeo_embed"`` and ``url``/``playback_url`` carry the ``player_embed_url``
(which already contains the private ``?h=`` hash).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx

from ..core.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

API_BASE = "https://api.vimeo.com"
_API_VERSION_ACCEPT = "application/vnd.vimeo.*+json;version=3.4"
# Bytes streamed per tus PATCH. Kept well under the in-memory upload limit; tests
# monkeypatch this to exercise the multi-chunk path.
_TUS_CHUNK_SIZE = 128 * 1024 * 1024


def _token() -> str:
    return str(settings.VIMEO_ACCESS_TOKEN or "").strip()


def vimeo_video_storage_enabled() -> bool:
    return bool(_token())


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_token()}",
        "Accept": _API_VERSION_ACCEPT,
    }


def _extract_hash(url: str | None) -> str | None:
    values = parse_qs(urlsplit(str(url or "")).query).get("h")
    return values[0] if values else None


def _extract_video_id(uri: str | None) -> str | None:
    last = str(uri or "").rstrip("/").split("/")[-1]
    # Some responses use "/videos/<id>:<hash>".
    video_id = last.split(":")[0].strip()
    return video_id or None


def infer_vimeo_ready_to_stream(*, transcode_status: object, video_status: object) -> bool:
    transcode = str(transcode_status or "").strip().lower()
    if transcode == "complete":
        return True
    if transcode in {"in_progress", "starting", "error"}:
        return False
    return str(video_status or "").strip().lower() == "available"


def _normalize_remote_video(
    payload: dict,
    *,
    source: str,
    fallback_size: int = 0,
    name: str | None = None,
) -> dict:
    if not isinstance(payload, dict):
        payload = {}

    uri = str(payload.get("uri") or "").strip()
    video_id = _extract_video_id(uri)
    embed_url = str(payload.get("player_embed_url") or "").strip()
    if not embed_url and video_id:
        embed_url = f"https://player.vimeo.com/video/{video_id}"

    transcode_status = (payload.get("transcode") or {}).get("status") if isinstance(payload.get("transcode"), dict) else None
    video_status = payload.get("status")
    ready = infer_vimeo_ready_to_stream(transcode_status=transcode_status, video_status=video_status)
    if ready:
        status = "ready"
    elif str(transcode_status or "").strip().lower() == "error":
        status = "error"
    else:
        status = "processing"

    pictures = payload.get("pictures")
    thumbnail = pictures.get("base_link") if isinstance(pictures, dict) else None

    return {
        "provider": "vimeo",
        "name": str(payload.get("name") or name or video_id or ""),
        "uid": video_id,
        "uri": uri,
        "url": embed_url,
        "playback_url": embed_url,
        "playback_type": "vimeo_embed",
        "hash": _extract_hash(embed_url),
        "thumbnail": thumbnail,
        "status": status,
        "ready_to_stream": bool(ready),
        "duration": payload.get("duration"),
        "size": int(payload.get("size") or fallback_size or 0),
        "source": source,
        "created_at": payload.get("created_time") or datetime.now(timezone.utc).isoformat(),
        "remote": payload,
    }


def _new_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=30.0))


async def _create_video(client: httpx.AsyncClient, *, filename: str, size: int) -> dict:
    body = {
        "upload": {"approach": "tus", "size": str(size)},
        "name": filename,
        "privacy": {
            "view": str(settings.VIMEO_PRIVACY_VIEW or "unlisted"),
            "embed": "public",
        },
    }
    response = await client.post(f"{API_BASE}/me/videos", headers=_headers(), json=body)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("Vimeo create-video returned an unexpected response")
    return payload


async def _tus_upload(client: httpx.AsyncClient, upload_link: str, file_path: Path, size: int) -> None:
    if not upload_link:
        raise RuntimeError("Vimeo create-video response did not include a tus upload_link")

    offset = 0
    with file_path.open("rb") as handle:
        while offset < size:
            chunk = handle.read(_TUS_CHUNK_SIZE)
            if not chunk:
                break
            response = await client.patch(
                upload_link,
                headers={
                    "Tus-Resumable": "1.0.0",
                    "Upload-Offset": str(offset),
                    "Content-Type": "application/offset+octet-stream",
                },
                content=chunk,
            )
            response.raise_for_status()
            offset = int(response.headers.get("upload-offset", offset + len(chunk)))

    if offset < size:
        raise RuntimeError(f"Vimeo tus upload incomplete: {offset}/{size} bytes")


async def _add_to_folder(client: httpx.AsyncClient, video_id: str | None) -> None:
    folder_id = str(settings.VIMEO_FOLDER_ID or "").strip()
    if not folder_id or not video_id:
        return
    try:
        response = await client.put(
            f"{API_BASE}/me/projects/{folder_id}/videos/{video_id}",
            headers=_headers(),
        )
        response.raise_for_status()
    except Exception as exc:  # best-effort: a failed filing must not fail the upload
        logger.warning("Failed to file Vimeo video %s into folder %s: %s", video_id, folder_id, exc)


async def upload_video_to_vimeo(
    file_path: Path,
    *,
    filename: str,
    source: str,
    client: httpx.AsyncClient | None = None,
) -> dict:
    if not vimeo_video_storage_enabled():
        raise RuntimeError("Vimeo storage is not configured (VIMEO_ACCESS_TOKEN missing)")

    file_size = file_path.stat().st_size if file_path.exists() else 0
    owns_client = client is None
    client = client or _new_client()
    try:
        payload = await _create_video(client, filename=filename, size=file_size)
        upload_link = str((payload.get("upload") or {}).get("upload_link") or "")
        await _tus_upload(client, upload_link, file_path, file_size)
        await _add_to_folder(client, _extract_video_id(payload.get("uri")))
        return _normalize_remote_video(payload, source=source, fallback_size=file_size, name=filename)
    finally:
        if owns_client:
            await client.aclose()


async def get_vimeo_video_details(
    *,
    uid: str | None = None,
    uri: str | None = None,
    source: str = "camera",
    client: httpx.AsyncClient | None = None,
) -> dict:
    video_id = uid or _extract_video_id(uri)
    if not video_id:
        return {}

    owns_client = client is None
    client = client or _new_client()
    try:
        response = await client.get(f"{API_BASE}/videos/{video_id}", headers=_headers())
        response.raise_for_status()
        payload = response.json()
        return _normalize_remote_video(payload, source=source, name=None)
    except Exception as exc:
        logger.warning("Failed to fetch Vimeo video %s: %s", video_id, exc)
        return {}
    finally:
        if owns_client:
            await client.aclose()
