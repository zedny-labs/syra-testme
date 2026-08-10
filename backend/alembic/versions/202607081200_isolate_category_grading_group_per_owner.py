"""isolate categories, grading scales, and user groups per owning admin

Adds ``created_by_id`` to ``categories``, ``grading_scales`` and ``user_groups``
so each admin/instructor sees only their own rows -- matching the ownership
model already used by exams, courses and question pools. Existing rows are
backfilled to the admin that already uses them (via exams) or, failing that,
the primary admin, and the previously global uniqueness on
``categories.name`` / ``user_groups.name`` becomes per-owner uniqueness.

Revision ID: 202607081200
Revises: 202606291200
Create Date: 2026-07-08 12:00:00
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "202607081200"
down_revision = "202606291200"
branch_labels = None
depends_on = None

_TABLES = ("categories", "grading_scales", "user_groups")


def _uuid_type(is_pg: bool):
    return postgresql.UUID(as_uuid=True) if is_pg else sa.String(length=36)


def _drop_name_unique(inspector, table: str) -> None:
    """Drop whatever single-column unique lives on ``<table>.name`` (name varies)."""
    for uc in inspector.get_unique_constraints(table):
        if uc.get("column_names") == ["name"] and uc.get("name"):
            op.drop_constraint(uc["name"], table, type_="unique")
    for ix in inspector.get_indexes(table):
        if ix.get("unique") and ix.get("column_names") == ["name"] and ix.get("name"):
            op.drop_index(ix["name"], table_name=table)


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"
    inspector = sa.inspect(bind)
    uuid_type = _uuid_type(is_pg)

    for table in _TABLES:
        columns = {col["name"] for col in inspector.get_columns(table)}
        if "created_by_id" not in columns:
            op.add_column(
                table,
                sa.Column(
                    "created_by_id",
                    uuid_type,
                    sa.ForeignKey("users.id", ondelete="SET NULL"),
                    nullable=True,
                ),
            )

    if not is_pg:
        # Test/dev SQLite builds the schema from the models (create_all), so the
        # per-owner constraints and backfill below are Postgres-only concerns.
        return

    # 1) Backfill categories / grading scales from the exams that reference them
    #    (deterministic owner = creator of the earliest exam that uses the row).
    op.execute(
        """
        UPDATE categories AS c
        SET created_by_id = e.created_by_id
        FROM (
            SELECT DISTINCT ON (category_id) category_id, created_by_id
            FROM exams
            WHERE category_id IS NOT NULL AND created_by_id IS NOT NULL
            ORDER BY category_id, created_at
        ) AS e
        WHERE c.id = e.category_id AND c.created_by_id IS NULL
        """
    )
    op.execute(
        """
        UPDATE grading_scales AS g
        SET created_by_id = e.created_by_id
        FROM (
            SELECT DISTINCT ON (grading_scale_id) grading_scale_id, created_by_id
            FROM exams
            WHERE grading_scale_id IS NOT NULL AND created_by_id IS NOT NULL
            ORDER BY grading_scale_id, created_at
        ) AS e
        WHERE g.id = e.grading_scale_id AND g.created_by_id IS NULL
        """
    )

    # 2) Remaining rows (unused taxonomy + every user group) go to the primary
    #    admin, keeping existing data owned by exactly one account.
    for table in _TABLES:
        op.execute(
            f"""
            UPDATE {table} SET created_by_id = (
                SELECT id FROM users
                WHERE CAST(role AS TEXT) = 'ADMIN'
                ORDER BY created_at NULLS LAST, id
                LIMIT 1
            )
            WHERE created_by_id IS NULL
            """
        )

    # 3) Global name-uniqueness -> per-owner uniqueness.
    _drop_name_unique(inspector, "categories")
    _drop_name_unique(inspector, "user_groups")
    op.create_unique_constraint("uq_category_owner_name", "categories", ["created_by_id", "name"])
    op.create_unique_constraint("uq_user_group_owner_name", "user_groups", ["created_by_id", "name"])


def downgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"
    if is_pg:
        op.execute("ALTER TABLE categories DROP CONSTRAINT IF EXISTS uq_category_owner_name")
        op.execute("ALTER TABLE user_groups DROP CONSTRAINT IF EXISTS uq_user_group_owner_name")
        op.create_unique_constraint("categories_name_key", "categories", ["name"])
        op.create_unique_constraint("user_groups_name_key", "user_groups", ["name"])
    for table in reversed(_TABLES):
        op.drop_column(table, "created_by_id")
