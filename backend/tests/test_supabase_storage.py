import asyncio
import json

import httpx

from app.services import supabase_storage


def _use_settings(monkeypatch, **overrides):
    from app.core.config import Settings

    s = Settings(_env_file=None, JWT_SECRET="x" * 32, **overrides)
    monkeypatch.setattr(supabase_storage, "settings", s)
    return s


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_delete_object_removes_remote_file(monkeypatch):
    _use_settings(
        monkeypatch,
        SUPABASE_URL="https://proj.supabase.co",
        SUPABASE_SECRET_KEY="secret",
        SUPABASE_STORAGE_BUCKET="proctoring",
    )
    state = {"calls": []}

    def handler(request: httpx.Request) -> httpx.Response:
        state["calls"].append((request.method, str(request.url)))
        state["body"] = json.loads(request.content.decode() or "{}")
        state["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"message": "deleted"})

    ok = asyncio.run(supabase_storage.delete_object("videos/cam.webm", client=_client(handler)))

    assert ok is True
    assert state["calls"] == [("DELETE", "https://proj.supabase.co/storage/v1/object/proctoring")]
    assert state["body"] == {"prefixes": ["videos/cam.webm"]}
    assert state["auth"] == "Bearer secret"


def test_delete_object_returns_false_when_not_configured(monkeypatch):
    _use_settings(monkeypatch, SUPABASE_URL="", SUPABASE_SECRET_KEY="", SUPABASE_STORAGE_BUCKET="")

    ok = asyncio.run(supabase_storage.delete_object("videos/cam.webm"))

    assert ok is False


def test_delete_object_returns_false_with_blank_path(monkeypatch):
    _use_settings(
        monkeypatch,
        SUPABASE_URL="https://proj.supabase.co",
        SUPABASE_SECRET_KEY="secret",
        SUPABASE_STORAGE_BUCKET="proctoring",
    )

    ok = asyncio.run(supabase_storage.delete_object(""))

    assert ok is False


def test_delete_object_returns_false_on_server_error(monkeypatch):
    _use_settings(
        monkeypatch,
        SUPABASE_URL="https://proj.supabase.co",
        SUPABASE_SECRET_KEY="secret",
        SUPABASE_STORAGE_BUCKET="proctoring",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    ok = asyncio.run(supabase_storage.delete_object("videos/cam.webm", client=_client(handler)))

    assert ok is False
