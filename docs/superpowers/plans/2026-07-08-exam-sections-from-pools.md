# Exam Sections from Question Pools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn question pools into first-class exam **sections** — admin hand-picks pool questions into named sections, and learners take the exam through a section hub (enter a section, answer one question at a time, finish, return to hub), with per-exam "sequential" and "allow-revisit" options.

**Architecture:** New `exam_sections` table; `Question.section_id` FK; two booleans on `ExamRuntimeConfig`; a JSON `sections_finished` list on `Attempt`. Backend gets section CRUD + a "copy picked pool questions into a section" endpoint (replacing random `seed_exam_from_pool`), a learner sections payload, a mark-section-finished endpoint, and server-side lock enforcement in `submit_answer`. Frontend gets a section manager in the admin wizard/manage page and a section hub in the learner taking UI. Migration backfills every existing exam with a "General" section.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 (async runtime, sync test sessions), Pydantic v2, Alembic; React + Vite, axios, react-i18next-style `useLanguage()` hook, Vitest (jsdom).

**Design spec:** `docs/superpowers/specs/2026-07-08-exam-sections-from-pools-design.md`

---

## Conventions used throughout

- **Backend tests** live in `backend/tests/`, use in-memory SQLite (`create_engine("sqlite+pysqlite:///:memory:")` + `Base.metadata.create_all`), call route functions directly with a `Session` and a `User`, and `db.close()` in a `finally`. No fixtures/conftest. Run: `cd backend && PYTHONPATH=src pytest tests/<file> -v`.
- **Frontend unit tests** live in `_workspace_nonruntime/tests/frontend/src/` mirroring the `src/` path of the module under test. Run: `cd frontend && npm run test`.
- **Field-name lock (do not rename between tasks):** model `ExamSection` / table `exam_sections`; `Question.section_id`; `Attempt.sections_finished` (JSON list of section-id strings); `ExamRuntimeConfig.sequential_sections` (default `false`), `ExamRuntimeConfig.allow_revisit_sections` (default `true`).
- **Commit** after every task's tests pass.

---

# PHASE 1 — Data model & migration (backend, independently shippable)

### Task 1: `ExamSection` model + `Question.section_id`

**Files:**
- Modify: `backend/src/app/models/__init__.py` (add class after `QuestionPool`, ~line 170; edit `Exam` ~line 201; edit `Question` ~line 235–241)
- Test: `backend/tests/test_exam_sections_model.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_exam_sections_model.py
from __future__ import annotations

import uuid

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Exam, ExamSection, ExamStatus, ExamType, Question


def _session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _exam(db: Session) -> Exam:
    exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ, status=ExamStatus.CLOSED)
    db.add(exam)
    db.flush()
    return exam


def test_section_holds_questions_and_links_to_exam() -> None:
    db = _session()
    try:
        exam = _exam(db)
        section = ExamSection(id=uuid.uuid4(), exam_id=exam.id, title="General", order=0)
        db.add(section)
        db.flush()
        q = Question(id=uuid.uuid4(), exam_id=exam.id, section_id=section.id, text="Q1", type=ExamType.MCQ, order=0)
        db.add(q)
        db.flush()

        db.refresh(exam)
        assert [s.title for s in exam.sections] == ["General"]
        assert [qq.text for qq in section.questions] == ["Q1"]
        assert q.section_id == section.id
    finally:
        db.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PYTHONPATH=src pytest tests/test_exam_sections_model.py -v`
Expected: FAIL — `ImportError: cannot import name 'ExamSection'`.

- [ ] **Step 3: Add the model + columns + relationships**

In `backend/src/app/models/__init__.py`, add this class immediately after the `QuestionPool` class (after ~line 170):

```python
class ExamSection(Base):
    __tablename__ = "exam_sections"
    __table_args__ = (
        Index("ix_exam_section_exam_order", "exam_id", "order"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    exam_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("exams.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))
    order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    source_pool_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("question_pools.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    exam = relationship("Exam", back_populates="sections")
    questions = relationship("Question", back_populates="section", order_by="Question.order")
    source_pool = relationship("QuestionPool", foreign_keys=[source_pool_id])

    @hybrid_property
    def question_count(self):
        return len(self.questions) if self.questions else 0
```

In the `Exam` class, add to the relationships block (after the `questions = relationship(...)` line ~201):

```python
    sections = relationship("ExamSection", back_populates="exam", cascade="all, delete-orphan", order_by="ExamSection.order")
```

In the `Question` class, add the column after `pool_id` (~line 235) and the relationship after `pool = relationship(...)` (~line 240):

```python
    section_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("exam_sections.id", ondelete="CASCADE"))
```
```python
    section = relationship("ExamSection", back_populates="questions")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PYTHONPATH=src pytest tests/test_exam_sections_model.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/app/models/__init__.py backend/tests/test_exam_sections_model.py
git commit -m "feat(sections): add ExamSection model and Question.section_id"
```

---

### Task 2: `Attempt.sections_finished` + `ExamRuntimeConfig` toggles

**Files:**
- Modify: `backend/src/app/models/__init__.py` (`Attempt` ~line 259; `ExamRuntimeConfig` ~line 549)
- Modify: `backend/src/app/services/normalized_relations.py` (`_RUNTIME_SCALAR_FIELDS` ~line 162, `_RUNTIME_DEFAULTS` ~line 184)
- Test: `backend/tests/test_exam_section_settings.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_exam_section_settings.py
from __future__ import annotations

import uuid

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Exam, ExamRuntimeConfig, ExamStatus, ExamType
from app.services.normalized_relations import exam_runtime_settings, set_exam_runtime_settings


def _session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def test_section_toggles_roundtrip_through_settings() -> None:
    db = _session()
    try:
        exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ, status=ExamStatus.CLOSED)
        db.add(exam)
        db.flush()
        set_exam_runtime_settings(exam, {"sequential_sections": True, "allow_revisit_sections": False})
        db.flush()
        db.refresh(exam)
        settings = exam_runtime_settings(exam)
        assert settings["sequential_sections"] is True
        assert settings["allow_revisit_sections"] is False
    finally:
        db.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PYTHONPATH=src pytest tests/test_exam_section_settings.py -v`
Expected: FAIL — `KeyError: 'sequential_sections'` (field not serialized yet).

- [ ] **Step 3: Add the columns and register the fields**

In `models/__init__.py`, `Attempt` class, add after `face_signature` (~line 259):

```python
    sections_finished: Mapped[list | None] = mapped_column(JSON, default=list)
```

In `ExamRuntimeConfig` (~after line 558, near `score_report_include_certificate_status`), add:

```python
    sequential_sections: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    allow_revisit_sections: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
```

In `normalized_relations.py`, append to `_RUNTIME_SCALAR_FIELDS` (before the closing `]` at ~line 177):

```python
    "sequential_sections",
    "allow_revisit_sections",
```

And add to `_RUNTIME_DEFAULTS` (~line 192):

```python
    "sequential_sections": False,
    "allow_revisit_sections": True,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PYTHONPATH=src pytest tests/test_exam_section_settings.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/app/models/__init__.py backend/src/app/services/normalized_relations.py backend/tests/test_exam_section_settings.py
git commit -m "feat(sections): add attempt section progress + exam sequential/revisit toggles"
```

---

### Task 3: Alembic migration + backfill

**Files:**
- Create: `backend/alembic/versions/202607081200_add_exam_sections.py`

> Find the current head revision first — Run: `cd backend && ls -t alembic/versions/ | head -3` and open the newest file to read its `revision = "..."`. Use that value as `down_revision` below (shown as `<CURRENT_HEAD>`).

- [ ] **Step 1: Write the migration**

```python
# backend/alembic/versions/202607081200_add_exam_sections.py
"""add exam_sections, question.section_id, attempt.sections_finished, section toggles

Revision ID: 202607081200
Revises: <CURRENT_HEAD>
Create Date: 2026-07-08 12:00:00
"""

from __future__ import annotations

import uuid

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "202607081200"
down_revision = "<CURRENT_HEAD>"
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

    # Backfill: every exam with questions gets one "General" section; assign its questions to it.
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
```

- [ ] **Step 2: Verify migration applies cleanly**

Run: `cd backend && PYTHONPATH=src alembic upgrade head`
Expected: no errors; `alembic current` shows `202607081200`.

- [ ] **Step 3: Sanity-check backfill (only if a dev DB with existing exams is available)**

Run: `cd backend && PYTHONPATH=src python -c "from app.db.session import ... "` — OR use psql: every exam that had questions now has exactly one `exam_sections` row titled `General`, and no `questions.section_id IS NULL` remain for those exams.
Expected: zero orphan questions for backfilled exams.

- [ ] **Step 4: Commit**

```bash
git add backend/alembic/versions/202607081200_add_exam_sections.py
git commit -m "feat(sections): migration for exam_sections + backfill General section"
```

---

# PHASE 2 — Backend API (independently shippable on top of Phase 1)

### Task 4: Section schemas

**Files:**
- Modify: `backend/src/app/schemas/__init__.py` (add near the Question/Exam schemas; also add `section_id` to `QuestionBase`/`QuestionRead`; add `sections_finished` to `AttemptRead`)
- Test: `backend/tests/test_exam_section_schemas.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_exam_section_schemas.py
import uuid

from app.schemas import ExamSectionFromPool, ExamSectionRead, ExamSectionUpdate


def test_from_pool_requires_pool_and_ids() -> None:
    body = ExamSectionFromPool(pool_id=uuid.uuid4(), question_ids=[uuid.uuid4()], title="Algebra")
    assert body.title == "Algebra"
    assert len(body.question_ids) == 1


def test_section_read_from_attributes() -> None:
    assert ExamSectionRead.model_config.get("from_attributes") is True
    assert ExamSectionUpdate(title="X").title == "X"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PYTHONPATH=src pytest tests/test_exam_section_schemas.py -v`
Expected: FAIL — `ImportError: cannot import name 'ExamSectionFromPool'`.

- [ ] **Step 3: Add the schemas**

In `schemas/__init__.py`, add (near the other Exam/Question schemas):

```python
class ExamSectionBase(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=1024)


class ExamSectionCreate(ExamSectionBase):
    pass


class ExamSectionUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=1024)


class ExamSectionFromPool(BaseModel):
    pool_id: UUID
    question_ids: list[UUID] = Field(min_length=1)
    title: Optional[str] = Field(default=None, max_length=255)


class ExamSectionReorderItem(BaseModel):
    id: UUID
    order: int = Field(ge=0)


class ExamSectionReorder(BaseModel):
    sections: list[ExamSectionReorderItem]


class ExamSectionRead(ExamSectionBase):
    id: UUID
    exam_id: UUID
    order: int
    source_pool_id: Optional[UUID] = None
    question_count: int = 0
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
```

Add `section_id` to `QuestionBase` (after `pool_id`, ~line 236):

```python
    section_id: Optional[UUID] = None
```

`QuestionRead` inherits it automatically. Add to `AttemptRead` (after `id_text`, ~line 467):

```python
    sections_finished: Optional[list] = None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PYTHONPATH=src pytest tests/test_exam_section_schemas.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/app/schemas/__init__.py backend/tests/test_exam_section_schemas.py
git commit -m "feat(sections): section schemas + section_id/sections_finished on read models"
```

---

### Task 5: Section CRUD + reorder routes

**Files:**
- Create: `backend/src/app/api/routes/exam_sections.py`
- Modify: `backend/src/app/api/router.py` (import + include, ~lines 3–32 and after line 46)
- Test: `backend/tests/test_exam_sections_routes.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_exam_sections_routes.py
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Exam, ExamSection, ExamStatus, ExamType, Question, RoleEnum, User
from app.schemas import ExamSectionCreate, ExamSectionUpdate
from app.api.routes.exam_sections import (
    create_section, list_sections, update_section, delete_section,
)


def _session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _user(db: Session, role=RoleEnum.ADMIN) -> User:
    u = User(user_id=f"u-{uuid.uuid4().hex[:8]}", email=f"{uuid.uuid4().hex[:8]}@e.com",
             name="U", hashed_password="h", role=role, is_active=True)
    db.add(u); db.flush(); return u


def _exam(db: Session, owner: User) -> Exam:
    e = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ,
             status=ExamStatus.CLOSED, created_by_id=owner.id)
    db.add(e); db.flush(); return e


def test_create_and_list_sections() -> None:
    db = _session()
    try:
        admin = _user(db)
        exam = _exam(db, admin)
        create_section(exam_id=str(exam.id), body=ExamSectionCreate(title="Intro"), db=db, current=admin)
        sections = list_sections(exam_id=str(exam.id), db=db, current=admin)
        assert [s.title for s in sections] == ["Intro"]
    finally:
        db.close()


def test_update_and_delete_section() -> None:
    db = _session()
    try:
        admin = _user(db)
        exam = _exam(db, admin)
        created = create_section(exam_id=str(exam.id), body=ExamSectionCreate(title="A"), db=db, current=admin)
        update_section(section_id=str(created.id), body=ExamSectionUpdate(title="B"), db=db, current=admin)
        assert db.get(ExamSection, created.id).title == "B"
        delete_section(section_id=str(created.id), db=db, current=admin)
        assert db.get(ExamSection, created.id) is None
    finally:
        db.close()


def test_non_owner_cannot_create_section() -> None:
    db = _session()
    try:
        owner = _user(db)
        other = _user(db, role=RoleEnum.INSTRUCTOR)
        exam = _exam(db, owner)
        with pytest.raises(HTTPException) as exc:
            create_section(exam_id=str(exam.id), body=ExamSectionCreate(title="X"), db=db, current=other)
        assert exc.value.status_code == 403
    finally:
        db.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PYTHONPATH=src pytest tests/test_exam_sections_routes.py -v`
Expected: FAIL — module `app.api.routes.exam_sections` does not exist.

- [ ] **Step 3: Create the routes module**

```python
# backend/src/app/api/routes/exam_sections.py
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.i18n import _t
from app.db.deps import get_db_dep
from app.models import Exam, ExamSection, ExamStatus, Question, RoleEnum
from app.schemas import (
    ExamSectionCreate, ExamSectionRead, ExamSectionReorder, ExamSectionUpdate,
)
from app.api.deps import require_permission
from app.api.routes.questions import ensure_exam_owner  # reuse existing owner check
from app.utils.uuids import parse_uuid_param

router = APIRouter()


def _get_owned_exam(db: Session, exam_id: str, current) -> Exam:
    exam_pk = parse_uuid_param(exam_id, detail=_t("test_not_found"))
    exam = db.get(Exam, exam_pk)
    if not exam:
        raise HTTPException(status_code=404, detail=_t("test_not_found"))
    ensure_exam_owner(exam, current, detail=_t("not_allowed"), status_code=403)
    return exam


def _get_owned_section(db: Session, section_id: str, current) -> ExamSection:
    section_pk = parse_uuid_param(section_id, detail=_t("test_not_found"))
    section = db.get(ExamSection, section_pk)
    if not section:
        raise HTTPException(status_code=404, detail=_t("test_not_found"))
    ensure_exam_owner(section.exam, current, detail=_t("not_allowed"), status_code=403)
    return section


@router.get("/exams/{exam_id}/sections", response_model=list[ExamSectionRead])
def list_sections(exam_id: str, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    exam = _get_owned_exam(db, exam_id, current)
    return db.scalars(select(ExamSection).where(ExamSection.exam_id == exam.id).order_by(ExamSection.order.asc())).all()


@router.post("/exams/{exam_id}/sections", response_model=ExamSectionRead)
def create_section(exam_id: str, body: ExamSectionCreate, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    exam = _get_owned_exam(db, exam_id, current)
    if exam.status == ExamStatus.OPEN:
        raise HTTPException(status_code=409, detail=_t("cannot_modify_published"))
    next_order = (db.scalar(select(func.max(ExamSection.order)).where(ExamSection.exam_id == exam.id)) or -1) + 1
    section = ExamSection(exam_id=exam.id, title=body.title, description=body.description, order=next_order)
    db.add(section)
    db.commit()
    db.refresh(section)
    return section


@router.put("/sections/{section_id}", response_model=ExamSectionRead)
def update_section(section_id: str, body: ExamSectionUpdate, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    section = _get_owned_section(db, section_id, current)
    if body.title is not None:
        section.title = body.title
    if body.description is not None:
        section.description = body.description
    section.updated_at = datetime.now(timezone.utc)
    db.add(section)
    db.commit()
    db.refresh(section)
    return section


@router.delete("/sections/{section_id}")
def delete_section(section_id: str, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    section = _get_owned_section(db, section_id, current)
    if section.exam and section.exam.status == ExamStatus.OPEN:
        raise HTTPException(status_code=409, detail=_t("cannot_modify_published"))
    db.delete(section)  # cascades to its questions via ondelete=CASCADE
    db.commit()
    return {"detail": _t("deleted")}


@router.post("/exams/{exam_id}/sections/reorder", response_model=list[ExamSectionRead])
def reorder_sections(exam_id: str, body: ExamSectionReorder, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    exam = _get_owned_exam(db, exam_id, current)
    by_id = {str(s.id): s for s in db.scalars(select(ExamSection).where(ExamSection.exam_id == exam.id)).all()}
    for item in body.sections:
        section = by_id.get(str(item.id))
        if section:
            section.order = item.order
    db.commit()
    return db.scalars(select(ExamSection).where(ExamSection.exam_id == exam.id).order_by(ExamSection.order.asc())).all()
```

> Verify import paths against the codebase before running: confirm `ensure_exam_owner` is importable from `app.api.routes.questions` and `parse_uuid_param` from its module (grep both). If `require_permission`/`get_db_dep`/`_t` live elsewhere, copy the exact import lines used at the top of `question_pools.py`.

In `router.py`: add `exam_sections` to the `from .routes import (...)` block (line 3–32), and after line 46 add:

```python
router.include_router(exam_sections.router, tags=["exam-sections"])
```

(No prefix — routes already include `/exams/...` and `/sections/...` paths.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PYTHONPATH=src pytest tests/test_exam_sections_routes.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/app/api/routes/exam_sections.py backend/src/app/api/router.py backend/tests/test_exam_sections_routes.py
git commit -m "feat(sections): section CRUD + reorder endpoints"
```

---

### Task 6: Create section from picked pool questions (replaces random seed)

**Files:**
- Modify: `backend/src/app/api/routes/exam_sections.py` (add endpoint + reuse `_load_pool_questions`)
- Test: `backend/tests/test_section_from_pool.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_section_from_pool.py
from __future__ import annotations

import uuid

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Exam, ExamSection, ExamStatus, ExamType, Question, QuestionPool, RoleEnum, User
from app.schemas import ExamSectionFromPool, QuestionBase
from app.api.routes.question_pools import create_pool_question
from app.api.routes.exam_sections import create_section_from_pool


def _session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _user(db, role=RoleEnum.ADMIN):
    u = User(user_id=f"u-{uuid.uuid4().hex[:8]}", email=f"{uuid.uuid4().hex[:8]}@e.com",
             name="U", hashed_password="h", role=role, is_active=True)
    db.add(u); db.flush(); return u


def _mcq(text):
    return QuestionBase(text=text, question_type="MCQ", options=["A", "B"], correct_answer="A", points=1.0, order=0)


def test_section_from_pool_copies_only_picked_questions() -> None:
    db = _session()
    try:
        admin = _user(db)
        pool = QuestionPool(id=uuid.uuid4(), name="Algebra", created_by_id=admin.id)
        db.add(pool); db.flush()
        q1 = create_pool_question(pool_id=str(pool.id), body=_mcq("Q1"), db=db, current=admin)
        create_pool_question(pool_id=str(pool.id), body=_mcq("Q2"), db=db, current=admin)

        exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ,
                    status=ExamStatus.CLOSED, created_by_id=admin.id)
        db.add(exam); db.flush()

        section = create_section_from_pool(
            exam_id=str(exam.id),
            body=ExamSectionFromPool(pool_id=pool.id, question_ids=[q1.id], title=None),
            db=db, current=admin,
        )
        # Title defaults to pool name.
        assert section.title == "Algebra"
        # Only the picked question is copied into the exam under this section.
        copied = db.scalars(select(Question).where(Question.exam_id == exam.id)).all()
        assert [q.text for q in copied] == ["Q1"]
        assert copied[0].section_id == section.id
        assert copied[0].pool_id == pool.id  # origin retained
    finally:
        db.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PYTHONPATH=src pytest tests/test_section_from_pool.py -v`
Expected: FAIL — `cannot import name 'create_section_from_pool'`.

- [ ] **Step 3: Add the endpoint**

In `exam_sections.py`, add these imports at the top:

```python
from app.models import QuestionPool
from app.schemas import ExamSectionFromPool
from app.api.routes.question_pools import _load_pool_questions
```

And the endpoint:

```python
@router.post("/exams/{exam_id}/sections/from-pool", response_model=ExamSectionRead)
def create_section_from_pool(exam_id: str, body: ExamSectionFromPool, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    exam = _get_owned_exam(db, exam_id, current)
    if exam.status == ExamStatus.OPEN:
        raise HTTPException(status_code=409, detail=_t("cannot_modify_published"))
    pool = db.get(QuestionPool, body.pool_id)
    if not pool:
        raise HTTPException(status_code=404, detail=_t("pool_not_found"))
    if pool.created_by_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))

    pool_questions = {str(q.id): q for q in _load_pool_questions(db, pool.id)}
    picked = [pool_questions[str(qid)] for qid in body.question_ids if str(qid) in pool_questions]
    if not picked:
        raise HTTPException(status_code=400, detail=_t("pool_no_questions"))

    next_order = (db.scalar(select(func.max(ExamSection.order)).where(ExamSection.exam_id == exam.id)) or -1) + 1
    section = ExamSection(
        exam_id=exam.id,
        title=(body.title or pool.name),
        order=next_order,
        source_pool_id=pool.id,
    )
    db.add(section)
    db.flush()  # get section.id

    existing_max_q = db.scalar(select(func.max(Question.order)).where(Question.exam_id == exam.id)) or 0
    now = datetime.now(timezone.utc)
    for i, pq in enumerate(picked):
        db.add(Question(
            exam_id=exam.id, section_id=section.id, text=pq.text, type=pq.type,
            options=pq.options, correct_answer=pq.correct_answer, points=pq.points,
            order=existing_max_q + i + 1, pool_id=pool.id, image_url=pq.image_url,
            created_at=now, updated_at=now,
        ))
    db.commit()
    db.refresh(section)
    return section
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PYTHONPATH=src pytest tests/test_section_from_pool.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/app/api/routes/exam_sections.py backend/tests/test_section_from_pool.py
git commit -m "feat(sections): create section from hand-picked pool questions"
```

---

### Task 7: Keep `section_id` set at every question construction site

Per `docs/superpowers/specs` and the memory note on construction sites, questions created directly on an exam must land in a section. When an exam has no explicit section, create/reuse a **"General"** section.

**Files:**
- Modify: `backend/src/app/api/routes/questions.py` (`create_question` ~line 75)
- Create helper: `backend/src/app/api/routes/exam_sections.py` (`ensure_general_section`)
- Test: `backend/tests/test_manual_question_gets_section.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_manual_question_gets_section.py
from __future__ import annotations

import uuid

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Exam, ExamStatus, ExamType, RoleEnum, User
from app.schemas import QuestionCreate
from app.api.routes.questions import create_question


def _session():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def test_manual_question_lands_in_general_section() -> None:
    db = _session()
    try:
        admin = User(user_id="a1", email="a@e.com", name="A", hashed_password="h", role=RoleEnum.ADMIN, is_active=True)
        db.add(admin); db.flush()
        exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ,
                    status=ExamStatus.CLOSED, created_by_id=admin.id)
        db.add(exam); db.flush()
        q = create_question(
            body=QuestionCreate(exam_id=exam.id, text="Q", question_type="MCQ", options=["A", "B"], correct_answer="A", points=1.0, order=0),
            db=db, current=admin,
        )
        assert q.section_id is not None
        db.refresh(exam)
        assert [s.title for s in exam.sections] == ["General"]
    finally:
        db.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PYTHONPATH=src pytest tests/test_manual_question_gets_section.py -v`
Expected: FAIL — `q.section_id is None`.

- [ ] **Step 3: Add `ensure_general_section` and call it in `create_question`**

In `exam_sections.py`:

```python
def ensure_general_section(db: Session, exam: Exam) -> ExamSection:
    section = db.scalar(
        select(ExamSection).where(ExamSection.exam_id == exam.id, ExamSection.source_pool_id.is_(None))
        .order_by(ExamSection.order.asc())
    )
    if section:
        return section
    next_order = (db.scalar(select(func.max(ExamSection.order)).where(ExamSection.exam_id == exam.id)) or -1) + 1
    section = ExamSection(exam_id=exam.id, title="General", order=next_order)
    db.add(section)
    db.flush()
    return section
```

In `questions.py`, modify `create_question` — after `ensure_exam_owner(...)` and the OPEN check, before building the `Question`:

```python
    from app.api.routes.exam_sections import ensure_general_section
    payload = sanitize_question_payload(body.model_dump())
    if not payload.get("section_id"):
        payload["section_id"] = ensure_general_section(db, exam).id
    now = datetime.now(timezone.utc)
    q = Question(**payload, created_at=now, updated_at=now)
```

(Replace the existing `q = Question(**sanitize_question_payload(body.model_dump()), ...)` line accordingly.)

> The pool construction sites (`create_pool_question`, `bulk_create_pool_questions`) write into the hidden **library exam**, which learners never take — leave `section_id` NULL there. Only real exam questions need a section. This keeps the pool library untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PYTHONPATH=src pytest tests/test_manual_question_gets_section.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/app/api/routes/questions.py backend/src/app/api/routes/exam_sections.py backend/tests/test_manual_question_gets_section.py
git commit -m "feat(sections): manual exam questions land in a General section"
```

---

### Task 8: Mark-section-finished endpoint

**Files:**
- Modify: `backend/src/app/modules/attempts/routes_public.py` (add endpoint near `submit_answer`)
- Test: `backend/tests/test_mark_section_finished.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_mark_section_finished.py
from __future__ import annotations

import uuid

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Attempt, AttemptStatus, Exam, ExamSection, ExamStatus, ExamType, RoleEnum, User
from app.modules.attempts.routes_public import mark_section_finished


def _session():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def test_mark_section_finished_appends_id() -> None:
    db = _session()
    try:
        learner = User(user_id="l1", email="l@e.com", name="L", hashed_password="h", role=RoleEnum.LEARNER, is_active=True)
        db.add(learner); db.flush()
        exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ, status=ExamStatus.OPEN)
        db.add(exam); db.flush()
        section = ExamSection(id=uuid.uuid4(), exam_id=exam.id, title="S1", order=0)
        db.add(section)
        attempt = Attempt(id=uuid.uuid4(), exam_id=exam.id, user_id=learner.id, status=AttemptStatus.IN_PROGRESS)
        db.add(attempt); db.flush()

        result = mark_section_finished(attempt_id=str(attempt.id), section_id=str(section.id), db=db, current=learner)
        assert str(section.id) in (result.sections_finished or [])
    finally:
        db.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PYTHONPATH=src pytest tests/test_mark_section_finished.py -v`
Expected: FAIL — `cannot import name 'mark_section_finished'`.

- [ ] **Step 3: Add the endpoint**

In `routes_public.py`, add (mirror the access/guards used by `submit_answer` — reuse `_load_attempt_for_update`, `_ensure_attempt_access`):

```python
@router.post("/{attempt_id}/sections/{section_id}/finish", response_model=AttemptRead)
def mark_section_finished(attempt_id: str, section_id: str, db: Session = Depends(get_db_dep), current=Depends(get_current_user)):
    attempt_pk = parse_uuid_param(attempt_id, detail=_t("attempt_not_found"))
    attempt = _load_attempt_for_update(db, attempt_pk)
    if not attempt:
        raise HTTPException(status_code=404, detail=_t("attempt_not_found"))
    _ensure_attempt_access(db, attempt, current)
    if attempt.status != AttemptStatus.IN_PROGRESS:
        raise HTTPException(status_code=409, detail=_t("cannot_modify_submitted"))
    section = db.get(ExamSection, parse_uuid_param(section_id, detail=_t("test_not_found")))
    if not section or section.exam_id != attempt.exam_id:
        raise HTTPException(status_code=400, detail=_t("question_not_in_exam"))
    finished = list(attempt.sections_finished or [])
    if str(section.id) not in finished:
        finished.append(str(section.id))
    attempt.sections_finished = finished
    db.add(attempt)
    db.commit()
    db.refresh(attempt)
    return attempt
```

Ensure `ExamSection` is imported at the top of `routes_public.py`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PYTHONPATH=src pytest tests/test_mark_section_finished.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/app/modules/attempts/routes_public.py backend/tests/test_mark_section_finished.py
git commit -m "feat(sections): endpoint to mark a section finished on an attempt"
```

---

### Task 9: Server-side lock enforcement in `submit_answer`

Enforce the two exam options when a learner saves an answer: if **sequential** and the answer's section is not yet unlocked (an earlier section is unfinished), reject; if **revisit disabled** and the section is already finished, reject.

**Files:**
- Modify: `backend/src/app/modules/attempts/routes_public.py` (`submit_answer`, after the "question belongs to exam" check, ~line 1400)
- Test: `backend/tests/test_section_answer_enforcement.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_section_answer_enforcement.py
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import (
    Attempt, AttemptStatus, Exam, ExamRuntimeConfig, ExamSection, ExamStatus,
    ExamType, Question, RoleEnum, User,
)
from app.schemas import AttemptAnswerBase
from app.modules.attempts.routes_public import submit_answer


def _session():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _setup(db, *, sequential=False, allow_revisit=True):
    learner = User(user_id="l1", email="l@e.com", name="L", hashed_password="h", role=RoleEnum.LEARNER, is_active=True)
    db.add(learner)
    exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ, status=ExamStatus.OPEN)
    db.add(exam); db.flush()
    db.add(ExamRuntimeConfig(exam_id=exam.id, sequential_sections=sequential, allow_revisit_sections=allow_revisit))
    s1 = ExamSection(id=uuid.uuid4(), exam_id=exam.id, title="S1", order=0)
    s2 = ExamSection(id=uuid.uuid4(), exam_id=exam.id, title="S2", order=1)
    db.add_all([s1, s2]); db.flush()
    q2 = Question(id=uuid.uuid4(), exam_id=exam.id, section_id=s2.id, text="Q", type=ExamType.MCQ, order=0, correct_answer="A", options=["A", "B"])
    db.add(q2)
    attempt = Attempt(id=uuid.uuid4(), exam_id=exam.id, user_id=learner.id, status=AttemptStatus.IN_PROGRESS)
    db.add(attempt); db.flush()
    return learner, exam, s1, s2, q2, attempt


def test_sequential_blocks_answer_in_locked_section(monkeypatch) -> None:
    db = _session()
    try:
        learner, exam, s1, s2, q2, attempt = _setup(db, sequential=True)
        # s1 not finished => s2 locked
        with pytest.raises(HTTPException) as exc:
            submit_answer(attempt_id=str(attempt.id), body=AttemptAnswerBase(question_id=q2.id, answer="A"), db=db, current=learner)
        assert exc.value.status_code == 409
    finally:
        db.close()
```

> If `submit_answer` performs proctoring/identity/time checks that block this unit path, either set the exam's proctoring to not require identity (default None is fine) or `monkeypatch` those helpers to no-ops. Keep the test focused on the section-lock branch.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PYTHONPATH=src pytest tests/test_section_answer_enforcement.py -v`
Expected: FAIL — no lock enforcement yet (answer saved, no 409).

- [ ] **Step 3: Add a helper + call it in `submit_answer`**

Add near the top of `routes_public.py` (helper):

```python
def _ensure_section_answerable(db: Session, attempt, question) -> None:
    section_id = getattr(question, "section_id", None)
    if not section_id:
        return
    settings = exam_runtime_settings(attempt.exam) if attempt.exam else {}
    sequential = bool(settings.get("sequential_sections"))
    allow_revisit = settings.get("allow_revisit_sections", True)
    finished = set(attempt.sections_finished or [])

    if not allow_revisit and str(section_id) in finished:
        raise HTTPException(status_code=409, detail=_t("cannot_modify_submitted"))

    if sequential:
        this_section = db.get(ExamSection, section_id)
        if this_section is not None:
            earlier = db.scalars(
                select(ExamSection).where(
                    ExamSection.exam_id == attempt.exam_id,
                    ExamSection.order < this_section.order,
                )
            ).all()
            if any(str(s.id) not in finished for s in earlier):
                raise HTTPException(status_code=409, detail=_t("section_locked"))
```

Import `exam_runtime_settings` and `ExamSection` and `select` at the top if not already present. Add `"section_locked"` to the i18n dictionaries (Task 16 covers locale keys; a missing key falls back to the key string, so tests pass regardless).

In `submit_answer`, right after the existing block that verifies `question.exam_id == attempt.exam_id`, add:

```python
    _ensure_section_answerable(db, attempt, question)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PYTHONPATH=src pytest tests/test_section_answer_enforcement.py -v`
Expected: PASS. Also run the full attempts test file to ensure no regressions: `PYTHONPATH=src pytest tests/ -k attempt -v`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/app/modules/attempts/routes_public.py backend/tests/test_section_answer_enforcement.py
git commit -m "feat(sections): enforce sequential + revisit rules server-side on answer save"
```

---

### Task 10: Learner sections payload endpoint

The learner UI needs the exam's sections (id, title, order) — questions already carry `section_id`. Expose a learner-accessible list.

**Files:**
- Modify: `backend/src/app/api/routes/exam_sections.py` (add a learner GET that reuses `learner_can_access_exam`)
- Test: `backend/tests/test_learner_sections_payload.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_learner_sections_payload.py
from __future__ import annotations

import uuid

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import Exam, ExamSection, ExamStatus, ExamType, RoleEnum, User
from app.api.routes.exam_sections import list_sections_for_learner


def _session():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def test_learner_sees_sections_in_order() -> None:
    db = _session()
    try:
        learner = User(user_id="l1", email="l@e.com", name="L", hashed_password="h", role=RoleEnum.LEARNER, is_active=True)
        db.add(learner)
        exam = Exam(id=uuid.uuid4(), node_id=uuid.uuid4(), title="E", type=ExamType.MCQ, status=ExamStatus.OPEN)
        db.add(exam); db.flush()
        db.add_all([
            ExamSection(id=uuid.uuid4(), exam_id=exam.id, title="B", order=1),
            ExamSection(id=uuid.uuid4(), exam_id=exam.id, title="A", order=0),
        ])
        db.flush()
        out = list_sections_for_learner(exam_id=str(exam.id), db=db, current=learner)
        assert [s.title for s in out] == ["A", "B"]
    finally:
        db.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PYTHONPATH=src pytest tests/test_learner_sections_payload.py -v`
Expected: FAIL — `cannot import name 'list_sections_for_learner'`.

- [ ] **Step 3: Add the learner endpoint**

In `exam_sections.py`:

```python
from app.models import Exam
from app.api.deps import get_current_user
from app.api.routes.questions import learner_can_access_exam  # reuse learner access rule


@router.get("/exams/{exam_id}/learner-sections", response_model=list[ExamSectionRead])
def list_sections_for_learner(exam_id: str, db: Session = Depends(get_db_dep), current=Depends(get_current_user)):
    exam_pk = parse_uuid_param(exam_id, detail=_t("test_not_found"))
    exam = db.get(Exam, exam_pk)
    if current.role == RoleEnum.LEARNER:
        if not learner_can_access_exam(db, exam, current):
            raise HTTPException(status_code=404, detail=_t("test_not_found"))
    elif not exam:
        raise HTTPException(status_code=404, detail=_t("test_not_found"))
    return db.scalars(select(ExamSection).where(ExamSection.exam_id == exam_pk).order_by(ExamSection.order.asc())).all()
```

> Confirm `learner_can_access_exam` and `get_current_user` import paths by grepping `questions.py`'s imports; copy the exact source module.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PYTHONPATH=src pytest tests/test_learner_sections_payload.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/app/api/routes/exam_sections.py backend/tests/test_learner_sections_payload.py
git commit -m "feat(sections): learner-accessible sections list endpoint"
```

- [ ] **Phase 2 gate:** Run the whole backend suite: `cd backend && PYTHONPATH=src pytest tests/ -q`. Expected: all green (pre-existing unrelated failures, if any, unchanged). Commit nothing new unless fixing a regression you introduced.

---

# PHASE 3 — Admin authoring UI

### Task 11: Frontend API service methods

**Files:**
- Modify: `frontend/src/services/admin.service.js` (add methods in the `adminApi` object)
- Test: `_workspace_nonruntime/tests/frontend/src/services/admin.sections.test.js`

- [ ] **Step 1: Write the failing test**

```js
// _workspace_nonruntime/tests/frontend/src/services/admin.sections.test.js
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./api', () => {
  const api = { get: vi.fn(() => Promise.resolve({ data: [] })), post: vi.fn(() => Promise.resolve({ data: {} })), put: vi.fn(), delete: vi.fn() }
  return { default: api }
})

import api from './api'
import { adminApi } from './admin.service'

describe('adminApi section methods', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('lists sections for an exam', () => {
    adminApi.getExamSections('exam-1')
    expect(api.get).toHaveBeenCalledWith('exams/exam-1/sections')
  })

  it('creates a section from picked pool questions', () => {
    adminApi.createSectionFromPool('exam-1', { pool_id: 'p1', question_ids: ['q1'], title: 'Algebra' })
    expect(api.post).toHaveBeenCalledWith('exams/exam-1/sections/from-pool', { pool_id: 'p1', question_ids: ['q1'], title: 'Algebra' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test`
Expected: FAIL — `adminApi.getExamSections is not a function`.

- [ ] **Step 3: Add the methods**

In `admin.service.js`, inside the `adminApi` object, add:

```js
  // Exam sections
  getExamSections: (examId) => api.get(`exams/${examId}/sections`),
  createSection: (examId, data) => api.post(`exams/${examId}/sections`, data),
  createSectionFromPool: (examId, data) => api.post(`exams/${examId}/sections/from-pool`, data),
  updateSection: (sectionId, data) => api.put(`sections/${sectionId}`, data),
  deleteSection: (sectionId) => api.delete(`sections/${sectionId}`),
  reorderSections: (examId, sections) => api.post(`exams/${examId}/sections/reorder`, { sections }),
  getLearnerSections: (examId) => api.get(`exams/${examId}/learner-sections`),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/admin.service.js _workspace_nonruntime/tests/frontend/src/services/admin.sections.test.js
git commit -m "feat(sections): admin API methods for section CRUD"
```

---

### Task 12: `SectionsManager` component (authoring)

A focused, self-contained component: lists sections for an exam, adds a section from a pool (choose pool → checkbox-pick questions → create), edits/deletes/reorders sections. Used by both the wizard (step 3) and the manage page ("sections" tab).

**Files:**
- Create: `frontend/src/pages/Admin/SectionsManager/SectionsManager.jsx`
- Create: `frontend/src/pages/Admin/SectionsManager/SectionsManager.module.css`
- Create pure helper: `frontend/src/pages/Admin/SectionsManager/sectionGrouping.js`
- Test: `_workspace_nonruntime/tests/frontend/src/pages/Admin/SectionsManager/sectionGrouping.test.js`

- [ ] **Step 1: Write the failing test for the pure helper**

```js
// _workspace_nonruntime/tests/frontend/src/pages/Admin/SectionsManager/sectionGrouping.test.js
import { describe, expect, it } from 'vitest'
import { groupQuestionsBySection } from './sectionGrouping'

describe('groupQuestionsBySection', () => {
  it('groups questions under their section in section order', () => {
    const sections = [
      { id: 's2', title: 'Second', order: 1 },
      { id: 's1', title: 'First', order: 0 },
    ]
    const questions = [
      { id: 'q1', section_id: 's1', order: 0, text: 'A' },
      { id: 'q2', section_id: 's2', order: 0, text: 'B' },
      { id: 'q3', section_id: 's1', order: 1, text: 'C' },
    ]
    const grouped = groupQuestionsBySection(sections, questions)
    expect(grouped.map((g) => g.section.title)).toEqual(['First', 'Second'])
    expect(grouped[0].questions.map((q) => q.text)).toEqual(['A', 'C'])
    expect(grouped[1].questions.map((q) => q.text)).toEqual(['B'])
  })

  it('puts questions with unknown section into a trailing bucket', () => {
    const grouped = groupQuestionsBySection([], [{ id: 'q1', section_id: null, order: 0, text: 'X' }])
    expect(grouped).toHaveLength(1)
    expect(grouped[0].section.title).toBe('General')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test`
Expected: FAIL — module `sectionGrouping` not found.

- [ ] **Step 3: Write the pure helper**

```js
// frontend/src/pages/Admin/SectionsManager/sectionGrouping.js
export function groupQuestionsBySection(sections, questions) {
  const ordered = [...(sections || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const byId = new Map(ordered.map((s) => [String(s.id), { section: s, questions: [] }]))
  const orphan = { section: { id: null, title: 'General', order: Number.MAX_SAFE_INTEGER }, questions: [] }
  for (const q of questions || []) {
    const bucket = byId.get(String(q.section_id)) || orphan
    bucket.questions.push(q)
  }
  const groups = ordered.map((s) => byId.get(String(s.id)))
  if (orphan.questions.length) groups.push(orphan)
  for (const g of groups) g.questions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  return groups
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test`
Expected: PASS.

- [ ] **Step 5: Build the `SectionsManager` component**

Create `SectionsManager.jsx`. It receives `examId` and renders: (1) the list of sections (each: title, question count, edit/delete, up/down reorder buttons), and (2) an "Add section from pool" panel (pool `<select>`, then a checkbox list of that pool's questions loaded via `adminApi.getPoolQuestions(poolId)`, an editable title input defaulting to the pool name, and a "Create section" button calling `adminApi.createSectionFromPool`). Reuse the existing `useLanguage()` `t()` hook for all strings, and the app's existing CSS-module styling conventions (see `QuestionsTab.module.css` for class patterns). Use the pure `groupQuestionsBySection` helper if you also render the exam's questions grouped.

Reorder uses up/down buttons (not drag) for v1 simplicity — on click, swap `order` with the neighbor and call `adminApi.reorderSections(examId, [{id, order}, ...])`, then refetch. Concrete handler sketch:

```jsx
const move = async (index, dir) => {
  const next = [...sections]
  const j = index + dir
  if (j < 0 || j >= next.length) return
  const a = next[index], b = next[j]
  const payload = [{ id: a.id, order: b.order }, { id: b.id, order: a.order }]
  await adminApi.reorderSections(examId, payload)
  const { data } = await adminApi.getExamSections(examId)
  setSections(data || [])
}
```

- [ ] **Step 6: Manual verification**

Run the app (`cd frontend && npm run dev`, backend running). Open an exam in the manage page → "Sections" tab. Verify: adding a pool → picking 2 of its questions creates a section titled with the pool name containing exactly those 2 questions; edit renames it; up/down reorders; delete removes it and its copied questions.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Admin/SectionsManager/ _workspace_nonruntime/tests/frontend/src/pages/Admin/SectionsManager/
git commit -m "feat(sections): SectionsManager authoring component + grouping helper"
```

---

### Task 13: Wire `SectionsManager` into the manage page and wizard

**Files:**
- Modify: `frontend/src/pages/Admin/AdminManageTestPage/AdminManageTestPage.jsx` (`tab === 'sections'` block ~line 3945)
- Modify: `frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.jsx` (step 3 render ~line 2462; settings step for the two toggles)

- [ ] **Step 1: Replace the manage page "sections" tab body**

In `AdminManageTestPage.jsx`, replace the `{tab === 'sections' && (<QuestionsTab .../>)}` block with a rendering that shows `SectionsManager` (import it), passing `examId`. Keep `QuestionsTab` available below it (or as a sub-view) for per-question editing within the exam if that flow is still needed — but the primary section authoring is now `SectionsManager`.

```jsx
{tab === 'sections' && (
  <SectionsManager examId={examId} />
)}
```

- [ ] **Step 2: Wizard step 3 — use SectionsManager after the exam is created**

The wizard seeds only once an `examId` exists (same precondition as today's `handleSeedPool`). Replace the pool `<select>` + seed button + `ExamQuestionPanel` block (~lines 2462–2487) so that, when `examId` is set, it renders `<SectionsManager examId={examId} />`. Keep the existing "create the exam first" guard/empty-state when `examId` is not yet set.

- [ ] **Step 3: Add the two toggles to the settings step**

In the wizard's settings/runtime step (where other runtime booleans like `show_score_report` are edited and sent), add two checkboxes bound to `sequential_sections` and `allow_revisit_sections`, defaulting to `false`/`true`. They flow through the existing exam-settings save path (the payload merged into `settings` → `set_exam_runtime_settings`). Grep the wizard for an existing runtime boolean (e.g. `show_score_report`) and mirror its state + payload wiring exactly.

- [ ] **Step 4: Manual verification**

Create a new exam through the wizard: add a section from a pool at step 3; toggle "Sequential sections" on and "Allow revisiting" off at the settings step; save. Reopen the exam in the manage page and confirm the section and both toggles persisted.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Admin/AdminManageTestPage/AdminManageTestPage.jsx frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.jsx
git commit -m "feat(sections): wire SectionsManager + section toggles into wizard & manage page"
```

---

# PHASE 4 — Learner taking UI (section hub)

### Task 14: Section navigation helper (pure, unit-tested)

Extract the hub/section logic into a pure module so it's testable without the DOM.

**Files:**
- Create: `frontend/src/pages/Proctoring/sectionNavigation.js`
- Test: `_workspace_nonruntime/tests/frontend/src/pages/Proctoring/sectionNavigation.test.js`

- [ ] **Step 1: Write the failing test**

```js
// _workspace_nonruntime/tests/frontend/src/pages/Proctoring/sectionNavigation.test.js
import { describe, expect, it } from 'vitest'
import { buildHub, sectionStatus } from './sectionNavigation'

const sections = [
  { id: 's1', title: 'One', order: 0 },
  { id: 's2', title: 'Two', order: 1 },
]
const questions = [
  { id: 'q1', section_id: 's1' },
  { id: 'q2', section_id: 's2' },
]

describe('buildHub', () => {
  it('orders sections and attaches their questions', () => {
    const hub = buildHub(sections, questions)
    expect(hub.map((s) => s.title)).toEqual(['One', 'Two'])
    expect(hub[0].questions.map((q) => q.id)).toEqual(['q1'])
  })
})

describe('sectionStatus', () => {
  const hub = buildHub(sections, questions)
  it('marks finished sections', () => {
    expect(sectionStatus(hub, 0, { finished: ['s1'], answers: {}, sequential: false })).toBe('finished')
  })
  it('locks later sections when sequential and prior unfinished', () => {
    expect(sectionStatus(hub, 1, { finished: [], answers: {}, sequential: true })).toBe('locked')
  })
  it('does not lock when sequential is off', () => {
    expect(sectionStatus(hub, 1, { finished: [], answers: {}, sequential: false })).toBe('not_started')
  })
  it('reports in_progress when some answers exist', () => {
    expect(sectionStatus(hub, 0, { finished: [], answers: { q1: 'A' }, sequential: false })).toBe('in_progress')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

```js
// frontend/src/pages/Proctoring/sectionNavigation.js
export function buildHub(sections, questions) {
  const ordered = [...(sections || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const byId = new Map(ordered.map((s) => [String(s.id), { ...s, questions: [] }]))
  for (const q of questions || []) {
    const bucket = byId.get(String(q.section_id))
    if (bucket) bucket.questions.push(q)
  }
  return ordered.map((s) => byId.get(String(s.id)))
}

export function sectionStatus(hub, index, { finished = [], answers = {}, sequential = false } = {}) {
  const section = hub[index]
  if (!section) return 'not_started'
  const finishedSet = new Set(finished.map(String))
  if (finishedSet.has(String(section.id))) return 'finished'
  if (sequential) {
    const priorUnfinished = hub.slice(0, index).some((s) => !finishedSet.has(String(s.id)))
    if (priorUnfinished) return 'locked'
  }
  const hasAnswer = (section.questions || []).some((q) => answers[q.id] != null && answers[q.id] !== '')
  return hasAnswer ? 'in_progress' : 'not_started'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Proctoring/sectionNavigation.js _workspace_nonruntime/tests/frontend/src/pages/Proctoring/sectionNavigation.test.js
git commit -m "feat(sections): pure section-hub navigation helper"
```

---

### Task 15: Section hub + in-section flow in `Proctoring.jsx`

**Files:**
- Modify: `frontend/src/pages/Proctoring/Proctoring.jsx`
- Modify: `frontend/src/services/test.service.js` (add `getLearnerSections`)

- [ ] **Step 1: Fetch sections alongside questions**

In `test.service.js` add:

```js
export const getLearnerSections = (testId) => api.get(`exams/${testId}/learner-sections`)
```

In `Proctoring.jsx`'s load effect (~line 370), add `getLearnerSections(att.exam_id)` to the `Promise.allSettled([...])` and store the result: `const [sections, setSections] = useState([])`. Also read `attempt.sections_finished` into state: `const [finishedSections, setFinishedSections] = useState([])` (from the attempt fetch).

- [ ] **Step 2: Add hub/section view state**

Add:

```jsx
import { buildHub, sectionStatus } from './sectionNavigation'
const [activeSectionId, setActiveSectionId] = useState(null) // null => show hub
const hub = useMemo(() => buildHub(sections, questions), [sections, questions])
const sequential = !!exam?.settings?.sequential_sections
const allowRevisit = exam?.settings?.allow_revisit_sections !== false
```

- [ ] **Step 3: Render the hub when `activeSectionId` is null**

Before the current question card, branch: when `activeSectionId == null`, render a hub listing `hub.map((s, i) => ...)` with a status badge from `sectionStatus(hub, i, { finished: finishedSections, answers, sequential })`. A `locked` section's button is `disabled`. A `finished` section is enterable only if `allowRevisit`. Clicking a section sets `activeSectionId = s.id` and `setCurrentIdx` to that section's first question's index in the flat `questions` array.

- [ ] **Step 4: Scope in-section navigation + section header**

When `activeSectionId` is set, compute the section's questions and the local position. Show the header `t('proctor_section_header', { title, current, total })` → e.g. "Section 2: Algebra — Question 3 of 8". Change prev/next so they move only within the section. On the section's **last** question, the Next button becomes **"Finish section"**: it calls a new `finishSection()` that POSTs `attempts/{attemptId}/sections/{activeSectionId}/finish` (add `finishSectionApi` to `admin.service.js`/a service), updates `finishedSections` from the response, then sets `activeSectionId = null` to return to the hub. Keep the existing per-question `question-nav` grid scoped to the current section only.

Concrete `finishSection` sketch:

```jsx
const finishSection = useCallback(async () => {
  try {
    await flush() // persist any pending answers first
    const { data } = await api.post(`attempts/${attemptId}/sections/${activeSectionId}/finish`)
    setFinishedSections(data.sections_finished || [])
  } catch (e) { /* surface via existing error toast */ }
  setActiveSectionId(null)
}, [attemptId, activeSectionId, flush])
```

- [ ] **Step 5: Submit from the hub**

The overall **Submit test** button lives on the hub screen (not inside a section). Keep the existing `handleSubmitRequest`/`runSubmissionFlow`. If `sequential`, disable Submit until every section is `finished`.

- [ ] **Step 6: Backward compatibility**

If `hub.length <= 1` (e.g. legacy exam with only the "General" section), skip the hub entirely and render the classic flat flow (set `activeSectionId` to that single section on load, hide the hub, and the final Next → Submit as today). Verify a legacy exam still behaves exactly as before.

- [ ] **Step 7: Manual verification (this is the core UX — verify carefully)**

With backend running and a multi-section exam:
1. Start an attempt → the hub lists all sections with "Not started".
2. Enter a section → header shows "Section N: Title — Question i of n"; prev/next stay within the section.
3. Last question → "Finish section" → returns to hub; that section shows "Finished".
4. With **Sequential on**: later sections are disabled until the prior is finished.
5. With **Allow revisiting off**: a finished section can't be re-entered; server also rejects a late answer (409).
6. With **Allow revisiting on**: re-enter a finished section and change an answer; it saves.
7. Submit from the hub; attempt scores as before.
8. A single-section (legacy) exam still runs as the classic flat flow.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Proctoring/Proctoring.jsx frontend/src/services/test.service.js
git commit -m "feat(sections): learner section hub + in-section navigation"
```

---

### Task 16: i18n strings

**Files:**
- Modify: `frontend/src/locales/en.json` (add keys; other locales auto-fall-back to en)
- Modify: backend i18n dictionaries for `section_locked` (find where `_t` keys like `cannot_modify_published` live; add `section_locked`)

- [ ] **Step 1: Add the new UI keys to `en.json`**

```json
"proctor_section_hub_title": "Sections",
"proctor_section_header": "Section {{title}} — Question {{current}} of {{total}}",
"proctor_finish_section": "Finish Section",
"proctor_section_status_not_started": "Not started",
"proctor_section_status_in_progress": "In progress",
"proctor_section_status_finished": "Finished",
"proctor_section_status_locked": "Locked",
"admin_sections_add_from_pool": "Add section from pool",
"admin_sections_pick_questions": "Select questions to include",
"admin_sections_create": "Create section",
"admin_sections_title_label": "Section title",
"admin_wizard_sequential_sections": "Take sections in sequence",
"admin_wizard_allow_revisit_sections": "Allow revisiting finished sections"
```

- [ ] **Step 2: Add the backend `section_locked` message**

Grep for the module holding `cannot_modify_published` (Run: `cd backend && grep -rn "cannot_modify_published" src/app | grep -i locale`), and add a `section_locked` entry (e.g. "This section is locked until earlier sections are finished.") to the same dictionary/file(s).

- [ ] **Step 3: Verify**

Run: `cd frontend && npm run test` (ensures nothing imports a broken JSON). Manually confirm the hub and headers show real text, not raw keys, in English.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/locales/en.json backend/src/app/**/locale*  # adjust to the real path found
git commit -m "feat(sections): i18n strings for section hub and authoring"
```

---

## Final verification

- [ ] Backend: `cd backend && PYTHONPATH=src pytest tests/ -q` — all green (unrelated pre-existing failures unchanged).
- [ ] Frontend: `cd frontend && npm run test` — new tests pass (note: ~168 pre-existing failures from the broken provider harness are expected per project memory; confirm your new tests pass and you added no new failures).
- [ ] Migration: `cd backend && PYTHONPATH=src alembic upgrade head` then `alembic downgrade -1` then `alembic upgrade head` — up/down/up clean.
- [ ] Manual end-to-end (Task 15 Step 7 checklist) passes for a multi-section exam and a legacy single-section exam.

---

## Self-review notes (author)

- **Spec coverage:** data model (Tasks 1–3), admin hand-pick (Task 6), everything-is-a-section/General (Tasks 3 backfill, 7), two exam toggles (Tasks 2, 13), section hub + one-at-a-time + finish→hub (Tasks 14–15), sequential + revisit enforcement client (Task 15) and server (Task 9), construction-site coverage incl. seed replacement (Tasks 6–7), migration + backfill (Task 3), learner payload (Task 10). All covered.
- **Out of scope (unchanged):** per-section timers, per-section scoring/reporting, random draw within a section.
- **Type consistency:** `sections_finished` (list of section-id strings), `section_id`, `sequential_sections`/`allow_revisit_sections`, `ExamSection`/`exam_sections`, `create_section_from_pool`, `mark_section_finished`, `buildHub`/`sectionStatus`, `groupQuestionsBySection` used consistently across tasks.
- **Known discovery points to confirm during execution (grep before coding):** exact import module for `ensure_exam_owner`, `learner_can_access_exam`, `require_permission`, `get_current_user`, `get_db_dep`, `_t`, `parse_uuid_param`; current Alembic head revision; the backend i18n dictionary path for `section_locked`; the wizard's existing runtime-boolean wiring to mirror.
