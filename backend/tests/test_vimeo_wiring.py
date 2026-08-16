import asyncio

import pytest
from fastapi import HTTPException

import app.modules.proctoring.routes_public as routes
import app.tasks.proctoring_video as tasks

EMBED = "https://player.vimeo.com/video/111?h=xy"


def _vimeo_remote(**over):
    base = {
        "provider": "vimeo",
        "name": "cam.webm",
        "uid": "111",
        "uri": "/videos/111",
        "url": EMBED,
        "playback_url": EMBED,
        "playback_type": "vimeo_embed",
        "hash": "xy",
        "status": "processing",
        "ready_to_stream": False,
        "duration": None,
        "size": 3,
        "source": "camera",
        "created_at": "2026-01-01T00:00:00+00:00",
        "remote": {"uri": "/videos/111"},
    }
    base.update(over)
    return base


# ---- Celery task helpers -------------------------------------------------


def test_task_normalize_upload_request_carries_provider():
    out = tasks._normalize_upload_request({"provider": "Vimeo", "session_id": "s", "spool_path": "/x"})
    assert out["provider"] == "vimeo"


def test_task_build_uploaded_file_info_uses_remote_provider():
    info = tasks._build_uploaded_file_info(
        remote=_vimeo_remote(),
        upload_request={"session_id": "s1", "source": "camera", "filename": "cam.webm", "extension": "webm", "size": 3},
    )
    assert info["provider"] == "vimeo"
    assert info["playback_type"] == "vimeo_embed"
    assert info["uid"] == "111"
    assert info["uri"] == "/videos/111"
    assert info["hash"] == "xy"
    assert info["url"] == EMBED


def test_task_build_uploaded_file_info_defaults_to_vimeo():
    info = tasks._build_uploaded_file_info(
        remote={"name": "c.webm", "url": "https://x/y.m3u8", "playback_url": "https://x/y.m3u8", "playback_type": "hls", "size": 5},
        upload_request={"session_id": "s1", "source": "camera", "filename": "c.webm", "extension": "webm", "size": 5},
    )
    assert info["provider"] == "vimeo"


# ---- routes: saved-meta normalization -----------------------------------


def test_normalize_saved_meta_accepts_ready_vimeo():
    item = routes._normalize_saved_video_meta(_vimeo_remote(status="ready", ready_to_stream=True))
    assert item is not None
    assert item["provider"] == "vimeo"
    assert item["ready_to_stream"] is True
    assert item["url"] == EMBED
    assert item["playback_type"] == "vimeo_embed"
    assert item.get("uid") == "111"
    assert item.get("hash") == "xy"


def test_normalize_saved_meta_accepts_processing_vimeo_with_bytes():
    item = routes._normalize_saved_video_meta(_vimeo_remote(status="processing", ready_to_stream=False, size=123))
    assert item is not None
    assert item["ready_to_stream"] is False


# ---- routes: _build_vimeo_video_info ------------------------------------


def test_build_vimeo_video_info(tmp_path, monkeypatch):
    f = tmp_path / "cam.webm"
    f.write_bytes(b"abc")

    async def fake_upload(path, *, filename, source, client=None):
        assert path == f
        return _vimeo_remote(name=filename, source=source)

    monkeypatch.setattr(routes, "upload_video_to_vimeo", fake_upload)
    info = asyncio.run(
        routes._build_vimeo_video_info(
            "att",
            session_id="s1",
            source="camera",
            filename="cam.webm",
            file_path=f,
            recording_started_at=None,
            recording_stopped_at=None,
        )
    )
    assert info["provider"] == "vimeo"
    assert info["uid"] == "111"
    assert info["uri"] == "/videos/111"
    assert info["playback_type"] == "vimeo_embed"
    assert info["hash"] == "xy"
    assert info["url"] == EMBED
    assert info["session_id"] == "s1"
    assert info["ready_to_stream"] is False
    assert info["status"] == "processing"


def test_build_vimeo_video_info_requires_playback_url(tmp_path, monkeypatch):
    f = tmp_path / "cam.webm"
    f.write_bytes(b"abc")

    async def fake_upload(path, *, filename, source, client=None):
        return {"provider": "vimeo", "uid": "111", "url": "", "playback_url": ""}

    monkeypatch.setattr(routes, "upload_video_to_vimeo", fake_upload)
    with pytest.raises(HTTPException):
        asyncio.run(
            routes._build_vimeo_video_info(
                "att",
                session_id="s1",
                source="camera",
                filename="cam.webm",
                file_path=f,
                recording_started_at=None,
                recording_stopped_at=None,
            )
        )


# ---- routes: hydrate refresh --------------------------------------------


def test_hydrate_vimeo_refreshes_and_preserves(monkeypatch):
    async def fake_details(*, uid=None, uri=None, source="camera", client=None):
        return _vimeo_remote(status="ready", ready_to_stream=True, duration=12.5, size=0)

    monkeypatch.setattr(routes, "get_vimeo_video_details", fake_details)
    item = {
        "provider": "vimeo",
        "uid": "111",
        "status": "processing",
        "ready_to_stream": False,
        "size": 999,
        "session_id": "s1",
        "source": "camera",
    }
    out = asyncio.run(routes._hydrate_video_file_info(item))
    assert out["ready_to_stream"] is True
    assert out["status"] == "ready"
    assert out["size"] == 999  # preserved despite refresh returning 0
    assert out["session_id"] == "s1"  # preserved
