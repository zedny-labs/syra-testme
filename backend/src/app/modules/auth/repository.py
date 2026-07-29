from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...models import SystemSettings, User


class AuthRepository:
    def __init__(self, db: Session):
        self.db = db

    def any_user_exists(self) -> bool:
        return self.db.scalar(select(User.id).limit(1)) is not None

    def signup_allowed(self) -> bool:
        setting = self.db.scalar(select(SystemSettings).where(SystemSettings.key == "allow_signup"))
        return bool(setting and str(setting.value).lower() in {"1", "true", "yes"})

    def get_user_by_email(self, email: str) -> User | None:
        return self.db.scalar(
            select(User).where(func.lower(User.email) == email.strip().lower())
        )

    def get_user_by_email_or_user_id(self, *, email: str, user_id: str) -> User | None:
        return self.db.scalar(
            select(User).where(
                (func.lower(User.email) == email.strip().lower()) | (User.user_id == user_id)
            )
        )

    def get_user_by_id(self, user_id: uuid.UUID) -> User | None:
        return self.db.get(User, user_id)

    def add(self, user: User) -> None:
        self.db.add(user)

    def commit(self) -> None:
        self.db.commit()

    def refresh(self, user: User) -> None:
        self.db.refresh(user)
