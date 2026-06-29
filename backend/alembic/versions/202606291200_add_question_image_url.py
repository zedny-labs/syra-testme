"""add image_url column to questions

Revision ID: 202606291200
Revises: 202603301030
Create Date: 2026-06-29 12:00:00
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "202606291200"
down_revision = "202603301030"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("questions", sa.Column("image_url", sa.String(length=1024), nullable=True))


def downgrade() -> None:
    op.drop_column("questions", "image_url")
