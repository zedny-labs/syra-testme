from ...detection.face_verification import compute_face_signature as _compute_face_signature
from ...modules.attempts import routes_public as _impl
from ...modules.attempts import routes_admin as _admin_impl
from ...modules.attempts.routes_public import (
    Attempt,
    AttemptAnswer,
    AttemptAnswerBase,
    AttemptAnswerRead,
    AttemptAnswerReviewUpdate,
    AttemptRead,
    AttemptStatus,
    finalize_attempt_review,
    grade_attempt,
    import_attempts,
    list_attempt_answers,
    list_attempts,
    router,
    review_attempt_answer,
    submit_answer,
    submit_attempt,
    verify_identity,
)


_original_face_present = _impl._face_present
_original_save_identity_photo = _impl._save_identity_photo


def _face_present(image_bytes: bytes) -> bool:
    return _original_face_present(image_bytes)


async def _save_identity_photo(*args, **kwargs):
    return await _original_save_identity_photo(*args, **kwargs)


def compute_face_signature(image_bytes: bytes):
    return _compute_face_signature(image_bytes)


_impl._face_present = lambda image_bytes: _face_present(image_bytes)
_impl._save_identity_photo = lambda *args, **kwargs: _save_identity_photo(*args, **kwargs)
_impl.compute_face_signature = lambda image_bytes: compute_face_signature(image_bytes)

_enforce_attempt_access = _impl._enforce_attempt_access
_create_attempt_record = _impl._create_attempt_record
_auto_score_attempt = _impl._auto_score_attempt
_evaluate_answer = _impl._evaluate_answer

# Include admin-only routes (e.g. DELETE /api/attempts/purge)
router.include_router(_admin_impl.router)


__all__ = [
    "router",
    "Attempt",
    "AttemptAnswer",
    "AttemptAnswerBase",
    "AttemptAnswerRead",
    "AttemptAnswerReviewUpdate",
    "AttemptRead",
    "AttemptStatus",
    "list_attempts",
    "list_attempt_answers",
    "submit_answer",
    "submit_attempt",
    "grade_attempt",
    "review_attempt_answer",
    "finalize_attempt_review",
    "verify_identity",
    "import_attempts",
    "_face_present",
    "_save_identity_photo",
    "compute_face_signature",
    "_enforce_attempt_access",
    "_create_attempt_record",
    "_auto_score_attempt",
    "_evaluate_answer",
]
