from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ...api.deps import get_db_dep, require_permission
from ...models import RoleEnum, User
from ...schemas import PaginatedResponse
from ...utils.pagination import MAX_PAGE_SIZE, normalize_pagination
from .repository import UserRepository
from .schemas import (
    AdminPasswordResetRequest,
    AdminUserPatch,
    Message,
    UserCreate,
    UserRead,
    UserUpdate,
)
from .service import UserService


router = APIRouter()


def _service_from_db(db=Depends(get_db_dep)) -> UserService:
    return UserService(UserRepository(db))


@router.get("/", response_model=PaginatedResponse[UserRead])
def list_users(
    role: str | None = None,
    search: str | None = None,
    is_active: bool | None = None,
    sort_by: str | None = Query(None),
    sort_dir: str | None = Query(None),
    page: int | None = Query(None, ge=1),
    page_size: int | None = Query(None, ge=1, le=MAX_PAGE_SIZE),
    sort: str | None = Query(None),
    order: str | None = Query(None),
    skip: int | None = Query(None, ge=0),
    limit: int | None = Query(None, ge=1, le=MAX_PAGE_SIZE),
    current: User = Depends(require_permission("Manage Users", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
    service: UserService = Depends(_service_from_db),
):
    pagination = normalize_pagination(
        page=page,
        page_size=page_size,
        search=search,
        sort=sort or sort_by,
        order=order or sort_dir,
        skip=skip,
        limit=limit,
        default_sort="created_at",
        default_page_size=50,
    )
    return service.list_users(pagination=pagination, role=role, is_active=is_active, actor_id=current.id)


@router.post("/", response_model=UserRead)
def create_user(
    body: UserCreate,
    current: User = Depends(require_permission("Manage Users", RoleEnum.ADMIN)),
    service: UserService = Depends(_service_from_db),
):
    return service.create_user(body=body, current=current)


@router.get("/{user_id}", response_model=UserRead)
def get_user(
    user_id: str,
    current: User = Depends(require_permission("Manage Users", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
    service: UserService = Depends(_service_from_db),
):
    return service.get_user(user_id, actor_id=current.id)


@router.put("/{user_id}", response_model=UserRead)
def update_user(
    user_id: str,
    body: UserUpdate,
    current: User = Depends(require_permission("Manage Users", RoleEnum.ADMIN)),
    service: UserService = Depends(_service_from_db),
):
    return service.update_user(user_id=user_id, body=body, current=current)


@router.patch("/{user_id}", response_model=UserRead)
def patch_user(
    user_id: str,
    body: AdminUserPatch,
    current: User = Depends(require_permission("Manage Users", RoleEnum.ADMIN)),
    service: UserService = Depends(_service_from_db),
):
    return service.patch_user(user_id=user_id, body=body, current=current)


@router.post("/{user_id}/reset-password", response_model=Message)
def reset_user_password(
    user_id: str,
    body: AdminPasswordResetRequest,
    current: User = Depends(require_permission("Manage Users", RoleEnum.ADMIN)),
    service: UserService = Depends(_service_from_db),
):
    return service.reset_user_password(user_id=user_id, body=body, current=current)


@router.delete("/{user_id}", response_model=Message)
def delete_user(
    user_id: str,
    current: User = Depends(require_permission("Manage Users", RoleEnum.ADMIN)),
    service: UserService = Depends(_service_from_db),
):
    return service.delete_user(user_id=user_id, current=current)


__all__ = ["router"]
