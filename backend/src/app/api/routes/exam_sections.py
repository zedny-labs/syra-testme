from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...core.i18n import translate as _t
from ...models import Exam, ExamSection, ExamStatus, Question, RoleEnum
from ...schemas import ExamSectionCreate, ExamSectionRead, ExamSectionReorder, ExamSectionUpdate
from ..deps import ensure_exam_owner, get_db_dep, parse_uuid_param, require_permission

router = APIRouter()


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
    next_order = (
        db.scalar(select(func.max(ExamSection.order)).where(ExamSection.exam_id == exam.id)) or -1
    ) + 1
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
    if body.title is not None:
        section.title = body.title
    if body.description is not None:
        section.description = body.description
    section.updated_at = datetime.now(timezone.utc)
    db.add(section)
    db.commit()
    db.refresh(section)
    return section


@router.delete("/sections/{section_id}")
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
    return {"detail": _t("deleted")}


@router.post("/exams/{exam_id}/sections/reorder", response_model=list[ExamSectionRead])
def reorder_sections(
    exam_id: str,
    body: ExamSectionReorder,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    exam = _get_owned_exam(db, exam_id, current)
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
