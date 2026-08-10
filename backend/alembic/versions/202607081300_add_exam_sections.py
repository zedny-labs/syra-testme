"""add exam_sections, question.section_id, attempt.sections_finished, section toggles

Revision ID: 202607081300
Revises: 202607081200
Create Date: 2026-07-08 13:00:00

NOTE: down_revision chains on 202607081200 (the owner-isolation migration) so the
alembic history stays a single linear head. If that revision is renumbered or
dropped, update down_revision here accordingly.
"""

from __future__ import annotations

import uuid

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "202607081300"
down_revision = "202607081200"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "exam_sections",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("exam_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("exams.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.String(length=1024), nullable=True),
        sa.Column("order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("source_pool_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("question_pools.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_exam_section_exam_order", "exam_sections", ["exam_id", "order"])

    op.add_column("questions", sa.Column("section_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_questions_section_id", "questions", "exam_sections",
        ["section_id"], ["id"], ondelete="CASCADE",
    )

    op.add_column("attempts", sa.Column("sections_finished", sa.JSON(), nullable=True))

    op.add_column("exam_runtime_configs", sa.Column("sequential_sections", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("exam_runtime_configs", sa.Column("allow_revisit_sections", sa.Boolean(), nullable=False, server_default=sa.text("true")))

    # Backfill: every exam that has questions gets one "General" section, and all
    # of that exam's currently-unsectioned questions are assigned to it. This keeps
    # the "every question belongs to a section" invariant for legacy exams.
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT DISTINCT exam_id FROM questions WHERE section_id IS NULL")).fetchall()
    for (exam_id,) in rows:
        section_id = str(uuid.uuid4())
        bind.execute(
            sa.text(
                'INSERT INTO exam_sections (id, exam_id, title, "order", created_at, updated_at) '
                "VALUES (:id, :exam_id, 'General', 0, now(), now())"
            ),
            {"id": section_id, "exam_id": str(exam_id)},
        )
        bind.execute(
            sa.text("UPDATE questions SET section_id = :sid WHERE exam_id = :eid AND section_id IS NULL"),
            {"sid": section_id, "eid": str(exam_id)},
        )


def downgrade() -> None:
    op.drop_column("exam_runtime_configs", "allow_revisit_sections")
    op.drop_column("exam_runtime_configs", "sequential_sections")
    op.drop_column("attempts", "sections_finished")
    op.drop_constraint("fk_questions_section_id", "questions", type_="foreignkey")
    op.drop_column("questions", "section_id")
    op.drop_index("ix_exam_section_exam_order", table_name="exam_sections")
    op.drop_table("exam_sections")
