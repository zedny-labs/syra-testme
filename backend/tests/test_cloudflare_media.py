import asyncio

import httpx

from app.services import cloudflare_media


def _use_settings(monkeypatch, **overrides):
    from app.core.config import Settings

    s = Settings(_env_file=None, JWT_SECRET="x" * 32, **overrides)
    monkeypatch.setattr(cloudflare_media, "settings", s)
    return s


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _delete_handler(state, *, status_code=204):
    def handler(request: httpx.Request) -> httpx.Response:
        state["calls"].append((request.method, str(request.url)))
        return httpx.Response(status_code)
    return handler


def test_delete_removes_remote_video(monkeypatch):
    _use_settings(monkeypatch, CLOUDFLARE_MEDIA_API_BASE_URL="https://media.example.com/api")
    state = {"calls": []}

    ok = asyncio.run(cloudflare_media.delete_cloudflare_video("uid123", client=_client(_delete_handler(state))))

    assert ok is True
    assert state["calls"] == [("DELETE", "https://media.example.com/api/videos/uid123")]


def test_delete_treats_already_gone_as_success(monkeypatch):
    _use_settings(monkeypatch, CLOUDFLARE_MEDIA_API_BASE_URL="https://media.example.com/api")
    state = {"calls": []}

    ok = asyncio.run(
        cloudflare_media.delete_cloudflare_video("uid123", client=_client(_delete_handler(state, status_code=404)))
    )

    assert ok is True


def test_delete_returns_false_on_server_error(monkeypatch):
    _use_settings(monkeypatch, CLOUDFLARE_MEDIA_API_BASE_URL="https://media.example.com/api")
    state = {"calls": []}

    ok = asyncio.run(
        cloudflare_media.delete_cloudflare_video("uid123", client=_client(_delete_handler(state, status_code=500)))
    )

    assert ok is False


def test_delete_returns_false_with_no_uid(monkeypatch):
    _use_settings(monkeypatch, CLOUDFLARE_MEDIA_API_BASE_URL="https://media.example.com/api")

    ok = asyncio.run(cloudflare_media.delete_cloudflare_video(""))

    assert ok is False
