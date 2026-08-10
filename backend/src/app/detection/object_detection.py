"""Forbidden object detection using YOLOv8 nano."""

import logging
import os
import threading
import time

import cv2
import numpy as np

from ._yolo_load import load_yolo, resolve_weights

try:
    from ultralytics import YOLO
except Exception:  # pragma: no cover - optional dependency in lightweight envs
    YOLO = None

# Comprehensive list of forbidden objects during exams
FORBIDDEN_LABELS = {
    "cell phone",
    "book",
    "laptop",
    "tablet",          # YOLO often classifies tablets as laptops, but include for coverage
    "headphones",      # Earphones / headphones
    "earphones",
}
# "remote" removed — YOLO's TV-remote class fires constantly on dark shapes
# (chair arms, shadows, clothing) producing too many false positives.
# "keyboard" and "mouse" removed — users take exams on computers.
LABEL_CONFIDENCE_OVERRIDES = {
    # Phones are small in webcam frames, so allow a lower confidence floor.
    "cell phone": 0.30,
    "tablet": 0.40,
}
_model = None
_model_load_failed = False
_model_load_attempted_at: float = 0.0
_MODEL_RETRY_SEC = 60.0
_lock = threading.Lock()
OBJECT_MODEL_PATH = os.environ.get("YOLO_OBJECT_MODEL", "yolov8n.pt")
logger = logging.getLogger(__name__)


class ObjectDetector:
    def __init__(self, forbidden_labels: set[str] = None, confidence_threshold: float = 0.35):
        self.forbidden_labels = forbidden_labels or FORBIDDEN_LABELS
        self.confidence_threshold = confidence_threshold
        self._warned_unavailable = False
        self._load_failure_warned = False

    def _normalize_label(self, label: str) -> str:
        return str(label or "").strip().lower()

    def _label_threshold(self, label: str) -> float:
        normalized = self._normalize_label(label)
        return min(self.confidence_threshold, LABEL_CONFIDENCE_OVERRIDES.get(normalized, self.confidence_threshold))

    def _prediction_threshold(self) -> float:
        if not LABEL_CONFIDENCE_OVERRIDES:
            return self.confidence_threshold
        return min(self.confidence_threshold, min(LABEL_CONFIDENCE_OVERRIDES.values()))

    def _get_model(self):
        global _model, _model_load_failed, _model_load_attempted_at
        if _model is not None:
            return _model
        if YOLO is None:
            return None
        if _model_load_failed and (time.monotonic() - _model_load_attempted_at) < _MODEL_RETRY_SEC:
            return None
        with _lock:
            if _model is not None:
                return _model
            if _model_load_failed and (time.monotonic() - _model_load_attempted_at) < _MODEL_RETRY_SEC:
                return None
            try:
                resolved = resolve_weights(OBJECT_MODEL_PATH, "YOLO_OBJECT_MODEL")
                if not os.path.isfile(resolved):
                    logger.error(
                        "YOLO object model file not found (looked up %r) — object detection disabled",
                        OBJECT_MODEL_PATH,
                    )
                    _model_load_failed = True
                    _model_load_attempted_at = time.monotonic()
                    return None
                loaded = load_yolo(resolved)
                available_labels = {str(v).strip().lower() for v in loaded.names.values()} if hasattr(loaded, "names") else set()
                missing = FORBIDDEN_LABELS - available_labels
                if missing:
                    logger.warning(
                        "Object model missing some forbidden labels (will never detect them): %s",
                        missing,
                    )
                logger.info(
                    "YOLO object model loaded from %s — %d classes, forbidden coverage: %s",
                    resolved,
                    len(loaded.names) if hasattr(loaded, "names") else -1,
                    FORBIDDEN_LABELS & available_labels,
                )
                _model = loaded
                _model_load_failed = False
            except Exception as exc:
                logger.error(
                    "Failed to load YOLO object model (%s) — forbidden-object detection "
                    "disabled: %s", OBJECT_MODEL_PATH, exc, exc_info=True,
                )
                _model_load_failed = True
                _model_load_attempted_at = time.monotonic()
                return None
        return _model

    def process_ndarray(self, frame: np.ndarray) -> list[dict]:
        """Detect forbidden objects in an already-decoded frame (avoids re-decode)."""
        if frame is None:
            return []
        model = self._get_model()
        if model is None:
            if not self._warned_unavailable:
                logger.warning("Object detection model unavailable - detection disabled")
                self._warned_unavailable = True
            if _model_load_failed and not self._load_failure_warned:
                logger.warning(
                    "Object detection model failed to load (path=%s) — all object detection is inactive. "
                    "Check YOLO_OBJECT_MODEL env var or model file availability.",
                    OBJECT_MODEL_PATH,
                )
                self._load_failure_warned = True
            return []

        results = model.predict(
            frame,
            verbose=False,
            conf=self._prediction_threshold(),
            imgsz=960,
        )
        alerts = []
        seen: set[str] = set()
        for r in results:
            for cls_id, conf in zip(r.boxes.cls, r.boxes.conf):
                label = r.names[int(cls_id)]
                normalized_label = self._normalize_label(label)
                confidence = float(conf)
                if (
                    normalized_label in self.forbidden_labels
                    and normalized_label not in seen
                    and confidence >= self._label_threshold(normalized_label)
                ):
                    seen.add(normalized_label)
                    alerts.append({
                        "event_type": "FORBIDDEN_OBJECT",
                        "severity": "HIGH",
                        "detail": f"Forbidden object detected: {label}",
                        "confidence": confidence,
                    })
        return alerts

    def process(self, frame_bytes: bytes) -> list[dict]:
        np_arr = np.frombuffer(frame_bytes, np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        return self.process_ndarray(frame)


def preload():
    """Eagerly load the object detection model so the first frame has no cold-start delay."""
    # Reuse the same robust loading path as _get_model via a temporary detector
    ObjectDetector()._get_model()
