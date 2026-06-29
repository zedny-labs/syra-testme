# Question Image Upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an exam author attach one optional uploaded image to a question; the image displays above the question text when a learner takes the test.

**Architecture:** Add a nullable `image_url` column to the shared `Question` model (used by both exam questions and pool questions). A new authenticated upload endpoint stores the file via the existing Supabase/local storage and returns a stable `/api/media/questions/<file>` URL saved on the question. A public media route serves the file (unguessable random-UUID filename acts as a capability URL — see Security Note). A shared `QuestionImageUpload` React component is wired into all three authoring surfaces, and the learner exam view renders the image.

**Tech Stack:** FastAPI (sync route functions + one async upload route), SQLAlchemy 2.0, Alembic, Pydantic v2, React (Vite), axios, vitest, pytest.

**Security Note (flag to user before executing):** The media route `GET /api/media/questions/<file>` is intentionally **public/unauthenticated** so a plain `<img src>` works for both authors and learners (an `<img>` tag cannot send the JWT Authorization header). Filenames are random UUIDs, so URLs are unguessable capability URLs. This is a deliberate deviation from the spec's "served to authenticated users" line; per-attempt access-scoping remains future work. If the user wants strict auth instead, the alternative is blob-fetch via axios in both render paths (more code) — do not implement unless requested.

---

## File Structure

**Backend — modify:**
- `backend/src/app/models/__init__.py` — add `image_url` column to `Question` (line ~236).
- `backend/src/app/schemas/__init__.py` — add `image_url` to `QuestionBase` (line ~239).
- `backend/src/app/services/sanitization.py` — add `sanitize_image_reference()` + handle `image_url` in `sanitize_question_payload()`.
- `backend/src/app/services/supabase_storage.py` — add `"questions"` to `_KNOWN_OBJECT_FOLDERS` (line 12).
- `backend/src/app/api/routes/questions.py` — add `_validate_question_image()` helper + `POST /image` upload endpoint.
- `backend/src/app/api/routes/media.py` — add `QUESTIONS_DIR` + public `GET /questions/{filename}` serve route.
- `backend/src/app/api/routes/question_pools.py` — persist `image_url` in create/update pool question (lines ~352, ~432).

**Backend — create:**
- `backend/alembic/versions/202606291200_add_question_image_url.py` — migration.
- `backend/tests/test_question_image.py` — tests.

**Frontend — create:**
- `frontend/src/components/QuestionImageUpload/QuestionImageUpload.jsx` — shared upload control.
- `frontend/src/components/QuestionImageUpload/QuestionImageUpload.module.scss` — styles.

**Frontend — modify:**
- `frontend/src/services/admin.service.js` — add `uploadQuestionImage()` (after line 64).
- `frontend/src/locales/en.json` + `frontend/src/locales/ar.json` — new i18n keys.
- `frontend/src/pages/Admin/AdminManageTestPage/AdminManageTestPage.jsx` — form state + control.
- `frontend/src/pages/Admin/ExamQuestionPanel/ExamQuestionPanel.jsx` — form state + control (wizard).
- `frontend/src/pages/Admin/QuestionPoolDetail/QuestionPoolDetail.jsx` — form state + control.
- `frontend/src/pages/Proctoring/Proctoring.jsx` — render image above question text (line ~2026).

---

## Phase 1 — Backend data model & storage folder

### Task 1: Add `image_url` column to the `Question` model

**Files:**
- Modify: `backend/src/app/models/__init__.py:236`

- [ ] **Step 1: Add the column**

In `class Question(Base)`, immediately after the `order` line (line 233) add `image_url`:

```python
    order: Mapped[int] = mapped_column(Integer, default=0)
    image_url: Mapped[str | None] = mapped_column(String(1024))
    pool_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("question_pools.id", ondelete="SET NULL"))
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/app/models/__init__.py
git commit -m "feat(questions): add image_url column to Question model"
```

### Task 2: Alembic migration for `image_url`

**Files:**
- Create: `backend/alembic/versions/202606291200_add_question_image_url.py`

- [ ] **Step 1: Write the migration**

Current head revision is `202603301030`. Create the file with exactly:

```python
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
```

- [ ] **Step 2: Apply and verify the migration**

Run (from `backend/`, venv active):
```bash
alembic upgrade head
```
Expected: completes with no error; `alembic current` shows `202606291200`.

- [ ] **Step 3: Verify downgrade works, then re-upgrade**

```bash
alembic downgrade -1 && alembic upgrade head
```
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add backend/alembic/versions/202606291200_add_question_image_url.py
git commit -m "feat(questions): migration adding image_url column"
```

### Task 3: Register the `questions` storage folder

**Files:**
- Modify: `backend/src/app/services/supabase_storage.py:12`

- [ ] **Step 1: Add the folder to the allow-list**

Change line 12 from:
```python
_KNOWN_OBJECT_FOLDERS = {"identity", "evidence", "reports", "videos"}
```
to:
```python
_KNOWN_OBJECT_FOLDERS = {"identity", "evidence", "reports", "videos", "questions"}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/app/services/supabase_storage.py
git commit -m "feat(storage): allow questions folder for Supabase object storage"
```

---

## Phase 2 — Backend schema, sanitization & upload endpoint

### Task 4: Add `image_url` to the question schema (TDD)

**Files:**
- Modify: `backend/src/app/schemas/__init__.py:239`
- Test: `backend/tests/test_question_image.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_question_image.py`:

```python
from __future__ import annotations

from app.schemas import QuestionBase


def test_question_base_accepts_image_url():
    q = QuestionBase(
        text="What is shown?",
        question_type="MCQ",
        options=["Cat", "Dog"],
        correct_answer="A",
        image_url="/api/media/questions/q_abc123.png",
    )
    assert q.image_url == "/api/media/questions/q_abc123.png"


def test_question_base_image_url_defaults_to_none():
    q = QuestionBase(
        text="No image here",
        question_type="MCQ",
        options=["Cat", "Dog"],
        correct_answer="A",
    )
    assert q.image_url is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PYTHONPATH=src pytest tests/test_question_image.py -v`
Expected: FAIL — `QuestionBase` has no `image_url` (TypeError / unexpected keyword) or attribute missing.

- [ ] **Step 3: Add the field**

In `backend/src/app/schemas/__init__.py`, in `class QuestionBase`, after the `pool_id` line (line 239) add:

```python
    pool_id: Optional[UUID] = None
    image_url: Optional[str] = Field(default=None, max_length=1024)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PYTHONPATH=src pytest tests/test_question_image.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/src/app/schemas/__init__.py backend/tests/test_question_image.py
git commit -m "feat(questions): add image_url to question schema"
```

### Task 5: Sanitize/validate `image_url` (TDD)

**Files:**
- Modify: `backend/src/app/services/sanitization.py`
- Test: `backend/tests/test_question_image.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_question_image.py`:

```python
from app.services.sanitization import sanitize_question_payload


def test_sanitize_keeps_valid_image_url():
    out = sanitize_question_payload({"text": "Q", "image_url": "/api/media/questions/q_abc123.png"})
    assert out["image_url"] == "/api/media/questions/q_abc123.png"


def test_sanitize_drops_foreign_image_url():
    out = sanitize_question_payload({"text": "Q", "image_url": "https://evil.example.com/x.png"})
    assert out["image_url"] is None


def test_sanitize_drops_blank_image_url():
    out = sanitize_question_payload({"text": "Q", "image_url": "  "})
    assert out["image_url"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PYTHONPATH=src pytest tests/test_question_image.py -v`
Expected: FAIL — `sanitize_question_payload` passes `image_url` through unchanged, so `test_sanitize_drops_foreign_image_url` fails.

- [ ] **Step 3: Implement the validator**

In `backend/src/app/services/sanitization.py`, add a module-level regex import + helper near the top (after the `ALLOWED_HTML_TAGS` line):

```python
import re

QUESTION_IMAGE_URL_RE = re.compile(r"^/api/media/questions/[A-Za-z0-9._-]+$")


def sanitize_image_reference(value: str | None) -> str | None:
    """Only accept image references our own upload endpoint produced."""
    if value is None:
        return None
    candidate = str(value).strip()
    if QUESTION_IMAGE_URL_RE.match(candidate):
        return candidate
    return None
```

Then, inside `sanitize_question_payload`, add `image_url` handling (after the `correct_answer` block):

```python
    if "correct_answer" in cleaned:
        cleaned["correct_answer"] = sanitize_html_fragment(cleaned.get("correct_answer"))
    if "image_url" in cleaned:
        cleaned["image_url"] = sanitize_image_reference(cleaned.get("image_url"))
    return cleaned
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PYTHONPATH=src pytest tests/test_question_image.py -v`
Expected: PASS (all 5 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/src/app/services/sanitization.py backend/tests/test_question_image.py
git commit -m "feat(questions): validate image_url reference in sanitizer"
```

### Task 6: Image-validation helper (TDD)

**Files:**
- Modify: `backend/src/app/api/routes/questions.py`
- Test: `backend/tests/test_question_image.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_question_image.py`:

```python
import pytest
from fastapi import HTTPException

from app.api.routes.questions import _validate_question_image, QUESTION_IMAGE_MAX_BYTES


def test_validate_image_accepts_png():
    # should not raise
    _validate_question_image("image/png", 1024)


def test_validate_image_rejects_pdf():
    with pytest.raises(HTTPException) as exc:
        _validate_question_image("application/pdf", 1024)
    assert exc.value.status_code == 400


def test_validate_image_rejects_oversized():
    with pytest.raises(HTTPException) as exc:
        _validate_question_image("image/png", QUESTION_IMAGE_MAX_BYTES + 1)
    assert exc.value.status_code == 413
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PYTHONPATH=src pytest tests/test_question_image.py -v`
Expected: FAIL — `_validate_question_image` / `QUESTION_IMAGE_MAX_BYTES` do not exist (ImportError).

- [ ] **Step 3: Implement the helper**

In `backend/src/app/api/routes/questions.py`, update imports and add the helper + constants near the top (after the existing imports). Add `File, UploadFile` to the fastapi import and `Path`, `uuid4`:

```python
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, File, UploadFile
```

Then add (module level, below imports / `router = APIRouter()`):

```python
QUESTION_IMAGE_MAX_BYTES = 5 * 1024 * 1024  # 5 MB
QUESTION_IMAGE_CONTENT_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
QUESTIONS_STORAGE_DIR = Path(__file__).resolve().parent.parent.parent.parent.parent / "storage" / "questions"


def _validate_question_image(content_type: str | None, size: int) -> None:
    if content_type not in QUESTION_IMAGE_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail=_t("question_image_bad_type"))
    if size > QUESTION_IMAGE_MAX_BYTES:
        raise HTTPException(status_code=413, detail=_t("question_image_too_large"))
```

Note: `_t` is already imported in this file as `from ...core.i18n import translate as _t`. Add the two i18n keys in Task 11.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && PYTHONPATH=src pytest tests/test_question_image.py -v`
Expected: PASS (all passed). (Translation keys not yet present will fall back to the key string — fine for the test, which only checks status codes.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/app/api/routes/questions.py backend/tests/test_question_image.py
git commit -m "feat(questions): image upload validation helper"
```

### Task 7: Upload endpoint `POST /api/questions/image`

**Files:**
- Modify: `backend/src/app/api/routes/questions.py`

- [ ] **Step 1: Add imports for storage**

At the top of `questions.py`, add the settings + supabase upload imports alongside the existing imports:

```python
from ...core.config import get_settings
from ...services.supabase_storage import upload_bytes as upload_bytes_to_supabase
```

And once, near the other module-level constants:

```python
settings = get_settings()
```

(If `settings`/`get_settings` already exist in the file, reuse them — do not redefine.)

- [ ] **Step 2: Add the endpoint**

Add this route to `questions.py` (place it above the existing `create_question` route so the static `/image` path is matched before any `/{question_id}` style routes):

```python
@router.post("/image")
async def upload_question_image(
    file: UploadFile = File(...),
    current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    content = await file.read()
    _validate_question_image(file.content_type, len(content))
    if not content:
        raise HTTPException(status_code=400, detail=_t("question_image_empty"))

    ext = QUESTION_IMAGE_CONTENT_TYPES[file.content_type]
    filename = f"q_{uuid.uuid4().hex}{ext}"

    if settings.MEDIA_STORAGE_PROVIDER == "supabase":
        await upload_bytes_to_supabase("questions", filename, content, content_type=file.content_type)
    else:
        QUESTIONS_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        (QUESTIONS_STORAGE_DIR / filename).write_bytes(content)

    return {"image_url": f"/api/media/questions/{filename}"}
```

- [ ] **Step 3: Smoke-check imports compile**

Run: `cd backend && PYTHONPATH=src python -c "import app.api.routes.questions"`
Expected: no output, exit 0 (no ImportError/SyntaxError).

- [ ] **Step 4: Commit**

```bash
git add backend/src/app/api/routes/questions.py
git commit -m "feat(questions): add question image upload endpoint"
```

### Task 8: Public media serve route for question images

**Files:**
- Modify: `backend/src/app/api/routes/media.py`

- [ ] **Step 1: Add the storage dir constant**

In `media.py`, after the existing dir constants (line 24), add:

```python
IDENTITY_DIR = BASE_STORAGE_DIR / "identity"
QUESTIONS_DIR = BASE_STORAGE_DIR / "questions"
```

- [ ] **Step 2: Add the public serve route**

Add this route (anywhere among the route defs). It is intentionally unauthenticated — see the Security Note at the top of this plan:

```python
@router.get("/questions/{filename}")
async def get_question_image(filename: str):
    """Serve a question image. Public: filenames are unguessable random UUIDs."""
    cleaned = _sanitize_filename(filename)
    if settings.MEDIA_STORAGE_PROVIDER == "supabase":
        return await _redirect_supabase_media("questions", cleaned)
    file_path = QUESTIONS_DIR / cleaned
    if not file_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_t("media_not_found"))
    return FileResponse(path=file_path, filename=cleaned)
```

- [ ] **Step 3: Smoke-check imports compile**

Run: `cd backend && PYTHONPATH=src python -c "import app.api.routes.media"`
Expected: exit 0, no error.

- [ ] **Step 4: Commit**

```bash
git add backend/src/app/api/routes/media.py
git commit -m "feat(media): serve question images"
```

---

## Phase 3 — Backend route persistence (exam + pool questions)

> Exam-question routes (`questions.py` `create_question`/`update_question`) already build the model via `Question(**sanitize_question_payload(body.model_dump()))` and a `setattr` loop, so they pick up `image_url` automatically — no change needed there. Pool questions are built field-by-field and need explicit wiring.

### Task 9: Persist `image_url` in pool question routes (TDD)

**Files:**
- Modify: `backend/src/app/api/routes/question_pools.py:352,432`
- Test: `backend/tests/test_question_image.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_question_image.py` (mirrors the in-memory-sqlite pattern from `tests/test_question_pools_bulk.py`):

```python
import uuid as _uuid
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as SASession

from app.db.base import Base
from app.models import QuestionPool, RoleEnum, User
from app.schemas import QuestionBase as QB
from app.api.routes.question_pools import create_pool_question, list_pool_questions


def _session():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    return SASession(engine, expire_on_commit=False)


def _admin(db):
    u = User(user_id=f"u-{_uuid.uuid4().hex[:8]}", email=f"{_uuid.uuid4().hex[:8]}@e.com",
             name="A", hashed_password="x", role=RoleEnum.ADMIN, is_active=True)
    db.add(u); db.flush(); return u


def test_pool_question_persists_image_url():
    db = _session()
    try:
        admin = _admin(db)
        pool = QuestionPool(name="P", created_by_id=admin.id)
        db.add(pool); db.flush()
        body = QB(text="See image", question_type="MCQ", options=["A", "B"],
                  correct_answer="A", image_url="/api/media/questions/q_xyz.png")
        created = create_pool_question(pool_id=str(pool.id), body=body, db=db, current=admin)
        assert created.image_url == "/api/media/questions/q_xyz.png"
        stored = list_pool_questions(pool_id=str(pool.id), db=db, current=admin)
        assert stored[0].image_url == "/api/media/questions/q_xyz.png"
    finally:
        db.close()
```

> If `QuestionPool(...)` requires more constructor args in this codebase, copy the exact `_create_pool` helper from `backend/tests/test_question_pools_bulk.py` instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && PYTHONPATH=src pytest tests/test_question_image.py::test_pool_question_persists_image_url -v`
Expected: FAIL — `created.image_url` is `None` (route doesn't set it).

- [ ] **Step 3: Wire `image_url` into create_pool_question**

In `question_pools.py` `create_pool_question`, add `image_url` to the `Question(...)` constructor (after the `order=` line):

```python
        order=next_order + 1,
        image_url=payload.get("image_url"),
        pool_id=pool_pk,
```

- [ ] **Step 4: Wire `image_url` into update_pool_question**

In `update_pool_question`, after `question.points = payload["points"]` add:

```python
        question.points = payload["points"]
        question.image_url = payload.get("image_url")
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && PYTHONPATH=src pytest tests/test_question_image.py -v`
Expected: PASS (all passed).

- [ ] **Step 6: Run the whole backend question suite for regressions**

Run: `cd backend && PYTHONPATH=src pytest tests/test_question_pools_bulk.py tests/test_question_image.py -v`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/app/api/routes/question_pools.py backend/tests/test_question_image.py
git commit -m "feat(question-pools): persist image_url on pool questions"
```

---

## Phase 4 — Frontend shared component, service, i18n

### Task 10: `uploadQuestionImage` service method

**Files:**
- Modify: `frontend/src/services/admin.service.js:64`

- [ ] **Step 1: Add the method**

After the `deleteQuestion` line (line 64), add:

```javascript
  deleteQuestion: (id) => api.delete(`questions/${id}`),
  uploadQuestionImage: (file) => {
    const data = new FormData()
    data.append('file', file)
    return api.post('questions/image', data, { headers: { 'Content-Type': 'multipart/form-data' } })
  },
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/services/admin.service.js
git commit -m "feat(admin-api): uploadQuestionImage method"
```

### Task 11: i18n keys (en + ar)

**Files:**
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/ar.json`

- [ ] **Step 1: Add English keys**

In `frontend/src/locales/en.json`, add (near the other `admin_questions_*` keys; keep valid JSON — mind trailing commas):

```json
"admin_questions_image_label": "Question image (optional)",
"admin_questions_image_add": "Add image",
"admin_questions_image_remove": "Remove image",
"admin_questions_image_uploading": "Uploading…",
"admin_questions_image_alt": "Question image",
"admin_questions_image_bad_type": "Please choose a PNG, JPG, or WebP image.",
"admin_questions_image_too_large": "Image must be 5 MB or smaller.",
"admin_questions_image_upload_failed": "Image upload failed. Please try again.",
```

- [ ] **Step 2: Add Arabic keys**

In `frontend/src/locales/ar.json`, add the matching keys:

```json
"admin_questions_image_label": "صورة السؤال (اختياري)",
"admin_questions_image_add": "إضافة صورة",
"admin_questions_image_remove": "إزالة الصورة",
"admin_questions_image_uploading": "جارٍ الرفع…",
"admin_questions_image_alt": "صورة السؤال",
"admin_questions_image_bad_type": "يرجى اختيار صورة بصيغة PNG أو JPG أو WebP.",
"admin_questions_image_too_large": "يجب ألا يتجاوز حجم الصورة 5 ميجابايت.",
"admin_questions_image_upload_failed": "فشل رفع الصورة. يرجى المحاولة مرة أخرى.",
```

- [ ] **Step 3: Add the backend i18n keys**

Backend messages are flat `key: "string"` JSON maps in `backend/src/app/messages/<lang>.json` (10 languages; `core/i18n.py` falls back to English for missing keys). Add these three keys to `backend/src/app/messages/en.json` and `backend/src/app/messages/ar.json` (near the existing `media_not_found` entry, ~line 130):

`en.json`:
```json
  "question_image_bad_type": "Unsupported image type. Use PNG, JPG, or WebP.",
  "question_image_too_large": "Image must be 5 MB or smaller.",
  "question_image_empty": "The uploaded image is empty.",
```

`ar.json`:
```json
  "question_image_bad_type": "نوع الصورة غير مدعوم. استخدم PNG أو JPG أو WebP.",
  "question_image_too_large": "يجب ألا يتجاوز حجم الصورة 5 ميجابايت.",
  "question_image_empty": "الصورة المرفوعة فارغة.",
```

(English fallback covers the other 8 languages; translating them is optional.)

- [ ] **Step 4: Validate JSON**

Run: `cd frontend && node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json','utf8')); JSON.parse(require('fs').readFileSync('src/locales/ar.json','utf8')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/locales/en.json frontend/src/locales/ar.json backend/src/app/messages/en.json backend/src/app/messages/ar.json
git commit -m "i18n: question image upload strings"
```

### Task 12: `QuestionImageUpload` shared component

**Files:**
- Create: `frontend/src/components/QuestionImageUpload/QuestionImageUpload.jsx`
- Create: `frontend/src/components/QuestionImageUpload/QuestionImageUpload.module.scss`

- [ ] **Step 1: Write the component**

Create `frontend/src/components/QuestionImageUpload/QuestionImageUpload.jsx`:

```jsx
import React, { useRef, useState } from 'react'
import { adminApi } from '../../services/admin.service'
import styles from './QuestionImageUpload.module.scss'

const ACCEPT = 'image/png,image/jpeg,image/webp'
const ALLOWED = ['image/png', 'image/jpeg', 'image/webp']
const MAX_BYTES = 5 * 1024 * 1024

export default function QuestionImageUpload({ value, onChange, disabled = false, t }) {
  const inputRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const pick = () => {
    if (disabled || uploading) return
    inputRef.current?.click()
  }

  const handleFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = '' // allow re-selecting the same file
    if (!file) return
    setError('')
    if (!ALLOWED.includes(file.type)) {
      setError(t('admin_questions_image_bad_type'))
      return
    }
    if (file.size > MAX_BYTES) {
      setError(t('admin_questions_image_too_large'))
      return
    }
    setUploading(true)
    try {
      const { data } = await adminApi.uploadQuestionImage(file)
      onChange(data.image_url)
    } catch {
      setError(t('admin_questions_image_upload_failed'))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <span className={styles.label}>{t('admin_questions_image_label')}</span>
      {value ? (
        <div className={styles.preview}>
          <img className={styles.thumb} src={value} alt={t('admin_questions_image_alt')} />
          <button type="button" className={styles.removeBtn} onClick={() => onChange(null)} disabled={disabled || uploading}>
            {t('admin_questions_image_remove')}
          </button>
        </div>
      ) : (
        <button type="button" className={styles.addBtn} onClick={pick} disabled={disabled || uploading}>
          {uploading ? t('admin_questions_image_uploading') : t('admin_questions_image_add')}
        </button>
      )}
      <input ref={inputRef} type="file" accept={ACCEPT} className={styles.hiddenInput} onChange={handleFile} />
      {error && <div className={styles.error}>{error}</div>}
    </div>
  )
}
```

- [ ] **Step 2: Write the styles**

Create `frontend/src/components/QuestionImageUpload/QuestionImageUpload.module.scss`:

```scss
.wrap { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
.label { font-size: 0.85rem; font-weight: 600; opacity: 0.85; }
.hiddenInput { display: none; }
.addBtn, .removeBtn {
  align-self: flex-start;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid currentColor;
  background: transparent;
  cursor: pointer;
}
.addBtn[disabled], .removeBtn[disabled] { opacity: 0.5; cursor: default; }
.preview { display: flex; align-items: flex-start; gap: 10px; }
.thumb { max-width: 160px; max-height: 120px; border-radius: 8px; object-fit: contain; border: 1px solid rgba(0,0,0,0.1); }
.error { color: #c0392b; font-size: 0.82rem; }
```

- [ ] **Step 3: Verify lint passes**

Run: `cd frontend && npx eslint src/components/QuestionImageUpload/QuestionImageUpload.jsx`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/QuestionImageUpload/
git commit -m "feat(questions): shared QuestionImageUpload component"
```

---

## Phase 5 — Wire the control into the three authoring surfaces

### Task 13: AdminManageTestPage (manage existing exam)

**Files:**
- Modify: `frontend/src/pages/Admin/AdminManageTestPage/AdminManageTestPage.jsx` (lines 331, 1922, 1942, 3982)

- [ ] **Step 1: Import the component**

Near the other component imports (e.g. after the `QuestionsTab` import at line 24):

```javascript
import QuestionImageUpload from '../../../components/QuestionImageUpload/QuestionImageUpload'
```

- [ ] **Step 2: Add `image_url` to form state**

`emptyQuestionForm()` (line 331) → add `image_url`:

```javascript
const emptyQuestionForm = () => ({
  text: '',
  question_type: 'MCQ',
  answer: emptyAnswerState('MCQ'),
  points: '1',
  order: '0',
  image_url: null,
})
```

`startEditQuestion` (line 1922) → add `image_url: q.image_url ?? null` to the `setQuestionForm({...})` object.

- [ ] **Step 3: Add `image_url` to the submit payload**

In `handleQuestionSubmit` (line 1942), add to the `payload` object:

```javascript
      const payload = {
        text: questionForm.text.trim(),
        question_type: qType,
        options,
        correct_answer,
        points: Number(questionForm.points || 1),
        order: Number(questionForm.order || 0),
        image_url: questionForm.image_url || null,
      }
```

- [ ] **Step 4: Render the control after the question-text textarea**

Right after line 3982 (the `admin_manage_question_text_label` textarea `<label>…</label>`), insert:

```jsx
              <QuestionImageUpload
                value={questionForm.image_url}
                onChange={(url) => setQuestionForm((p) => ({ ...p, image_url: url }))}
                disabled={lockedExamFields}
                t={t}
              />
```

- [ ] **Step 5: Verify lint + build**

Run: `cd frontend && npx eslint src/pages/Admin/AdminManageTestPage/AdminManageTestPage.jsx`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Admin/AdminManageTestPage/AdminManageTestPage.jsx
git commit -m "feat(manage-test): attach image to questions"
```

### Task 14: ExamQuestionPanel (new-test wizard)

**Files:**
- Modify: `frontend/src/pages/Admin/ExamQuestionPanel/ExamQuestionPanel.jsx` (lines 4, 20, 97, 125, 299)

- [ ] **Step 1: Import the component**

After line 4 (`import QuestionTypeFields ...`):

```javascript
import QuestionImageUpload from '../../../components/QuestionImageUpload/QuestionImageUpload'
```

- [ ] **Step 2: Add `image_url` to the draft factory**

`createEmptyQuestion` (line 19-21):

```javascript
function createEmptyQuestion(type) {
  return { text: '', question_type: type, answer: emptyAnswerState(type), points: 1, image_url: null }
}
```

- [ ] **Step 3: Carry `image_url` into edit mode**

`openEdit` (line 97) → add `image_url: question.image_url ?? null` to the `setForm({...})` object.

- [ ] **Step 4: Add `image_url` to the save payload**

`handleSave` payload (line 125) → add `image_url: form.image_url || null,` to the `payload` object.

- [ ] **Step 5: Render the control after the question-text input**

After the question-text `formGroup` (closes at line 299), insert:

```jsx
          <div className={styles.formGroup}>
            <QuestionImageUpload
              value={form.image_url}
              onChange={(url) => setForm((current) => ({ ...current, image_url: url }))}
              disabled={saving}
              t={t}
            />
          </div>
```

- [ ] **Step 6: Verify lint**

Run: `cd frontend && npx eslint src/pages/Admin/ExamQuestionPanel/ExamQuestionPanel.jsx`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Admin/ExamQuestionPanel/ExamQuestionPanel.jsx
git commit -m "feat(wizard): attach image to questions"
```

### Task 15: QuestionPoolDetail (question bank)

**Files:**
- Modify: `frontend/src/pages/Admin/QuestionPoolDetail/QuestionPoolDetail.jsx` (lines 5, 27, 115, 141, 259)

- [ ] **Step 1: Import the component**

After line 5 (`import QuestionTypeFields ...`):

```javascript
import QuestionImageUpload from '../../../components/QuestionImageUpload/QuestionImageUpload'
```

- [ ] **Step 2: Add `image_url` to `blankQuestion`**

`blankQuestion` (line 27):

```javascript
const blankQuestion = (questionType = 'MCQ') => ({
  text: '',
  question_type: questionType,
  answer: emptyAnswerState(questionType),
  image_url: null,
})
```

- [ ] **Step 3: Add `image_url` to the submit payload**

In `handleSubmit` payload (line 115):

```javascript
      const payload = {
        text: form.text,
        question_type: form.question_type,
        correct_answer,
        options,
        image_url: form.image_url || null,
      }
```

- [ ] **Step 4: Carry `image_url` into edit mode**

`startEdit` (line 141) → add `image_url: question.image_url ?? null` to the `setForm({...})` object.

- [ ] **Step 5: Render the control after the question-text textarea**

After the question-text `<textarea id="pool-question-text" …/>` (line 259), insert:

```jsx
            <QuestionImageUpload
              value={form.image_url}
              onChange={(url) => setForm((current) => ({ ...current, image_url: url }))}
              disabled={saving}
              t={t}
            />
```

- [ ] **Step 6: Verify lint**

Run: `cd frontend && npx eslint src/pages/Admin/QuestionPoolDetail/QuestionPoolDetail.jsx`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Admin/QuestionPoolDetail/QuestionPoolDetail.jsx
git commit -m "feat(question-pool): attach image to questions"
```

---

## Phase 6 — Render the image during the exam

### Task 16: Show the image in the learner exam view

**Files:**
- Modify: `frontend/src/pages/Proctoring/Proctoring.jsx:2026`
- Modify: `frontend/src/pages/Proctoring/Proctoring.module.scss`

> `normalizeQuestion` spreads all fields, so `currentQ.image_url` is already available. No fetch change needed.

- [ ] **Step 1: Render the image above the question text**

In `Proctoring.jsx`, the block at line ~2025-2026 is:

```jsx
    <div className={styles.qLabel}>{t('question')} {currentIdx + 1} {t('of')} {questions.length}</div>
    <div className={styles.qText}>{currentQ.text}</div>
```

Insert the image between the label and the text:

```jsx
    <div className={styles.qLabel}>{t('question')} {currentIdx + 1} {t('of')} {questions.length}</div>
    {currentQ.image_url && (
      <img className={styles.qImage} src={currentQ.image_url} alt={t('admin_questions_image_alt')} />
    )}
    <div className={styles.qText}>{currentQ.text}</div>
```

- [ ] **Step 2: Add the style**

Append to `frontend/src/pages/Proctoring/Proctoring.module.scss`:

```scss
.qImage {
  display: block;
  max-width: 100%;
  max-height: 320px;
  margin: 0 0 14px;
  border-radius: 10px;
  object-fit: contain;
}
```

- [ ] **Step 3: Verify lint**

Run: `cd frontend && npx eslint src/pages/Proctoring/Proctoring.jsx`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Proctoring/Proctoring.jsx frontend/src/pages/Proctoring/Proctoring.module.scss
git commit -m "feat(exam): render question image to learners"
```

---

## Phase 7 — Full verification

### Task 17: End-to-end verification

- [ ] **Step 1: Backend tests + lint**

Run: `cd backend && PYTHONPATH=src pytest tests/test_question_image.py tests/test_question_pools_bulk.py -v && flake8 src/app/api/routes/questions.py src/app/api/routes/media.py src/app/services/sanitization.py`
Expected: all tests PASS; flake8 clean.

- [ ] **Step 2: Frontend build + lint**

Run: `cd frontend && npm run lint && npm run build`
Expected: lint clean; build succeeds.

- [ ] **Step 3: Manual smoke test (local stack)**

Start backend (`uvicorn src.app.main:app --reload --port 8000`) and frontend (`npm run dev`), then:
1. Log in as admin/instructor. Open a DRAFT exam → Questions → add/edit a question → **Add image** → pick a PNG → confirm thumbnail preview → save.
2. Reload the page, edit the same question → confirm the image still shows (persisted).
3. Confirm `GET /api/media/questions/<file>` returns the image in the browser.
4. Take the exam as a learner → confirm the image renders above the question text.
5. Edit the question → **Remove image** → save → confirm it no longer renders for the learner.
6. Try uploading a 6 MB file and a `.pdf` → confirm friendly inline errors, no save.

- [ ] **Step 4: Final review**

Confirm every commit is present and the working tree is clean: `git status` and `git log --oneline -20`.

---

## Notes for the implementer

- **Do not** change the shared `get_current_user` auth dependency for the media route — keep the question-image GET public per the Security Note.
- The exam-question create/update routes need **no** change for persistence (they use `**model_dump()` / `setattr`); only pool routes build the model field-by-field.
- `_t` translation keys that are missing at runtime fall back to the key string — add the backend keys (Task 11 Step 3) so messages read well.
- The legacy `QuestionsTab.jsx` (under `AdminManageTestPage/tabs/`) is **not** the active editor (its `options_text` state is unused by the parent). Do not wire the image control there.
- **Frontend automated tests are intentionally omitted.** This repo's vitest harness is known-broken (~168 pre-existing failures from a broken provider harness; tests live under `_workspace_nonruntime/tests/`). The spec's frontend test items (component select/preview/remove, render-only-when-set) are instead covered by `npm run build` + `npm run lint` + the manual smoke test in Task 17 Step 3. Backend keeps full TDD coverage (working pytest harness).
