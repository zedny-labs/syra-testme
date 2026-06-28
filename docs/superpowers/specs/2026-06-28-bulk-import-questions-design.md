# Bulk-Import Questions into a Question Pool — Design

**Date:** 2026-06-28
**Status:** Approved (design phase)
**Area:** Admin → Question Pools

## Summary

Add an **"Import Questions"** button next to the existing **"+ New Pool"** button on the
Question Pools page (`/admin/question-pools`). It opens a modal that lets an admin/instructor
upload a CSV or Excel (`.xlsx`/`.xls`) file of questions and add them — in bulk, in a single
transaction — to either a newly created pool or an existing pool.

This replaces the current one-at-a-time question entry flow for cases where the author already
has many questions prepared in a spreadsheet.

## Goals

- One new button beside "+ New Pool" that opens a bulk-import modal.
- Upload `.csv`, `.xlsx`, or `.xls`; parse client-side; preview rows before committing.
- Target either a **new pool** (name + description) or an **existing pool** (dropdown).
- Support all 7 question types: `MCQ`, `MULTI`, `TRUEFALSE`, `TEXT`, `ORDERING`,
  `FILLINBLANK`, `MATCHING`.
- Validate each row, show a per-row valid/invalid preview, and import only valid rows in one
  atomic backend request.
- Provide a downloadable template.

## Non-Goals (YAGNI)

- No editing of questions inside the import modal (use the pool detail page for that).
- No bulk-create of multiple **pools** at once (the user confirmed this is about bulk
  *questions*, not bulk *pools*).
- No image/attachment columns.
- No background/async processing — import is synchronous (expected volumes are modest:
  tens-to-hundreds of rows).

## User-facing flow

1. On the Question Pools page, click **Import Questions** (secondary button next to
   "+ New Pool").
2. Modal opens with:
   - **Target** radio: *New pool* | *Existing pool*.
     - *New pool* → `name` (required) + `description` (optional) inputs (reuse existing
       create-pool call).
     - *Existing pool* → `<select>` populated from the already-loaded `pools` state.
   - **File** input: `<input type="file" accept=".csv,.xlsx,.xls">`.
   - **Download template** link → generates a sample file in the browser.
3. On file select → parse → render a **preview table** (capped, e.g. first 50 rows shown) with a
   per-row ✓/✗ status and a reason for any ✗. A summary line reads `X valid, Y invalid`.
4. **Import** button is enabled only when a target is chosen and ≥1 valid row exists. It sends
   only the valid rows.
5. Result banner: `Imported N questions into <pool name>`. If rows were skipped, the count and
   reasons are listed. Modal closes (or stays open showing the result), and the pools list
   refreshes so the new question counts appear.

## File format

- A **header row is required**. Column matching is case-insensitive on the header name.
- Multiple values within one logical cell are written **one value per line inside that cell**
  (CSV: the cell must be quoted; the existing CSV parser already handles quoted multi-line
  cells. XLSX: a multi-line cell via Alt+Enter).

| column | required | meaning |
|---|---|---|
| `text` | yes | Question text. |
| `type` | yes | One of `MCQ`, `MULTI`, `TRUEFALSE`, `TEXT`, `ORDERING`, `FILLINBLANK`, `MATCHING` (case-insensitive; common aliases like `TRUE_FALSE`, `SHORT_ANSWER`, `FILL_IN_BLANK`, `MULTIPLE_CHOICE` are normalized, matching the app's existing `normalizeType` logic). |
| `options` | depends on type (see below) | Newline-separated values inside the cell. |
| `correct_answer` | depends on type (see below) | See per-type rules. |
| `points` | no | Number > 0; defaults to `1` when blank/invalid. |

### Per-type rules (aligned to the app's documented hints in `en.json`)

| type | `options` | `correct_answer` | resulting payload |
|---|---|---|---|
| `MCQ` | ≥2 choices, one per line | the exact text of the correct option | `options=[...]`, `correct_answer="<text>"` |
| `MULTI` | ≥2 choices, one per line | comma-separated list of correct option texts | `options=[...]`, `correct_answer="a,b"` |
| `TRUEFALSE` | optional; defaults to `True`/`False` | `True` or `False` (case-insensitive) | `options=["True","False"]`, `correct_answer="True"` |
| `TEXT` | ignored | optional model/expected answer | `options=null`, `correct_answer="<text or null>"` |
| `ORDERING` | items in correct order, one per line (≥2) | blank — auto-derived from option order | `options=[...]`, `correct_answer=null` |
| `FILLINBLANK` | acceptable answers, one per line (≥1) | blank | `options=[...]`, `correct_answer=null` |
| `MATCHING` | `Left \| Right` pairs, one per line (≥1) | `A-1,B-2`-style index mapping | `options=["Left \| Right", ...]`, `correct_answer="A-1,B-2"` |

The importer produces exactly the `{ text, type, options, correct_answer, points }` payload that
the existing single-question create flow produces — bulk import is semantically "repeat the
single add N times, in one transaction."

### Validation rules (per row)

- `text` present and non-blank → else invalid.
- `type` resolves to a known type → else invalid.
- `points` parses to a number > 0, else defaults to `1` (not an error).
- Type-specific minimums:
  - `MCQ`/`MULTI`: ≥2 options **and** a non-empty `correct_answer`; for `MCQ` the answer must
    match one of the options; for `MULTI` every listed answer must match an option.
  - `TRUEFALSE`: `correct_answer` ∈ {True, False}.
  - `ORDERING`: ≥2 options.
  - `FILLINBLANK`: ≥1 option.
  - `MATCHING`: ≥1 pair, each line containing a single `|`.
  - `TEXT`: no options required.
- Invalid rows are excluded from the import and reported in the preview/result.

## Architecture & components

### Frontend

- **`AdminQuestionPools.jsx`** — add the "Import Questions" button in the header and render the
  new modal; on success call the existing `load()` to refresh.
- **New modal component** `BulkImportQuestionsModal.jsx` (+ `.module.scss`) under the
  `AdminQuestionPools/` folder — owns target selection, file input, preview table, import
  action, and result display. Kept separate so `AdminQuestionPools.jsx` stays focused.
- **New pure helper** `frontend/src/utils/parseQuestionRows.js` — `parseFile(file) → rows` (via
  SheetJS) and `mapRowToQuestion(row) → { payload | error }`, plus `buildTemplate()`. Pure and
  unit-tested; no React, no network.
- **`admin.service.js`** — add `bulkCreatePoolQuestions(poolId, questions)` →
  `POST question-pools/${poolId}/questions/bulk`.
- **Dependency**: add `xlsx` (SheetJS) to `frontend/package.json`. Used to read both `.xlsx` and
  `.csv` uniformly (and to generate the template).

### Backend

- **`backend/src/app/api/routes/question_pools.py`** — add:

  ```
  POST /question-pools/{pool_id}/questions/bulk
  body:  { "questions": [ QuestionBase, ... ] }   # max length capped (e.g. 1000)
  resp:  { "created": <int> }
  ```

  Behavior mirrors `create_pool_question`: resolve pool, ownership check
  (`pool.created_by_id == current.id` else 403; 404 if missing), `_ensure_pool_library_exam`,
  compute starting `order` once, loop building `Question` rows with
  `sanitize_question_payload`, single `db.commit()`. Empty list → 400. Same permission gate:
  `require_permission("Manage Question Pools", ADMIN, INSTRUCTOR)`.

- Re-validation happens automatically through the `QuestionBase` Pydantic schema on each list
  item; the frontend pre-validates for UX but the backend is the source of truth.

## Data flow

1. User picks file → SheetJS parses to row objects → `mapRowToQuestion` validates/maps each →
   preview rendered.
2. User clicks Import:
   - If *New pool*: `adminApi.createQuestionPool({name, description})` → get `pool.id`.
   - `adminApi.bulkCreatePoolQuestions(poolId, validPayloads)`.
3. On success: show result, refresh pools list.

## Error handling

- **Parse failure** (corrupt/empty/no header) → modal error banner; no rows shown.
- **No valid rows** → Import disabled; explain why.
- **New-pool name conflict (409)** → surface the existing `pool_name_exists` message; questions
  not sent.
- **Bulk request failure** → error banner; because the backend commits atomically, a failure
  means nothing was inserted (pool may already exist if it was newly created in step 2a — the
  user can retry against the now-existing pool via *Existing pool*). This edge case is noted to
  the user in the error text.
- **Partial validity** → only valid rows are sent; skipped rows are reported by row number.

## Testing

- **Backend (pytest)** — new tests for the bulk endpoint:
  - happy path inserts N questions and returns `created=N`;
  - 403 when the pool belongs to another user;
  - 404 for unknown pool;
  - 400 for empty list;
  - questions are retrievable via the existing list endpoint afterward.
- **Frontend (vitest)** — unit tests for `parseQuestionRows.js`:
  - correct mapping for each of the 7 types;
  - invalid rows flagged with reasons (missing text, unknown type, MCQ answer not in options,
    too few options, bad TRUEFALSE answer, malformed MATCHING pair);
  - `points` defaulting;
  - header case-insensitivity and type aliases.

## i18n

New translation keys for the button, modal labels, validation messages, and result text are
added to `frontend/src/locales/en.json`. Other locales fall back to English (consistent with how
missing keys are handled today); translations can be backfilled later.

## Risks / notes

- The existing app is **inconsistent** about `correct_answer` for some complex types (e.g. one
  editor defaults a TRUEFALSE answer to `'A'`). The importer aligns to the **documented `en.json`
  hints** so imported questions behave like correctly authored ones. Anything that cannot be made
  consistent will be called out during implementation rather than silently guessed.
- Adding the `xlsx` dependency increases the frontend bundle. Accepted by the user in favor of
  native `.xlsx` support.
