from __future__ import annotations

import uuid

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from ...models import User, UserPreference


class UserRepository:
    def __init__(self, db: Session):
        self.db = db

    def get_user(self, user_id: uuid.UUID) -> User | None:
        return self.db.get(User, user_id)

    def get_user_by_email(self, email: str) -> User | None:
        return self.db.scalar(
            select(User).where(func.lower(User.email) == email.strip().lower())
        )

    def get_user_by_user_id(self, user_id: str) -> User | None:
        return self.db.scalar(select(User).where(User.user_id == user_id))

    def list_users(self, statement: Select):
        return self.db.scalars(statement)

    def count_users(self, statement: Select) -> int:
        return int(self.db.scalar(select(func.count()).select_from(statement.subquery())) or 0)

    def get_preference(self, *, user_id: uuid.UUID, key: str) -> UserPreference | None:
        return self.db.scalar(
            select(UserPreference).where(
                UserPreference.user_id == user_id,
                UserPreference.key == key,
            )
        )

    def add(self, entity) -> None:
        self.db.add(entity)

    def commit(self) -> None:
        self.db.commit()

    def refresh(self, entity) -> None:
        self.db.refresh(entity)

    def delete(self, entity) -> None:
        self.db.delete(entity)
