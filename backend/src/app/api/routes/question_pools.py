import random
import logging

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from ...models import Course, CourseStatus, Exam, ExamStatus, ExamType, Node, Question, QuestionPool, RoleEnum
from ...schemas import Message, QuestionBase, QuestionPoolCreate, QuestionPoolRead, QuestionRead
from ...services.audit import write_audit_log
from ...services.normalized_relations import is_exam_pool_library, set_exam_library_pool
from ...services.sanitization import sanitize_question_payload
from ...core.i18n import translate as _t
from ..deps import get_db_dep, parse_uuid_param, require_permission

router = APIRouter()
logger = logging.getLogger(__name__)


def _is_pool_library_exam(exam: Exam, pool_id) -> bool:
    return is_exam_pool_library(exam, pool_id)


def _looks_like_pool_library_exam(exam: Exam, pool_id) -> bool:
    expected_prefix = f"Pool Library {str(pool_id)[:8]}"
    return str(getattr(exam, "title", "") or "").startswith(expected_prefix)


def _first_scalar_row(result):
    if hasattr(result, "first"):
        return result.first()
    rows = result.all() if hasattr(result, "all") else list(result)
    return rows[0] if rows else None


def _ensure_pool_library_exam(db: Session, current, pool: QuestionPool) -> Exam:
    existing = _first_scalar_row(db.scalars(select(Exam).where(Exam.library_pool_id == pool.id).limit(1)))
    if existing:
        return existing

    now = datetime.now(timezone.utc)
    course = _first_scalar_row(
        db.scalars(
            select(Course).where(
                Course.created_by_id == current.id,
                Course.title == "Question Pool Library",
            )
        )
    )
    if not course:
        course = Course(
            title="Question Pool Library",
            description="Hidden library course for question pool storage",
            status=CourseStatus.DRAFT,
            created_by_id=current.id,
            created_at=now,
            updated_at=now,
        )
        db.add(course)
        db.flush()

    node = _first_scalar_row(
        db.scalars(
            select(Node).where(
                Node.course_id == course.id,
                Node.title == "Shared Pool Questions",
            )
        )
    )
    if not node:
        node = Node(
            course_id=course.id,
            title="Shared Pool Questions",
            order=0,
            created_at=now,
            updated_at=now,
        )
        db.add(node)
        db.flush()

    exam = Exam(
        node_id=node.id,
        title=f"Pool Library {str(pool.id)[:8]}",
        description=f"Hidden storage exam for pool {pool.name}",
        type=ExamType.MCQ,
        status=ExamStatus.CLOSED,
        time_limit=60,
        max_attempts=1,
        created_by_id=current.id,
        library_pool_id=pool.id,
        created_at=now,
        updated_at=now,
    )
    set_exam_library_pool(exam, pool.id)
    db.add(exam)
    db.flush()
    return exam


def _find_pool_library_exam(db: Session, pool_id) -> Exam | None:
    direct_match = _first_scalar_row(
        db.scalars(select(Exam).where(Exam.library_pool_id == pool_id).limit(1))
    )
    if direct_match:
        return direct_match

    prefix = f"Pool Library {str(pool_id)[:8]}"
    legacy_candidate = _first_scalar_row(
        db.scalars(select(Exam).where(Exam.title.startswith(prefix)).order_by(Exam.created_at.desc()).limit(1))
    )
    if legacy_candidate and _is_pool_library_exam(legacy_candidate, pool_id):
        return legacy_candidate
    return None


def _find_corrupted_pool_library_exam(db: Session, pool_id) -> Exam | None:
    prefix = f"Pool Library {str(pool_id)[:8]}"
    candidates = db.scalars(
        select(Exam).where(Exam.title.startswith(prefix)).order_by(Exam.created_at.desc()).limit(5)
    ).all()
    for candidate in candidates:
        if not _is_pool_library_exam(candidate, pool_id):
            return candidate
    return None


def _list_pool_library_exams(db: Session, pool_id) -> list[Exam]:
    prefix = f"Pool Library {str(pool_id)[:8]}"
    candidates = db.scalars(
        select(Exam)
        .options(joinedload(Exam.node).joinedload(Node.course))
        .where(
            or_(
                Exam.library_pool_id == pool_id,
                Exam.title.startswith(prefix),
            )
        )
        .order_by(Exam.created_at.desc())
    ).unique().all()
    seen: set[str] = set()
    matches: list[Exam] = []
    for candidate in candidates:
        candidate_id = str(getattr(candidate, "id", ""))
        if candidate_id in seen:
            continue
        if _is_pool_library_exam(candidate, pool_id) or _looks_like_pool_library_exam(candidate, pool_id):
            matches.append(candidate)
            seen.add(candidate_id)
    return matches


def _cleanup_pool_library_resources(db: Session, pool_id) -> None:
    library_exams = _list_pool_library_exams(db, pool_id)
    if not library_exams:
        return

    candidate_node_ids = {exam.node_id for exam in library_exams if getattr(exam, "node_id", None) is not None}
    candidate_course_ids = {
        exam.node.course_id
        for exam in library_exams
        if getattr(exam, "node", None) is not None and getattr(exam.node, "course_id", None) is not None
    }

    for exam in library_exams:
        db.delete(exam)
    db.flush()

    if candidate_node_ids:
        shared_node_ids = db.scalars(
            select(Node.id).where(
                Node.id.in_(candidate_node_ids),
                Node.title == "Shared Pool Questions",
            )
        ).all()
        for node_id in shared_node_ids:
            remaining_exam_count = db.scalar(
                select(func.count()).select_from(Exam).where(Exam.node_id == node_id)
            ) or 0
            if remaining_exam_count:
                continue
            node = db.get(Node, node_id)
            if node is None:
                continue
            candidate_course_ids.add(node.course_id)
            db.delete(node)
        db.flush()

    if candidate_course_ids:
        for course_id in candidate_course_ids:
            remaining_node_count = db.scalar(
                select(func.count()).select_from(Node).where(Node.course_id == course_id)
            ) or 0
            if remaining_node_count:
                continue
            course = db.get(Course, course_id)
            if course is not None and course.title == "Question Pool Library":
                db.delete(course)
        db.flush()


def _load_pool_questions(db: Session, pool_id):
    direct_questions = db.scalars(
        select(Question).where(Question.pool_id == pool_id).order_by(Question.order.asc(), Question.created_at.asc())
    ).all()
    if direct_questions:
        return direct_questions

    # Pool questions are stored in hidden exams to preserve the legacy schema until
    # the system can move to a dedicated junction-table design.
    library_exam = _find_pool_library_exam(db, pool_id)
    if not library_exam:
        corrupted_exam = _find_corrupted_pool_library_exam(db, pool_id)
        if corrupted_exam:
            logger.warning(
                "Question pool %s has a hidden library exam %s with missing or corrupt _pool_library metadata",
                pool_id,
                getattr(corrupted_exam, "id", None),
            )
        return []
    if not _is_pool_library_exam(library_exam, pool_id):
        logger.warning("Question pool %s library exam metadata is invalid", pool_id)
        return []
    return db.scalars(
        select(Question).where(Question.exam_id == library_exam.id).order_by(Question.order.asc(), Question.created_at.asc())
    ).all()


def _serialize_pool(pool: QuestionPool, db: Session) -> QuestionPoolRead:
    return QuestionPoolRead(
        id=pool.id,
        name=pool.name,
        description=pool.description,
        created_by_id=pool.created_by_id,
        question_count=len(_load_pool_questions(db, pool.id)),
    )


@router.post("/", response_model=QuestionPoolRead)
def create_pool(
    body: QuestionPoolCreate,
    request: Request,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Manage Question Pools", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    now = datetime.now(timezone.utc)
    pool = QuestionPool(
        name=body.name,
        description=body.description,
        created_by_id=current.id,
        created_at=now,
        updated_at=now,
    )
    db.add(pool)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=_t("pool_name_exists"))
    db.refresh(pool)
    write_audit_log(
        db,
        getattr(current, "id", None),
        action="QUESTION_POOL_CREATED",
        resource_type="question_pool",
        resource_id=str(pool.id),
        detail=f"Created question pool: {pool.name}",
        ip_address=getattr(getattr(request, "client", None), "host", None),
    )
    return _serialize_pool(pool, db)


@router.get("/", response_model=list[QuestionPoolRead])
def list_pools(db: Session = Depends(get_db_dep), current=Depends(require_permission("Manage Question Pools", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    query = select(QuestionPool).where(QuestionPool.created_by_id == current.id).order_by(QuestionPool.name.asc())
    pools = db.scalars(query).all()
    return [_serialize_pool(pool, db) for pool in pools]


@router.get("/{pool_id}", response_model=QuestionPoolRead)
def get_pool(pool_id: str, db: Session = Depends(get_db_dep), current=Depends(require_permission("Manage Question Pools", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    pool_pk = parse_uuid_param(pool_id, detail=_t("not_found"))
    pool = db.get(QuestionPool, pool_pk)
    if not pool or pool.created_by_id != current.id:
        raise HTTPException(status_code=404, detail=_t("not_found"))
    return _serialize_pool(pool, db)


@router.put("/{pool_id}", response_model=QuestionPoolRead)
def update_pool(
    pool_id: str,
    body: QuestionPoolCreate,
    request: Request,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Manage Question Pools", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    pool_pk = parse_uuid_param(pool_id, detail=_t("not_found"))
    pool = db.get(QuestionPool, pool_pk)
    if not pool:
        raise HTTPException(status_code=404, detail=_t("not_found"))
    if pool.created_by_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))
    pool.name = body.name
    pool.description = body.description
    pool.updated_at = datetime.now(timezone.utc)
    db.add(pool)
    db.commit()
    db.refresh(pool)
    write_audit_log(
        db,
        getattr(current, "id", None),
        action="QUESTION_POOL_UPDATED",
        resource_type="question_pool",
        resource_id=str(pool.id),
        detail=f"Updated question pool: {pool.name}",
        ip_address=getattr(getattr(request, "client", None), "host", None),
    )
    return _serialize_pool(pool, db)


@router.get("/{pool_id}/questions", response_model=list[QuestionRead])
def list_pool_questions(pool_id: str, db: Session = Depends(get_db_dep), current=Depends(require_permission("Manage Question Pools", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    pool_pk = parse_uuid_param(pool_id, detail=_t("pool_not_found"))
    pool = db.get(QuestionPool, pool_pk)
    if not pool or pool.created_by_id != current.id:
        raise HTTPException(status_code=404, detail=_t("pool_not_found"))
    return _load_pool_questions(db, pool_pk)


@router.post("/{pool_id}/questions", response_model=QuestionRead)
def create_pool_question(
    pool_id: str,
    body: QuestionBase,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Manage Question Pools", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    pool_pk = parse_uuid_param(pool_id, detail=_t("pool_not_found"))
    pool = db.get(QuestionPool, pool_pk)
    if not pool:
        raise HTTPException(status_code=404, detail=_t("pool_not_found"))
    if pool.created_by_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))

    library_exam = _ensure_pool_library_exam(db, current, pool)
    next_order = db.scalar(select(func.max(Question.order)).where(Question.pool_id == pool_pk)) or 0
    now = datetime.now(timezone.utc)
    payload = sanitize_question_payload(body.model_dump())
    question = Question(
        exam_id=library_exam.id,
        text=payload["text"],
        type=payload["type"],
        options=payload.get("options"),
        correct_answer=payload.get("correct_answer"),
        points=payload["points"],
        order=next_order + 1,
        pool_id=pool_pk,
        created_at=now,
        updated_at=now,
    )
    db.add(question)
    db.commit()
    db.refresh(question)
    return question


@router.put("/{pool_id}/questions/{question_id}", response_model=QuestionRead)
def update_pool_question(
    pool_id: str,
    question_id: str,
    body: QuestionBase,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Manage Question Pools", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    pool_pk = parse_uuid_param(pool_id, detail=_t("pool_not_found"))
    pool = db.get(QuestionPool, pool_pk)
    if not pool:
        raise HTTPException(status_code=404, detail=_t("pool_not_found"))
    if pool.created_by_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))

    question_pk = parse_uuid_param(question_id, detail=_t("question_not_found"))
    question = db.get(Question, question_pk)
    if not question or question.pool_id != pool_pk:
        raise HTTPException(status_code=404, detail=_t("question_not_found"))

    payload = sanitize_question_payload(body.model_dump())
    question.text = payload["text"]
    question.type = payload["type"]
    question.options = payload.get("options")
    question.correct_answer = payload.get("correct_answer")
    question.points = payload["points"]
    question.updated_at = datetime.now(timezone.utc)
    db.add(question)
    db.commit()
    db.refresh(question)
    return question


@router.delete("/{pool_id}/questions/{question_id}", response_model=Message)
def delete_pool_question(
    pool_id: str,
    question_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Manage Question Pools", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    pool_pk = parse_uuid_param(pool_id, detail=_t("pool_not_found"))
    pool = db.get(QuestionPool, pool_pk)
    if not pool:
        raise HTTPException(status_code=404, detail=_t("pool_not_found"))
    if pool.created_by_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))

    question_pk = parse_uuid_param(question_id, detail=_t("question_not_found"))
    question = db.get(Question, question_pk)
    if not question or question.pool_id != pool_pk:
        raise HTTPException(status_code=404, detail=_t("question_not_found"))
    db.delete(question)
    db.commit()
    return Message(detail=_t("deleted"))


@router.post("/{pool_id}/seed-exam/{exam_id}", response_model=Message)
def seed_exam_from_pool(
    pool_id: str,
    exam_id: str,
    count: int = Query(default=5, ge=1, le=500),
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Manage Question Pools", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    pool_pk = parse_uuid_param(pool_id, detail=_t("pool_not_found"))
    pool = db.get(QuestionPool, pool_pk)
    if not pool:
        raise HTTPException(status_code=404, detail=_t("pool_not_found"))
    exam_pk = parse_uuid_param(exam_id, detail=_t("test_not_found"))
    exam = db.get(Exam, exam_pk)
    if not exam:
        raise HTTPException(status_code=404, detail=_t("test_not_found"))
    if exam.created_by_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))
    if exam.status == ExamStatus.OPEN:
        raise HTTPException(status_code=409, detail=_t("cannot_seed_published"))
    pool_questions = _load_pool_questions(db, pool_pk)
    if not pool_questions:
        raise HTTPException(status_code=400, detail=_t("pool_no_questions"))
    already_seeded_texts = set(
        db.scalars(
            select(Question.text).where(
                Question.exam_id == exam_pk,
                Question.pool_id == pool_pk,
            )
        ).all()
    )
    candidates = [pq for pq in pool_questions if pq.text not in already_seeded_texts]
    if not candidates:
        return Message(detail=_t("seeded_questions", count=0))
    existing_max = db.scalar(
        select(func.max(Question.order)).where(Question.exam_id == exam_pk)
    ) or 0
    selected = random.sample(candidates, min(count, len(candidates)))
    for i, pq in enumerate(selected):
        q = Question(
            exam_id=exam_pk, text=pq.text, type=pq.type, options=pq.options,
            correct_answer=pq.correct_answer, points=pq.points,
            order=existing_max + i + 1, pool_id=pool_pk,
        )
        db.add(q)
    db.commit()
    return Message(detail=_t("seeded_questions", count=len(selected)))


@router.delete("/{pool_id}", response_model=Message)
def delete_pool(
    pool_id: str,
    request: Request,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Manage Question Pools", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    pool_pk = parse_uuid_param(pool_id, detail=_t("not_found"))
    pool = db.get(QuestionPool, pool_pk)
    if not pool:
        raise HTTPException(status_code=404, detail=_t("not_found"))
    if pool.created_by_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))
    pool_name = pool.name
    pool_pk_str = str(pool.id)
    _cleanup_pool_library_resources(db, pool.id)
    db.delete(pool)
    db.commit()
    write_audit_log(
        db,
        getattr(current, "id", None),
        action="QUESTION_POOL_DELETED",
        resource_type="question_pool",
        resource_id=pool_pk_str,
        detail=f"Deleted question pool: {pool_name}",
        ip_address=getattr(getattr(request, "client", None), "host", None),
    )
    return Message(detail=_t("deleted"))
