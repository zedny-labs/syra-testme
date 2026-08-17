"""backfill tab-switch force-submit alert rules for existing exams

New exams default the tab-switch force-submit checkbox to off, same as every
other proctoring feature (see AdminNewTestWizard.jsx FORCE_SUBMIT_EVENT_MAP /
toggleForceSubmit). Before this change, tab-switching had its own hardcoded,
always-on client-side force-submit check (Proctoring.jsx, now removed) that
every existing exam with tab_switch_detect=true implicitly relied on. This
migration inserts the equivalent exam_proctoring_alert_rules rows so those
exams keep behaving the way they do today, without requiring an admin to
manually re-enable the checkbox.

No schema change — exam_proctoring_alert_rules already has every column
needed. Idempotent: re-running only inserts rows that don't already exist
(checked by exact rule_key, not just prefix, so the two per-exam inserts
below don't shadow each other on a partial re-run).

Revision ID: 202608171200
Revises: 202607091000
Create Date: 2026-08-17 12:00:00
"""
from __future__ import annotations

import uuid

from alembic import op
import sqlalchemy as sa

revision = "202608171200"
down_revision = "202607091000"
branch_labels = None
depends_on = None

_RULE_KEY_PREFIX = "force_submit:tab_switch_detect:"
_EVENT_TYPES = ("TAB_SWITCH", "FOCUS_LOSS")


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        # Tests/dev SQLite build the schema from the models (create_all); this
        # backfill is a Postgres-only production concern, same pattern as
        # 202607091000_scope_learners_per_owner.py.
        return

    rows = bind.execute(
        sa.text(
            "SELECT exam_id, max_tab_blurs FROM exam_proctoring_configs "
            "WHERE tab_switch_detect = true"
        )
    ).fetchall()

    for exam_id, max_tab_blurs in rows:
        threshold = max_tab_blurs or 3
        for event_type in _EVENT_TYPES:
            rule_key = f"{_RULE_KEY_PREFIX}{event_type}"
            already_exists = bind.execute(
                sa.text(
                    "SELECT 1 FROM exam_proctoring_alert_rules "
                    "WHERE exam_id = :exam_id AND rule_key = :rule_key"
                ),
                {"exam_id": str(exam_id), "rule_key": rule_key},
            ).first()
            if already_exists:
                continue

            next_position = bind.execute(
                sa.text(
                    "SELECT COALESCE(MAX(position) + 1, 0) "
                    "FROM exam_proctoring_alert_rules WHERE exam_id = :exam_id"
                ),
                {"exam_id": str(exam_id)},
            ).scalar()

            bind.execute(
                sa.text(
                    "INSERT INTO exam_proctoring_alert_rules "
                    "(id, exam_id, position, rule_key, event_type, threshold, severity, action, message) "
                    "VALUES (:id, :exam_id, :position, :rule_key, :event_type, :threshold, 'HIGH', 'AUTO_SUBMIT', '')"
                ),
                {
                    "id": str(uuid.uuid4()),
                    "exam_id": str(exam_id),
                    "position": next_position,
                    "rule_key": rule_key,
                    "event_type": event_type,
                    "threshold": threshold,
                },
            )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    bind.execute(
        sa.text(
            "DELETE FROM exam_proctoring_alert_rules WHERE rule_key LIKE :prefix"
        ),
        {"prefix": f"{_RULE_KEY_PREFIX}%"},
    )
