"""Redis-backed pub/sub bus for cross-worker live proctoring monitoring.

With multiple Gunicorn workers, WebSocket connections (both student and admin)
can land on different processes. This module provides:
  - publish_* helpers (called from the student WebSocket worker)
  - subscribe() async generator (consumed by the admin WebSocket worker)
  - get_* helpers to read session metadata / latest thumbnail from Redis

If Redis is unavailable, all operations are no-ops / return empty values so
that the rest of the application continues to work (live monitoring just won't
work across workers).
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
from collections.abc import AsyncIterator

import redis.asyncio as aioredis
from redis.asyncio.connection import ConnectionPool

from ..core.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# ── Redis key / channel schema ─────────────────────────────────────────────
_KEY_SESSION = "syra:live:session:{}"   # JSON session metadata
_KEY_THUMB = "syra:live:thumb:{}"       # raw JPEG bytes of last thumbnail
_CHANNEL = "syra:live:{}"               # pub/sub channel per attempt

SESSION_TTL_S = 3 * 3600   # 3 h — safety expiry in case of crash
THUMB_TTL_S = 120          # 2 min — last thumbnail expires quickly

# ── Shared connection pool (for all non-subscribe operations) ──────────────
_pool: ConnectionPool | None = None


def _get_url() -> str | None:
    return settings.REDIS_URL or settings.celery_broker_url


def _get_pool() -> ConnectionPool | None:
    global _pool
    url = _get_url()
    if not url:
        return None
    if _pool is None:
        _pool = ConnectionPool.from_url(url, decode_responses=False, max_connections=20)
    return _pool


def _client() -> aioredis.Redis | None:
    pool = _get_pool()
    if pool is None:
        return None
    return aioredis.Redis(connection_pool=pool)


# ── Publish helpers (student-side) ─────────────────────────────────────────

async def publish_session_open(attempt_id: str, session_info: dict) -> None:
    """Store session metadata in Redis so any worker can read it."""
    r = _client()
    if r is None:
        return
    try:
        await r.setex(_KEY_SESSION.format(attempt_id), SESSION_TTL_S, json.dumps(session_info))
    except Exception as exc:
        logger.warning("live_bus: publish_session_open %s: %s", attempt_id, exc)
    finally:
        try:
            await r.aclose()
        except Exception:
            pass


async def publish_session_closed(attempt_id: str) -> None:
    """Broadcast session_ended then remove Redis keys."""
    r = _client()
    if r is None:
        return
    try:
        msg = json.dumps({"type": "session_ended", "attempt_id": attempt_id})
        await r.publish(_CHANNEL.format(attempt_id), msg)
        await r.delete(_KEY_SESSION.format(attempt_id), _KEY_THUMB.format(attempt_id))
    except Exception as exc:
        logger.warning("live_bus: publish_session_closed %s: %s", attempt_id, exc)
    finally:
        try:
            await r.aclose()
        except Exception:
            pass


async def publish_json_event(attempt_id: str, message: dict) -> None:
    """Broadcast a JSON message (alert, live_summary, force_submitted …)."""
    r = _client()
    if r is None:
        return
    try:
        payload = json.dumps({"type": "json", "payload": message})
        await r.publish(_CHANNEL.format(attempt_id), payload)
    except Exception as exc:
        logger.warning("live_bus: publish_json_event %s: %s", attempt_id, exc)
    finally:
        try:
            await r.aclose()
        except Exception:
            pass


async def publish_thumb(
    attempt_id: str,
    thumb_bytes: bytes,
    msg_type: str = "frame",
) -> None:
    """Store latest thumbnail and broadcast it as a base64-encoded message.

    msg_type is "frame" or "screen", matching the type-byte convention in the
    original binary broadcast.
    """
    r = _client()
    if r is None:
        return
    try:
        b64 = base64.b64encode(thumb_bytes).decode()
        payload = json.dumps({"type": "thumb", "payload": b64, "msg_type": msg_type})
        await asyncio.gather(
            r.setex(_KEY_THUMB.format(attempt_id), THUMB_TTL_S, thumb_bytes),
            r.publish(_CHANNEL.format(attempt_id), payload),
        )
    except Exception as exc:
        logger.warning("live_bus: publish_thumb %s: %s", attempt_id, exc)
    finally:
        try:
            await r.aclose()
        except Exception:
            pass


# ── Read helpers (admin-side) ──────────────────────────────────────────────

async def get_session_info(attempt_id: str) -> dict | None:
    r = _client()
    if r is None:
        return None
    try:
        data = await r.get(_KEY_SESSION.format(attempt_id))
        return json.loads(data) if data else None
    except Exception as exc:
        logger.warning("live_bus: get_session_info %s: %s", attempt_id, exc)
        return None
    finally:
        try:
            await r.aclose()
        except Exception:
            pass


async def get_all_sessions() -> list[dict]:
    """Return metadata for every currently open proctoring session."""
    r = _client()
    if r is None:
        return []
    try:
        keys = [key async for key in r.scan_iter(match=_KEY_SESSION.format("*"))]
        if not keys:
            return []
        vals = await r.mget(*keys)
        result = []
        for v in vals:
            if v:
                with contextlib.suppress(Exception):
                    result.append(json.loads(v))
        return result
    except Exception as exc:
        logger.warning("live_bus: get_all_sessions: %s", exc)
        return []
    finally:
        try:
            await r.aclose()
        except Exception:
            pass


async def get_latest_thumb(attempt_id: str) -> bytes | None:
    r = _client()
    if r is None:
        return None
    try:
        return await r.get(_KEY_THUMB.format(attempt_id))
    except Exception as exc:
        logger.warning("live_bus: get_latest_thumb %s: %s", attempt_id, exc)
        return None
    finally:
        try:
            await r.aclose()
        except Exception:
            pass


async def get_viewer_count(attempt_id: str) -> int:
    """Return the number of admin WebSocket subscribers for this session."""
    r = _client()
    if r is None:
        return 0
    try:
        result = await r.execute_command("PUBSUB", "NUMSUB", _CHANNEL.format(attempt_id))
        # result: [channel_bytes, count, ...]
        if result and len(result) >= 2:
            return int(result[1])
        return 0
    except Exception:
        return 0
    finally:
        try:
            await r.aclose()
        except Exception:
            pass


# ── Subscription (admin-side) ──────────────────────────────────────────────

async def subscribe(attempt_id: str) -> AsyncIterator[dict]:
    """Async generator yielding decoded messages from the session channel.

    Each yielded item is a dict with at least a "type" key:
      {"type": "json",        "payload": {...}}
      {"type": "thumb",       "payload": "<b64>", "msg_type": "frame"|"screen"}
      {"type": "session_ended", "attempt_id": "..."}

    The generator exits when:
      - A "session_ended" message is received
      - The caller cancels/stops iteration (e.g. WebSocket disconnect)
      - A Redis error occurs
    """
    url = _get_url()
    if not url:
        return

    redis = aioredis.from_url(url, decode_responses=False)
    pubsub = redis.pubsub()
    await pubsub.subscribe(_CHANNEL.format(attempt_id))
    try:
        async for message in pubsub.listen():
            if message["type"] != "message":
                continue
            try:
                msg = json.loads(message["data"])
            except Exception:
                continue
            yield msg
            if msg.get("type") == "session_ended":
                break
    finally:
        with contextlib.suppress(Exception):
            await pubsub.unsubscribe(_CHANNEL.format(attempt_id))
        with contextlib.suppress(Exception):
            await pubsub.aclose()
        with contextlib.suppress(Exception):
            await redis.aclose()
