from datetime import datetime, timedelta, timezone
import inspect
import json

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
import base64
from pathlib import Path
from uuid import uuid4
import cv2
import numpy as np
import io
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.utils import simpleSplit
from reportlab.pdfgen import canvas
from sqlalchemy import case, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, load_only

from ...models import (
    Attempt,
    AttemptAnswer,
    Exam,
    ExamSection,
    GradingScale,
    User,
    Question,
    RoleEnum,
    AttemptStatus,
    ExamType,
    ExamStatus,
    Schedule,
    AccessMode,
    ProctoringEvent,
    SeverityEnum,
)
from ...services.normalized_relations import (
    DEFAULT_CERTIFICATE_ISSUE_RULE,
    exam_certificate,
    exam_proctoring,
    exam_runtime_settings,
    normalize_certificate_issue_rule,
)
from ...core.config import get_settings
from ...schemas import (
    AttemptCreate,
    AttemptResolveRequest,
    PaginatedResponse,
    AttemptRead,
    AttemptAnswerBase,
    AttemptAnswerRead,
    AttemptCertificateReviewUpdate,
    AttemptAnswerReviewUpdate,
    Message,
)
from ...api.deps import ensure_exam_owner, ensure_permission, get_current_user, get_db_dep, require_permission, require_role, parse_uuid_param, normalize_utc_datetime
from ...detection.face_verification import compute_face_signature
from ...services.crypto_utils import encrypt_bytes
from ...services.notifications import notify_user
from ...services.supabase_storage import upload_bytes as upload_bytes_to_supabase
from ...modules.tests.proctoring_requirements import get_proctoring_requirements
from ...utils.response_cache import TimedSingleFlightCache
from ...core.i18n import translate as _t
from ...utils.pagination import MAX_PAGE_SIZE, build_page_response, clamp_sort_field, normalize_pagination

router = APIRouter()
settings = get_settings()

CERTIFICATE_REVIEW_APPROVED = "CERTIFICATE_REVIEW_APPROVED"
CERTIFICATE_REVIEW_REJECTED = "CERTIFICATE_REVIEW_REJECTED"
ATTEMPT_LIST_CACHE_TTL_SECONDS = 8.0
_attempt_list_cache: TimedSingleFlightCache[dict] = TimedSingleFlightCache(ttl_seconds=ATTEMPT_LIST_CACHE_TTL_SECONDS)


def _invalidate_attempt_list_cache() -> None:
    _attempt_list_cache.invalidate()


def _get_mediapipe():
    try:
        import mediapipe as mp

        return mp
    except Exception:  # pragma: no cover - optional dependency
        return None


def _notify_attempt_result(db: Session, attempt: Attempt, *, result_kind: str) -> None:
    if attempt.score is None:
        return
    exam_title = attempt.exam.title if attempt.exam else "your test"
    grade_text = f" Grade: {attempt.grade}." if attempt.grade else ""
    notify_user(
        db,
        attempt.user_id,
        title="Attempt result available",
        message=(
            f"Your attempt for {exam_title} has been {result_kind} with a score of "
            f"{attempt.score:.2f}%."
            f"{grade_text}"
        ),
        link=f"/attempt-result/{attempt.id}",
    )


def _attempt_is_paused(db: Session, attempt_id) -> bool:
    if not hasattr(db, "scalars"):
        return False
    result = db.scalars(
        select(ProctoringEvent)
        .where(
            ProctoringEvent.attempt_id == attempt_id,
            ProctoringEvent.event_type.in_(["ATTEMPT_PAUSED", "ATTEMPT_RESUMED"]),
        )
        .order_by(ProctoringEvent.occurred_at.desc())
        .limit(1)
    )
    if hasattr(result, "first"):
        last_state_event = result.first()
    elif hasattr(result, "all"):
        rows = result.all()
        last_state_event = rows[0] if rows else None
    else:
        last_state_event = None
    return bool(last_state_event and last_state_event.event_type == "ATTEMPT_PAUSED")


def _paused_attempt_ids(db: Session, attempt_ids: list) -> set:
    if not attempt_ids:
        return set()

    rows = db.execute(
        select(
            ProctoringEvent.attempt_id,
            ProctoringEvent.event_type,
        )
        .where(
            ProctoringEvent.attempt_id.in_(attempt_ids),
            ProctoringEvent.event_type.in_(["ATTEMPT_PAUSED", "ATTEMPT_RESUMED"]),
        )
        .order_by(ProctoringEvent.attempt_id, ProctoringEvent.occurred_at.desc())
    ).all()

    paused_ids = set()
    seen_attempt_ids = set()
    for attempt_id, event_type in rows:
        if attempt_id in seen_attempt_ids:
            continue
        seen_attempt_ids.add(attempt_id)
        if event_type == "ATTEMPT_PAUSED":
            paused_ids.add(attempt_id)
    return paused_ids


def _violation_counts_by_attempt(db: Session, attempt_ids: list) -> dict[str, dict[str, int]]:
    if not attempt_ids:
        return {}

    rows = db.execute(
        select(
            ProctoringEvent.attempt_id,
            func.sum(case((ProctoringEvent.severity == SeverityEnum.HIGH, 1), else_=0)).label("high_violations"),
            func.sum(case((ProctoringEvent.severity == SeverityEnum.MEDIUM, 1), else_=0)).label("med_violations"),
        )
        .where(ProctoringEvent.attempt_id.in_(attempt_ids))
        .group_by(ProctoringEvent.attempt_id)
    ).all()

    return {
        str(attempt_id): {
            "high_violations": int(high_violations or 0),
            "med_violations": int(med_violations or 0),
        }
        for attempt_id, high_violations, med_violations in rows
    }


def _certificate_review_event(attempt: Attempt, db: Session) -> ProctoringEvent | None:
    return db.scalar(
        select(ProctoringEvent)
        .where(
            ProctoringEvent.attempt_id == attempt.id,
            ProctoringEvent.event_type.in_([CERTIFICATE_REVIEW_APPROVED, CERTIFICATE_REVIEW_REJECTED]),
        )
        .order_by(ProctoringEvent.occurred_at.desc())
        .limit(1)
    )


def _certificate_review_events_by_attempt(db: Session, attempt_ids: list) -> dict:
    if not attempt_ids:
        return {}

    rows = db.execute(
        select(
            ProctoringEvent.attempt_id,
            ProctoringEvent.event_type,
            ProctoringEvent.occurred_at,
        )
        .where(
            ProctoringEvent.attempt_id.in_(attempt_ids),
            ProctoringEvent.event_type.in_([CERTIFICATE_REVIEW_APPROVED, CERTIFICATE_REVIEW_REJECTED]),
        )
        .order_by(ProctoringEvent.attempt_id, ProctoringEvent.occurred_at.desc())
    ).all()

    latest_events = {}
    for attempt_id, event_type, occurred_at in rows:
        latest_events.setdefault(attempt_id, (event_type, occurred_at))
    return latest_events


def _has_negative_proctoring_signal(attempt: Attempt, db: Session) -> bool:
    count = db.scalar(
        select(func.count())
        .select_from(ProctoringEvent)
        .where(
            ProctoringEvent.attempt_id == attempt.id,
            ProctoringEvent.event_type.notin_([CERTIFICATE_REVIEW_APPROVED, CERTIFICATE_REVIEW_REJECTED]),
            ProctoringEvent.severity.in_([SeverityEnum.HIGH, SeverityEnum.MEDIUM]),
        )
    )
    return bool(count)


def _attempt_ids_with_negative_proctoring_signal(db: Session, attempt_ids: list) -> set:
    if not attempt_ids:
        return set()
    rows = db.scalars(
        select(ProctoringEvent.attempt_id)
        .where(
            ProctoringEvent.attempt_id.in_(attempt_ids),
            ProctoringEvent.event_type.notin_([CERTIFICATE_REVIEW_APPROVED, CERTIFICATE_REVIEW_REJECTED]),
            ProctoringEvent.severity.in_([SeverityEnum.HIGH, SeverityEnum.MEDIUM]),
        )
        .distinct()
    ).all()
    return set(rows)


def _certificate_decision(
    attempt: Attempt,
    *,
    db: Session | None,
    pending_manual_review: bool | None = None,
) -> dict[str, object]:
    exam = attempt.exam
    certificate = exam_certificate(exam) if exam else None
    if not exam or not certificate:
        return {
            "eligible": False,
            "issue_rule": None,
            "review_status": None,
            "reviewed_at": None,
            "block_reason": None,
        }

    issue_rule = normalize_certificate_issue_rule(certificate.get("issue_rule"))
    if attempt.status not in {AttemptStatus.SUBMITTED, AttemptStatus.GRADED}:
        return {
            "eligible": False,
            "issue_rule": issue_rule,
            "review_status": None,
            "reviewed_at": None,
            "block_reason": "Attempt not completed yet",
        }

    if pending_manual_review is None and db is not None:
        pending_manual_review = _pending_manual_review_for_attempt(attempt, db)
    if pending_manual_review:
        return {
            "eligible": False,
            "issue_rule": issue_rule,
            "review_status": None,
            "reviewed_at": None,
            "block_reason": "Awaiting answer review",
        }

    if exam.passing_score is not None and attempt.score is not None and attempt.score < exam.passing_score:
        return {
            "eligible": False,
            "issue_rule": issue_rule,
            "review_status": None,
            "reviewed_at": None,
            "block_reason": "Passing score not met",
        }

    review_event = _certificate_review_event(attempt, db) if db is not None else None
    review_status = None
    reviewed_at = None
    if review_event:
        review_status = "APPROVED" if review_event.event_type == CERTIFICATE_REVIEW_APPROVED else "REJECTED"
        reviewed_at = review_event.occurred_at

    if issue_rule == "POSITIVE_PROCTORING":
        if db is not None and _has_negative_proctoring_signal(attempt, db):
            return {
                "eligible": False,
                "issue_rule": issue_rule,
                "review_status": review_status,
                "reviewed_at": reviewed_at,
                "block_reason": "Positive proctoring result not achieved",
            }
    elif issue_rule == "AFTER_PROCTORING_REVIEW":
        effective_status = review_status or "PENDING"
        if effective_status != "APPROVED":
            return {
                "eligible": False,
                "issue_rule": issue_rule,
                "review_status": effective_status,
                "reviewed_at": reviewed_at,
                "block_reason": (
                    "Certificate release rejected after proctoring review"
                    if effective_status == "REJECTED"
                    else "Awaiting proctoring review"
                ),
            }
        review_status = effective_status

    return {
        "eligible": True,
        "issue_rule": issue_rule,
        "review_status": review_status,
        "reviewed_at": reviewed_at,
        "block_reason": None,
    }


def _certificate_decisions_by_attempt(
    attempts: list[Attempt],
    *,
    db: Session,
    pending_manual_review_ids: set | None = None,
) -> dict:
    if not attempts:
        return {}

    pending_manual_review_ids = pending_manual_review_ids or set()
    completed_attempt_ids = []
    positive_signal_attempt_ids = []
    results = {}

    for attempt in attempts:
        exam = attempt.exam
        certificate = exam_certificate(exam) if exam else None
        if not exam or not certificate:
            results[attempt.id] = {
                "eligible": False,
                "issue_rule": None,
                "review_status": None,
                "reviewed_at": None,
                "block_reason": None,
            }
            continue

        issue_rule = normalize_certificate_issue_rule(certificate.get("issue_rule"))
        result = {
            "eligible": False,
            "issue_rule": issue_rule,
            "review_status": None,
            "reviewed_at": None,
            "block_reason": None,
        }

        if attempt.status not in {AttemptStatus.SUBMITTED, AttemptStatus.GRADED}:
            result["block_reason"] = "Attempt not completed yet"
            results[attempt.id] = result
            continue

        if attempt.id in pending_manual_review_ids:
            result["block_reason"] = "Awaiting answer review"
            results[attempt.id] = result
            continue

        if exam.passing_score is not None and attempt.score is not None and attempt.score < exam.passing_score:
            result["block_reason"] = "Passing score not met"
            results[attempt.id] = result
            continue

        completed_attempt_ids.append(attempt.id)
        if issue_rule == "POSITIVE_PROCTORING":
            positive_signal_attempt_ids.append(attempt.id)
        results[attempt.id] = result

    review_events = _certificate_review_events_by_attempt(db, completed_attempt_ids)
    negative_signal_attempt_ids = _attempt_ids_with_negative_proctoring_signal(db, positive_signal_attempt_ids)

    for attempt in attempts:
        result = results[attempt.id]
        issue_rule = result["issue_rule"]
        if not issue_rule or result["block_reason"]:
            continue

        review_event = review_events.get(attempt.id)
        if review_event:
            event_type, occurred_at = review_event
            result["review_status"] = "APPROVED" if event_type == CERTIFICATE_REVIEW_APPROVED else "REJECTED"
            result["reviewed_at"] = occurred_at

        if issue_rule == "POSITIVE_PROCTORING":
            if attempt.id in negative_signal_attempt_ids:
                result["block_reason"] = "Positive proctoring result not achieved"
                continue
        elif issue_rule == "AFTER_PROCTORING_REVIEW":
            effective_status = result["review_status"] or "PENDING"
            if effective_status != "APPROVED":
                result["review_status"] = effective_status
                result["block_reason"] = (
                    "Certificate release rejected after proctoring review"
                    if effective_status == "REJECTED"
                    else "Awaiting proctoring review"
                )
                continue

        result["eligible"] = True

    return results


def _build_attempt_read(
    attempt: Attempt,
    *,
    db: Session | None = None,
    pending_manual_review: bool | None = None,
    high_violations: int = 0,
    med_violations: int = 0,
    paused: bool | None = None,
    certificate: dict | None = None,
) -> AttemptRead:
    exam = attempt.exam
    user = getattr(attempt, "user", None)
    title = getattr(exam, "title", None) if exam else None
    exam_type = getattr(exam, "type", None) if exam else None
    time_limit = getattr(exam, "time_limit", None) if exam else None
    resolved_certificate = certificate or (
        _certificate_decision(
            attempt,
            db=db,
            pending_manual_review=pending_manual_review,
        ) if db is not None else {
            "eligible": False,
            "issue_rule": None,
            "review_status": None,
            "reviewed_at": None,
            "block_reason": None,
        }
    )
    return AttemptRead(
        id=attempt.id,
        exam_id=attempt.exam_id,
        user_id=attempt.user_id,
        status=attempt.status,
        paused=paused if paused is not None else (_attempt_is_paused(db, attempt.id) if db is not None else False),
        high_violations=high_violations,
        med_violations=med_violations,
        score=attempt.score,
        grade=attempt.grade,
        pending_manual_review=pending_manual_review,
        started_at=attempt.started_at,
        submitted_at=attempt.submitted_at,
        identity_verified=attempt.identity_verified,
        precheck_passed_at=getattr(attempt, "precheck_passed_at", None),
        lighting_score=getattr(attempt, "lighting_score", None),
        id_text=getattr(attempt, "id_text", None) if isinstance(getattr(attempt, "id_text", None), dict) else None,
        sections_finished=attempt.sections_finished,
        created_at=attempt.created_at,
        updated_at=attempt.updated_at,
        test_title=title,
        test_type=exam_type,
        test_time_limit=time_limit,
        exam_title=title,
        exam_type=exam_type,
        exam_time_limit=time_limit,
        node_id=getattr(exam, "node_id", None) if exam else None,
        attempts_used=None,
        attempts_remaining=None,
        user_name=getattr(user, "name", None) if user else None,
        user_student_id=getattr(user, "user_id", None) if user else None,
        selfie_path=attempt.selfie_path,
        id_doc_path=attempt.id_doc_path,
        certificate_eligible=bool(resolved_certificate["eligible"]) if resolved_certificate["issue_rule"] else None,
        certificate_issue_rule=resolved_certificate["issue_rule"],
        certificate_review_status=resolved_certificate["review_status"],
        certificate_reviewed_at=resolved_certificate["reviewed_at"],
        certificate_block_reason=resolved_certificate["block_reason"],
    )


async def _save_identity_photo(attempt_id: str, b64_data: str) -> str:
    """Persist an encrypted base64-encoded identity photo.

    Accepts both raw base64 strings and data URLs (data:image/jpeg;base64,...).
    Returns the stored object path or local file path.
    """
    # Strip possible data URL prefix
    if "," in b64_data:
        b64_data = b64_data.split(",", 1)[1]

    photo_bytes = encrypt_bytes(base64.b64decode(b64_data))
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
    filename = f"{attempt_id}_{ts}.bin"

    if settings.MEDIA_STORAGE_PROVIDER == "supabase":
        stored = await upload_bytes_to_supabase("identity", filename, photo_bytes, content_type="application/octet-stream")
        return str(stored.get("path") or filename)

    storage_dir = (
        Path(__file__)
        .resolve()
        .parent.parent.parent.parent.parent
        / "storage"
        / "identity"
    )
    storage_dir.mkdir(parents=True, exist_ok=True)
    filepath = storage_dir / filename
    filepath.write_bytes(photo_bytes)
    return str(filepath)


def _persistable_answer(raw_answer):
    if raw_answer is None:
        return None
    if isinstance(raw_answer, str):
        return raw_answer
    try:
        return json.dumps(raw_answer)
    except TypeError:
        return str(raw_answer)


def _normalized_text(value) -> str:
    if value is None:
        return ""
    return str(value).strip().lower()


def _normalized_sequence(value) -> list[str] | None:
    if value is None:
        return None
    parsed = _parsed_answer_value(value)
    if isinstance(parsed, list):
        return [_normalized_text(item) for item in parsed]
    return None


def _normalized_mapping(value) -> dict[str, str] | None:
    if value is None:
        return None
    parsed = _parsed_answer_value(value)
    if isinstance(parsed, dict):
        return {
            str(key).strip(): _normalized_text(item)
            for key, item in parsed.items()
        }
    return None


def _normalized_blank_values(value) -> list[str] | None:
    if value is None:
        return None
    parsed = _parsed_answer_value(value)
    if isinstance(parsed, list):
        return [_normalized_text(item) for item in parsed]
    if isinstance(parsed, str):
        return [_normalized_text(item) for item in parsed.split("|")]
    return None


def _choice_token(value, options: list[str] | None) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    upper = text.upper()
    if len(upper) == 1 and "A" <= upper <= "Z":
        if options:
            idx = ord(upper) - ord("A")
            if 0 <= idx < len(options):
                return upper
        else:
            return upper

    if options:
        normalized_options = [_normalized_text(opt) for opt in options]
        text_norm = _normalized_text(text)
        for idx, option_norm in enumerate(normalized_options):
            if option_norm == text_norm:
                return chr(ord("A") + idx)
    return _normalized_text(text)


def _multi_choice_tokens(value, options: list[str] | None) -> set[str]:
    tokens: list[str] = []
    if value is None:
        return set()

    if isinstance(value, list):
        tokens = [str(v) for v in value]
    elif isinstance(value, str):
        parsed = None
        try:
            parsed = json.loads(value)
        except Exception:
            parsed = None
        if isinstance(parsed, list):
            tokens = [str(v) for v in parsed]
        else:
            normalized = value.replace(";", ",").replace("\n", ",")
            tokens = [part.strip() for part in normalized.split(",") if part.strip()]
    else:
        tokens = [str(value)]

    canonical = {_choice_token(token, options) for token in tokens if str(token).strip()}
    return {token for token in canonical if token}


def _parsed_answer_value(value):
    if value is None:
        return None
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return ""
        if (trimmed.startswith("[") and trimmed.endswith("]")) or (
            trimmed.startswith("{") and trimmed.endswith("}")
        ):
            try:
                return json.loads(trimmed)
            except Exception:
                return trimmed
        return trimmed
    return value


def _answer_has_content(value) -> bool:
    parsed = _parsed_answer_value(value)
    if parsed is None:
        return False
    if isinstance(parsed, str):
        return bool(parsed.strip())
    if isinstance(parsed, list):
        return any(_answer_has_content(item) for item in parsed)
    if isinstance(parsed, dict):
        return any(_answer_has_content(item) for item in parsed.values())
    return True


def _question_requires_manual_review(question: Question, submitted_answer) -> bool:
    if not _answer_has_content(submitted_answer):
        return False
    if question.type == ExamType.TEXT:
        # Free-text responses always require reviewer scoring.
        return True
    return not bool(_normalized_text(question.correct_answer))


def _exam_schedule_for_user(db: Session, exam_id, user_id):
    return db.scalar(
        select(Schedule).where(Schedule.exam_id == exam_id, Schedule.user_id == user_id)
    )


def _enforce_attempt_access(db: Session, exam: Exam, current: User):
    if current.role != RoleEnum.LEARNER:
        ensure_exam_owner(exam, current, detail=_t("not_allowed"), status_code=status.HTTP_403_FORBIDDEN)
        return None
    if exam.status != ExamStatus.OPEN:
        raise HTTPException(status_code=404, detail=_t("test_not_found"))

    now = normalize_utc_datetime(datetime.now(timezone.utc))
    user_schedule = _exam_schedule_for_user(db, exam.id, current.id)
    if not user_schedule:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=_t("not_assigned_to_test"),
        )
    scheduled_at = normalize_utc_datetime(getattr(user_schedule, "scheduled_at", None))
    if scheduled_at and now and scheduled_at > now:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=_t("test_not_yet_available"),
        )
    return user_schedule


def _ensure_attempt_access(db: Session, attempt: Attempt, current: User):
    if current.role == RoleEnum.LEARNER:
        if attempt.user_id != current.id:
            raise HTTPException(status_code=403, detail=_t("not_allowed"))
        return
    ensure_permission(db, current, "View Attempt Analysis")
    exam = attempt.exam or db.get(Exam, attempt.exam_id)
    ensure_exam_owner(exam, current, detail=_t("not_allowed"), status_code=status.HTTP_403_FORBIDDEN)


def _evaluate_answer(question: Question, submitted_answer):
    if not question.correct_answer:
        # No correct answer configured — treat as 0 points (not None) to avoid
        # blocking the manual review queue for non-TEXT questions
        return None, 0.0

    q_type = question.type
    options = question.options or []
    expected = question.correct_answer

    if q_type in {ExamType.MCQ, ExamType.TRUEFALSE}:
        actual_token = _choice_token(submitted_answer, options)
        expected_token = _choice_token(expected, options)
        is_correct = bool(actual_token) and actual_token == expected_token
    elif q_type == ExamType.MULTI:
        actual_tokens = _multi_choice_tokens(submitted_answer, options)
        expected_tokens = _multi_choice_tokens(expected, options)
        is_correct = bool(actual_tokens) and actual_tokens == expected_tokens
    elif q_type == ExamType.ORDERING:
        actual_order = _normalized_sequence(submitted_answer)
        expected_order = _normalized_sequence(expected)
        if actual_order is None or expected_order is None:
            is_correct = _normalized_text(submitted_answer) == _normalized_text(expected)
        else:
            is_correct = actual_order == expected_order
    elif q_type == ExamType.MATCHING:
        actual_pairs = _normalized_mapping(submitted_answer)
        expected_pairs = _normalized_mapping(expected)
        if actual_pairs is None or expected_pairs is None:
            is_correct = _normalized_text(submitted_answer) == _normalized_text(expected)
        else:
            is_correct = bool(expected_pairs) and len(actual_pairs) == len(expected_pairs) and all(
                actual_pairs.get(key) == value
                for key, value in expected_pairs.items()
            )
    elif q_type == ExamType.FILLINBLANK:
        actual_values = _normalized_blank_values(submitted_answer)
        expected_values = _normalized_blank_values(expected)
        if actual_values is None or expected_values is None:
            is_correct = _normalized_text(submitted_answer) == _normalized_text(expected)
        else:
            is_correct = actual_values == expected_values
    elif q_type == ExamType.TEXT:
        is_correct = _normalized_text(submitted_answer) == _normalized_text(expected)
    else:
        is_correct = _normalized_text(submitted_answer) == _normalized_text(expected)

    points = float(question.points or 0) if is_correct else 0.0
    return is_correct, points


def _grade_label_for_score(exam: Exam | None, score: float | None, db: Session) -> str | None:
    grading_scale_id = getattr(exam, "grading_scale_id", None) if exam is not None else None
    if score is None or exam is None or not grading_scale_id:
        return None

    grading_scale = getattr(exam, "grading_scale", None) or db.get(GradingScale, grading_scale_id)
    labels = grading_scale.labels if grading_scale and isinstance(grading_scale.labels, list) else []
    numeric_score = float(score)
    for band in sorted(labels, key=lambda item: (item.get("min_score", 0), item.get("max_score", 0)), reverse=True):
        try:
            min_score = float(band.get("min_score"))
            max_score = float(band.get("max_score"))
        except (TypeError, ValueError):
            continue
        if min_score <= numeric_score <= max_score:
            label = str(band.get("label") or "").strip()
            return label or None
    return None


def _apply_attempt_grade(attempt: Attempt, score: float | None, db: Session) -> str | None:
    exam = attempt.exam or db.get(Exam, attempt.exam_id)
    attempt.grade = _grade_label_for_score(exam, score, db)
    return attempt.grade


def _load_attempt_for_update(db: Session, attempt_id) -> Attempt | None:
    if not hasattr(db, "execute"):
        return db.get(Attempt, attempt_id)
    return db.scalar(
        select(Attempt)
        .where(Attempt.id == attempt_id)
        .with_for_update()
    )


def _auto_score_attempt(attempt: Attempt, db: Session) -> dict:
    answers = db.scalars(
        select(AttemptAnswer).where(AttemptAnswer.attempt_id == attempt.id)
    ).all()
    answer_map = {answer.question_id: answer for answer in answers}
    questions = db.scalars(
        select(Question)
        .where(Question.exam_id == attempt.exam_id)
        .order_by(Question.order.asc(), Question.created_at.asc())
    ).all()
    if not questions:
        return {"score": None, "grade": None, "pending_manual_review": False}

    total_points = 0.0
    earned_points = 0.0
    earned_auto_points = 0.0
    pending_manual_review = False
    exam_settings = exam_runtime_settings(attempt.exam) if attempt.exam else {}
    negative_marking = bool((exam_settings or {}).get("negative_marking"))
    neg_mark_value = float((exam_settings or {}).get("neg_mark_value") or 0)
    neg_mark_type = str((exam_settings or {}).get("neg_mark_type") or "points").lower()
    for question in questions:
        total_points += float(question.points or 0)
        answer = answer_map.get(question.id)
        if not answer:
            continue

        has_content = _answer_has_content(answer.answer)
        if _question_requires_manual_review(question, answer.answer):
            pending_manual_review = True
            answer.is_correct = None
            answer.points_earned = None
            db.add(answer)
            continue

        if not has_content:
            answer.is_correct = None
            answer.points_earned = 0.0
            db.add(answer)
            continue

        is_correct, points_earned = _evaluate_answer(question, answer.answer)
        if (
            points_earned == 0.0
            and is_correct is False
            and negative_marking
            and neg_mark_value > 0
            and has_content
        ):
            if neg_mark_type == "points":
                points_earned = -min(neg_mark_value, float(question.points or 0))
            else:
                deduction = min(float(question.points or 0) * neg_mark_value, float(question.points or 0))
                points_earned = -deduction
        answer.is_correct = is_correct
        answer.points_earned = points_earned
        if points_earned is not None:
            earned_points += points_earned
            earned_auto_points += points_earned
        db.add(answer)

    if total_points <= 0:
        return {"score": None, "grade": None, "pending_manual_review": pending_manual_review}
    if pending_manual_review:
        partial_score = round((max(earned_auto_points, 0.0) / total_points) * 100, 2)
        return {"score": partial_score, "grade": None, "pending_manual_review": True}
    earned_points = max(earned_points, 0.0)
    score = round((earned_points / total_points) * 100, 2)
    return {
        "score": score,
        "grade": _grade_label_for_score(attempt.exam, score, db),
        "pending_manual_review": False,
    }


def _backfill_auto_graded_answers(attempt: Attempt, db: Session) -> bool:
    answers = db.scalars(
        select(AttemptAnswer)
        .options(joinedload(AttemptAnswer.question))
        .where(AttemptAnswer.attempt_id == attempt.id, AttemptAnswer.points_earned.is_(None))
    ).all()
    if not answers:
        return False

    exam_settings = exam_runtime_settings(attempt.exam) if attempt.exam else {}
    negative_marking = bool((exam_settings or {}).get("negative_marking"))
    neg_mark_value = float((exam_settings or {}).get("neg_mark_value") or 0)
    neg_mark_type = str((exam_settings or {}).get("neg_mark_type") or "points").lower()
    changed = False

    for answer in answers:
        question = answer.question
        if not question or question.exam_id != attempt.exam_id:
            continue
        if _question_requires_manual_review(question, answer.answer):
            continue

        has_content = _answer_has_content(answer.answer)
        if not has_content:
            answer.is_correct = None
            answer.points_earned = 0.0
            db.add(answer)
            changed = True
            continue

        is_correct, points_earned = _evaluate_answer(question, answer.answer)
        if (
            points_earned == 0.0
            and is_correct is False
            and negative_marking
            and neg_mark_value > 0
            and has_content
        ):
            if neg_mark_type == "points":
                points_earned = -min(neg_mark_value, float(question.points or 0))
            else:
                deduction = min(float(question.points or 0) * neg_mark_value, float(question.points or 0))
                points_earned = -deduction
        answer.is_correct = is_correct
        answer.points_earned = points_earned
        db.add(answer)
        changed = True

    if changed:
        db.commit()
        _invalidate_attempt_list_cache()
        db.refresh(attempt)
    return changed


def _pending_manual_review_for_attempt(attempt: Attempt, db: Session) -> bool:
    if attempt.status not in {AttemptStatus.SUBMITTED, AttemptStatus.GRADED}:
        return False
    progress = _calculate_attempt_review_progress(attempt, db)
    return bool(progress["pending_manual_review"])


def _pending_manual_review_attempt_ids(db: Session, attempt_ids: list) -> set:
    if not attempt_ids:
        return set()
    answers = db.scalars(
        select(AttemptAnswer)
        .options(
            load_only(
                AttemptAnswer.attempt_id,
                AttemptAnswer.answer,
                AttemptAnswer.points_earned,
            ),
            joinedload(AttemptAnswer.question).load_only(
                Question.id,
                Question.type,
                Question.correct_answer,
            ),
        )
        .where(
            AttemptAnswer.attempt_id.in_(attempt_ids),
            AttemptAnswer.points_earned.is_(None),
        )
    ).all()
    pending_ids = set()
    for answer in answers:
        if answer.question and _question_requires_manual_review(answer.question, answer.answer):
            pending_ids.add(answer.attempt_id)
    return pending_ids


def _attempt_list_cache_key(
    *,
    exam_id: str | None,
    user_id: str | None,
    status: str | None,
    pagination,
    current,
) -> str:
    return json.dumps(
        {
            "exam_id": exam_id,
            "user_id": user_id,
            "status": status,
            "pagination": {
                "page": pagination.page,
                "page_size": pagination.page_size,
                "search": pagination.search,
                "sort": pagination.sort,
                "order": pagination.order,
            },
            "current_role": getattr(current.role, "value", current.role),
            "current_user_id": str(getattr(current, "id", "")),
        },
        sort_keys=True,
        default=str,
    )


def _apply_admin_grade(attempt: Attempt, *, score: float, db: Session, graded_by=None) -> Attempt:
    from ...services.audit import write_audit_log

    if score < 0 or score > 100:
        raise HTTPException(status_code=422, detail=_t("score_range_error"))
    if attempt.status == AttemptStatus.IN_PROGRESS:
        raise HTTPException(status_code=400, detail=_t("attempt_must_be_submitted"))

    previous_score = attempt.score
    if attempt.submitted_at is None:
        attempt.submitted_at = datetime.now(timezone.utc)
    attempt.score = round(float(score), 2)
    _apply_attempt_grade(attempt, attempt.score, db)
    attempt.status = AttemptStatus.GRADED
    db.add(attempt)
    db.commit()
    db.refresh(attempt)
    try:
        write_audit_log(
            db,
            getattr(graded_by, "id", None),
            "ATTEMPT_GRADED",
            "attempt",
            str(attempt.id),
            f"Score changed from {previous_score} to {attempt.score} by admin",
        )
    except Exception:
        pass
    return attempt


def _calculate_attempt_review_progress(attempt: Attempt, db: Session) -> dict:
    answers = db.scalars(
        select(AttemptAnswer).where(AttemptAnswer.attempt_id == attempt.id)
    ).all()
    answer_map = {answer.question_id: answer for answer in answers}
    questions = db.scalars(
        select(Question)
        .where(Question.exam_id == attempt.exam_id)
        .order_by(Question.order.asc(), Question.created_at.asc())
    ).all()

    total_points = 0.0
    earned_points = 0.0
    manual_total = 0
    manual_reviewed = 0
    pending_manual_review = False

    for question in questions:
        total_points += float(question.points or 0)
        answer = answer_map.get(question.id)
        if not answer:
            continue

        if _question_requires_manual_review(question, answer.answer):
            manual_total += 1
            if answer.points_earned is None:
                pending_manual_review = True
                continue
            manual_reviewed += 1
            earned_points += float(answer.points_earned or 0)
            continue

        if answer.points_earned is not None:
            earned_points += float(answer.points_earned)

    score = None
    if total_points > 0 and not pending_manual_review:
        score = round((max(earned_points, 0.0) / total_points) * 100, 2)

    return {
        "score": score,
        "grade": _grade_label_for_score(attempt.exam, score, db),
        "pending_manual_review": pending_manual_review,
        "manual_total": manual_total,
        "manual_reviewed": manual_reviewed,
    }


def _face_present(image_bytes: bytes) -> bool:
    np_arr = np.frombuffer(image_bytes, np.uint8)
    frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if frame is None:
        return False
    mp = _get_mediapipe()
    if mp is not None and hasattr(mp, "solutions") and getattr(mp.solutions, "face_detection", None):
        try:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            with mp.solutions.face_detection.FaceDetection(model_selection=0, min_detection_confidence=0.6) as detector:
                res = detector.process(rgb)
                return bool(res.detections)
        except Exception:
            pass
    # Fallback when mediapipe is unavailable (e.g. lightweight CI/dev environments).
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    classifier = cv2.CascadeClassifier(cascade_path)
    faces = classifier.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(40, 40))
    return len(faces) > 0


def _runtime_settings(exam: Exam | None) -> dict:
    return exam_runtime_settings(exam) if exam else {}


def _create_attempt_record(db: Session, exam: Exam, current: User) -> Attempt:
    _enforce_attempt_access(db, exam, current)
    if current.role == RoleEnum.LEARNER:
        existing_attempts = db.scalars(
            select(Attempt)
            .where(
                Attempt.exam_id == exam.id,
                Attempt.user_id == current.id,
            )
            .order_by(Attempt.started_at.desc(), Attempt.created_at.desc())
            .with_for_update()
        ).all()
        count = len(existing_attempts)
        if count >= exam.max_attempts:
            raise HTTPException(status_code=400, detail=_t("max_attempts_reached"))

        runtime_settings = _runtime_settings(exam)
        completed_attempts = [attempt for attempt in existing_attempts if attempt.status in {AttemptStatus.SUBMITTED, AttemptStatus.GRADED}]
        if completed_attempts:
            allow_retake = bool(runtime_settings.get("allow_retake"))
            if not allow_retake:
                raise HTTPException(status_code=400, detail=_t("retakes_disabled"))

            cooldown_raw = runtime_settings.get("retake_cooldown_hours")
            try:
                cooldown_hours = float(cooldown_raw or 0)
            except (TypeError, ValueError):
                cooldown_hours = 0.0

            latest_completed = max(
                completed_attempts,
                key=lambda attempt: normalize_utc_datetime(
                    attempt.submitted_at or attempt.updated_at or attempt.created_at
                ) or datetime.min.replace(tzinfo=timezone.utc),
            )
            latest_completed_at = normalize_utc_datetime(
                latest_completed.submitted_at or latest_completed.updated_at or latest_completed.created_at
            )
            if latest_completed_at and cooldown_hours > 0:
                available_at = latest_completed_at + timedelta(hours=cooldown_hours)
                now = normalize_utc_datetime(datetime.now(timezone.utc))
                if now and now < available_at:
                    wait_minutes = max(1, int((available_at - now).total_seconds() // 60) + (1 if (available_at - now).total_seconds() % 60 else 0))
                    raise HTTPException(status_code=400, detail=_t("retake_available_in", wait_minutes=wait_minutes))
    now = datetime.now(timezone.utc)
    attempt = Attempt(
        exam_id=exam.id,
        user_id=current.id,
        status=AttemptStatus.IN_PROGRESS,
        started_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(attempt)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=409, detail=_t("could_not_create_attempt"))
    db.refresh(attempt)
    # Post-commit guard: if a concurrent request snuck past the pre-check,
    # verify we haven't exceeded max_attempts and roll back if so.
    if current.role == RoleEnum.LEARNER and exam.max_attempts:
        post_count = db.scalar(
            select(func.count(Attempt.id)).where(
                Attempt.exam_id == exam.id,
                Attempt.user_id == current.id,
            )
        )
        if post_count and post_count > exam.max_attempts:
            db.delete(attempt)
            db.commit()
            raise HTTPException(status_code=400, detail=_t("max_attempts_reached"))
    return attempt


@router.post("/", response_model=AttemptRead)
def create_attempt(body: AttemptCreate, db: Session = Depends(get_db_dep), current=Depends(require_role(RoleEnum.LEARNER, RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    exam = db.get(Exam, body.exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail=_t("test_not_found"))
    attempt = _create_attempt_record(db, exam, current)
    return _build_attempt_read(attempt, db=db)


@router.post("/resolve", response_model=AttemptRead)
def resolve_attempt(
    body: AttemptResolveRequest,
    db: Session = Depends(get_db_dep),
    current=Depends(require_role(RoleEnum.LEARNER, RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    exam = db.get(Exam, body.exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail=_t("test_not_found"))
    _enforce_attempt_access(db, exam, current)
    reusable = db.scalars(
        select(Attempt)
        .where(
            Attempt.exam_id == body.exam_id,
            Attempt.user_id == current.id,
            Attempt.status == AttemptStatus.IN_PROGRESS,
        )
        .order_by(Attempt.started_at.desc(), Attempt.created_at.desc())
        .limit(1)
    ).first()
    if reusable:
        return _build_attempt_read(reusable, db=db)
    attempt = _create_attempt_record(db, exam, current)
    return _build_attempt_read(attempt, db=db)


@router.get("/", response_model=PaginatedResponse[AttemptRead])
def list_attempts(
    exam_id: str | None = None,
    user_id: str | None = None,
    status: str | None = None,
    page: int | None = Query(None, ge=1),
    page_size: int | None = Query(None, ge=1, le=MAX_PAGE_SIZE),
    search: str | None = Query(None),
    sort: str | None = Query(None),
    order: str | None = Query(None),
    skip: int | None = Query(None, ge=0),
    limit: int | None = Query(None, ge=1, le=MAX_PAGE_SIZE),
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    pagination = normalize_pagination(
        page=page,
        page_size=page_size,
        search=search,
        sort=sort,
        order=order,
        skip=skip,
        limit=limit,
        default_sort="created_at",
        default_page_size=50,
    )
    resolved_sort = clamp_sort_field(pagination.sort, {"created_at", "updated_at", "submitted_at", "score"}, "created_at")
    order_column = getattr(Attempt, resolved_sort)
    order_column = order_column.asc() if pagination.order == "asc" else order_column.desc()
    cache_key = _attempt_list_cache_key(
        exam_id=exam_id,
        user_id=user_id,
        status=status,
        pagination=pagination,
        current=current,
    )

    def _load_attempts() -> dict:
        base_query = select(Attempt)
        if current.role == RoleEnum.LEARNER:
            base_query = base_query.where(Attempt.user_id == current.id)
        else:
            ensure_permission(db, current, "View Attempt Analysis")
            base_query = base_query.where(Attempt.exam_id.in_(select(Exam.id).where(Exam.created_by_id == current.id)))
            if user_id:
                try:
                    from uuid import UUID

                    base_query = base_query.where(Attempt.user_id == str(UUID(user_id)))
                except (ValueError, TypeError):
                    pass
        if exam_id:
            try:
                from uuid import UUID

                base_query = base_query.where(Attempt.exam_id == str(UUID(exam_id)))
            except (ValueError, TypeError):
                pass
        if status:
            try:
                base_query = base_query.where(Attempt.status == AttemptStatus(status))
            except ValueError:
                pass
        if pagination.search:
            like = f"%{pagination.search.lower()}%"
            base_query = (
                base_query.join(Attempt.exam, isouter=True)
                .join(Attempt.user, isouter=True)
                .where(
                    or_(
                        func.lower(func.coalesce(Exam.title, "")).like(like),
                        func.lower(func.coalesce(User.name, "")).like(like),
                        func.lower(func.coalesce(User.user_id, "")).like(like),
                    )
                )
            )
        total = db.scalar(select(func.count()).select_from(base_query.subquery())) or 0
        query = (
            base_query
            .options(
                load_only(
                    Attempt.id,
                    Attempt.exam_id,
                    Attempt.user_id,
                    Attempt.status,
                    Attempt.score,
                    Attempt.grade,
                    Attempt.started_at,
                    Attempt.submitted_at,
                    Attempt.identity_verified,
                    Attempt.created_at,
                    Attempt.updated_at,
                ),
                joinedload(Attempt.exam).load_only(
                    Exam.id,
                    Exam.node_id,
                    Exam.title,
                    Exam.type,
                    Exam.time_limit,
                    Exam.passing_score,
                    Exam.certificate,
                ),
                joinedload(Attempt.exam).joinedload(Exam.certificate_config_rel),
                joinedload(Attempt.user).load_only(
                    User.id,
                    User.name,
                    User.user_id,
                ),
            )
            .order_by(order_column, Attempt.created_at.desc())
            .offset(pagination.offset)
            .limit(pagination.limit)
        )
        attempts = db.scalars(query).unique().all()
        attempt_ids = [attempt.id for attempt in attempts]
        pending_ids = _pending_manual_review_attempt_ids(db, attempt_ids)
        violation_counts = _violation_counts_by_attempt(db, attempt_ids)
        paused_ids = _paused_attempt_ids(db, attempt_ids)
        certificate_decisions = _certificate_decisions_by_attempt(
            attempts,
            db=db,
            pending_manual_review_ids=pending_ids,
        )
        return build_page_response(
            items=[
                _build_attempt_read(
                    a,
                    db=None,
                    pending_manual_review=a.id in pending_ids,
                    high_violations=violation_counts.get(str(a.id), {}).get("high_violations", 0),
                    med_violations=violation_counts.get(str(a.id), {}).get("med_violations", 0),
                    paused=a.id in paused_ids,
                    certificate=certificate_decisions.get(a.id),
                )
                for a in attempts
            ],
            total=total,
            pagination=pagination,
            extended=False,
        )

    return _attempt_list_cache.get_or_compute(cache_key, _load_attempts)


@router.get("/{attempt_id}", response_model=AttemptRead)
def get_attempt(
    attempt_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    attempt = db.get(Attempt, attempt_pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    _ensure_attempt_access(db, attempt, current)
    violation_counts = _violation_counts_by_attempt(db, [attempt.id]).get(str(attempt.id), {})
    return _build_attempt_read(
        attempt,
        db=db,
        pending_manual_review=_pending_manual_review_for_attempt(attempt, db),
        high_violations=violation_counts.get("high_violations", 0),
        med_violations=violation_counts.get("med_violations", 0),
    )


def _ensure_section_answerable(db: Session, attempt, question) -> None:
    section_id = getattr(question, "section_id", None)
    if not section_id:
        return
    settings = exam_runtime_settings(attempt.exam) if attempt.exam else {}
    sequential = bool(settings.get("sequential_sections"))
    allow_revisit = settings.get("allow_revisit_sections", True)
    finished = set(str(s) for s in (attempt.sections_finished or []))

    if not allow_revisit and str(section_id) in finished:
        raise HTTPException(status_code=409, detail=_t("cannot_modify_submitted"))

    if sequential:
        this_section = db.get(ExamSection, section_id)
        if this_section is not None:
            earlier = db.scalars(
                select(ExamSection).where(
                    ExamSection.exam_id == attempt.exam_id,
                    ExamSection.order < this_section.order,
                )
            ).all()
            if any(str(s.id) not in finished for s in earlier):
                raise HTTPException(status_code=409, detail=_t("section_locked"))


@router.post("/{attempt_id}/answers", response_model=AttemptAnswerRead)
def submit_answer(
    attempt_id: str,
    body: AttemptAnswerBase,
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    attempt = _load_attempt_for_update(db, attempt_pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    _ensure_attempt_access(db, attempt, current)
    if attempt.status != AttemptStatus.IN_PROGRESS:
        raise HTTPException(status_code=409, detail=_t("cannot_modify_submitted"))
    if _attempt_is_paused(db, attempt_pk):
        raise HTTPException(status_code=409, detail=_t("attempt_is_paused"))
    # Server-side identity verification enforcement
    proctoring_payload = exam_proctoring(attempt.exam) if attempt.exam else None
    exam_requirements = get_proctoring_requirements(proctoring_payload)
    if exam_requirements["identity_required"] and not (attempt.id_verified or attempt.identity_verified):
        raise HTTPException(status_code=403, detail=_t("identity_verification_required"))
    # Server-side time limit enforcement
    time_limit = getattr(attempt.exam, "time_limit", None) if attempt.exam else None
    if time_limit and attempt.started_at:
        deadline = attempt.started_at + timedelta(minutes=time_limit)
        if datetime.now(timezone.utc) > deadline + timedelta(seconds=30):
            raise HTTPException(status_code=409, detail=_t("time_limit_exceeded"))
    # Verify the question belongs to this attempt's exam
    question = db.get(Question, body.question_id)
    if not question or question.exam_id != attempt.exam_id:
        raise HTTPException(status_code=400, detail=_t("question_not_in_exam"))
    _ensure_section_answerable(db, attempt, question)
    persisted_answer = _persistable_answer(body.answer)
    ans = db.scalar(
        select(AttemptAnswer).where(
            AttemptAnswer.attempt_id == attempt_pk,
            AttemptAnswer.question_id == body.question_id,
        )
    )
    if ans:
        ans.answer = persisted_answer
    else:
        ans = AttemptAnswer(attempt_id=attempt_pk, question_id=body.question_id, answer=persisted_answer)
        db.add(ans)
    try:
        db.commit()
    except IntegrityError:
        # In case of concurrent creates, reconcile on the newly existing row.
        db.rollback()
        ans = db.scalar(
            select(AttemptAnswer).where(
                AttemptAnswer.attempt_id == attempt_pk,
                AttemptAnswer.question_id == body.question_id,
            )
        )
        if not ans:
            raise
        ans.answer = persisted_answer
        db.add(ans)
        db.commit()
    _invalidate_attempt_list_cache()
    db.refresh(ans)
    if getattr(ans, "id", None) is None:
        ans.id = uuid4()
    ans.question_text = ans.question.text if ans.question else None
    return ans


@router.post("/{attempt_id}/sections/{section_id}/finish", response_model=AttemptRead)
def mark_section_finished(
    attempt_id: str,
    section_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    attempt = _load_attempt_for_update(db, attempt_pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    _ensure_attempt_access(db, attempt, current)
    if attempt.status != AttemptStatus.IN_PROGRESS:
        raise HTTPException(status_code=409, detail=_t("cannot_modify_submitted"))
    section = db.get(ExamSection, parse_uuid_param(section_id, detail=_t("test_not_found")))
    if not section or section.exam_id != attempt.exam_id:
        raise HTTPException(status_code=400, detail=_t("question_not_in_exam"))
    finished = list(attempt.sections_finished or [])
    if str(section.id) not in finished:
        finished.append(str(section.id))
    attempt.sections_finished = finished
    db.add(attempt)
    db.commit()
    db.refresh(attempt)
    return _build_attempt_read(attempt, db=db)


@router.get("/{attempt_id}/answers", response_model=list[AttemptAnswerRead])
def list_attempt_answers(
    attempt_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    attempt = db.get(Attempt, attempt_pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    _ensure_attempt_access(db, attempt, current)
    answers = db.scalars(
        select(AttemptAnswer)
        .where(AttemptAnswer.attempt_id == attempt_pk)
        .order_by(AttemptAnswer.id)
    ).all()
    for answer in answers:
        if getattr(answer, "id", None) is None:
            answer.id = uuid4()
        answer.question_text = answer.question.text if answer.question else None
    return answers


@router.post("/{attempt_id}/submit", response_model=AttemptRead)
def submit_attempt(
    attempt_id: str,
    score: float | None = None,
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    attempt = _load_attempt_for_update(db, attempt_pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    _ensure_attempt_access(db, attempt, current)
    if attempt.status in {AttemptStatus.SUBMITTED, AttemptStatus.GRADED}:
        raise HTTPException(status_code=400, detail=_t("attempt_already_submitted"))
    if attempt.status != AttemptStatus.IN_PROGRESS:
        raise HTTPException(status_code=400, detail=_t("cannot_submit_current_state"))
    if _attempt_is_paused(db, attempt_pk):
        raise HTTPException(status_code=409, detail=_t("attempt_is_paused"))
    # Server-side time limit enforcement (same as submit_answer, with 30s grace)
    time_limit = getattr(attempt.exam, "time_limit", None) if attempt.exam else None
    if time_limit and attempt.started_at:
        deadline = attempt.started_at + timedelta(minutes=time_limit)
        if datetime.now(timezone.utc) > deadline + timedelta(seconds=30):
            raise HTTPException(status_code=409, detail=_t("time_limit_exceeded"))
    proctoring_payload = exam_proctoring(attempt.exam) if attempt.exam else None
    exam_requirements = get_proctoring_requirements(proctoring_payload)
    exam_requires_verification = exam_requirements["identity_required"]
    if (
        exam_requires_verification
        and not (attempt.id_verified or attempt.identity_verified)
    ):
        raise HTTPException(status_code=400, detail=_t("pre_test_verification_required"))
    if current.role == RoleEnum.LEARNER:
        score = None  # learners cannot grade
    elif score is not None:
        graded = _apply_admin_grade(attempt, score=score, db=db, graded_by=current)
        _invalidate_attempt_list_cache()
        _notify_attempt_result(db, graded, result_kind="graded")
        return _build_attempt_read(graded, db=db)

    score_result = _auto_score_attempt(attempt, db)
    computed_score = score_result["score"]
    pending_manual_review = bool(score_result.get("pending_manual_review"))
    attempt.status = AttemptStatus.SUBMITTED
    attempt.submitted_at = datetime.now(timezone.utc)
    if score is None and computed_score is not None:
        score = computed_score
    if score is not None:
        attempt.score = score
    else:
        attempt.score = None
    attempt.grade = score_result.get("grade") if attempt.score is not None else None
    db.add(attempt)
    db.commit()
    _invalidate_attempt_list_cache()
    db.refresh(attempt)
    if attempt.score is not None and not pending_manual_review:
        _notify_attempt_result(db, attempt, result_kind="scored")
    return _build_attempt_read(
        attempt,
        db=db,
        pending_manual_review=pending_manual_review,
    )


@router.post("/{attempt_id}/grade", response_model=AttemptRead)
def grade_attempt(
    attempt_id: str,
    score: float,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("View Attempt Analysis", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    attempt = db.get(Attempt, attempt_pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    exam = attempt.exam or db.get(Exam, attempt.exam_id)
    ensure_exam_owner(exam, current, detail=_t("not_allowed"), status_code=status.HTTP_403_FORBIDDEN)
    graded = _apply_admin_grade(attempt, score=score, db=db, graded_by=current)
    _invalidate_attempt_list_cache()
    _notify_attempt_result(db, graded, result_kind="graded")
    return _build_attempt_read(graded, db=db, pending_manual_review=False)


@router.post("/{attempt_id}/answers/{answer_id}/review", response_model=AttemptAnswerRead)
def review_attempt_answer(
    attempt_id: str,
    answer_id: str,
    body: AttemptAnswerReviewUpdate,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("View Attempt Analysis", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    answer_pk = parse_uuid_param(answer_id, detail=_t("attempt_answer_not_found"))
    attempt = db.get(Attempt, attempt_pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    exam = attempt.exam or db.get(Exam, attempt.exam_id)
    ensure_exam_owner(exam, current, detail=_t("not_allowed"), status_code=status.HTTP_403_FORBIDDEN)
    if attempt.status == AttemptStatus.IN_PROGRESS:
        raise HTTPException(status_code=400, detail=_t("attempt_must_be_submitted_review"))

    answer = db.scalar(
        select(AttemptAnswer).where(
            AttemptAnswer.id == answer_pk,
            AttemptAnswer.attempt_id == attempt_pk,
        )
    )
    if not answer:
        raise HTTPException(status_code=404, detail=_t("attempt_answer_not_found"))

    question = answer.question
    if not question:
        raise HTTPException(status_code=404, detail=_t("question_not_found"))
    if not _question_requires_manual_review(question, answer.answer):
        raise HTTPException(status_code=400, detail=_t("only_manual_review"))

    max_points = float(question.points or 0)
    points_earned = round(float(body.points_earned), 2)
    if points_earned < 0 or points_earned > max_points:
        raise HTTPException(status_code=422, detail=_t("points_range_error", max_points=f"{max_points:g}"))

    answer.points_earned = points_earned
    answer.is_correct = None
    db.add(answer)
    db.commit()
    _invalidate_attempt_list_cache()
    db.refresh(answer)
    answer.question_text = answer.question.text if answer.question else None
    return answer


@router.post("/{attempt_id}/finalize-review", response_model=AttemptRead)
def finalize_attempt_review(
    attempt_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("View Attempt Analysis", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    attempt = db.get(Attempt, attempt_pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    exam = attempt.exam or db.get(Exam, attempt.exam_id)
    ensure_exam_owner(exam, current, detail=_t("not_allowed"), status_code=status.HTTP_403_FORBIDDEN)
    if attempt.status == AttemptStatus.IN_PROGRESS:
        raise HTTPException(status_code=400, detail=_t("attempt_must_be_submitted_review"))

    _backfill_auto_graded_answers(attempt, db)
    progress = _calculate_attempt_review_progress(attempt, db)
    if progress["manual_total"] > 0 and progress["pending_manual_review"]:
        raise HTTPException(status_code=409, detail=_t("review_all_manual"))
    if progress["score"] is None:
        raise HTTPException(status_code=400, detail=_t("attempt_score_not_finalized"))

    attempt.score = progress["score"]
    attempt.grade = progress.get("grade")
    attempt.status = AttemptStatus.GRADED
    if attempt.submitted_at is None:
        attempt.submitted_at = datetime.now(timezone.utc)
    db.add(attempt)
    db.commit()
    _invalidate_attempt_list_cache()
    db.refresh(attempt)
    _notify_attempt_result(db, attempt, result_kind="graded")
    return _build_attempt_read(attempt, db=db, pending_manual_review=False)


@router.post("/{attempt_id}/certificate-review", response_model=AttemptRead)
def review_attempt_certificate(
    attempt_id: str,
    body: AttemptCertificateReviewUpdate,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("View Attempt Analysis", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    attempt = db.get(Attempt, attempt_pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    exam = attempt.exam or db.get(Exam, attempt.exam_id)
    ensure_exam_owner(exam, current, detail=_t("not_allowed"), status_code=status.HTTP_403_FORBIDDEN)
    if attempt.status == AttemptStatus.IN_PROGRESS:
        raise HTTPException(status_code=400, detail=_t("attempt_must_be_submitted_cert"))

    certificate = exam_certificate(attempt.exam) if attempt.exam else None
    if not certificate:
        raise HTTPException(status_code=400, detail=_t("cert_not_configured"))
    if normalize_certificate_issue_rule(certificate.get("issue_rule")) != "AFTER_PROCTORING_REVIEW":
        raise HTTPException(status_code=400, detail=_t("cert_no_proctoring_review"))

    pending_manual_review = _pending_manual_review_for_attempt(attempt, db)
    if pending_manual_review:
        raise HTTPException(status_code=409, detail=_t("finalize_answer_review_first"))

    event_type = CERTIFICATE_REVIEW_APPROVED if body.decision == "APPROVED" else CERTIFICATE_REVIEW_REJECTED
    detail = (
        "Certificate approved after proctoring review"
        if body.decision == "APPROVED"
        else "Certificate rejected after proctoring review"
    )
    db.add(
        ProctoringEvent(
            attempt_id=attempt.id,
            event_type=event_type,
            severity=SeverityEnum.LOW if body.decision == "APPROVED" else SeverityEnum.MEDIUM,
            detail=detail,
            meta={
                "reviewer_user_id": str(current.id),
                "reviewer_name": current.name,
                "decision": body.decision,
            },
            occurred_at=datetime.now(timezone.utc),
        )
    )
    db.commit()
    _invalidate_attempt_list_cache()
    db.refresh(attempt)
    return _build_attempt_read(attempt, db=db, pending_manual_review=False)


@router.post("/{attempt_id}/verify-identity", response_model=AttemptRead)
async def verify_identity(
    attempt_id: str,
    photo_base64: str = Body(..., embed=True, description="Base64 data URL or raw base64 of the captured ID photo."),
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    """Mark attempt as identity verified and persist the captured photo."""
    attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    attempt = db.get(Attempt, attempt_pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))

    if current.role == RoleEnum.LEARNER:
        if attempt.user_id != current.id:
            raise HTTPException(status_code=403, detail=_t("not_allowed"))
    else:
        exam = attempt.exam or db.get(Exam, attempt.exam_id)
        ensure_exam_owner(exam, current, detail=_t("not_allowed"), status_code=status.HTTP_403_FORBIDDEN)

    try:
        raw_bytes = base64.b64decode(photo_base64.split(",", 1)[1] if "," in photo_base64 else photo_base64)
    except Exception:
        raise HTTPException(status_code=400, detail=_t("invalid_photo_data"))

    if not _face_present(raw_bytes):
        raise HTTPException(status_code=400, detail=_t("face_not_detected"))

    signature = compute_face_signature(raw_bytes)

    saved_photo = _save_identity_photo(str(attempt_pk), photo_base64)
    if inspect.isawaitable(saved_photo):
        saved_photo = await saved_photo

    # Only mark as verified if a face signature could be computed.
    # This endpoint captures a single photo — it does NOT compare faces.
    # Full identity verification (selfie vs ID) goes through /precheck.
    verified = signature is not None
    attempt.identity_verified = verified
    attempt.id_verified = verified
    attempt.precheck_passed_at = datetime.now(timezone.utc) if verified else None
    attempt.face_signature = signature
    attempt.updated_at = datetime.now(timezone.utc)
    db.add(attempt)
    db.commit()
    db.refresh(attempt)
    return _build_attempt_read(attempt, db=db)


def _certificate_data(attempt: Attempt) -> dict:
    """Flatten the exam certificate config + attempt into the fields a template draws."""
    exam = attempt.exam
    user = attempt.user
    cfg = exam_certificate(exam) or {}
    date = attempt.submitted_at or datetime.now(timezone.utc)
    return {
        "title": cfg.get("title") or "Certificate of Completion",
        "subtitle": cfg.get("subtitle") or "",
        "description": cfg.get("description") or "",
        "issuer": cfg.get("issuer_name") or cfg.get("issuer") or "SYRA LMS",
        "signer": cfg.get("signer_name") or cfg.get("signer") or "Authorized Signatory",
        "name": user.name if user else "Learner",
        "exam": exam.title if exam else "Test",
        "score": f"{attempt.score:.0f}%" if attempt.score is not None else "N/A",
        "date": date.strftime("%B %d, %Y"),
        "template": (cfg.get("template") or "Classic"),
        "orientation": (cfg.get("orientation") or "landscape"),
    }


def _draw_wrapped_centered(c, text, cx, y, font, size, max_width, color=None, leading=None) -> float:
    """Draw word-wrapped, centred text; return the y below the last line."""
    if not text:
        return y
    if color is not None:
        c.setFillColor(color)
    c.setFont(font, size)
    step = leading or size * 1.35
    for line in simpleSplit(str(text), font, size, max_width):
        c.drawCentredString(cx, y, line)
        y -= step
    return y


def _cert_classic(c, W, H, d) -> None:
    navy = colors.HexColor("#1e2a4a")
    gold = colors.HexColor("#b0893f")
    grey = colors.HexColor("#4a4a4a")
    cx, m = W / 2, 0.055 * W
    c.setStrokeColor(navy); c.setLineWidth(3); c.rect(m, m, W - 2 * m, H - 2 * m)
    c.setStrokeColor(gold); c.setLineWidth(1); c.rect(m + 7, m + 7, W - 2 * m - 14, H - 2 * m - 14)
    c.setFillColor(navy); c.setFont("Times-Bold", 30); c.drawCentredString(cx, H * 0.80, d["title"])
    if d["subtitle"]:
        c.setFillColor(gold); c.setFont("Times-Italic", 14); c.drawCentredString(cx, H * 0.755, d["subtitle"])
    c.setFillColor(grey); c.setFont("Times-Roman", 12); c.drawCentredString(cx, H * 0.655, "This is to certify that")
    c.setFillColor(navy); c.setFont("Times-BoldItalic", 26); c.drawCentredString(cx, H * 0.595, d["name"])
    c.setStrokeColor(gold); c.setLineWidth(1); c.line(cx - 0.22 * W, H * 0.575, cx + 0.22 * W, H * 0.575)
    c.setFillColor(grey); c.setFont("Times-Roman", 12); c.drawCentredString(cx, H * 0.515, "has successfully completed")
    c.setFillColor(navy); c.setFont("Times-Bold", 17); c.drawCentredString(cx, H * 0.470, d["exam"])
    y = _draw_wrapped_centered(c, d["description"], cx, H * 0.415, "Times-Italic", 11, 0.62 * W, colors.HexColor("#666666"))
    c.setFillColor(grey); c.setFont("Times-Roman", 11)
    c.drawCentredString(cx, min(y - 6, H * 0.32), f"Score: {d['score']}     -     {d['date']}")
    c.setStrokeColor(navy); c.setLineWidth(1); c.line(cx - 0.16 * W, H * 0.19, cx + 0.16 * W, H * 0.19)
    c.setFillColor(navy); c.setFont("Times-Bold", 12); c.drawCentredString(cx, H * 0.165, d["signer"])
    c.setFillColor(colors.HexColor("#666666")); c.setFont("Times-Roman", 10); c.drawCentredString(cx, H * 0.14, d["issuer"])


def _cert_modern(c, W, H, d) -> None:
    accent = colors.HexColor("#0e7c66")
    dark = colors.HexColor("#1f2937")
    muted = colors.HexColor("#6b7280")
    cx = W / 2
    band = H * 0.17
    c.setFillColor(accent); c.rect(0, H - band, W, band, fill=1, stroke=0)
    c.setFillColor(colors.white); c.setFont("Helvetica-Bold", 26); c.drawCentredString(cx, H - band * 0.63, d["title"])
    if d["subtitle"]:
        c.setFillColor(accent); c.setFont("Helvetica", 13); c.drawCentredString(cx, H * 0.745, d["subtitle"])
    c.setFillColor(muted); c.setFont("Helvetica", 11); c.drawCentredString(cx, H * 0.645, "PRESENTED TO")
    c.setFillColor(dark); c.setFont("Helvetica-Bold", 26); c.drawCentredString(cx, H * 0.585, d["name"])
    c.setFillColor(muted); c.setFont("Helvetica", 11); c.drawCentredString(cx, H * 0.505, "for successfully completing")
    c.setFillColor(accent); c.setFont("Helvetica-Bold", 16); c.drawCentredString(cx, H * 0.460, d["exam"])
    y = _draw_wrapped_centered(c, d["description"], cx, H * 0.405, "Helvetica", 11, 0.64 * W, muted)
    c.setFillColor(dark); c.setFont("Helvetica", 11)
    c.drawCentredString(cx, min(y - 6, H * 0.30), f"Score {d['score']}     |     {d['date']}")
    c.setStrokeColor(accent); c.setLineWidth(2); c.line(cx - 0.15 * W, H * 0.18, cx + 0.15 * W, H * 0.18)
    c.setFillColor(dark); c.setFont("Helvetica-Bold", 12); c.drawCentredString(cx, H * 0.155, d["signer"])
    c.setFillColor(muted); c.setFont("Helvetica", 10); c.drawCentredString(cx, H * 0.13, d["issuer"])


def _cert_simple(c, W, H, d) -> None:
    dark = colors.HexColor("#111827")
    muted = colors.HexColor("#6b7280")
    hair = colors.HexColor("#d1d5db")
    cx, m = W / 2, 0.05 * W
    c.setStrokeColor(hair); c.setLineWidth(0.75); c.rect(m, m, W - 2 * m, H - 2 * m)
    c.setFillColor(dark); c.setFont("Helvetica-Bold", 24); c.drawCentredString(cx, H * 0.78, d["title"])
    if d["subtitle"]:
        c.setFillColor(muted); c.setFont("Helvetica", 12); c.drawCentredString(cx, H * 0.735, d["subtitle"])
    c.setFillColor(muted); c.setFont("Helvetica", 11); c.drawCentredString(cx, H * 0.635, "This certifies that")
    c.setFillColor(dark); c.setFont("Helvetica-Bold", 22); c.drawCentredString(cx, H * 0.575, d["name"])
    c.setFillColor(muted); c.setFont("Helvetica", 11); c.drawCentredString(cx, H * 0.495, "has completed")
    c.setFillColor(dark); c.setFont("Helvetica-Bold", 15); c.drawCentredString(cx, H * 0.450, d["exam"])
    y = _draw_wrapped_centered(c, d["description"], cx, H * 0.395, "Helvetica", 10, 0.66 * W, muted)
    c.setFillColor(muted); c.setFont("Helvetica", 10)
    c.drawCentredString(cx, min(y - 6, H * 0.29), f"{d['score']}     -     {d['date']}")
    c.setStrokeColor(hair); c.setLineWidth(0.75); c.line(cx - 0.14 * W, H * 0.18, cx + 0.14 * W, H * 0.18)
    c.setFillColor(dark); c.setFont("Helvetica-Bold", 11); c.drawCentredString(cx, H * 0.155, d["signer"])
    c.setFillColor(muted); c.setFont("Helvetica", 9); c.drawCentredString(cx, H * 0.13, d["issuer"])


_CERT_TEMPLATES = {"classic": _cert_classic, "modern": _cert_modern, "simple": _cert_simple}


def _generate_certificate(attempt: Attempt) -> bytes:
    """Render the attempt's certificate as a PDF, honouring the exam's configured
    template (Classic/Modern/Simple), orientation (landscape/portrait) and description."""
    d = _certificate_data(attempt)
    pagesize = landscape(A4) if str(d["orientation"]).strip().lower() == "landscape" else A4
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=pagesize)
    width, height = pagesize
    renderer = _CERT_TEMPLATES.get(str(d["template"]).strip().lower(), _cert_classic)
    renderer(c, width, height, d)
    c.showPage()
    c.save()
    buffer.seek(0)
    return buffer.read()


@router.post("/import", response_model=list[AttemptRead])
def import_attempts(
    body: list[dict] = Body(...),
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("View Attempt Analysis", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    """Bulk import attempt results. Each row: {user_id, test_title|exam_title, score}"""
    created = []
    now = datetime.now(timezone.utc)
    for row in body:
        uid = str(row.get("user_id", "")).strip()
        test_title = str(row.get("test_title") or row.get("exam_title") or "").strip()
        try:
            score = float(row.get("score", 0))
        except (TypeError, ValueError):
            continue
        if score < 0 or score > 100:
            continue
        user = db.scalar(
            select(User).where((User.user_id == uid) | (User.email == uid))
        )
        exam = db.scalar(select(Exam).where(Exam.title == test_title)) if test_title else None
        if not user or not exam:
            continue
        ensure_exam_owner(exam, current, detail=_t("not_allowed"), status_code=status.HTTP_403_FORBIDDEN)
        attempt = Attempt(
            exam_id=exam.id,
            user_id=user.id,
            status=AttemptStatus.GRADED,
            score=score,
            started_at=now,
            submitted_at=now,
            created_at=now,
            updated_at=now,
        )
        attempt.exam = exam
        attempt.user = user
        _apply_attempt_grade(attempt, score, db)
        db.add(attempt)
        db.flush()
        created.append(_build_attempt_read(attempt, db=db))
    db.commit()
    return created


@router.get("/{attempt_id}/certificate")
def download_certificate(
    attempt_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    attempt = db.get(Attempt, attempt_pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    _ensure_attempt_access(db, attempt, current)

    exam = attempt.exam
    if not exam or not exam_certificate(exam):
        raise HTTPException(status_code=400, detail=_t("cert_not_configured"))
    decision = _certificate_decision(
        attempt,
        db=db,
        pending_manual_review=_pending_manual_review_for_attempt(attempt, db),
    )
    if not decision["eligible"]:
        raise HTTPException(status_code=400, detail=str(decision["block_reason"] or _t("cert_not_available")))

    pdf_bytes = _generate_certificate(attempt)
    return StreamingResponse(io.BytesIO(pdf_bytes), media_type="application/pdf", headers={
        "Content-Disposition": f'attachment; filename="certificate_{attempt_id}.pdf"',
        "Content-Length": str(len(pdf_bytes)),
    })
