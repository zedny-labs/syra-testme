"""Shared YOLOv8 face detection model loader.

Both face_detection.py and multi_face.py import from here so the model
is only loaded into memory once.

Set YOLO_FACE_MODEL env var to the full path of your .pt weights file, e.g.:
  YOLO_FACE_MODEL=/path/to/yolov8-face/weights/yolov8n-face.pt
"""

import logging
import os
import threading

from ._yolo_load import load_yolo, resolve_weights

try:
    from ultralytics import YOLO
except Exception:  # pragma: no cover
    YOLO = None

# Override via env var; otherwise resolved to an absolute path independent of CWD.
FACE_MODEL_PATH = os.environ.get("YOLO_FACE_MODEL", "yolov8n-face.pt")
_model = None
_model_load_failed = False
_lock = threading.Lock()
logger = logging.getLogger(__name__)


def get_face_model():
    """Return (and lazily load) the shared YOLO face model, or None if unavailable."""
    global _model, _model_load_failed
    if _model is not None:
        return _model
    if YOLO is None or _model_load_failed:
        return None
    with _lock:
        # Double-check after acquiring lock — another thread may have loaded it
        if _model is not None:
            return _model
        if _model_load_failed:
            return None
        try:
            resolved = resolve_weights(FACE_MODEL_PATH, "YOLO_FACE_MODEL")
            _model = load_yolo(resolved)
            logger.info("YOLO face model loaded from %s", resolved)
        except Exception as exc:
            logger.error(
                "Failed to load YOLO face model (%s) — face + multi-face detection "
                "disabled: %s", FACE_MODEL_PATH, exc, exc_info=True,
            )
            _model_load_failed = True
            return None
    return _model


def preload():
    """Eagerly load the face model so the first frame has no cold-start delay."""
    get_face_model()
