"""Auto-submit must ignore low-confidence AI detections so a degraded/unavailable
detector emitting noise can't force-submit a real student. Deterministic browser
events (no ai_confidence) still count.
"""

from __future__ import annotations

from app.models import ProctoringEvent
from app.modules.proctoring.routes_public import (
    AUTO_SUBMIT_MIN_CONFIDENCE,
    _count_auto_submit_alerts,
)


def _ev(event_type: str, confidence: float | None) -> ProctoringEvent:
    return ProctoringEvent(event_type=event_type, ai_confidence=confidence)


def test_low_confidence_ai_alerts_are_not_counted():
    events = [
        _ev("FORBIDDEN_OBJECT", 0.20),
        _ev("EYE_MOVEMENT", 0.35),
        _ev("NO_BLINK", 0.10),
    ]
    assert _count_auto_submit_alerts(events) == 0


def test_high_confidence_and_deterministic_alerts_count():
    events = [
        _ev("FORBIDDEN_OBJECT", 0.95),                 # confident AI -> counts
        _ev("FACE_MISSING", AUTO_SUBMIT_MIN_CONFIDENCE),  # exactly at threshold -> counts
        _ev("FULLSCREEN_EXIT", None),                  # deterministic browser event -> counts
    ]
    assert _count_auto_submit_alerts(events) == 3


def test_mixed_only_reliable_alerts_count():
    events = [
        _ev("FORBIDDEN_OBJECT", 0.9),   # counts
        _ev("EYE_MOVEMENT", 0.2),       # too low, skipped
        _ev("TAB_SWITCH", 0.99),        # excluded event type, skipped
        _ev("FULLSCREEN_EXIT", None),   # deterministic, counts
    ]
    assert _count_auto_submit_alerts(events) == 2
