from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import Exam, GradingScale, RoleEnum
from ...schemas import GradingScaleBase, GradingScaleRead, Message
from ...services.audit import write_audit_log
from ...services.sanitization import sanitize_plain_text
from ...core.i18n import translate as _t
from ..deps import get_db_dep, parse_uuid_param, require_permission

router = APIRouter()


def _clean_required_text(value: str | None, field_name: str) -> str:
    cleaned = sanitize_plain_text((value or "").strip()) or ""
    if not cleaned:
        raise HTTPException(status_code=422, detail=_t("field_required", field_name=field_name))
    return cleaned


def _ensure_unique_scale_name(db: Session, name: str, owner_id, existing_scale_id=None):
    existing = db.scalar(
        select(GradingScale).where(
            GradingScale.created_by_id == owner_id,
            func.lower(GradingScale.name) == name.lower(),
        )
    )
    if existing and getattr(existing, "id", None) != existing_scale_id:
        raise HTTPException(status_code=409, detail=_t("grading_scale_exists"))


def _get_owned_scale_or_404(db: Session, scale_id: str, current) -> GradingScale:
    scale_pk = parse_uuid_param(scale_id, detail=_t("not_found"))
    scale = db.get(GradingScale, scale_pk)
    if not scale or scale.created_by_id != current.id:
        raise HTTPException(status_code=404, detail=_t("not_found"))
    return scale


def _normalize_scale_bands(labels: list[dict]) -> list[dict]:
    if not labels:
        raise HTTPException(status_code=422, detail=_t("at_least_one_band"))

    normalized = []
    seen_labels: set[str] = set()
    for index, band in enumerate(labels, start=1):
        label = _clean_required_text(band.get("label"), f"Band {index} label")
        label_key = label.lower()
        if label_key in seen_labels:
            raise HTTPException(status_code=422, detail=_t("band_labels_unique"))
        seen_labels.add(label_key)
        try:
            min_score = int(band.get("min_score"))
            max_score = int(band.get("max_score"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail=f"Band {index} scores must be numbers") from None
        if min_score < 0 or max_score < 0 or min_score > 100 or max_score > 100:
            raise HTTPException(status_code=422, detail=f"Band {index} scores must be between 0 and 100")
        if min_score > max_score:
            raise HTTPException(status_code=422, detail=f"Band {index} minimum score cannot exceed maximum score")
        normalized.append({"label": label, "min_score": min_score, "max_score": max_score})

    ordered = sorted(normalized, key=lambda band: (band["min_score"], band["max_score"]))
    for previous, current in zip(ordered, ordered[1:]):
        if current["min_score"] <= previous["max_score"]:
            raise HTTPException(status_code=422, detail=_t("bands_cannot_overlap"))

    return normalized


def _normalize_scale_payload(body: GradingScaleBase) -> dict:
    return {
        "name": _clean_required_text(body.name, "Scale name"),
        "labels": _normalize_scale_bands(body.labels),
    }


@router.post("/", response_model=GradingScaleRead)
def create_scale(
    body: GradingScaleBase,
    request: Request,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Manage Grading Scales", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    payload = _normalize_scale_payload(body)
    _ensure_unique_scale_name(db, payload["name"], current.id)
    scale = GradingScale(**payload, created_by_id=current.id)
    db.add(scale)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=_t("grading_scale_name_exists"))
    db.refresh(scale)
    write_audit_log(
        db,
        getattr(current, "id", None),
        action="GRADING_SCALE_CREATED",
        resource_type="grading_scale",
        resource_id=str(scale.id),
        detail=f"Created grading scale: {scale.name}",
        ip_address=getattr(getattr(request, "client", None), "host", None),
    )
    return scale


@router.get("/", response_model=list[GradingScaleRead])
def list_scales(db: Session = Depends(get_db_dep), current=Depends(require_permission("Manage Grading Scales", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    return db.scalars(
        select(GradingScale).where(GradingScale.created_by_id == current.id).order_by(GradingScale.name.asc())
    ).all()


@router.get("/{scale_id}", response_model=GradingScaleRead)
def get_scale(scale_id: str, db: Session = Depends(get_db_dep), current=Depends(require_permission("Manage Grading Scales", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    return _get_owned_scale_or_404(db, scale_id, current)


@router.put("/{scale_id}", response_model=GradingScaleRead)
def update_scale(
    scale_id: str,
    body: GradingScaleBase,
    request: Request,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Manage Grading Scales", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    scale = _get_owned_scale_or_404(db, scale_id, current)
    payload = _normalize_scale_payload(body)
    _ensure_unique_scale_name(db, payload["name"], current.id, existing_scale_id=scale.id)
    scale.name = payload["name"]
    scale.labels = payload["labels"]
    db.add(scale)
    db.commit()
    db.refresh(scale)
    write_audit_log(
        db,
        getattr(current, "id", None),
        action="GRADING_SCALE_UPDATED",
        resource_type="grading_scale",
        resource_id=str(scale.id),
        detail=f"Updated grading scale: {scale.name}",
        ip_address=getattr(getattr(request, "client", None), "host", None),
    )
    return scale


@router.delete("/{scale_id}", response_model=Message)
def delete_scale(
    scale_id: str,
    request: Request,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Manage Grading Scales", RoleEnum.ADMIN)),
):
    scale = _get_owned_scale_or_404(db, scale_id, current)
    usage_count = int(
        db.scalar(select(func.count(Exam.id)).where(Exam.grading_scale_id == scale.id))
        or 0
    )
    if usage_count:
        raise HTTPException(
            status_code=409,
            detail=_t("cannot_delete_grading_assigned"),
        )
    scale_name = scale.name
    scale_pk_str = str(scale.id)
    db.delete(scale)
    db.commit()
    write_audit_log(
        db,
        getattr(current, "id", None),
        action="GRADING_SCALE_DELETED",
        resource_type="grading_scale",
        resource_id=scale_pk_str,
        detail=f"Deleted grading scale: {scale_name}",
        ip_address=getattr(getattr(request, "client", None), "host", None),
    )
    return Message(detail=_t("deleted"))
