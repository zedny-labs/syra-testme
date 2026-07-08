# Exam Sections from Question Pools — Design

**Date:** 2026-07-08
**Status:** Approved (design), pending implementation plan
**Author:** brainstorming session

## Summary

Turn question pools into first-class **sections** of an exam. When an admin adds a
question pool to an exam, it becomes a section containing a hand-picked subset of
that pool's questions. During an attempt the learner sees a **section hub**: a menu
of sections they enter one at a time, answering questions inside a section with the
existing one-question-at-a-time flow, then returning to the hub where the section is
marked **Finished**. Two per-exam admin options control whether sections must be
taken **in sequence** and whether a finished section can be **revisited**.

## Motivation

Today there is no section concept. Questions are a flat list attached to an exam via
`Question.exam_id` + an integer `Question.order`, and "adding a pool to an exam"
copies a *random* sample of the pool's questions into the exam
(`seed_exam_from_pool`). The "Sections" tab in the admin UI is a mislabeled
questions tab. Instructors want to group an exam into named sections sourced from
pools, control the order/lock behavior, and give learners a clearer, sectioned
experience.

## Current architecture (as-is)

- **Question model** (`backend/src/app/models/__init__.py`): `id, exam_id (FK,
  CASCADE), text, type (7 types), options (JSON), correct_answer, points, order,
  image_url, pool_id (FK, SET NULL, nullable), timestamps`. Index
  `ix_question_exam_order (exam_id, order)`.
- **Exam model**: has `settings` (JSON), `library_pool_id`, plus one-to-one config
  relations (`ExamRuntimeConfig`, `ExamAdminConfig`, etc.). No section/group concept.
- **QuestionPool model**: `id, name, description, created_by_id, timestamps`;
  `questions` relationship. Pools also keep questions in a hidden "library exam"
  (legacy) — see `_load_pool_questions()`.
- **Seeding** (`backend/src/app/api/routes/question_pools.py`,
  `seed_exam_from_pool`, ~lines 469–515): validates ownership + unpublished exam,
  loads pool questions, filters already-seeded by text, **randomly samples up to
  `count`**, creates new `Question` rows in the exam with `pool_id` set to track
  origin.
- **Other question construction sites** (must stay consistent — see
  [[question-model-construction-sites]]): single add
  (`POST /question_pools/{pool_id}/questions`), bulk add
  (`.../questions/bulk`), question update, and `seed_exam_from_pool`.
- **Learner taking UI** (`frontend/src/pages/Proctoring/Proctoring.jsx`): fetches
  `getTestQuestions(exam_id)` → flat array, navigates by `currentIdx`
  (one-question-at-a-time), progress = answered / total. No grouping.
- **Admin authoring**: `AdminNewTestWizard` (step 3 questions, seeds via
  `seedExamFromPool`), `AdminManageTestPage` (tab labeled "sections" = questions
  tab, `QuestionsTab`), `QuestionPoolDetail` (pool question CRUD).

## Design

### 1. Data model (Approach A — dedicated table)

**New table `exam_sections`:**

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `exam_id` | UUID FK → `exams.id` | `ON DELETE CASCADE` |
| `title` | str(255) | Defaults to the source pool's name; editable |
| `description` | str(1024) | Nullable |
| `order` | int | Section order in the hub; unique per exam |
| `source_pool_id` | UUID FK → `question_pools.id` | `ON DELETE SET NULL`, nullable; `NULL` for the "General" section |
| `created_at` / `updated_at` | datetime | |

**`Question` gains `section_id`** (UUID FK → `exam_sections.id`, `ON DELETE
CASCADE`). Every question belongs to exactly one section. The existing `pool_id`
stays as origin tracking of an individual question. Question `order` becomes an
ordering **within its section**.

**Exam-level settings** (stored alongside existing exam settings, e.g.
`Exam.settings` JSON / `ExamRuntimeConfig`):
- `sequential_sections: bool` (default `false`) — sections must be completed
  top-to-bottom; later sections locked until the prior one is finished.
- `allow_revisit_sections: bool` (default `true`) — a finished section can be
  re-entered and edited until the whole exam is submitted; when `false`, a finished
  section is read-only.

**Attempt section progress:** a per-attempt store of section completion status so
the hub survives page refresh and lock rules are enforced server-side. Recorded as
a `finished` status per `section_id` for the attempt. (Exact storage — JSON column
on `Attempt` vs. a small `attempt_section_progress` table — is decided in the
implementation plan; behavior is the same either way.)

### 2. Admin authoring

- The "Sections" tab becomes a real section manager (replacing the mislabeled
  questions tab behavior).
- **Add a section from a pool:** choose a pool → **hand-pick** which of its
  questions to include → creates an `exam_sections` row (title pre-filled with the
  pool name, editable) and copies the selected questions into the exam as `Question`
  rows with that `section_id` (and `pool_id` retained for origin). The same pool may
  be added more than once as separate sections.
- **Manual questions** are placed in an auto-created **"General"** section
  (`source_pool_id = NULL`), created lazily on first manual question.
- **Reorder sections** via drag, reusing the reorder helper already used for
  questions.
- **Reorder questions within a section.**
- New settings-step toggles: **Sequential sections** and **Allow revisiting
  finished sections**.
- All 7 question types (MCQ, MULTI, TRUEFALSE, TEXT, ORDERING, FILLINBLANK,
  MATCHING) remain consistent across `QuestionPoolDetail`, `AdminNewTestWizard`, and
  `AdminManageTestPage` (per CLAUDE.md).

### 3. Learner taking flow

- Entering an attempt shows the **section hub**: a list of the exam's sections, each
  with a status badge — *Not started / In progress / Finished / Locked*.
- Selecting a section opens the existing one-question-at-a-time flow, with a header
  showing **"Section X: Title — Question i of n"**.
- On the section's last question, **Next** marks the section **Finished**
  (server call) and returns the learner to the hub.
- **Sequential on:** locked sections are disabled in the hub until the prior section
  is finished. **Sequential off:** any not-finished section can be entered in any
  order.
- **Revisit on:** finished sections are re-enterable and editable until final submit.
  **Revisit off:** finished sections are read-only.
- **Submit exam** is available from the hub. The proctoring WebSocket session and the
  overall exam timer continue unchanged across hub navigation.

### 4. Backend / API

- **Section CRUD + reorder** endpoints (create/update/delete/reorder), scoped by
  exam ownership like existing routes.
- **Add picked questions to a section:** replaces the random-N `seed_exam_from_pool`
  with an explicit "copy these pool question IDs into this section" operation.
- **Learner payload** returns the exam's sections plus questions grouped by section
  plus the attempt's section progress.
- **Mark-section-finished** endpoint updates attempt progress.
- **Server-side enforcement:** the backend enforces sequential unlocking and
  read-only-after-finish (e.g., rejects answers submitted to a locked or read-only
  section) — the client is never trusted for these rules.

### 5. Migration & construction-site updates

- **Alembic migration:** create `exam_sections`; add `Question.section_id`; add the
  attempt section-progress storage; add the two exam flags.
- **Backfill:** for every existing exam, create one **"General"** section
  (`source_pool_id = NULL`, `order = 0`) and set `section_id` on all of that exam's
  existing questions to it. This keeps every legacy exam valid under
  "everything is a section."
- **Update every question construction site** so `section_id` is always set — single
  add, bulk add, update, and especially **`seed_exam_from_pool`** (the easy-to-miss
  one, per [[question-model-construction-sites]]). The seed path changes from random
  sampling to explicit hand-picked IDs targeting a section.

### 6. Error handling & edge cases

- Adding a section is blocked on published/OPEN exams, matching the existing
  seed guard.
- Deleting a pool leaves existing sections intact (`source_pool_id` → `NULL`);
  the section and its already-copied questions remain.
- Deleting a section cascades to its questions (`ON DELETE CASCADE`).
- An exam with zero configured sections still presents a valid hub (empty state);
  the "General" section appears only when manual questions exist.
- A learner mid-attempt when settings change keeps their existing progress; lock
  rules are evaluated from current settings + recorded progress.

### 7. Testing

- **Backend:** section CRUD + ownership scoping; hand-pick copy sets `section_id`
  and retains `pool_id`; migration backfill creates a General section and assigns
  questions; server rejects answers to locked (sequential) and read-only
  (revisit-off) sections; mark-finished updates progress; `seed`/bulk/single/update
  construction sites all set `section_id`.
- **Frontend:** hub renders sections with correct status badges; sequential locking
  disables the right sections; revisit on/off gates re-entry; section header shows
  correct "Section X — Question i of n"; Next on last question returns to hub and
  marks finished; submit from hub.

## Out of scope (v1)

- Per-section time limits (overall exam timer only).
- Per-section scoring, pass thresholds, and per-section report breakdowns.
- Random draw within a section (admin hand-picks for v1).

These are natural future extensions and are noted here so the data model
(`exam_sections` as a real entity) leaves room for them.

## Confirmed decisions

- Section content: **admin hand-picks** specific pool questions (not whole-pool, not
  random-N).
- Learner navigation: **section hub** → enter section → one-at-a-time with header →
  **Next** finishes section → back to hub with **Finished** status.
- **Everything is a section**; manual questions go into an auto-created **General**
  section.
- **Sequential sections** and **Allow revisiting** are **per-exam admin options** set
  at exam creation.
- Storage: **Approach A** — dedicated `exam_sections` table + `Question.section_id`.
- Section **title defaults to the pool name** and is editable.
