"""scope learner accounts to the admin that created them

Adds ``created_by_id`` to ``users`` (self-referential FK, SET NULL). Existing
learners are backfilled to the admin whose exam they most-earliest attempted,
then earliest scheduled, then the primary admin. Admins/instructors stay NULL.
No uniqueness changes (email/user_id remain globally unique login identifiers).

Revision ID: 202607091000
Revises: 202607081300
Create Date: 2026-07-09 10:00:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "202607091000"
down_revision = "202607081300"
branch_labels = None
depends_on = None


def _uuid_type(is_pg: bool):
    return postgresql.UUID(as_uuid=True) if is_pg else sa.String(length=36)


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"
    inspector = sa.inspect(bind)

    columns = {col["name"] for col in inspector.get_columns("users")}
    if "created_by_id" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "created_by_id",
                _uuid_type(is_pg),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
                nullable=True,
            ),
        )

    if not is_pg:
        # Tests/dev SQLite build the schema from the models (create_all); the
        # backfill below is a Postgres-only production concern.
        return

    # 1) Owner = creator of the earliest exam the learner ATTEMPTED.
    op.execute(
        """
        UPDATE users AS u
        SET created_by_id = e.created_by_id
        FROM (
            SELECT DISTINCT ON (a.user_id) a.user_id, ex.created_by_id
            FROM attempts a
            JOIN exams ex ON ex.id = a.exam_id
            WHERE ex.created_by_id IS NOT NULL
            ORDER BY a.user_id, ex.created_at
        ) AS e
        WHERE u.id = e.user_id
          AND u.created_by_id IS NULL
          AND CAST(u.role AS TEXT) = 'LEARNER'
        """
    )

    # 2) Still-unowned learners: creator of the earliest exam they were SCHEDULED to.
    op.execute(
        """
        UPDATE users AS u
        SET created_by_id = e.created_by_id
        FROM (
            SELECT DISTINCT ON (s.user_id) s.user_id, ex.created_by_id
            FROM schedules s
            JOIN exams ex ON ex.id = s.exam_id
            WHERE ex.created_by_id IS NOT NULL
            ORDER BY s.user_id, ex.created_at
        ) AS e
        WHERE u.id = e.user_id
          AND u.created_by_id IS NULL
          AND CAST(u.role AS TEXT) = 'LEARNER'
        """
    )

    # 3) Any remaining learner with no interaction -> primary admin.
    op.execute(
        """
        UPDATE users SET created_by_id = (
            SELECT id FROM users
            WHERE CAST(role AS TEXT) = 'ADMIN'
            ORDER BY created_at NULLS LAST, id
            LIMIT 1
        )
        WHERE created_by_id IS NULL
          AND CAST(role AS TEXT) = 'LEARNER'
        """
    )


def downgrade() -> None:
    op.drop_column("users", "created_by_id")
