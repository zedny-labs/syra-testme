from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session, joinedload, load_only

from ..api.deps import ensure_exam_owner, ensure_permission, learner_can_access_exam
from ..models import Course, CourseStatus, Exam, ExamStatus, Node, Question, RoleEnum, Schedule
from ..modules.tests.proctoring_requirements import normalize_proctoring_config
from ..schemas import ExamCreate, ExamRead, ExamUpdate, Message
from ..utils.pagination import build_page_response, clamp_sort_field, normalize_pagination
from ..utils.response_cache import TimedSingleFlightCache
from .normalized_relations import (
    apply_runtime_attempt_policy_defaults,
    exam_certificate,
    exam_proctoring,
    exam_runtime_settings,
    runtime_attempt_policy_conflicts,
    set_exam_certificate,
    set_exam_proctoring,
    set_exam_runtime_settings,
)
from ..core.i18n import translate as _t
from .sanitization import sanitize_exam_payload

logger = logging.getLogger(__name__)
_learner_exam_list_cache: TimedSingleFlightCache[dict] = TimedSingleFlightCache(ttl_seconds=15.0)


DEFAULT_PROCTORING = {
    "face_detection": True,
    "multi_face": True,
    "audio_detection": True,
    "object_detection": True,
    "eye_tracking": True,
    "head_pose_detection": True,
    "mouth_detection": False,
    "face_verify": True,
    "fullscreen_enforce": True,
    "tab_switch_detect": True,
    "screen_capture": True,
    "copy_paste_block": True,
    "alert_rules": [],
    "eye_deviation_deg": 12,
    "mouth_open_threshold": 0.35,
    "audio_rms_threshold": 0.08,
    "max_face_absence_sec": 1.5,
    "max_tab_blurs": 3,
    "max_alerts_before_autosubmit": 5,
    "max_fullscreen_exits": 2,
    "max_alt_tabs": 3,
    "lighting_min_score": 0.35,
    "face_verify_id_threshold": 0.55,
    "max_score_before_autosubmit": 15,
    "frame_interval_ms": 900,
    "audio_chunk_ms": 2000,
    "screenshot_interval_sec": 60,
    "face_verify_threshold": 0.15,
    "cheating_consecutive_frames": 5,
    "head_pose_consecutive": 5,
    "eye_consecutive": 5,
    "object_confidence_threshold": 0.35,
    "audio_consecutive_chunks": 2,
    "audio_speech_consecutive_chunks": 2,
    "audio_speech_min_rms": 0.03,
    "audio_speech_baseline_multiplier": 1.35,
    "audio_window": 5,
    "multi_face_min_area_ratio": 0.008,
    "head_pose_yaw_deg": 20,
    "head_pose_pitch_deg": 20,
    "head_pitch_min_rad": -0.3,
    "head_pitch_max_rad": 0.2,
    "head_yaw_min_rad": -0.6,
    "head_yaw_max_rad": 0.6,
    "eye_pitch_min_rad": -0.5,
    "eye_pitch_max_rad": 0.2,
    "eye_yaw_min_rad": -0.5,
    "eye_yaw_max_rad": 0.5,
    "pose_change_threshold_rad": 0.1,
    "eye_change_threshold_rad": 0.2,
    "camera_cover_hard_luma": 20.0,
    "camera_cover_soft_luma": 40.0,
    "camera_cover_stddev_max": 16.0,
    "camera_cover_hard_consecutive_frames": 1,
    "camera_cover_soft_consecutive_frames": 2,
}


def _assert_runtime_attempt_policy(settings: dict | None, max_attempts: int | None) -> None:
    if runtime_attempt_policy_conflicts(settings, max_attempts):
        raise HTTPException(status_code=422, detail=_t("enable_retakes_or_reduce"))


def _scalars_all(db: Session, query):
    if hasattr(db, "scalars"):
        result = db.scalars(query)
        if hasattr(result, "all"):
            return result.all()
        return list(result)

    result = db.execute(query)
    rows = result.all() if hasattr(result, "all") else list(result)
    items = []
    for row in rows:
        if isinstance(row, tuple):
            items.append(row[0] if row else row)
            continue
        if hasattr(row, "_mapping"):
            values = list(row._mapping.values())
            items.append(values[0] if len(values) == 1 else row)
            continue
        try:
            items.append(row[0])
        except Exception:
            items.append(row)
    return items


def list_tests(
    *,
    db: Session,
    current,
    page: int | None,
    page_size: int | None,
    search: str | None,
    sort: str | None,
    order: str | None,
    skip: int | None,
    limit: int | None,
):
    pagination = normalize_pagination(
        page=page,
        page_size=page_size,
        search=search,
        sort=sort,
        order=order,
        skip=skip,
        limit=limit,
        default_sort="updated_at",
        default_page_size=50,
    )
    sort_field = clamp_sort_field(pagination.sort, {"created_at", "updated_at", "title"}, "updated_at")
    order_column = getattr(Exam, sort_field)
    order_column = order_column.asc() if pagination.order == "asc" else order_column.desc()

    if current.role == RoleEnum.LEARNER:
        return _list_learner_tests(
            db=db,
            current=current,
            pagination=pagination,
            order_column=order_column,
        )

    question_count_sq = (
        select(func.count(Question.id))
        .where(Question.exam_id == Exam.id)
        .correlate(Exam)
        .scalar_subquery()
        .label("_question_count")
    )
    query = (
        select(Exam, question_count_sq)
        .options(
            joinedload(Exam.node).joinedload(Node.course),
            joinedload(Exam.category),
        )
        .where(Exam.library_pool_id.is_(None))
        .order_by(order_column, Exam.created_at.desc())
    )
    if pagination.search:
        like = f"%{pagination.search.lower()}%"
        query = query.where(
            or_(
                func.lower(Exam.title).like(like),
                func.lower(func.coalesce(Exam.description, "")).like(like),
            )
        )

    ensure_permission(db, current, "Edit Tests")
    if current.role in {RoleEnum.ADMIN, RoleEnum.INSTRUCTOR}:
        query = query.where(Exam.created_by_id == current.id)
    total = db.scalar(select(func.count()).select_from(query.with_only_columns(Exam.id).order_by(None).subquery())) or 0
    rows = db.execute(query.offset(pagination.offset).limit(pagination.limit)).all()
    return build_page_response(
        items=[serialize_legacy_test(test, qcount=qc) for test, qc in rows],
        total=total,
        pagination=pagination,
        extended=False,
    )


def _list_learner_tests(*, db: Session, current, pagination, order_column) -> dict:
    cache_key = json.dumps(
        {
            "user_id": str(current.id),
            "page": pagination.page,
            "page_size": pagination.page_size,
            "search": pagination.search,
            "sort": pagination.sort,
            "order": pagination.order,
        },
        sort_keys=True,
    )

    def _load() -> dict:
        current_time = datetime.now(timezone.utc)
        scheduled_exam_ids = (
            select(Schedule.exam_id.label("exam_id"))
            .where(
                Schedule.user_id == current.id,
                Schedule.exam_id.is_not(None),
                Schedule.scheduled_at <= current_time,
            )
            .subquery()
        )
        filters = [
            Exam.library_pool_id.is_(None),
            Exam.status == ExamStatus.OPEN,
        ]
        if pagination.search:
            like = f"%{pagination.search.lower()}%"
            filters.append(
                or_(
                    func.lower(Exam.title).like(like),
                    func.lower(func.coalesce(Exam.description, "")).like(like),
                )
            )

        query = (
            select(Exam)
            .join(scheduled_exam_ids, scheduled_exam_ids.c.exam_id == Exam.id)
            .options(
                load_only(
                    Exam.id,
                    Exam.node_id,
                    Exam.title,
                    Exam.type,
                    Exam.status,
                    Exam.time_limit,
                    Exam.max_attempts,
                    Exam.passing_score,
                    Exam.description,
                    Exam.category_id,
                    Exam.grading_scale_id,
                    Exam.created_at,
                    Exam.updated_at,
                ),
                joinedload(Exam.node)
                .load_only(Node.id, Node.title, Node.course_id)
                .joinedload(Node.course)
                .load_only(Course.id, Course.title),
            )
            .where(*filters)
            .order_by(order_column, Exam.created_at.desc())
        )
        total = db.scalar(
            select(func.count(Exam.id))
            .select_from(Exam)
            .join(scheduled_exam_ids, scheduled_exam_ids.c.exam_id == Exam.id)
            .where(*filters)
        ) or 0
        tests = db.execute(query.offset(pagination.offset).limit(pagination.limit)).unique().scalars().all()
        return build_page_response(
            items=[serialize_learner_catalog_test(test) for test in tests],
            total=total,
            pagination=pagination,
            extended=False,
        )

    return _learner_exam_list_cache.get_or_compute(cache_key, _load)


def create_test(*, db: Session, body: ExamCreate, current) -> ExamRead:
    now = datetime.now(timezone.utc)
    payload = sanitize_exam_payload(body.model_dump(exclude={"questions"}))
    _validate_create_payload(body)
    runtime_settings = apply_runtime_attempt_policy_defaults(payload.get("settings"), body.max_attempts)
    _assert_runtime_attempt_policy(runtime_settings, body.max_attempts)

    node = _resolve_node(db=db, node_id=body.node_id, actor=current, now=now)
    test = Exam(
        node_id=node.id,
        title=body.title.strip(),
        description=payload.get("description"),
        type=body.type,
        status=body.status,
        time_limit=body.time_limit,
        max_attempts=body.max_attempts,
        passing_score=body.passing_score,
        category_id=body.category_id,
        grading_scale_id=body.grading_scale_id,
        created_at=now,
        updated_at=now,
        created_by_id=current.id,
    )
    set_exam_proctoring(test, normalize_proctoring(body.proctoring_config))
    set_exam_runtime_settings(test, runtime_settings)
    set_exam_certificate(test, body.certificate)
    db.add(test)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=_t("title_already_exists_module"))
    except OperationalError:
        db.rollback()
        raise HTTPException(status_code=503, detail=_t("database_unavailable"))
    db.refresh(test)
    _invalidate_learner_exam_list_cache()
    return serialize_legacy_test(test)


def get_test(*, db: Session, test_id: str, current) -> ExamRead:
    test = db.get(Exam, parse_test_id(test_id))
    if not test:
        raise HTTPException(status_code=404, detail=_t("test_not_found"))
    if current.role == RoleEnum.LEARNER:
        if not learner_can_access_exam(db, test, current):
            raise HTTPException(status_code=404, detail=_t("test_not_found"))
    else:
        ensure_permission(db, current, "Edit Tests")
        ensure_exam_owner(test, current)
    return serialize_legacy_test(test)


def update_test(*, db: Session, test_id: str, body: ExamUpdate, current) -> ExamRead:
    test = db.get(Exam, parse_test_id(test_id))
    if not test:
        raise HTTPException(status_code=404, detail=_t("test_not_found"))
    if current.role in {RoleEnum.ADMIN, RoleEnum.INSTRUCTOR}:
        ensure_exam_owner(test, current, detail=_t("not_allowed"), status_code=403)

    data = sanitize_exam_payload(body.model_dump(exclude_unset=True))
    if not data:
        return serialize_legacy_test(test)
    _validate_update_payload(data)
    next_max_attempts = data.get("max_attempts", test.max_attempts)

    # Block critical setting changes while exam is published (OPEN)
    _LOCKED_WHILE_OPEN = {"time_limit", "max_attempts", "passing_score", "proctoring_config", "type"}
    if test.status == ExamStatus.OPEN:
        locked_fields = _LOCKED_WHILE_OPEN & data.keys()
        if locked_fields:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot modify {', '.join(sorted(locked_fields))} while the test is published",
            )

    for field, value in data.items():
        if field == "node_id":
            node = db.get(Node, value)
            if not node:
                raise HTTPException(status_code=404, detail=_t("node_not_found"))
            test.node_id = value
            continue
        if field == "proctoring_config":
            set_exam_proctoring(test, normalize_proctoring(value))
            continue
        if field == "settings":
            normalized_settings = apply_runtime_attempt_policy_defaults(value, next_max_attempts)
            _assert_runtime_attempt_policy(normalized_settings, next_max_attempts)
            set_exam_runtime_settings(test, normalized_settings)
            continue
        if field == "certificate":
            set_exam_certificate(test, value)
            continue
        setattr(test, field, value)

    if "settings" not in data and "max_attempts" in data and next_max_attempts > 1:
        current_settings = exam_runtime_settings(test)
        if current_settings.get("allow_retake") is False:
            set_exam_runtime_settings(test, {**current_settings, "allow_retake": True})

    test.updated_at = datetime.now(timezone.utc)
    target_status = data.get("status", test.status)
    if target_status == ExamStatus.OPEN:
        assert_has_questions(db, test.id)
    db.add(test)
    try:
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Failed to update legacy test %s", test_id)
        raise HTTPException(status_code=409, detail=_t("failed_update_test_conflict"))
    db.refresh(test)
    _invalidate_learner_exam_list_cache()
    return serialize_legacy_test(test)


def delete_test(*, db: Session, test_id: str, current) -> Message:
    test = db.get(Exam, parse_test_id(test_id))
    if not test:
        raise HTTPException(status_code=404, detail=_t("test_not_found"))
    ensure_exam_owner(test, current, detail=_t("not_allowed"), status_code=403)
    try:
        db.delete(test)
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Failed to delete legacy test %s", test_id)
        raise HTTPException(
            status_code=409,
            detail=_t("cannot_delete_test_attempts"),
        )
    _invalidate_learner_exam_list_cache()
    return Message(detail=_t("deleted"))


def serialize_legacy_test(test: Exam, *, qcount: int | None = None) -> ExamRead:
    node = test.node
    course = node.course if node else None
    category_name = test.category.name if test.category else None
    return ExamRead(
        id=test.id,
        node_id=test.node_id,
        node_title=node.title if node else None,
        course_id=course.id if course else None,
        course_title=course.title if course else None,
        title=test.title,
        type=test.type,
        status=test.status,
        time_limit=test.time_limit,
        max_attempts=test.max_attempts,
        passing_score=test.passing_score,
        proctoring_config=exam_proctoring(test),
        description=test.description,
        settings=exam_runtime_settings(test),
        certificate=exam_certificate(test),
        category_id=test.category_id,
        grading_scale_id=test.grading_scale_id,
        category_name=category_name,
        time_limit_minutes=test.time_limit,
        created_at=test.created_at,
        updated_at=test.updated_at,
        question_count=qcount if qcount is not None else test.question_count,
    )


def serialize_learner_catalog_test(test: Exam) -> ExamRead:
    node = test.node
    course = node.course if node else None
    return ExamRead(
        id=test.id,
        node_id=test.node_id,
        node_title=node.title if node else None,
        course_id=course.id if course else None,
        course_title=course.title if course else None,
        title=test.title,
        type=test.type,
        status=test.status,
        time_limit=test.time_limit,
        max_attempts=test.max_attempts,
        passing_score=test.passing_score,
        proctoring_config=None,
        description=test.description,
        settings=None,
        certificate=None,
        category_id=test.category_id,
        grading_scale_id=test.grading_scale_id,
        category_name=None,
        created_at=test.created_at,
        updated_at=test.updated_at,
        question_count=None,
    )


def _invalidate_learner_exam_list_cache() -> None:
    _learner_exam_list_cache.invalidate()


def assert_has_questions(db: Session, test_id) -> None:
    count = db.scalar(select(func.count()).select_from(Question).where(Question.exam_id == test_id))
    if not count:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_t("must_have_question_publish"))


def parse_test_id(test_id: str) -> str:
    try:
        return str(UUID(test_id))
    except (TypeError, ValueError):
        raise HTTPException(status_code=404, detail=_t("test_not_found"))


def normalize_proctoring(config: dict | None) -> dict:
    payload = DEFAULT_PROCTORING.copy()
    if config:
        payload.update({key: value for key, value in config.items() if value is not None})
    return normalize_proctoring_config(payload)


def _validate_create_payload(body: ExamCreate) -> None:
    if not body.title or not body.title.strip():
        raise HTTPException(status_code=422, detail=_t("title_required"))
    if body.time_limit is not None and body.time_limit <= 0:
        raise HTTPException(status_code=422, detail=_t("time_limit_positive"))
    if body.time_limit is not None and body.time_limit > 600:
        raise HTTPException(status_code=422, detail=_t("time_limit_max"))
    if body.max_attempts is not None and body.max_attempts < 1:
        raise HTTPException(status_code=422, detail=_t("max_attempts_min"))
    if body.passing_score is not None and not 0 <= body.passing_score <= 100:
        raise HTTPException(status_code=422, detail=_t("passing_score_range"))
    if body.status == ExamStatus.OPEN:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_t("must_have_question_publish"))


def _validate_update_payload(data: dict) -> None:
    if "title" in data and (data["title"] is None or not str(data["title"]).strip()):
        raise HTTPException(status_code=422, detail=_t("title_required"))
    if "title" in data:
        data["title"] = str(data["title"]).strip()
    if "time_limit" in data:
        time_limit = data["time_limit"]
        if time_limit is not None and time_limit <= 0:
            raise HTTPException(status_code=422, detail=_t("time_limit_positive"))
        if time_limit is not None and time_limit > 600:
            raise HTTPException(status_code=422, detail=_t("time_limit_max"))
    if "max_attempts" in data:
        max_attempts = data["max_attempts"]
        if max_attempts is not None and max_attempts < 1:
            raise HTTPException(status_code=422, detail=_t("max_attempts_min"))
    if "passing_score" in data:
        passing_score = data["passing_score"]
        if passing_score is not None and not 0 <= passing_score <= 100:
            raise HTTPException(status_code=422, detail=_t("passing_score_range"))


def _resolve_node(*, db: Session, node_id, actor, now: datetime) -> Node:
    if node_id:
        node = db.get(Node, node_id)
        if not node:
            raise HTTPException(status_code=404, detail=_t("node_not_found"))
        return node

    node = db.scalars(select(Node).order_by(Node.created_at)).first()
    if node:
        return node

    course = Course(
        title="General",
        description="Auto-created course",
        status=CourseStatus.DRAFT,
        created_by_id=actor.id,
        created_at=now,
        updated_at=now,
    )
    db.add(course)
    db.flush()

    node = Node(course_id=course.id, title="Module 1", order=0, created_at=now, updated_at=now)
    db.add(node)
    db.flush()
    return node
