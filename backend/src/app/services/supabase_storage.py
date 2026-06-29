from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import httpx

from ..core.config import get_settings

settings = get_settings()
_KNOWN_OBJECT_FOLDERS = {"identity", "evidence", "reports", "videos", "questions"}


def supabase_storage_configured() -> bool:
    return bool(
        str(settings.SUPABASE_URL or "").strip()
        and str(settings.SUPABASE_SECRET_KEY or "").strip()
        and str(settings.SUPABASE_STORAGE_BUCKET or "").strip()
    )


def media_storage_uses_supabase() -> bool:
    return settings.MEDIA_STORAGE_PROVIDER == "supabase" and supabase_storage_configured()


def supabase_video_storage_enabled() -> bool:
    return settings.PROCTORING_VIDEO_STORAGE_PROVIDER == "supabase" and supabase_storage_configured()


def build_object_path(folder: str, filename: str) -> str:
    normalized_folder = str(folder or "").strip().lower().replace("\\", "/").strip("/")
    if normalized_folder not in _KNOWN_OBJECT_FOLDERS:
        raise ValueError(f"Unsupported Supabase storage folder: {folder}")

    safe_filename = Path(str(filename or "")).name
    if not safe_filename or safe_filename in {".", ".."}:
        raise ValueError("A valid Supabase object filename is required")
    return f"{normalized_folder}/{safe_filename}"


def _api_base_url() -> str:
    return f"{str(settings.SUPABASE_URL or '').rstrip('/')}/storage/v1"


def _headers() -> dict[str, str]:
    api_key = str(settings.SUPABASE_SECRET_KEY or "").strip()
    if not api_key:
        raise RuntimeError("SUPABASE_SECRET_KEY is not configured")
    return {
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
    }


def _quoted_object_path(object_path: str) -> str:
    return quote(str(object_path or "").strip(), safe="/")


def _normalize_signed_url(candidate: str) -> str:
    raw = str(candidate or "").strip()
    if not raw:
        return ""
    if raw.startswith(("http://", "https://")):
        return raw
    if raw.startswith("/storage/v1/"):
        return f"{str(settings.SUPABASE_URL or '').rstrip('/')}{raw}"
    if raw.startswith("/object/"):
        return f"{_api_base_url()}{raw}"
    if raw.startswith("object/"):
        return f"{_api_base_url()}/{raw}"
    return ""


def _extract_signed_url(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""

    for key in ("signedURL", "signedUrl", "signed_url"):
        normalized = _normalize_signed_url(payload.get(key))
        if normalized:
            return normalized

    nested = payload.get("data")
    if isinstance(nested, dict):
        for key in ("signedURL", "signedUrl", "signed_url"):
            normalized = _normalize_signed_url(nested.get(key))
            if normalized:
                return normalized

    return ""


def _response_error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except Exception:
        payload = response.text

    if isinstance(payload, dict):
        for key in ("message", "error", "msg"):
            value = str(payload.get(key) or "").strip()
            if value:
                return value
    text = str(payload or "").strip()
    return text or f"HTTP {response.status_code}"


async def create_signed_url(object_path: str, *, expires_in: int | None = None) -> str:
    if not supabase_storage_configured():
        raise RuntimeError("Supabase storage is not configured")

    effective_expires_in = int(expires_in or settings.SUPABASE_SIGNED_URL_EXPIRES_SECONDS)
    request_url = (
        f"{_api_base_url()}/object/sign/"
        f"{quote(str(settings.SUPABASE_STORAGE_BUCKET or '').strip(), safe='')}/"
        f"{_quoted_object_path(object_path)}"
    )

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            request_url,
            headers={**_headers(), "Content-Type": "application/json"},
            json={"expiresIn": effective_expires_in},
        )

    if response.is_error:
        raise RuntimeError(f"Supabase signed URL creation failed: {_response_error_message(response)}")

    signed_url = _extract_signed_url(response.json())
    if not signed_url:
        raise RuntimeError("Supabase signed URL creation returned an empty URL")
    return signed_url


async def upload_bytes(
    folder: str,
    filename: str,
    content: bytes,
    *,
    content_type: str,
    upsert: bool = True,
) -> dict[str, object]:
    if not supabase_storage_configured():
        raise RuntimeError("Supabase storage is not configured")

    object_path = build_object_path(folder, filename)
    request_url = (
        f"{_api_base_url()}/object/"
        f"{quote(str(settings.SUPABASE_STORAGE_BUCKET or '').strip(), safe='')}/"
        f"{_quoted_object_path(object_path)}"
    )

    async with httpx.AsyncClient(timeout=300.0) as client:
        response = await client.post(
            request_url,
            headers={
                **_headers(),
                "Content-Type": content_type or "application/octet-stream",
                "x-upsert": "true" if upsert else "false",
            },
            content=content,
        )

    if response.is_error:
        raise RuntimeError(f"Supabase upload failed: {_response_error_message(response)}")

    signed_url = await create_signed_url(object_path)
    return {
        "provider": "supabase",
        "bucket": settings.SUPABASE_STORAGE_BUCKET,
        "path": object_path,
        "name": Path(filename).name,
        "url": signed_url,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "size": len(content or b""),
    }
