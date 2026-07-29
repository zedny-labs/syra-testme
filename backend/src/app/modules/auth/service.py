from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import HTTPException, status

from ...core.security import (
    create_access_token,
    create_password_reset_token,
    create_refresh_token,
    hash_password,
    token_issued_at,
    verify_password,
    verify_token,
)
from ...models import RoleEnum, User
from ...schemas import Message, Token, TokenRefresh
from ...services.audit import write_audit_log
from ...services.sanitization import sanitize_plain_text
from .repository import AuthRepository
from .schemas import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    RefreshRequest,
    ResetPasswordRequest,
    SignupRequest,
    UserCreate,
)
from ...core.i18n import translate as _t


class AuthService:
    def __init__(self, repository: AuthRepository):
        self.repository = repository

    def setup_admin(self, body: UserCreate) -> User:
        if self.repository.any_user_exists():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_t("admin_already_set_up"))
        user = User(
            email=str(body.email).strip().lower(),
            name=sanitize_plain_text(body.name) or body.name,
            user_id=body.user_id,
            hashed_password=hash_password(body.password),
            role=RoleEnum.ADMIN,
        )
        self.repository.add(user)
        try:
            self.repository.commit()
        except Exception:
            self.repository.db.rollback()
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_t("admin_already_set_up"))
        self.repository.refresh(user)
        return user

    def signup_status(self) -> dict[str, bool]:
        return {"allowed": self.repository.signup_allowed()}

    def signup(self, body: SignupRequest) -> User:
        if not self.repository.signup_allowed():
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_t("self_signup_disabled"))
        existing = self.repository.get_user_by_email_or_user_id(email=body.email, user_id=body.user_id)
        if existing:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_t("account_already_exists"))
        user = User(
            email=str(body.email).strip().lower(),
            name=sanitize_plain_text(body.name) or body.name,
            user_id=body.user_id,
            hashed_password=hash_password(body.password),
            role=RoleEnum.LEARNER,
        )
        self.repository.add(user)
        try:
            self.repository.commit()
        except Exception:
            self.repository.db.rollback()
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_t("account_already_exists"))
        self.repository.refresh(user)
        return user

    def login(self, body: LoginRequest, *, request_ip: str | None) -> Token:
        email = str(body.email).strip().lower()
        user = self.repository.get_user_by_email(email)
        if not user or not verify_password(body.password, user.hashed_password):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_t("invalid_credentials"))
        if not user.is_active:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_t("inactive_user"))
        write_audit_log(
            self.repository.db,
            user.id,
            action="USER_LOGIN",
            resource_type="user",
            resource_id=str(user.id),
            detail="Successful login",
            ip_address=request_ip,
        )
        return Token(
            access_token=create_access_token(
                str(user.id),
                user.user_id,
                user.role.value,
                name=user.name,
                email=user.email,
            ),
            refresh_token=create_refresh_token(str(user.id)),
        )

    def refresh_access_token(self, body: RefreshRequest) -> TokenRefresh:
        try:
            payload = verify_token(body.refresh_token, expected_type="refresh")
        except Exception as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_t("invalid_token")) from exc
        user = self._load_token_user(payload)
        if not user.is_active:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_t("inactive_user"))
        self._ensure_token_is_current(user, payload)
        return TokenRefresh(
            access_token=create_access_token(
                str(user.id),
                user.user_id,
                user.role.value,
                name=user.name,
                email=user.email,
            )
        )

    def logout(self, *, current_user: User, request_ip: str | None) -> Message:
        self._invalidate_user_tokens(current_user)
        self.repository.add(current_user)
        self.repository.commit()
        write_audit_log(
            self.repository.db,
            current_user.id,
            action="USER_LOGOUT",
            resource_type="user",
            resource_id=str(current_user.id),
            detail="User logged out",
            ip_address=request_ip,
        )
        return Message(detail=_t("logged_out"))

    def change_password(self, *, current_user: User, body: ChangePasswordRequest) -> Message:
        if not verify_password(body.current_password, current_user.hashed_password):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=_t("incorrect_current_password"))
        current_user.hashed_password = hash_password(body.new_password)
        self._invalidate_user_tokens(current_user)
        self.repository.add(current_user)
        self.repository.commit()
        write_audit_log(
            self.repository.db,
            current_user.id,
            action="PASSWORD_CHANGED",
            resource_type="user",
            resource_id=str(current_user.id),
            detail="Password changed by authenticated user",
        )
        return Message(detail=_t("password_updated"))

    def prepare_password_reset(self, body: ForgotPasswordRequest) -> tuple[User | None, str | None]:
        email = str(body.email).strip().lower()
        user = self.repository.get_user_by_email(email)
        if not user:
            return None, None
        return user, create_password_reset_token(str(user.id))

    def reset_password(self, body: ResetPasswordRequest) -> Message:
        try:
            payload = verify_token(body.token, expected_type="password_reset")
        except Exception as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_t("invalid_token")) from exc
        user = self._load_token_user(payload, not_found_status=status.HTTP_404_NOT_FOUND)
        self._ensure_token_is_current(user, payload)
        user.hashed_password = hash_password(body.new_password)
        self._invalidate_user_tokens(user)
        self.repository.add(user)
        self.repository.commit()
        write_audit_log(
            self.repository.db,
            user.id,
            action="PASSWORD_RESET",
            resource_type="user",
            resource_id=str(user.id),
            detail="Password reset via token",
        )
        return Message(detail=_t("password_reset_successful"))

    def _load_token_user(self, payload: dict, *, not_found_status: int = status.HTTP_401_UNAUTHORIZED) -> User:
        sub = payload.get("sub")
        try:
            user_pk = uuid.UUID(sub) if isinstance(sub, str) else sub
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_t("invalid_token")) from exc

        user = self.repository.get_user_by_id(user_pk)
        if not user:
            detail = _t("user_not_found") if not_found_status == status.HTTP_404_NOT_FOUND else _t("invalid_token")
            raise HTTPException(status_code=not_found_status, detail=detail)
        return user

    def _ensure_token_is_current(self, user: User, payload: dict) -> None:
        issued_at = token_issued_at(payload)
        cutoff = getattr(user, "token_invalid_before", None)
        if issued_at is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_t("invalid_token"))
        if cutoff:
            normalized_cutoff = cutoff if cutoff.tzinfo else cutoff.replace(tzinfo=timezone.utc)
            if issued_at < normalized_cutoff:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=_t("invalid_token"))

    def _invalidate_user_tokens(self, user: User) -> None:
        now = datetime.now(timezone.utc)
        user.token_invalid_before = now
        user.updated_at = now
