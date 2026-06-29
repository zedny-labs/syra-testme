# Design: Image-per-question for SYRA exams

**Date:** 2026-06-29
**Status:** Approved (pending spec review)

## Problem

Exam authors cannot attach an image to a question. Questions are plain text only:

- `Question.text` is the only content field — no image field (`backend/src/app/models/__init__.py:218`).
- The question editor is a plain `<textarea>` with no upload control (`frontend/src/pages/Admin/AdminManageTestPage/tabs/QuestionsTab.jsx`).
- Pasting an `<img>` tag does not work — the backend sanitizer strips it (only `b, i, u, p, br, ul, ol, li, strong, em` are allowed) (`backend/src/app/services/sanitization.py:6`).
- The learner-facing exam UI renders question text as raw text, so there is no place an image would appear (`frontend/src/pages/Proctoring/Proctoring.jsx:2017`).

Authors need to attach images (diagrams, charts, photos) that learners see while taking the test.

## Goal

Let an exam author attach **one optional image** to a question by **uploading a file**. The image displays **above the question text** when a learner takes the test. Questions without an image behave exactly as today.

## Scope decisions (confirmed with user)

- **One image per question**, shown above the question text. Not embedded inside the text, not on individual answer options.
- **Upload only** — pick a file from the computer. No paste-a-URL.
- **Bulk Excel import stays text-only.** Images are added by editing each question individually. Bulk-import image support is explicitly out of scope for this iteration.
- File constraints: **PNG / JPG / WebP**, max **5 MB**.

## Design

### 1. Data model

Add one nullable field to the `Question` model:

- `image_url: str | None` — stored reference (path or signed URL) to the uploaded image.

The image is a **dedicated field, separate from `text`** — this deliberately sidesteps the HTML sanitizer (no need to allow `<img>` in text, no XSS surface from embedded markup). `Question.text` and its sanitizer are unchanged.

- New Alembic migration adds the `image_url` column (nullable, default NULL).
- Pydantic schemas: `QuestionBase` gets optional `image_url`; `QuestionRead` returns it; create/update accept it.
- `sanitize_question_payload` does **not** run `image_url` through the HTML fragment sanitizer. It is validated as a URL/path reference instead (the value only ever comes from our own upload endpoint, so we store the value our endpoint returned).

### 2. Upload endpoint (reuse existing storage)

New endpoint: `POST /api/admin/questions/image` (exact path to confirm against existing admin route conventions during planning).

- Accepts a single uploaded image file (multipart).
- Validates content type ∈ {image/png, image/jpeg, image/webp} and size ≤ 5 MB; rejects with a friendly 4xx otherwise.
- Stores via the **existing** `supabase_storage.upload_bytes()` service, adding a new `questions` folder alongside the current `identity / evidence / reports / videos`. Local-storage fallback writes to `/storage/questions/`.
- Returns `{ "image_url": "<stored reference>" }`.
- Authorization: restricted to admins/instructors with the existing question-edit permission (same gate used for creating/editing questions).

Serving: question images are served via the existing `/media/...` pattern (`backend/src/app/api/routes/media.py`) so a learner can load the image during the exam. A `questions` media route is added mirroring the existing folder routes. (Question images are exam content, not sensitive identity data — served to authenticated users; access-scoping beyond authentication is out of scope for v1 and noted as a follow-up.)

### 3. Authoring UI

A shared `QuestionImageUpload` component:

- "Add image" button → file picker → uploads via the new endpoint → shows a thumbnail preview.
- "Remove" button clears the image (and lets the author replace it).
- Friendly inline error on wrong type / too large / upload failure.
- The parent form tracks `image_url` in its question state and saves it with the question like any other field.

Placed consistently in all three question-authoring surfaces (per the CLAUDE.md rule that question features stay consistent across these):

- `AdminNewTestWizard`
- `AdminManageTestPage → QuestionsTab`
- `QuestionPoolDetail`

### 4. Rendering during the exam

In the learner-facing question display (`Proctoring.jsx`, at the `{currentQ.text}` render site):

- When `currentQ.image_url` is present, render `<img>` above the text — responsive, max-width-constrained, with `alt` text and graceful handling if the image fails to load.
- Apply the same rendering anywhere a question is previewed/reviewed by an instructor.

## Edge cases

- Question with no image → unchanged behavior (image field NULL, nothing rendered).
- Replacing an image → upload a new one; the form's `image_url` is overwritten on save.
- Wrong file type / oversized file → rejected with a clear message; question is not saved with a bad reference.
- Image fails to load at exam time → `alt` text shown, layout does not break.
- Orphaned uploads (image uploaded but question never saved) → acceptable for v1; cleanup is a noted follow-up, not in scope.

## Testing

**Backend**
- Upload endpoint: valid image succeeds and returns a URL; oversized rejected; wrong content-type rejected; unauthorized rejected.
- Migration applies cleanly (and downgrades).
- Schema round-trips `image_url` on create → read.

**Frontend**
- `QuestionImageUpload`: selecting a file shows a preview; "Remove" clears it.
- Exam render: image appears above the text only when `image_url` is set; nothing rendered when null.

## Out of scope (future work)

- Images embedded inline within question text.
- Images on individual answer options.
- Image support in bulk Excel import.
- Per-attempt access-scoping of question images.
- Orphaned-upload cleanup / garbage collection.
