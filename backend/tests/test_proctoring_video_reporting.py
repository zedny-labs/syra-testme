from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.models import ProctoringEvent, SeverityEnum
from app.modules.proctoring.routes_public import _saved_recordings_by_source
from app.reporting.report_generator import _build_recording_rows
from app.tasks.proctoring_video import _build_findings


def _saved_video_event(
    *,
    source: str,
    status: str,
    size: int,
    ready_to_stream: bool = False,
) -> ProctoringEvent:
    return ProctoringEvent(
        attempt_id=uuid.uuid4(),
        event_type="VIDEO_SAVED",
        severity=SeverityEnum.LOW,
        detail=f"{source} saved",
        meta={
            "source": source,
            "status": status,
            "size": size,
            "ready_to_stream": ready_to_stream,
        },
        occurred_at=datetime.now(timezone.utc),
    )


def test_saved_recordings_by_source_ignores_failed_video_saves() -> None:
    failed_camera = _saved_video_event(source="camera", status="error", size=22)
    ready_screen = _saved_video_event(source="screen", status="ready", size=2048, ready_to_stream=True)

    saved = _saved_recordings_by_source([failed_camera, ready_screen])

    assert set(saved) == {"screen"}


def test_recording_rows_mark_failed_saved_video_as_error() -> None:
    failed_camera = _saved_video_event(source="camera", status="error", size=22)

    rows = _build_recording_rows([failed_camera], ["camera"])

    assert rows == [{
        "label": "Camera",
        "status": "Error",
        "pill_tone": "bad",
        "recorded_duration": "N/A",
        "saved_at": rows[0]["saved_at"],
        "size": "22 B",
        "note": "Video upload finished but the storage provider marked the recording as failed.",
    }]


def test_build_findings_treats_storage_error_as_failure() -> None:
    findings = _build_findings({
        "provider": "vimeo",
        "source": "camera",
        "status": "error",
        "size": 22,
        "duration": -1,
        "ready_to_stream": False,
    })

    codes = {item["code"] for item in findings}

    assert "VIDEO_STREAM_ERROR" in codes
    assert "VIDEO_STREAM_UNAVAILABLE" in codes
    assert "VIDEO_UPLOAD_CAPTURED" not in codes
