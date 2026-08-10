from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import Category, Exam, RoleEnum
from ...schemas import CategoryBase, CategoryRead, Message
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


def _clean_optional_text(value: str | None) -> str | None:
    cleaned = sanitize_plain_text((value or "").strip()) or ""
    return cleaned or None


def _ensure_unique_category_name(db: Session, name: str, owner_id, existing_category_id=None):
    existing = db.scalar(
        select(Category).where(
            Category.created_by_id == owner_id,
            func.lower(Category.name) == name.lower(),
        )
    )
    if existing and getattr(existing, "id", None) != existing_category_id:
        raise HTTPException(status_code=409, detail=_t("category_exists"))


def _get_owned_category_or_404(db: Session, category_id: str, current) -> Category:
    category_pk = parse_uuid_param(category_id, detail=_t("not_found"))
    cat = db.get(Category, category_pk)
    if not cat or cat.created_by_id != current.id:
        raise HTTPException(status_code=404, detail=_t("not_found"))
    return cat


def _normalize_category_payload(body: CategoryBase) -> dict:
    return {
        "name": _clean_required_text(body.name, "Category name"),
        "type": body.type,
        "description": _clean_optional_text(body.description),
    }


@router.post("/", response_model=CategoryRead)
def create_category(
    body: CategoryBase,
    request: Request,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Manage Categories", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    payload = _normalize_category_payload(body)
    _ensure_unique_category_name(db, payload["name"], current.id)
    cat = Category(**payload, created_by_id=current.id)
    db.add(cat)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=_t("category_exists"))
    db.refresh(cat)
    write_audit_log(
        db,
        getattr(current, "id", None),
        action="CATEGORY_CREATED",
        resource_type="category",
        resource_id=str(cat.id),
        detail=f"Created category: {cat.name}",
        ip_address=getattr(getattr(request, "client", None), "host", None),
    )
    return cat


@router.get("/", response_model=list[CategoryRead])
def list_categories(db: Session = Depends(get_db_dep), current=Depends(require_permission("Manage Categories", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    return db.scalars(
        select(Category).where(Category.created_by_id == current.id).order_by(Category.name.asc())
    ).all()


@router.get("/{category_id}", response_model=CategoryRead)
def get_category(category_id: str, db: Session = Depends(get_db_dep), current=Depends(require_permission("Manage Categories", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    return _get_owned_category_or_404(db, category_id, current)


@router.put("/{category_id}", response_model=CategoryRead)
def update_category(
    category_id: str,
    body: CategoryBase,
    request: Request,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Manage Categories", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    cat = _get_owned_category_or_404(db, category_id, current)
    payload = _normalize_category_payload(body)
    _ensure_unique_category_name(db, payload["name"], current.id, existing_category_id=cat.id)
    for field, value in payload.items():
        setattr(cat, field, value)
    db.add(cat)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=_t("category_name_exists"))
    db.refresh(cat)
    write_audit_log(
        db,
        getattr(current, "id", None),
        action="CATEGORY_UPDATED",
        resource_type="category",
        resource_id=str(cat.id),
        detail=f"Updated category: {cat.name}",
        ip_address=getattr(getattr(request, "client", None), "host", None),
    )
    return cat


@router.delete("/{category_id}", response_model=Message)
def delete_category(
    category_id: str,
    request: Request,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Manage Categories", RoleEnum.ADMIN)),
):
    cat = _get_owned_category_or_404(db, category_id, current)
    usage = db.scalar(select(func.count(Exam.id)).where(Exam.category_id == cat.id)) or 0
    if usage:
        raise HTTPException(status_code=409, detail=_t("cannot_delete_cat_assigned"))
    category_name = cat.name
    category_pk_str = str(cat.id)
    db.delete(cat)
    db.commit()
    write_audit_log(
        db,
        getattr(current, "id", None),
        action="CATEGORY_DELETED",
        resource_type="category",
        resource_id=category_pk_str,
        detail=f"Deleted category: {category_name}",
        ip_address=getattr(getattr(request, "client", None), "host", None),
    )
    return Message(detail=_t("deleted"))
