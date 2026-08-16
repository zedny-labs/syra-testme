import asyncio
import json

import httpx
import pytest

from app.services import vimeo_media

VIDEO_ID = "987654321"
TUS_LINK = "https://tus.example.com/files/abc123"


def _use_settings(monkeypatch, **overrides):
    from app.core.config import Settings

    s = Settings(_env_file=None, JWT_SECRET="x" * 32, **overrides)
    monkeypatch.setattr(vimeo_media, "settings", s)
    return s


def _make_handler(state, *, size):
    def handler(request: httpx.Request) -> httpx.Response:
        state["calls"].append((request.method, str(request.url)))
        path = request.url.path

        if request.method == "POST" and path == "/me/videos":
            body = json.loads(request.content.decode() or "{}")
            state["create_body"] = body
            state["auth"] = request.headers.get("authorization")
            return httpx.Response(
                201,
                json={
                    "uri": f"/videos/{VIDEO_ID}",
                    "name": body.get("name"),
                    "link": f"https://vimeo.com/{VIDEO_ID}",
                    "player_embed_url": f"https://player.vimeo.com/video/{VIDEO_ID}?h=deadbeef",
                    "status": "uploading",
                    "duration": None,
                    "transcode": {"status": "in_progress"},
                    "upload": {
                        "approach": "tus",
                        "size": str(size),
                        "upload_link": TUS_LINK,
                        "status": "in_progress",
                    },
                    "privacy": body.get("privacy"),
                },
            )

        if request.method == "PATCH" and str(request.url) == TUS_LINK:
            offset = int(request.headers.get("upload-offset", "0"))
            state.setdefault("patch_offsets", []).append(offset)
            new_offset = offset + len(request.content)
            state["patched"] = new_offset
            return httpx.Response(
                204,
                headers={"Upload-Offset": str(new_offset), "Tus-Resumable": "1.0.0"},
            )

        if request.method == "PUT" and "/projects/" in path and "/videos/" in path:
            state["folder_put"] = str(request.url)
            return httpx.Response(204)

        if request.method == "PATCH" and path == f"/videos/{VIDEO_ID}":
            state["end_screen_patch"] = json.loads(request.content.decode() or "{}")
            return httpx.Response(200, json={"uri": f"/videos/{VIDEO_ID}"})

        if request.method == "GET" and path == f"/videos/{VIDEO_ID}":
            return httpx.Response(
                200,
                json={
                    "uri": f"/videos/{VIDEO_ID}",
                    "name": "cam.webm",
                    "player_embed_url": f"https://player.vimeo.com/video/{VIDEO_ID}?h=deadbeef",
                    "status": "available",
                    "duration": 12.5,
                    "transcode": {"status": "complete"},
                    "upload": {"status": "complete"},
                },
            )

        return httpx.Response(404, json={"error": f"unexpected {request.method} {request.url}"})

    return handler


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


# ---- pure helpers -------------------------------------------------------


def test_enabled_true_when_token_set(monkeypatch):
    _use_settings(monkeypatch, VIMEO_ACCESS_TOKEN="tok")
    assert vimeo_media.vimeo_video_storage_enabled() is True


def test_enabled_false_when_token_blank(monkeypatch):
    _use_settings(monkeypatch, VIMEO_ACCESS_TOKEN="")
    assert vimeo_media.vimeo_video_storage_enabled() is False


def test_extract_hash():
    assert vimeo_media._extract_hash("https://player.vimeo.com/video/1?h=abc&x=1") == "abc"
    assert vimeo_media._extract_hash("https://player.vimeo.com/video/1") is None


def test_extract_video_id():
    assert vimeo_media._extract_video_id("/videos/123") == "123"
    assert vimeo_media._extract_video_id("/videos/123:hashpart") == "123"


def test_infer_ready_to_stream():
    assert vimeo_media.infer_vimeo_ready_to_stream(transcode_status="complete", video_status="available") is True
    assert vimeo_media.infer_vimeo_ready_to_stream(transcode_status="in_progress", video_status="uploading") is False
    assert vimeo_media.infer_vimeo_ready_to_stream(transcode_status="", video_status="available") is True


# ---- upload -------------------------------------------------------------


def test_upload_creates_uploads_and_normalizes(tmp_path, monkeypatch):
    _use_settings(monkeypatch, VIMEO_ACCESS_TOKEN="tok")
    data = b"hello-video-bytes"
    f = tmp_path / "cam.webm"
    f.write_bytes(data)
    state = {"calls": []}

    info = asyncio.run(
        vimeo_media.upload_video_to_vimeo(
            f, filename="cam.webm", source="camera", client=_client(_make_handler(state, size=len(data)))
        )
    )

    # normalized shape the rest of the pipeline consumes
    assert info["provider"] == "vimeo"
    assert info["uid"] == VIDEO_ID
    assert info["uri"] == f"/videos/{VIDEO_ID}"
    assert info["playback_type"] == "vimeo_embed"
    assert info["url"] == f"https://player.vimeo.com/video/{VIDEO_ID}?h=deadbeef"
    assert info["playback_url"] == info["url"]
    assert info["hash"] == "deadbeef"
    assert info["source"] == "camera"
    assert info["size"] == len(data)
    # freshly uploaded -> still transcoding
    assert info["ready_to_stream"] is False
    assert info["status"] == "processing"

    # create request was correct
    assert state["auth"] == "Bearer tok"
    assert state["create_body"]["upload"] == {"approach": "tus", "size": str(len(data))}
    assert state["create_body"]["name"] == "cam.webm"
    assert state["create_body"]["privacy"]["view"] == "unlisted"
    # all bytes uploaded via tus
    assert state["patched"] == len(data)
    # end-of-clip "more videos" suggestions disabled (this Vimeo account hosts
    # every student's recordings, so leaving them on could surface someone else's)
    assert state["end_screen_patch"] == {"embed": {"end_screen": {"type": "nothing"}}}


def test_upload_survives_end_screen_patch_failure(tmp_path, monkeypatch):
    _use_settings(monkeypatch, VIMEO_ACCESS_TOKEN="tok")
    data = b"hello-video-bytes"
    f = tmp_path / "cam.webm"
    f.write_bytes(data)
    state = {"calls": []}
    handler = _make_handler(state, size=len(data))

    def failing_handler(request):
        if request.method == "PATCH" and request.url.path == f"/videos/{VIDEO_ID}":
            return httpx.Response(500, json={"error": "boom"})
        return handler(request)

    info = asyncio.run(
        vimeo_media.upload_video_to_vimeo(
            f, filename="cam.webm", source="camera", client=_client(failing_handler)
        )
    )

    # a failed end-screen update is best-effort and must not fail the upload
    assert info["uid"] == VIDEO_ID


def test_upload_streams_in_tus_chunks(tmp_path, monkeypatch):
    _use_settings(monkeypatch, VIMEO_ACCESS_TOKEN="tok")
    monkeypatch.setattr(vimeo_media, "_TUS_CHUNK_SIZE", 4)
    data = b"0123456789"  # 10 bytes -> chunks at offsets 0,4,8
    f = tmp_path / "screen.webm"
    f.write_bytes(data)
    state = {"calls": []}

    asyncio.run(
        vimeo_media.upload_video_to_vimeo(
            f, filename="screen.webm", source="screen", client=_client(_make_handler(state, size=len(data)))
        )
    )

    assert state["patch_offsets"] == [0, 4, 8]
    assert state["patched"] == len(data)


def test_upload_files_into_folder_when_configured(tmp_path, monkeypatch):
    _use_settings(monkeypatch, VIMEO_ACCESS_TOKEN="tok", VIMEO_FOLDER_ID="555")
    data = b"abc"
    f = tmp_path / "cam.webm"
    f.write_bytes(data)
    state = {"calls": []}

    asyncio.run(
        vimeo_media.upload_video_to_vimeo(
            f, filename="cam.webm", source="camera", client=_client(_make_handler(state, size=len(data)))
        )
    )

    assert state["folder_put"].endswith(f"/me/projects/555/videos/{VIDEO_ID}")


def test_upload_skips_folder_when_not_configured(tmp_path, monkeypatch):
    _use_settings(monkeypatch, VIMEO_ACCESS_TOKEN="tok")
    data = b"abc"
    f = tmp_path / "cam.webm"
    f.write_bytes(data)
    state = {"calls": []}

    asyncio.run(
        vimeo_media.upload_video_to_vimeo(
            f, filename="cam.webm", source="camera", client=_client(_make_handler(state, size=len(data)))
        )
    )

    assert "folder_put" not in state


# ---- details refresh ----------------------------------------------------


def test_get_details_marks_ready_when_transcode_complete(monkeypatch):
    _use_settings(monkeypatch, VIMEO_ACCESS_TOKEN="tok")
    state = {"calls": []}

    info = asyncio.run(
        vimeo_media.get_vimeo_video_details(
            uid=VIDEO_ID, source="screen", client=_client(_make_handler(state, size=0))
        )
    )

    assert info["provider"] == "vimeo"
    assert info["uid"] == VIDEO_ID
    assert info["ready_to_stream"] is True
    assert info["status"] == "ready"
    assert info["duration"] == 12.5
    assert info["source"] == "screen"
    assert info["playback_type"] == "vimeo_embed"
