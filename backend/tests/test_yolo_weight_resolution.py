"""YOLO weights must resolve independently of the process CWD, so the inference
worker finds the baked .pt files regardless of where Celery starts it.
"""

from __future__ import annotations

import os

from app.detection._yolo_load import resolve_weights


def test_env_override_wins(tmp_path, monkeypatch):
    f = tmp_path / "custom-face.pt"
    f.write_bytes(b"weights")
    monkeypatch.setenv("YOLO_TEST_FACE", str(f))
    assert resolve_weights("ignored.pt", "YOLO_TEST_FACE") == str(f)


def test_finds_file_in_cwd(tmp_path, monkeypatch):
    f = tmp_path / "test-marker-model.pt"
    f.write_bytes(b"weights")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("YOLO_MARK", raising=False)
    got = resolve_weights("test-marker-model.pt", "YOLO_MARK")
    assert os.path.samefile(got, str(f))


def test_baked_weights_resolve_without_cwd(tmp_path, monkeypatch):
    # CWD points at an empty dir and the env var is unset — the loader must still
    # locate the repo-baked yolov8n.pt via its module-anchored search. This is the
    # exact regression that took object/face detection offline on the worker.
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("YOLO_OBJECT_MODEL", raising=False)
    got = resolve_weights("yolov8n.pt", "YOLO_OBJECT_MODEL")
    assert got.endswith("yolov8n.pt")
    assert os.path.isfile(got), f"expected a real baked weights file, got {got!r}"


def test_missing_model_returns_bare_name(monkeypatch):
    monkeypatch.delenv("YOLO_NOPE", raising=False)
    assert resolve_weights("definitely-not-here-9999.pt", "YOLO_NOPE") == "definitely-not-here-9999.pt"
