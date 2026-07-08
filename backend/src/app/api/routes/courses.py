from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import Attempt, Course, CourseStatus, Exam, Node, RoleEnum
from ...schemas import CourseCreate, CourseRead, CourseBase, Message
from ...services.sanitization import sanitize_plain_text
from ...core.i18n import translate as _t
from ..deps import ensure_permission, get_current_user, get_db_dep, parse_uuid_param, require_permission

router = APIRouter()
INTERNAL_POOL_LIBRARY_TITLE = "Question Pool Library"
INTERNAL_POOL_LIBRARY_DESCRIPTION = "Hidden library course for question pool storage"


def _query_first(db: Session, statement):
    scalar = getattr(db, "scalar", None)
    if callable(scalar):
        existing = scalar(statement)
        if existing is not None:
            return existing
    scalars = getattr(db, "scalars", None)
    if not callable(scalars):
        return None
    result = scalars(statement)
    if hasattr(result, "first"):
        return result.first()
    rows = result.all() if hasattr(result, "all") else list(result)
    return rows[0] if rows else None


def _clean_required_text(value: str | None, field_name: str) -> str:
    text = sanitize_plain_text(str(value or "").strip()) or ""
    if not text:
        raise HTTPException(
            status_code=422,
            detail=_t("field_required", field_name=field_name),
        )
    return text


def _clean_optional_text(value: str | None) -> str | None:
    text = sanitize_plain_text(str(value or "").strip()) or ""
    return text or None


def _ensure_unique_course_title(db: Session, title: str, existing_course_id=None):
    normalized = title.strip().lower()
    existing = _query_first(
        db,
        select(Course).where(func.lower(Course.title) == normalized)
    )
    if existing and getattr(existing, "id", None) != existing_course_id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_t("course_title_exists"))


def _normalize_course_payload(body: CourseBase) -> dict:
    return {
        "title": _clean_required_text(body.title, "Course title"),
        "description": _clean_optional_text(body.description),
        "status": body.status,
    }


def _exclude_internal_library_courses(statement):
    return statement.where(
        ~(
            (Course.title == INTERNAL_POOL_LIBRARY_TITLE)
            & (Course.description == INTERNAL_POOL_LIBRARY_DESCRIPTION)
        )
    )


@router.get("/", response_model=list[CourseRead])
def list_courses(db: Session = Depends(get_db_dep), current=Depends(get_current_user)):
    # The "Question Pool Library" course is internal storage for question pools
    # (see question_pools._ensure_pool_library_exam) and must never surface as a
    # selectable course — for learners OR for admins/instructors in the test wizard.
    query = _exclude_internal_library_courses(select(Course))
    if current.role == RoleEnum.LEARNER:
        query = query.where(Course.status == CourseStatus.PUBLISHED)
    else:
        ensure_permission(db, current, "Edit Tests")
        query = query.where(Course.created_by_id == current.id)
    courses = db.scalars(query.order_by(Course.created_at.desc())).all()
    return courses


@router.post("/", response_model=CourseRead)
def create_course(body: CourseCreate, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    payload = _normalize_course_payload(body)
    _ensure_unique_course_title(db, payload["title"])
    now = datetime.now(timezone.utc)
    course = Course(
        title=payload["title"],
        description=payload["description"],
        status=payload["status"],
        created_by_id=current.id,
        created_at=now,
        updated_at=now,
    )
    db.add(course)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=_t("course_title_already_exists"))
    db.refresh(course)
    return course


@router.get("/{course_id}", response_model=CourseRead)
def get_course(course_id: str, db: Session = Depends(get_db_dep), current=Depends(get_current_user)):
    course_pk = parse_uuid_param(course_id, detail=_t("course_not_found"))
    course = db.get(Course, course_pk)
    if not course:
        raise HTTPException(status_code=404, detail=_t("course_not_found"))
    if current.role == RoleEnum.LEARNER and course.status == CourseStatus.DRAFT:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_t("course_not_found"))
    if current.role != RoleEnum.LEARNER:
        ensure_permission(db, current, "Edit Tests")
        if course.created_by_id != current.id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_t("course_not_found"))
    return course


@router.put("/{course_id}", response_model=CourseRead)
def update_course(course_id: str, body: CourseBase, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    course_pk = parse_uuid_param(course_id, detail=_t("course_not_found"))
    course = db.get(Course, course_pk)
    if not course:
        raise HTTPException(status_code=404, detail=_t("course_not_found"))
    if course.created_by_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))
    payload = _normalize_course_payload(body)
    _ensure_unique_course_title(db, payload["title"], existing_course_id=course.id)
    for field, value in payload.items():
        setattr(course, field, value)
    course.updated_at = datetime.now(timezone.utc)
    db.add(course)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=_t("course_title_already_exists"))
    db.refresh(course)
    return course


@router.delete("/{course_id}", response_model=Message)
def delete_course(course_id: str, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN))):
    course_pk = parse_uuid_param(course_id, detail=_t("course_not_found"))
    course = db.get(Course, course_pk)
    if not course:
        raise HTTPException(status_code=404, detail=_t("course_not_found"))
    if course.created_by_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))
    attempt_count = int(
        db.scalar(
            select(func.count(Attempt.id))
            .select_from(Attempt)
            .join(Exam, Attempt.exam_id == Exam.id)
            .join(Node, Exam.node_id == Node.id)
            .where(Node.course_id == course.id)
        )
        or 0
    )
    if attempt_count:
        raise HTTPException(
            status_code=409,
            detail=_t("cannot_delete_course_attempts"),
        )
    db.delete(course)
    db.commit()
    return Message(detail=_t("deleted"))
