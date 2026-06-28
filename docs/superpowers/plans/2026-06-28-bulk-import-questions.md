# Bulk-Import Questions into a Question Pool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Import Questions" button next to "+ New Pool" that uploads a CSV/Excel file and bulk-adds questions (all 7 types) into a new or existing pool in one atomic request.

**Architecture:** A pure, unit-tested helper parses spreadsheet rows into question payloads; a new modal component drives target selection, file upload, preview, and import; a new transactional backend endpoint inserts the questions. Bulk import is semantically "repeat the existing single-add N times, in one transaction."

**Tech Stack:** React (Vite), FastAPI + SQLAlchemy, Vitest, pytest, `xlsx` (SheetJS) for spreadsheet parsing.

**Spec:** `docs/superpowers/specs/2026-06-28-bulk-import-questions-design.md`

**Working directory:** all paths are relative to `/home/rashash/testme/syra-testme`.

---

## File Structure

- **Create** `frontend/src/utils/parseQuestionRows.js` — pure parsing/validation/mapping + template matrix. No React, no network.
- **Create** `_workspace_nonruntime/tests/frontend/src/utils/parseQuestionRows.test.js` — Vitest unit tests for the helper. (Frontend tests are mirrored from here into `.generated-tests/unit/src/` by `frontend/scripts/run-vitest.mjs`; a helper at `src/utils/foo.js` is tested by a file at `.../src/utils/foo.test.js` importing `./foo`.)
- **Create** `frontend/src/pages/Admin/AdminQuestionPools/BulkImportQuestionsModal.jsx` — the modal UI.
- **Modify** `frontend/src/pages/Admin/AdminQuestionPools/AdminQuestionPools.jsx` — add the button + render the modal.
- **Modify** `frontend/src/pages/Admin/AdminQuestionPools/AdminQuestionPools.module.scss` — add a few classes.
- **Modify** `frontend/src/services/admin.service.js` — add `bulkCreatePoolQuestions`.
- **Modify** `frontend/src/locales/en.json` — add i18n keys.
- **Modify** `frontend/package.json` — add `xlsx` dependency.
- **Modify** `backend/src/app/schemas/__init__.py` — add `BulkQuestionsCreate`, `BulkQuestionsResult`.
- **Modify** `backend/src/app/api/routes/question_pools.py` — add the bulk endpoint.
- **Modify** `backend/src/app/messages/en.json` — add `pool_bulk_too_many`.
- **Create** `backend/tests/test_question_pools_bulk.py` — pytest for the endpoint.

**Testing note:** The repo has unit tests only for pure utils (frontend) and direct route/service calls (backend); there are no React component tests. This plan TDDs the two logic-heavy units (the parsing helper and the backend endpoint) and verifies the modal + wiring manually (lint + dev-server check), matching the established testing reality.

---

## Task 1: Add the `xlsx` dependency

**Files:**
- Modify: `frontend/package.json`

- [ ] **Step 1: Install xlsx**

Run: `cd frontend && npm install xlsx`
Expected: `package.json` gains an `xlsx` entry under `dependencies`; `package-lock.json` updates; exit code 0.

- [ ] **Step 2: Verify it resolves**

Run: `cd frontend && node -e "console.log(require('xlsx').version || 'ok')"`
Expected: prints a version string (e.g. `0.18.5`) or `ok`, no error.

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "build: add xlsx (SheetJS) for question bulk import"
```

---

## Task 2: Pure parsing/mapping helper (TDD)

**Files:**
- Create: `frontend/src/utils/parseQuestionRows.js`
- Test: `_workspace_nonruntime/tests/frontend/src/utils/parseQuestionRows.test.js`

- [ ] **Step 1: Write the failing tests**

Create `_workspace_nonruntime/tests/frontend/src/utils/parseQuestionRows.test.js`:

```javascript
import { describe, expect, it } from 'vitest'

import { mapRecordToQuestion, mapRecords, rowsToRecords, templateMatrix } from './parseQuestionRows'

describe('rowsToRecords', () => {
  it('maps a header row to lowercased keys and skips blank rows', () => {
    const matrix = [
      ['Text', 'Type', 'Options', 'Correct_Answer', 'Points'],
      ['Q1', 'MCQ', 'a\nb', 'a', '2'],
      ['', '', '', '', ''],
    ]
    expect(rowsToRecords(matrix)).toEqual([
      { text: 'Q1', type: 'MCQ', options: 'a\nb', correct_answer: 'a', points: '2' },
    ])
  })

  it('returns [] for empty input', () => {
    expect(rowsToRecords([])).toEqual([])
  })
})

describe('mapRecordToQuestion', () => {
  it('maps a valid MCQ', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'MCQ', options: '3\n4\n5', correct_answer: '4', points: '2' }))
      .toEqual({ payload: { text: 'Q', question_type: 'MCQ', options: ['3', '4', '5'], correct_answer: '4', points: 2 } })
  })

  it('maps MULTI with comma-separated answers', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'MULTI', options: '2\n3\n4', correct_answer: '2, 3' }).payload)
      .toEqual({ text: 'Q', question_type: 'MULTI', options: ['2', '3', '4'], correct_answer: '2,3', points: 1 })
  })

  it('maps TRUEFALSE and defaults options', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'true false', correct_answer: 'TRUE' }).payload)
      .toEqual({ text: 'Q', question_type: 'TRUEFALSE', options: ['True', 'False'], correct_answer: 'True', points: 1 })
  })

  it('maps TEXT with optional answer and no options', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'SHORT_ANSWER', correct_answer: 'model' }).payload)
      .toEqual({ text: 'Q', question_type: 'TEXT', options: null, correct_answer: 'model', points: 1 })
  })

  it('maps ORDERING with auto-derived (null) answer', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'ORDERING', options: 'a\nb\nc' }).payload)
      .toEqual({ text: 'Q', question_type: 'ORDERING', options: ['a', 'b', 'c'], correct_answer: null, points: 1 })
  })

  it('maps FILLINBLANK acceptable answers', () => {
    expect(mapRecordToQuestion({ text: 'Q [blank]', type: 'FILL_IN_BLANK', options: 'Paris\nparis' }).payload)
      .toEqual({ text: 'Q [blank]', question_type: 'FILLINBLANK', options: ['Paris', 'paris'], correct_answer: null, points: 1 })
  })

  it('maps MATCHING pairs', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'MATCHING', options: 'France | Paris\nEgypt | Cairo', correct_answer: 'A-1,B-2' }).payload)
      .toEqual({ text: 'Q', question_type: 'MATCHING', options: ['France | Paris', 'Egypt | Cairo'], correct_answer: 'A-1,B-2', points: 1 })
  })

  it('flags missing text', () => {
    expect(mapRecordToQuestion({ text: '   ', type: 'MCQ' })).toEqual({ error: 'missing_text' })
  })

  it('flags unknown type', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'ESSAYISH' })).toEqual({ error: 'unknown_type' })
  })

  it('flags MCQ with fewer than 2 options', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'MCQ', options: 'only', correct_answer: 'only' }))
      .toEqual({ error: 'mcq_need_2_options' })
  })

  it('flags MCQ answer not among options', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'MCQ', options: 'a\nb', correct_answer: 'c' }))
      .toEqual({ error: 'answer_not_in_options' })
  })

  it('flags bad TRUEFALSE answer', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'TRUEFALSE', correct_answer: 'maybe' }))
      .toEqual({ error: 'truefalse_answer' })
  })

  it('flags malformed MATCHING pair', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'MATCHING', options: 'no pipe here', correct_answer: 'A-1' }))
      .toEqual({ error: 'matching_pair_format' })
  })

  it('defaults invalid points to 1', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'TEXT', points: 'abc' }).payload.points).toBe(1)
  })
})

describe('mapRecords', () => {
  it('tags each result with a 1-based row number offset by the header row', () => {
    const out = mapRecords([
      { text: 'Q1', type: 'TEXT' },
      { text: '', type: 'TEXT' },
    ])
    expect(out[0]).toEqual({ row: 2, payload: { text: 'Q1', question_type: 'TEXT', options: null, correct_answer: null, points: 1 } })
    expect(out[1]).toEqual({ row: 3, error: 'missing_text' })
  })
})

describe('templateMatrix', () => {
  it('has the expected header and one sample row per type', () => {
    const matrix = templateMatrix()
    expect(matrix[0]).toEqual(['text', 'type', 'options', 'correct_answer', 'points'])
    const types = matrix.slice(1).map((row) => row[1])
    expect(types).toEqual(['MCQ', 'MULTI', 'TRUEFALSE', 'TEXT', 'ORDERING', 'FILLINBLANK', 'MATCHING'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm run test -- parseQuestionRows`
Expected: FAIL — cannot resolve `./parseQuestionRows` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `frontend/src/utils/parseQuestionRows.js`:

```javascript
// Pure helpers to turn spreadsheet rows into question-create payloads.
// No React, no network — unit tested in parseQuestionRows.test.js.

const VALID_TYPES = new Set(['MCQ', 'MULTI', 'TRUEFALSE', 'TEXT', 'ORDERING', 'FILLINBLANK', 'MATCHING'])

const TYPE_ALIASES = {
  TRUE_FALSE: 'TRUEFALSE',
  SHORT_ANSWER: 'TEXT',
  FILL_IN_BLANK: 'FILLINBLANK',
  MULTIPLE_CHOICE: 'MULTI',
}

function normalizeType(raw) {
  const key = String(raw || '').trim().toUpperCase().replace(/[\s/-]+/g, '_')
  if (TYPE_ALIASES[key]) return TYPE_ALIASES[key]
  const compact = key.replace(/_/g, '')
  if (VALID_TYPES.has(compact)) return compact
  if (VALID_TYPES.has(key)) return key
  return null
}

function lines(cell) {
  return String(cell ?? '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
}

// matrix: array-of-arrays (first row = header). Returns array of records keyed by lowercased header.
export function rowsToRecords(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0) return []
  const headers = (matrix[0] || []).map((header) => String(header ?? '').trim().toLowerCase())
  return matrix
    .slice(1)
    .filter((cols) => Array.isArray(cols) && cols.some((col) => String(col ?? '').trim() !== ''))
    .map((cols) => Object.fromEntries(headers.map((header, index) => [header, cols[index] ?? ''])))
}

// Returns { payload } for a valid row, or { error: <code> } otherwise.
export function mapRecordToQuestion(record) {
  const text = String(record?.text ?? '').trim()
  if (!text) return { error: 'missing_text' }

  const type = normalizeType(record?.type)
  if (!type) return { error: 'unknown_type' }

  let points = Number(String(record?.points ?? '').trim())
  if (!Number.isFinite(points) || points <= 0) points = 1

  const opts = lines(record?.options)
  const answerRaw = String(record?.correct_answer ?? '').trim()

  let options = null
  let correctAnswer = null

  if (type === 'MCQ') {
    if (opts.length < 2) return { error: 'mcq_need_2_options' }
    if (!answerRaw) return { error: 'missing_correct_answer' }
    if (!opts.includes(answerRaw)) return { error: 'answer_not_in_options' }
    options = opts
    correctAnswer = answerRaw
  } else if (type === 'MULTI') {
    if (opts.length < 2) return { error: 'mcq_need_2_options' }
    const answers = answerRaw.split(',').map((value) => value.trim()).filter(Boolean)
    if (!answers.length) return { error: 'missing_correct_answer' }
    if (!answers.every((answer) => opts.includes(answer))) return { error: 'answer_not_in_options' }
    options = opts
    correctAnswer = answers.join(',')
  } else if (type === 'TRUEFALSE') {
    const normalized = answerRaw.toLowerCase()
    if (normalized !== 'true' && normalized !== 'false') return { error: 'truefalse_answer' }
    options = ['True', 'False']
    correctAnswer = normalized === 'true' ? 'True' : 'False'
  } else if (type === 'ORDERING') {
    if (opts.length < 2) return { error: 'ordering_need_2' }
    options = opts
    correctAnswer = null
  } else if (type === 'FILLINBLANK') {
    if (opts.length < 1) return { error: 'fillinblank_need_1' }
    options = opts
    correctAnswer = null
  } else if (type === 'MATCHING') {
    if (opts.length < 1) return { error: 'matching_need_1' }
    if (!opts.every((line) => line.split('|').length === 2)) return { error: 'matching_pair_format' }
    options = opts
    correctAnswer = answerRaw || null
  } else {
    // TEXT
    options = null
    correctAnswer = answerRaw || null
  }

  return { payload: { text, question_type: type, options, correct_answer: correctAnswer, points } }
}

// records: output of rowsToRecords. Returns [{ row, payload? , error? }] with 1-based
// spreadsheet row numbers (header is row 1, so data starts at row 2).
export function mapRecords(records) {
  return (records || []).map((record, index) => ({ row: index + 2, ...mapRecordToQuestion(record) }))
}

// Sample data for the downloadable template (array-of-arrays: header + one row per type).
export function templateMatrix() {
  return [
    ['text', 'type', 'options', 'correct_answer', 'points'],
    ['What is 2 + 2?', 'MCQ', '3\n4\n5\n6', '4', '1'],
    ['Select the prime numbers.', 'MULTI', '2\n3\n4\n6', '2,3', '1'],
    ['The sky is blue.', 'TRUEFALSE', '', 'True', '1'],
    ['Define photosynthesis.', 'TEXT', '', 'Conversion of light into chemical energy', '2'],
    ['Order the planets from the sun.', 'ORDERING', 'Mercury\nVenus\nEarth\nMars', '', '1'],
    ['The capital of France is [blank].', 'FILLINBLANK', 'Paris\nparis', '', '1'],
    ['Match each country to its capital.', 'MATCHING', 'France | Paris\nEgypt | Cairo', 'A-1,B-2', '1'],
  ]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npm run test -- parseQuestionRows`
Expected: PASS — all tests in `parseQuestionRows.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/parseQuestionRows.js _workspace_nonruntime/tests/frontend/src/utils/parseQuestionRows.test.js
git commit -m "feat: pure helper to parse spreadsheet rows into question payloads"
```

---

## Task 3: Backend bulk endpoint (TDD)

**Files:**
- Modify: `backend/src/app/schemas/__init__.py` (after `QuestionBase`, around line 252)
- Modify: `backend/src/app/api/routes/question_pools.py`
- Modify: `backend/src/app/messages/en.json`
- Test: `backend/tests/test_question_pools_bulk.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_question_pools_bulk.py`:

```python
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import QuestionPool, RoleEnum, User
from app.schemas import BulkQuestionsCreate, QuestionBase
from app.api.routes.question_pools import bulk_create_pool_questions, list_pool_questions


def _new_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def _create_user(db: Session, role: RoleEnum = RoleEnum.ADMIN) -> User:
    user = User(
        user_id=f"u-{uuid.uuid4().hex[:8]}",
        email=f"u-{uuid.uuid4().hex[:8]}@example.com",
        name="User",
        hashed_password="hashed",
        role=role,
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def _create_pool(db: Session, owner: User) -> QuestionPool:
    pool = QuestionPool(name=f"Pool {uuid.uuid4().hex[:6]}", description=None, created_by_id=owner.id)
    db.add(pool)
    db.commit()
    db.refresh(pool)
    return pool


def _mcq(text: str) -> QuestionBase:
    return QuestionBase(text=text, question_type="MCQ", options=["a", "b"], correct_answer="a", points=1)


def test_bulk_create_inserts_all_questions() -> None:
    db = _new_session()
    try:
        admin = _create_user(db)
        pool = _create_pool(db, admin)
        body = BulkQuestionsCreate(questions=[_mcq("Q1"), _mcq("Q2"), _mcq("Q3")])

        result = bulk_create_pool_questions(pool_id=str(pool.id), body=body, db=db, current=admin)

        assert result.created == 3
        stored = list_pool_questions(pool_id=str(pool.id), db=db, current=admin)
        assert sorted(q.text for q in stored) == ["Q1", "Q2", "Q3"]
    finally:
        db.close()


def test_bulk_create_rejects_non_owner() -> None:
    db = _new_session()
    try:
        owner = _create_user(db)
        other = _create_user(db, role=RoleEnum.INSTRUCTOR)
        pool = _create_pool(db, owner)
        body = BulkQuestionsCreate(questions=[_mcq("Q1")])

        with pytest.raises(HTTPException) as exc:
            bulk_create_pool_questions(pool_id=str(pool.id), body=body, db=db, current=other)
        assert exc.value.status_code == 403
    finally:
        db.close()


def test_bulk_create_unknown_pool_returns_404() -> None:
    db = _new_session()
    try:
        admin = _create_user(db)
        body = BulkQuestionsCreate(questions=[_mcq("Q1")])

        with pytest.raises(HTTPException) as exc:
            bulk_create_pool_questions(pool_id=str(uuid.uuid4()), body=body, db=db, current=admin)
        assert exc.value.status_code == 404
    finally:
        db.close()


def test_bulk_create_empty_list_returns_400() -> None:
    db = _new_session()
    try:
        admin = _create_user(db)
        pool = _create_pool(db, admin)
        body = BulkQuestionsCreate(questions=[])

        with pytest.raises(HTTPException) as exc:
            bulk_create_pool_questions(pool_id=str(pool.id), body=body, db=db, current=admin)
        assert exc.value.status_code == 400
    finally:
        db.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PYTHONPATH=src pytest tests/test_question_pools_bulk.py -v`
Expected: FAIL — `ImportError: cannot import name 'BulkQuestionsCreate'` (and `bulk_create_pool_questions` not defined).

- [ ] **Step 3a: Add the schemas**

In `backend/src/app/schemas/__init__.py`, immediately after the `QuestionBase` class definition (after its validators, around line 252), add:

```python
class BulkQuestionsCreate(BaseModel):
    questions: list[QuestionBase]


class BulkQuestionsResult(BaseModel):
    created: int
```

- [ ] **Step 3b: Add the translation key**

In `backend/src/app/messages/en.json`, add a key next to the other `pool_*` entries (near line 96):

```json
  "pool_bulk_too_many": "Too many questions in one upload (max {max}).",
```

(Ensure surrounding JSON commas remain valid.)

- [ ] **Step 3c: Add the route**

In `backend/src/app/api/routes/question_pools.py`:

Update the schema import (currently line 12) to include the new schemas:

```python
from ...schemas import Message, QuestionBase, QuestionPoolCreate, QuestionPoolRead, QuestionRead, BulkQuestionsCreate, BulkQuestionsResult
```

Add a module-level constant near the top (after `logger = logging.getLogger(__name__)`):

```python
MAX_BULK_QUESTIONS = 1000
```

Add the route immediately after the existing `create_pool_question` function (after line 365):

```python
@router.post("/{pool_id}/questions/bulk", response_model=BulkQuestionsResult)
def bulk_create_pool_questions(
    pool_id: str,
    body: BulkQuestionsCreate,
    db: Session = Depends(get_db_dep),
    current=Depends(require_permission("Manage Question Pools", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    pool_pk = parse_uuid_param(pool_id, detail=_t("pool_not_found"))
    pool = db.get(QuestionPool, pool_pk)
    if not pool:
        raise HTTPException(status_code=404, detail=_t("pool_not_found"))
    if pool.created_by_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))
    if not body.questions:
        raise HTTPException(status_code=400, detail=_t("pool_no_questions"))
    if len(body.questions) > MAX_BULK_QUESTIONS:
        raise HTTPException(status_code=400, detail=_t("pool_bulk_too_many", max=MAX_BULK_QUESTIONS))

    library_exam = _ensure_pool_library_exam(db, current, pool)
    next_order = db.scalar(select(func.max(Question.order)).where(Question.pool_id == pool_pk)) or 0
    now = datetime.now(timezone.utc)
    created = 0
    for item in body.questions:
        payload = sanitize_question_payload(item.model_dump())
        next_order += 1
        question = Question(
            exam_id=library_exam.id,
            text=payload["text"],
            type=payload["type"],
            options=payload.get("options"),
            correct_answer=payload.get("correct_answer"),
            points=payload["points"],
            order=next_order,
            pool_id=pool_pk,
            created_at=now,
            updated_at=now,
        )
        db.add(question)
        created += 1
    db.commit()
    return BulkQuestionsResult(created=created)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PYTHONPATH=src pytest tests/test_question_pools_bulk.py -v`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/app/schemas/__init__.py backend/src/app/api/routes/question_pools.py backend/src/app/messages/en.json backend/tests/test_question_pools_bulk.py
git commit -m "feat: transactional bulk-create endpoint for pool questions"
```

---

## Task 4: Frontend service method

**Files:**
- Modify: `frontend/src/services/admin.service.js:44` (right after `createPoolQuestion`)

- [ ] **Step 1: Add the method**

After the `createPoolQuestion` line (line 44), add:

```javascript
  bulkCreatePoolQuestions: (poolId, questions) => api.post(`question-pools/${poolId}/questions/bulk`, { questions }),
```

- [ ] **Step 2: Verify it parses (lint)**

Run: `cd frontend && npm run lint -- src/services/admin.service.js`
Expected: no errors for this file.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/services/admin.service.js
git commit -m "feat: admin.service bulkCreatePoolQuestions"
```

---

## Task 5: i18n keys

**Files:**
- Modify: `frontend/src/locales/en.json`

- [ ] **Step 1: Add the keys**

Add these keys to `frontend/src/locales/en.json` (place them near the other `admin_pools_*` keys; ensure valid JSON commas):

```json
  "admin_pools_import_questions": "Import Questions",
  "admin_pools_import_title": "Import Questions",
  "admin_pools_import_target": "Add to",
  "admin_pools_import_target_new": "New pool",
  "admin_pools_import_target_existing": "Existing pool",
  "admin_pools_import_select_pool": "Choose a pool",
  "admin_pools_import_file": "CSV or Excel file",
  "admin_pools_import_file_hint": "Accepted: .csv, .xlsx, .xls. One value per line inside a cell.",
  "admin_pools_import_download_template": "Download template",
  "admin_pools_import_preview": "{valid} valid, {invalid} invalid",
  "admin_pools_import_no_rows": "No data rows found in the file.",
  "admin_pools_import_parse_error": "Could not read that file. Check the format and try again.",
  "admin_pools_import_submit": "Import {count} questions",
  "admin_pools_import_importing": "Importing…",
  "admin_pools_import_done": "Imported {count} questions into {pool}",
  "admin_pools_import_row_error": "Row {row}: {reason}",
  "admin_pools_import_err_missing_text": "Question text is required",
  "admin_pools_import_err_unknown_type": "Unknown question type",
  "admin_pools_import_err_missing_answer": "Correct answer is required",
  "admin_pools_import_err_answer_not_in_options": "Correct answer must match one of the options",
  "admin_pools_import_err_need_2_options": "At least two options are required",
  "admin_pools_import_err_need_1_option": "At least one option is required",
  "admin_pools_import_err_truefalse": "Correct answer must be True or False",
  "admin_pools_import_err_matching_format": "Each pair must be written as 'Left | Right'",
```

- [ ] **Step 2: Verify JSON is valid**

Run: `cd frontend && node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json','utf8')); console.log('valid')"`
Expected: prints `valid`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/locales/en.json
git commit -m "i18n: add bulk-import question strings (en)"
```

---

## Task 6: Bulk import modal component

**Files:**
- Create: `frontend/src/pages/Admin/AdminQuestionPools/BulkImportQuestionsModal.jsx`
- Modify: `frontend/src/pages/Admin/AdminQuestionPools/AdminQuestionPools.module.scss`

- [ ] **Step 1: Add the SCSS classes**

Append to `frontend/src/pages/Admin/AdminQuestionPools/AdminQuestionPools.module.scss`:

```scss
.modalWide {
  composes: modal;
  max-width: 640px;
  width: 100%;
}

.btnSecondary {
  composes: actionBtn;
  font-weight: 600;
}

.radioRow {
  display: flex;
  gap: 1.25rem;
  align-items: center;
  flex-wrap: wrap;

  label {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
  }
}

.previewBox {
  margin-top: 0.75rem;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
}

.previewList {
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 0.5rem;
}

.previewRowOk,
.previewRowBad {
  display: flex;
  gap: 0.5rem;
  font-size: 0.85rem;
  padding: 0.15rem 0;
}

.previewRowBad {
  color: #f87171;
}
```

Note: `composes:` requires the composed class to exist in the same file — `modal`, `actionBtn` already do.

- [ ] **Step 2: Create the modal component**

Create `frontend/src/pages/Admin/AdminQuestionPools/BulkImportQuestionsModal.jsx`:

```javascript
import React, { useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { adminApi } from '../../../services/admin.service'
import useLanguage from '../../../hooks/useLanguage'
import { mapRecords, rowsToRecords, templateMatrix } from '../../../utils/parseQuestionRows'
import styles from './AdminQuestionPools.module.scss'

function resolveError(err, fallback) {
  if (err?.userMessage) return err.userMessage
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string') return detail
  return fallback
}

const REASON_KEYS = {
  missing_text: 'admin_pools_import_err_missing_text',
  unknown_type: 'admin_pools_import_err_unknown_type',
  missing_correct_answer: 'admin_pools_import_err_missing_answer',
  answer_not_in_options: 'admin_pools_import_err_answer_not_in_options',
  mcq_need_2_options: 'admin_pools_import_err_need_2_options',
  ordering_need_2: 'admin_pools_import_err_need_2_options',
  fillinblank_need_1: 'admin_pools_import_err_need_1_option',
  matching_need_1: 'admin_pools_import_err_need_1_option',
  truefalse_answer: 'admin_pools_import_err_truefalse',
  matching_pair_format: 'admin_pools_import_err_matching_format',
}

export default function BulkImportQuestionsModal({ pools, onClose, onImported }) {
  const { t } = useLanguage()
  const fileRef = useRef()
  const [target, setTarget] = useState('new')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [existingPoolId, setExistingPoolId] = useState(pools[0]?.id || '')
  const [mapped, setMapped] = useState([])
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)

  const validRows = useMemo(() => mapped.filter((row) => row.payload), [mapped])
  const invalidRows = useMemo(() => mapped.filter((row) => row.error), [mapped])

  const reasonText = (code) => t(REASON_KEYS[code] || 'admin_pools_import_err_unknown_type')

  const handleFile = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    setError('')
    try {
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false, raw: false })
      const rows = mapRecords(rowsToRecords(matrix))
      setMapped(rows)
      if (!rows.length) setError(t('admin_pools_import_no_rows'))
    } catch (err) {
      setMapped([])
      setError(t('admin_pools_import_parse_error'))
    }
  }

  const downloadTemplate = () => {
    const sheet = XLSX.utils.aoa_to_sheet(templateMatrix())
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, sheet, 'Questions')
    XLSX.writeFile(workbook, 'question-import-template.xlsx')
  }

  const targetReady = target === 'existing' ? Boolean(existingPoolId) : Boolean(name.trim())
  const canImport = validRows.length > 0 && targetReady && !importing

  const handleImport = async () => {
    if (!canImport) return
    setImporting(true)
    setError('')
    try {
      let poolId = existingPoolId
      let poolName = pools.find((pool) => String(pool.id) === String(existingPoolId))?.name || ''
      if (target === 'new') {
        const { data } = await adminApi.createQuestionPool({ name: name.trim(), description: description.trim() || null })
        poolId = data.id
        poolName = data.name
      }
      const { data } = await adminApi.bulkCreatePoolQuestions(poolId, validRows.map((row) => row.payload))
      onImported(t('admin_pools_import_done', { count: data.created, pool: poolName }))
    } catch (err) {
      setError(resolveError(err, t('admin_pools_import_parse_error')))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={importing ? undefined : onClose}>
      <div className={styles.modalWide} role="dialog" aria-modal="true" aria-labelledby="bulk-import-title" onClick={(event) => event.stopPropagation()}>
        <h3 id="bulk-import-title" className={styles.modalTitle}>{t('admin_pools_import_title')}</h3>
        {error && <div className={styles.modalError}>{error}</div>}

        <div className={styles.formGroup}>
          <span className={styles.label}>{t('admin_pools_import_target')}</span>
          <div className={styles.radioRow}>
            <label>
              <input type="radio" name="bulk-target" checked={target === 'new'} onChange={() => setTarget('new')} />
              {t('admin_pools_import_target_new')}
            </label>
            <label>
              <input type="radio" name="bulk-target" checked={target === 'existing'} onChange={() => setTarget('existing')} disabled={!pools.length} />
              {t('admin_pools_import_target_existing')}
            </label>
          </div>
        </div>

        {target === 'new' ? (
          <>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="bulk-pool-name">{t('name')}</label>
              <input id="bulk-pool-name" className={styles.input} value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="bulk-pool-desc">{t('description')}</label>
              <input id="bulk-pool-desc" className={styles.input} value={description} onChange={(event) => setDescription(event.target.value)} />
            </div>
          </>
        ) : (
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="bulk-pool-select">{t('admin_pools_import_select_pool')}</label>
            <select id="bulk-pool-select" className={styles.input} value={existingPoolId} onChange={(event) => setExistingPoolId(event.target.value)}>
              {pools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name}</option>)}
            </select>
          </div>
        )}

        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="bulk-file">{t('admin_pools_import_file')}</label>
          <input id="bulk-file" ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFile} />
          <div className={styles.filterMeta}>{t('admin_pools_import_file_hint')}</div>
          <button type="button" className={styles.actionBtn} onClick={downloadTemplate}>{t('admin_pools_import_download_template')}</button>
        </div>

        {mapped.length > 0 && (
          <div className={styles.previewBox}>
            <div className={styles.filterMeta}>{t('admin_pools_import_preview', { valid: validRows.length, invalid: invalidRows.length })}</div>
            <div className={styles.previewList}>
              {mapped.slice(0, 50).map((row) => (
                <div key={row.row} className={row.error ? styles.previewRowBad : styles.previewRowOk}>
                  <span className={styles.questionIndex}>{row.row}.</span>
                  <span>{row.payload ? row.payload.text : t('admin_pools_import_row_error', { row: row.row, reason: reasonText(row.error) })}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={styles.modalActions}>
          <button type="button" className={styles.btnCancel} onClick={onClose} disabled={importing}>{t('cancel')}</button>
          <button type="button" className={styles.btnPrimary} onClick={() => void handleImport()} disabled={!canImport}>
            {importing ? t('admin_pools_import_importing') : t('admin_pools_import_submit', { count: validRows.length })}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Lint the new files**

Run: `cd frontend && npm run lint -- src/pages/Admin/AdminQuestionPools/BulkImportQuestionsModal.jsx`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Admin/AdminQuestionPools/BulkImportQuestionsModal.jsx frontend/src/pages/Admin/AdminQuestionPools/AdminQuestionPools.module.scss
git commit -m "feat: bulk import questions modal"
```

---

## Task 7: Wire the button into the Question Pools page

**Files:**
- Modify: `frontend/src/pages/Admin/AdminQuestionPools/AdminQuestionPools.jsx`

- [ ] **Step 1: Import the modal**

Add to the imports (after the `AdminPageHeader` import, line 4):

```javascript
import BulkImportQuestionsModal from './BulkImportQuestionsModal'
```

- [ ] **Step 2: Add modal state**

After the `const [modal, setModal] = useState(false)` line (line 27), add:

```javascript
  const [bulkModal, setBulkModal] = useState(false)
```

- [ ] **Step 3: Add the button next to "+ New Pool"**

Replace the `<AdminPageHeader …>` block (lines 168-179) so both buttons render in the header actions:

```javascript
      <AdminPageHeader title={t('admin_pools_title')} subtitle={t('admin_pools_subtitle')}>
        <button
          type="button"
          className={styles.btnSecondary}
          onClick={() => setBulkModal(true)}
        >
          {t('admin_pools_import_questions')}
        </button>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={() => {
            setModal(true)
            setModalError('')
          }}
        >
          {t('admin_pools_new_pool')}
        </button>
      </AdminPageHeader>
```

- [ ] **Step 4: Render the modal**

Immediately before the closing `</div>` of the page (just after the existing `{modal && ( … )}` block, before line 330's `</div>`), add:

```javascript
      {bulkModal && (
        <BulkImportQuestionsModal
          pools={pools}
          onClose={() => setBulkModal(false)}
          onImported={(message) => {
            setBulkModal(false)
            setNotice(message)
            void load()
          }}
        />
      )}
```

- [ ] **Step 5: Lint**

Run: `cd frontend && npm run lint -- src/pages/Admin/AdminQuestionPools/AdminQuestionPools.jsx`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Admin/AdminQuestionPools/AdminQuestionPools.jsx
git commit -m "feat: add Import Questions button to question pools page"
```

---

## Task 8: Full verification

- [ ] **Step 1: Run the full frontend unit suite**

Run: `cd frontend && npm run test`
Expected: PASS, including `parseQuestionRows.test.js`.

- [ ] **Step 2: Run the full backend suite**

Run: `cd backend && PYTHONPATH=src pytest tests/ -v`
Expected: PASS, including `test_question_pools_bulk.py`.

- [ ] **Step 3: Lint the frontend**

Run: `cd frontend && npm run lint`
Expected: no new errors.

- [ ] **Step 4: Manual smoke test (dev servers)**

Start backend (`cd backend && source .venv/bin/activate && uvicorn src.app.main:app --reload --port 8000`) and frontend (`cd frontend && npm run dev`), log in as an admin, go to **Question Pools**, and verify:
- "Import Questions" button shows next to "+ New Pool".
- Clicking it opens the modal; "Download template" downloads `question-import-template.xlsx`.
- Re-uploading that template shows "7 valid, 0 invalid" in the preview.
- Importing into a **new** pool creates the pool and the count badge shows 7 questions; importing into an **existing** pool adds to it.
- A row with a bad type / missing text is shown as invalid and is excluded from the import.

- [ ] **Step 5: Final commit (if any tweaks were needed)**

```bash
git add -A
git commit -m "chore: bulk question import verification fixes"
```

---

## Self-Review notes

- **Spec coverage:** button + modal (Tasks 6–7), CSV/Excel via xlsx (Tasks 1,6), new-or-existing target (Task 6), all 7 types + validation (Task 2), preview (Task 6), template (Tasks 2,6), atomic backend endpoint (Task 3), tests (Tasks 2,3,8), i18n (Task 5). All spec sections map to a task.
- **`correct_answer` consistency risk** (from the spec) is handled in `mapRecordToQuestion`, which emits the documented per-type encodings.
- **Type/name consistency:** helper exports (`rowsToRecords`, `mapRecordToQuestion`, `mapRecords`, `templateMatrix`), service method (`bulkCreatePoolQuestions`), payload key (`question_type`, matching the existing single-add call in `QuestionPoolDetail.jsx`), and backend schema names (`BulkQuestionsCreate`/`BulkQuestionsResult`) are used identically across all tasks.
