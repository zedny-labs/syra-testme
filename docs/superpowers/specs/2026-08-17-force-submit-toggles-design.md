# Per-Feature Force-Submit Toggles — Design

**Date:** 2026-08-17
**Status:** Approved (design), pending implementation plan
**Author:** brainstorming session

## Summary

Add a "force submit on violation" checkbox beside every proctoring feature that has
a real-time violation signal (11 of the exam's proctoring toggles: 4 requirement
cards + 7 AI detector cards). Checking it means: if that specific feature is
violated during the exam, the attempt is automatically submitted. Unchecking it
means: the violation is still logged and the learner is still warned, but the exam
keeps running.

The feature reuses the existing `alert_rules` engine end-to-end — no new backend
columns or schema changes. The checkbox is a friendly front-end over rules that
already round-trip through the same evaluation path used by the (currently hidden)
advanced "alert rules" builder. The one behavior change is retiring tab-switching's
separate, always-on, client-side force-submit check, folding it into the same
engine so all 11 features work identically — new exams opt in like every other
feature, and a one-time data migration backfills existing exams so their behavior
doesn't silently change.

## Motivation

The user wants direct, per-feature control over whether a violation ends the exam
or just gets logged — without having to learn or use the separate alert-rule
builder. Today:

- By default, **zero** alert rules exist on a new exam, so nothing auto-submits
  except tab-switching, which has its own hardcoded, always-on mechanism completely
  outside the alert-rules system.
- The alert-rule builder *can* express "auto-submit on this event type," but it's a
  multi-field form (event type dropdown, threshold, severity, action) an admin has
  to discover and use manually, once per event type they care about.

## Current architecture (as-is)

**The `alert_rules` engine** (already built, already wired, currently underused):

- `ExamProctoringConfig.alert_rules` → `ExamProctoringAlertRule` rows (`backend/src/app/models/__init__.py:726`):
  `id/rule_key, event_type, threshold, severity, action ('WARN'|'AUTO_SUBMIT'|'FLAG_REVIEW')`.
- Transport: the frontend reads/writes `proctoring_config.alert_rules` as plain
  dicts `{id, event_type, threshold, severity, action, message}`
  (`frontend/src/utils/proctoringRequirements.js: normalizeAlertRule`). `id` is the
  stable identifier used for dedup (`rule.get("id")` → `rule_id` in
  `_apply_alert_rules`) and is what persists as `ExamProctoringAlertRule.rule_key`.
- Evaluation: `_apply_alert_rules()` (`backend/src/app/modules/proctoring/routes_public.py:1471`)
  runs on **every** violation-producing path — the `/ping` endpoint (FOCUS_LOSS,
  FULLSCREEN_EXIT, CAMERA_COVERED) and every WebSocket detector/client-event handler
  (frame analysis, audio analysis, screen analysis, generic browser events). For a
  matching, not-yet-triggered rule where the event count reaches `threshold`, it logs
  an `ALERT_RULE_TRIGGERED` event and, if `action == "AUTO_SUBMIT"`, calls
  `_auto_submit_attempt(...)` and returns `forced_submit: true`.
- Delivery to the frontend: the ping response's `forced_submit` field is already
  consumed by `applyPingResponse` → `handleForcedSubmit` (`Proctoring.jsx:1160`);
  the WebSocket `{"type": "forced_submit"}` message is already consumed by
  `ProctorOverlay.jsx:681`. **Both channels are fully wired today** — they just have
  no rules to evaluate by default.
- The admin-facing builder for this exists at `AdminNewTestWizard.jsx` (case 2,
  "Alert rules" section, ~line 2277) with `ALERT_RULE_EVENT_OPTIONS`/`ALERT_RULE_ACTIONS`,
  but it's a separate, manual, per-rule form — not associated with the feature
  toggles themselves.

**The tab-switch exception:**

- `Proctoring.jsx:1379-1389` — a `useEffect` on `tabBlurs`/`max_tab_blurs` that,
  once the client-side blur counter reaches `max_tab_blurs`, calls
  `runSubmissionFlow({ forceSubmit: true })` **directly**, bypassing `alert_rules`
  and the server entirely. This is the only feature with automatic force-submit
  behavior by default (since `alert_rules` starts empty), and it works completely
  differently from every other feature.
- `max_tab_blurs` is a plain admin-configured integer (wizard slider, 1–10,
  `enabledBy: 'tab_switch_detect'`) that today serves only this hardcoded check.

**Feature toggle rendering** (both fully generic, array-driven — `AdminNewTestWizard.jsx`):

- `PROCTORING_REQUIREMENTS` (line 101) → rendered as clickable cards at line 2259
  (`requirementCard`, whole-card `onClick` toggles `proctoring[item.key]`).
- `DETECTORS` (line 45) → rendered as clickable cards at line 2395 (`detectorCard`,
  same whole-card-click pattern via `toggleDetector`).

## Design

### 1. Feature → event mapping

Only features with a real, currently-emitted violation event type get a toggle.
`mic_required`, `lighting_required`, `identity_required`, and `screen_capture` are
one-time entry-gate checks with no ongoing violation signal, so they're excluded.

| Feature key | Card type | Event type(s) |
|---|---|---|
| `fullscreen_enforce` | requirement | `FULLSCREEN_EXIT` |
| `tab_switch_detect` | requirement | `TAB_SWITCH`, `FOCUS_LOSS` |
| `copy_paste_block` | requirement | `COPY_PASTE_ATTEMPT` |
| `camera_required` | requirement | `CAMERA_COVERED` |
| `face_detection` | detector | `FACE_DISAPPEARED` |
| `multi_face` | detector | `MULTIPLE_FACES` |
| `audio_detection` | detector | `LOUD_AUDIO`, `AUDIO_ANOMALY` |
| `object_detection` | detector | `FORBIDDEN_OBJECT` |
| `eye_tracking` | detector | `EYE_MOVEMENT` |
| `head_pose_detection` | detector | `HEAD_POSE` |
| `mouth_detection` | detector | `MOUTH_MOVEMENT` |

This mapping lives as a new constant, e.g. `FORCE_SUBMIT_EVENT_MAP`, next to
`ALERT_RULE_EVENT_OPTIONS` in `AdminNewTestWizard.jsx`.

### 2. Rule management (upsert / remove, not a new field)

For a feature `key` with event list `events`, define a stable id per event:
`` `force_submit:${key}:${eventType}` ``.

- **Checked → on:** for each event in `events`, upsert (replace-if-present,
  append-if-not) an entry into `proctoring.alert_rules`:
  ```js
  {
    id: `force_submit:${key}:${eventType}`,
    event_type: eventType,
    threshold: key === 'tab_switch_detect' ? (proctoring.max_tab_blurs || 3) : 1,
    severity: 'HIGH',
    action: 'AUTO_SUBMIT',
    message: '',
  }
  ```
- **Unchecked → off:** remove every entry from `proctoring.alert_rules` whose `id`
  starts with `` `force_submit:${key}:` ``.
- **Checkbox `checked` state** is derived on every render — not separately tracked
  state — by checking whether all of that feature's mapped-event rules currently
  exist with `action === 'AUTO_SUBMIT'`. This keeps the simple checkbox and the
  existing advanced alert-rule builder as two views over one source of truth: if an
  admin manually edits or deletes a `force_submit:*` rule via the advanced builder,
  the checkbox reflects that immediately, and vice versa.
- Nothing server-side changes: these are ordinary entries in the same
  `alert_rules` array the builder already produces, persisted through the existing
  `set_exam_proctoring` / `ExamProctoringAlertRule` path untouched.

### 3. UI placement

Both `PROCTORING_REQUIREMENTS` cards (line 2259) and `DETECTORS` cards (line 2395)
gain a small checkbox inside the card, for entries present in
`FORCE_SUBMIT_EVENT_MAP` only. The checkbox:
- Stops click propagation (the card itself has an `onClick` that toggles the
  feature's own enable/disable state — the checkbox must not trigger that).
- Is disabled/grayed when the parent feature (`proctoring[key]`) is off — can't
  force-submit on a violation of a detector that isn't running.
- Label: reuses this app's existing "force-submit" terminology (already used in
  `admin_monitor_attempt_force_submitted`, `settings_attempt_force_submitted`,
  `admin_monitor_confirm_force_submit`).

A single small render helper (used by both card types) avoids duplicating the
stop-propagation + disabled-state logic twice.

### 4. Retiring the tab-switch hardcoded path

`Proctoring.jsx:1379-1389` currently does:
```js
useEffect(() => {
  const max = proctorCfg.max_tab_blurs
  if (max && tabBlurs >= max) {
    setToast({ severity: 'HIGH', event_type: 'TAB_SWITCH', detail: t('proctor_too_many_tabs') })
    lastToastBlursRef.current = tabBlurs
    void runSubmissionFlow({ forceSubmit: true })          // ← remove this call
  } else if (...) { ... }
}, [...])
```
The `void runSubmissionFlow({ forceSubmit: true })` call is removed. The toast
branch stays — the learner still sees "too many tabs" warnings at the same
threshold. The actual submit now happens exactly like every other feature: the
client already posts `TAB_SWITCH` (`sendBrowserViolation` → WebSocket) and
`FOCUS_LOSS` (`/ping`) events on every blur; once a `force_submit:tab_switch_detect:*`
rule exists (checkbox on) and the server-side count reaches `threshold`
(`max_tab_blurs`), `_apply_alert_rules` sets `forced_submit: true` and the existing
`applyPingResponse` / WebSocket `forced_submit` handling takes it from there. No new
plumbing needed on that side — it already fires for every other feature today.

`max_tab_blurs` keeps its existing slider (1–10, `enabledBy: 'tab_switch_detect'`)
in the wizard; it now feeds the rule's `threshold` instead of a hardcoded client
check.

### 5. Migration: backfilling existing exams

New exams default this checkbox to **off** for all 11 features, including
tab-switch — consistent with the other 10, which never had automatic behavior
before. But tab-switch is the one feature that *did* have automatic force-submit
behavior prior to this change (the hardcoded client check), so existing exams need
a one-time backfill to keep behaving the way they do today.

A data-only Alembic migration (no schema change — `exam_proctoring_alert_rules`
already has every column needed):

- For every `exam_proctoring_configs` row with `tab_switch_detect = true`:
  - Skip if a `rule_key` starting with `force_submit:tab_switch_detect:` already
    exists for that `exam_id` (idempotent — safe if re-run).
  - Otherwise insert two `exam_proctoring_alert_rules` rows, appended after any
    existing rules for that exam (`position = max(existing position) + 1`, then
    `+2`):
    - `rule_key='force_submit:tab_switch_detect:TAB_SWITCH'`, `event_type='TAB_SWITCH'`
    - `rule_key='force_submit:tab_switch_detect:FOCUS_LOSS'`, `event_type='FOCUS_LOSS'`
    - both: `threshold = max_tab_blurs or 3`, `severity='HIGH'`, `action='AUTO_SUBMIT'`, `message=''`
- `downgrade()`: delete rows whose `rule_key` starts with `force_submit:tab_switch_detect:`.

After this migration, existing exams' tab-switch checkbox renders as **checked**
(since the derived checked-state check in §2 finds the rules), exactly preserving
their current behavior. New exams created after this ships start unchecked, same
as the other 10 features.

### 6. Backend

No changes beyond the one-time migration above. `alert_rules` already persists and evaluates arbitrary event types
including `TAB_SWITCH` and `COPY_PASTE_ATTEMPT` (verified against the WebSocket
client-event allowlist at `routes_public.py:3133`) even though the wizard's
`ALERT_RULE_EVENT_OPTIONS` dropdown doesn't currently list every backend-supported
event type — that dropdown is for the advanced manual builder and is unrelated to
this feature.

### 7. Locale

Two new `en.json` keys for the checkbox label and short helper text (e.g.
`admin_wizard_force_submit_on_violation` / `_desc`). Per existing project
convention, only English is added; other locales fall back to `en.json`.

## Error handling & edge cases

- **Feature toggled off after its force-submit checkbox was on:** the requirement
  card's own `onClick` already just flips `proctoring[key]`; the force-submit rules
  are left in `alert_rules` but become inert (the card renders them
  disabled/grayed, and since the underlying detector/requirement is off, its event
  type is never emitted). No cleanup needed — if the admin re-enables the feature
  later, the checkbox correctly shows "on" again since the rules are still there.
- **Two auto-managed rules for one feature (e.g. `audio_detection`'s `LOUD_AUDIO` +
  `AUDIO_ANOMALY`):** independent rules, either can independently trigger
  force-submit; this matches how `_apply_alert_rules` already treats multiple rules
  on different event types.
- **Admin manually adds a *second*, differently-configured rule for the same event
  type via the advanced builder:** both rules are evaluated independently by
  `_apply_alert_rules` (existing behavior for multiple rules on one event type,
  unchanged by this feature).
- **Existing exams:** covered by the §5 migration — their tab-switch checkbox
  renders checked immediately after migration, so behavior is preserved with no
  admin action required. Only *new* exams start with tab-switch force-submit off.

## Testing

- **Frontend (`_workspace_nonruntime/tests/frontend/...`):**
  - `AdminNewTestWizard`: toggling a feature's force-submit checkbox upserts/removes
    the correct `alert_rules` entries; checkbox reflects externally-edited
    `alert_rules` state; checkbox disabled when parent feature is off.
  - `Proctoring.jsx`: the hardcoded `max_tab_blurs` → `runSubmissionFlow` call is
    gone; tab-switch force-submit now only happens via a `forced_submit` response
    from ping/WS (existing `applyPingResponse`/`ProctorOverlay` tests should cover
    the delivery path already).
- **Backend:** `_apply_alert_rules` itself is unchanged, so no new tests there —
  existing coverage for `AUTO_SUBMIT` action applies directly. The new migration
  needs its own test: an exam with `tab_switch_detect=true` and no existing rules
  gets the two rules backfilled with the right `threshold`; an exam that already has
  a `force_submit:tab_switch_detect:*` rule (re-run case) is left untouched; an exam
  with `tab_switch_detect=false` gets nothing.

## Out of scope

- `mic_required`, `lighting_required`, `identity_required`, `screen_capture` — no
  ongoing violation signal exists for these today; adding one would mean building
  new detector/violation pipelines, not just a toggle.
- Reconciling the wizard's `ALERT_RULE_EVENT_OPTIONS` dropdown with the full set of
  backend-supported event types (e.g. it's missing `COPY_PASTE_ATTEMPT`,
  `TAB_SWITCH` under that exact name) — pre-existing gap in the advanced builder,
  unrelated to this feature.
- `AdminManageTestPage.jsx` — its proctoring editor doesn't expose `alert_rules` or
  `max_tab_blurs` today; out of scope here.

## Confirmed decisions

- Scope: "Requirements + AI detectors" (11 features), not just tab-switching.
- Tab-switching is **unified** into the same engine rather than kept as a separate
  bespoke toggle — one consistent mechanism for all 11 features.
- New exams: tab-switch force-submit defaults **off**, same as the other 10
  features (all opt-in, no automatic behavior by default).
- Existing exams: a one-time data migration (§5) backfills the tab-switch
  force-submit rules so their checkbox renders **on** and behavior is unchanged —
  no silent regression for exams already running with this protection.
- No new backend schema for the feature itself — the existing `alert_rules` engine
  already does everything needed; the checkbox is a UI convenience layer over it.
  The only new backend artifact is the one-time backfill migration.
