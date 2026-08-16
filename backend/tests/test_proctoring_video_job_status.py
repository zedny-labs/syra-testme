from __future__ import annotations

from app.services import proctoring_video_batch


class _FakeAsyncResult:
    def __init__(self, state: str, result=None) -> None:
        self.state = state
        self.result = result


def test_get_proctoring_video_job_status_returns_completed_payload(monkeypatch) -> None:
    payload = {
        "status": "COMPLETED",
        "detail": "Video uploaded successfully.",
        "file": {"provider": "vimeo", "source": "camera"},
        "completed_at": "2026-03-29T12:00:00Z",
    }
    monkeypatch.setattr(
        proctoring_video_batch,
        "AsyncResult",
        lambda job_id, app=None: _FakeAsyncResult("SUCCESS", payload),
    )

    status = proctoring_video_batch.get_proctoring_video_job_status("job-123")

    assert status == {
        "job_id": "job-123",
        "status": "COMPLETED",
        "detail": "Video uploaded successfully.",
        "findings": [],
        "summary": {},
        "file": {"provider": "vimeo", "source": "camera"},
        "completed_at": "2026-03-29T12:00:00Z",
    }


def test_get_proctoring_video_job_status_maps_retry_state_to_processing(monkeypatch) -> None:
    monkeypatch.setattr(
        proctoring_video_batch,
        "AsyncResult",
        lambda job_id, app=None: _FakeAsyncResult("RETRY"),
    )

    status = proctoring_video_batch.get_proctoring_video_job_status("job-456")

    assert status == {
        "job_id": "job-456",
        "status": "PROCESSING",
        "detail": "Video processing is still running.",
        "findings": [],
        "summary": {},
        "file": None,
        "completed_at": None,
    }
