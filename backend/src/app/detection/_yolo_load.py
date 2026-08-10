"""Shared helpers for locating and loading YOLO (.pt) weights robustly.

Two failure modes have historically taken face + object detection offline on the
inference worker while the lighter MediaPipe detectors kept working:

1. **Weights not found** — the loaders used a bare relative filename resolved
   against the process CWD. If the Celery worker's CWD isn't the dir where the
   `.pt` files are baked, `YOLO("yolov8n.pt")` can't find them and (for the
   custom face model) can't download them either.

2. **torch>=2.6 `weights_only=True`** — PyTorch 2.6 flipped `torch.load`'s
   default to `weights_only=True`, which *rejects* ultralytics checkpoints
   (they pickle model objects, not just tensors) with an UnpicklingError. Older
   ultralytics builds don't opt out, so `YOLO(path)` raises and the detector is
   silently disabled.

`resolve_weights` fixes (1) by searching known locations independent of CWD.
`load_yolo` fixes (2) by retrying with `weights_only=False` — safe here because
the weights are our own trusted, image-baked files, not untrusted input.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_HERE = os.path.dirname(os.path.abspath(__file__))


def _candidate_dirs() -> list[str]:
    """Directories to search for a baked weights file, best-first."""
    dirs = [os.getcwd(), "/app"]
    # Walk up from this module so we find the file whether it lives at the repo
    # `backend/<file>.pt` (dev) or the image `/app/<file>.pt` (prod).
    current = _HERE
    for _ in range(6):
        dirs.append(current)
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    # de-dupe, keep order
    seen: set[str] = set()
    out: list[str] = []
    for d in dirs:
        if d and d not in seen:
            seen.add(d)
            out.append(d)
    return out


def resolve_weights(filename: str, env_var: str) -> str:
    """Return an absolute path to the weights, independent of the process CWD.

    Order: explicit env var (if it points at a real file) → each candidate dir →
    the bare filename as a last resort (lets ultralytics download official models
    like ``yolov8n.pt``; a missing custom model will then fail loudly in load_yolo).
    """
    override = os.environ.get(env_var)
    if override and os.path.isfile(override):
        return override
    for directory in _candidate_dirs():
        candidate = os.path.join(directory, filename)
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    logger.warning(
        "YOLO weights %r not found in any known location (%s); passing the bare "
        "name to ultralytics (official models may download, custom ones will fail)",
        filename, ", ".join(_candidate_dirs()),
    )
    return filename


def load_yolo(path: str):
    """Load a YOLO model, transparently handling torch>=2.6 `weights_only`.

    Imports ultralytics lazily so callers can guard on availability themselves.
    """
    from ultralytics import YOLO

    try:
        return YOLO(path)
    except Exception as exc:  # noqa: BLE001 - inspect message, then decide
        message = str(exc).lower()
        weights_only_hint = any(
            token in message
            for token in ("weights_only", "weightsunpickler", "unsupported global", "unpickl")
        )
        if not weights_only_hint:
            raise
        logger.warning(
            "YOLO load of %s hit a torch weights_only restriction; retrying with "
            "weights_only=False (trusted local weights): %s",
            path, exc,
        )
        import torch

        original_load = torch.load

        def _load_full(*args, **kwargs):
            kwargs["weights_only"] = False
            return original_load(*args, **kwargs)

        torch.load = _load_full
        try:
            return YOLO(path)
        finally:
            torch.load = original_load
