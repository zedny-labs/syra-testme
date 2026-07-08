from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...core.i18n import translate as _t
from ...models import Exam, ExamSection, ExamStatus, Question, QuestionPool, RoleEnum
from ...schemas import ExamSectionCreate, ExamSectionFromPool, ExamSectionRead, ExamSectionReorder, ExamSectionUpdate, Message
from .question_pools import _load_pool_questions
from ..deps import ensure_exam_owner, get_db_dep, parse_uuid_param, require_permission

router = APIRouter()


def ensure_general_section(db: Session, exam: Exam) -> ExamSection:
    """Return the existing General (manual) section for *exam*, or create one."""
    section = db.scalar(
        select(ExamSection).where(ExamSection.exam_id == exam.id, ExamSection.source_pool_id.is_(None))
        .order_by(ExamSection.order.asc())
    )
    if section:
        return section
    max_order = db.scalar(select(func.max(ExamSection.order)).where(ExamSection.exam_id == exam.id))
    next_order = (max_order + 1) if max_order is not None else 0
    section = ExamSection(exam_id=exam.id, title="General", order=next_order)
    db.add(section)
    db.flush()
    return section


def _get_owned_exam(db: Session, exam_id: str, current) -> Exam:
    exam_pk = parse_uuid_param(exam_id, detail=_t("test_not_found"))
    exam = db.get(Exam, exam_pk)
    if not exam:
        raise HTTPException(status_code=404, detail=_t("test_not_found"))
    ensure_exam_owner(exam, current, detail=_t("not_allowed"), status_code=403)
    return exam


def _get_owned_section(db: Session, section_id: str, current) -> ExamSection:
    section_pk = parse_uuid_param(section_id, detail=_t("test_not_found"))
    section = db.get(ExamSection, section_pk)
    if not section:
        raise HTTPException(status_code=404, detail=_t("test_not_found"))
    ensure_exam_owner(section.exam, current, detail=_t("not_allowed"), status_code=403)
    return section


@router.get("/exams/{exam_id}/sections", response_model=list[ExamSectionRead])
def list_sections(
    exam_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    exam = _get_owned_exam(db, exam_id, current)
    return db.scalars(
        select(ExamSection)
        .where(ExamSection.exam_id == exam.id)
        .order_by(ExamSection.order.asc())
    ).all()


@router.post("/exams/{exam_id}/sections", response_model=ExamSectionRead)
def create_section(
    exam_id: str,
    body: ExamSectionCreate,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    exam = _get_owned_exam(db, exam_id, current)
    if exam.status == ExamStatus.OPEN:
        raise HTTPException(status_code=409, detail=_t("cannot_modify_published"))
    max_order = db.scalar(select(func.max(ExamSection.order)).where(ExamSection.exam_id == exam.id))
    next_order = (max_order + 1) if max_order is not None else 0
    section = ExamSection(
        exam_id=exam.id,
        title=body.title,
        description=body.description,
        order=next_order,
    )
    db.add(section)
    db.commit()
    db.refresh(section)
    return section


@router.put("/sections/{section_id}", response_model=ExamSectionRead)
def update_section(
    section_id: str,
    body: ExamSectionUpdate,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    section = _get_owned_section(db, section_id, current)
    if section.exam and section.exam.status == ExamStatus.OPEN:
        raise HTTPException(status_code=409, detail=_t("cannot_modify_published"))
    if body.title is not None:
        section.title = body.title
    if body.description is not None:
        section.description = body.description
    section.updated_at = datetime.now(timezone.utc)
    db.add(section)
    db.commit()
    db.refresh(section)
    return section


@router.delete("/sections/{section_id}", response_model=Message)
def delete_section(
    section_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    section = _get_owned_section(db, section_id, current)
    if section.exam and section.exam.status == ExamStatus.OPEN:
        raise HTTPException(status_code=409, detail=_t("cannot_modify_published"))
    db.delete(section)
    db.commit()
    return Message(detail=_t("deleted"))


@router.post("/exams/{exam_id}/sections/from-pool", response_model=ExamSectionRead)
def create_section_from_pool(
    exam_id: str,
    body: ExamSectionFromPool,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    exam = _get_owned_exam(db, exam_id, current)
    if exam.status == ExamStatus.OPEN:
        raise HTTPException(status_code=409, detail=_t("cannot_modify_published"))
    pool = db.get(QuestionPool, body.pool_id)
    if not pool:
        raise HTTPException(status_code=404, detail=_t("pool_not_found"))
    if pool.created_by_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))

    pool_questions = {str(q.id): q for q in _load_pool_questions(db, pool.id)}
    picked = [pool_questions[str(qid)] for qid in body.question_ids if str(qid) in pool_questions]
    if not picked:
        raise HTTPException(status_code=400, detail=_t("pool_no_questions"))

    max_order = db.scalar(select(func.max(ExamSection.order)).where(ExamSection.exam_id == exam.id))
    next_order = (max_order + 1) if max_order is not None else 0
    section = ExamSection(exam_id=exam.id, title=(body.title or pool.name), order=next_order, source_pool_id=pool.id)
    db.add(section)
    db.flush()  # get section.id

    existing_max_q = db.scalar(select(func.max(Question.order)).where(Question.exam_id == exam.id)) or 0
    now = datetime.now(timezone.utc)
    for i, pq in enumerate(picked):
        db.add(Question(
            exam_id=exam.id, section_id=section.id, text=pq.text, type=pq.type,
            options=pq.options, correct_answer=pq.correct_answer, points=pq.points,
            order=existing_max_q + i + 1, pool_id=pool.id, image_url=pq.image_url,
            created_at=now, updated_at=now,
        ))
    db.commit()
    db.refresh(section)
    return section


@router.post("/exams/{exam_id}/sections/reorder", response_model=list[ExamSectionRead])
def reorder_sections(
    exam_id: str,
    body: ExamSectionReorder,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    exam = _get_owned_exam(db, exam_id, current)
    if exam.status == ExamStatus.OPEN:
        raise HTTPException(status_code=409, detail=_t("cannot_modify_published"))
    by_id = {
        str(s.id): s
        for s in db.scalars(
            select(ExamSection).where(ExamSection.exam_id == exam.id)
        ).all()
    }
    for item in body.sections:
        section = by_id.get(str(item.id))
        if section:
            section.order = item.order
    db.commit()
    return db.scalars(
        select(ExamSection)
        .where(ExamSection.exam_id == exam.id)
        .order_by(ExamSection.order.asc())
    ).all()
