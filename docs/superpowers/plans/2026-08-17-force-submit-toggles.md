# Per-Feature Force-Submit Toggles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "force submit on violation" checkbox beside each of the 11 proctoring
features that has a real-time violation signal (4 requirement cards + 7 AI detector
cards) in the exam creation wizard, and retire tab-switching's separate hardcoded
force-submit path so all 11 features work through the same mechanism.

**Architecture:** No new backend schema. The checkbox is a thin UI layer that
upserts/removes entries in the exam's existing `proctoring.alert_rules` array
(`action: 'AUTO_SUBMIT'`), which the backend's `_apply_alert_rules()` engine already
evaluates on every ping and WebSocket detector event. Tab-switching's bespoke
always-on client-side force-submit check is deleted so it goes through that same
engine; a one-time data migration backfills existing exams so their behavior doesn't
silently change.

**Tech Stack:** React (frontend wizard + exam-taking page), FastAPI/SQLAlchemy
(backend, unchanged except one data migration), Alembic, Vitest + Testing Library
(frontend tests).

**Spec:** `docs/superpowers/specs/2026-08-17-force-submit-toggles-design.md`

---

## File Structure

- Modify `frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.jsx` —
  add `FORCE_SUBMIT_EVENT_MAP`, `forceSubmitRuleId()`, `isForceSubmitEnabled()`
  (module-level, pure), `toggleForceSubmit()`, `renderForceSubmitToggle()`
  (component-level, closes over state), and wire the checkbox into the existing
  `PROCTORING_REQUIREMENTS` and `DETECTORS` card renders.
- Modify `frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.module.scss`
  — one new wrapper class, `.forceSubmitCardWrap`.
- Modify `frontend/src/locales/en.json` — two new keys.
- Modify `frontend/src/pages/Proctoring/Proctoring.jsx` — delete the hardcoded
  `runSubmissionFlow({ forceSubmit: true })` call in the tab-blur-limit effect.
- Create `backend/alembic/versions/202608171200_backfill_tab_switch_force_submit.py`
  — one-time data migration, no schema change.
- Test: `_workspace_nonruntime/tests/frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.test.jsx`
- Test: `_workspace_nonruntime/tests/frontend/src/pages/Proctoring/Proctoring.test.jsx`

No backend Python source changes and no new backend tests — `_apply_alert_rules()`
in `backend/src/app/modules/proctoring/routes_public.py` is untouched; it already
evaluates arbitrary `event_type`/`action` combinations. This repo has no existing
tests for Alembic migrations (checked: none of the ~20 files under
`backend/alembic/versions/` have a matching test), so Task 5's migration is verified
manually against a real Postgres database, matching that established (lack of)
pattern rather than inventing a new one.

**Pre-existing failure, not a regression:** running
`cd frontend && npm run test -- src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.test.jsx`
against the code as of this plan already shows 1 failing / 7 passing (the
`'blocks seeding from an empty pool...'` test fails on an unrelated `getByDisplayValue`
lookup). This is the broken test-provider-harness issue already on file — none of
this plan's tasks touch that code path. Confirm the failure count doesn't *grow*
after each task, not that it hits zero.

---

### Task 1: Locale strings for the force-submit checkbox

**Files:**
- Modify: `frontend/src/locales/en.json:1137` (insert after `admin_wizard_ctrl_max_tab_desc`)

- [ ] **Step 1: Add the two new keys**

In `frontend/src/locales/en.json`, immediately after line 1137
(`"admin_wizard_ctrl_max_tab_desc": "Lower is stricter. The attempt can auto-submit after fewer focus losses.",`), insert:

```json
  "admin_wizard_force_submit_on_violation": "Force-submit on violation",
  "admin_wizard_force_submit_on_violation_desc": "Automatically submit the exam the first time this is violated, instead of only logging a warning.",
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/locales/en.json
git commit -m "$(cat <<'EOF'
Add locale strings for the force-submit-on-violation checkbox

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Force-submit mapping, helpers, and requirement-card wiring

**Files:**
- Modify: `frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.jsx`
- Modify: `frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.module.scss`
- Test: `_workspace_nonruntime/tests/frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.test.jsx`

- [ ] **Step 1: Write the failing test**

In `_workspace_nonruntime/tests/frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.test.jsx`, change the import line (line 2) to also pull in `within`:

```js
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
```

Then add this test inside the `describe('AdminNewTestWizard', ...)` block, after the `'makes the proctoring phase explicit...'` test (after line 274, i.e. right after its closing `})`):

```js
  it('toggles a force-submit alert rule beside a requirement card and disables it when the requirement is off', async () => {
    renderWizard()

    fireEvent.change(await screen.findByLabelText(/Test Name/i), {
      target: { value: 'Core Cycle Test' },
    })

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByText('Test Creation Method')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Proctoring & Test Settings' })).toBeTruthy())

    expect(screen.getByText('Escalation rules: 0')).toBeTruthy()

    const forceSubmitCheckbox = screen.getByTestId('force-submit-fullscreen_enforce')
    expect(forceSubmitCheckbox.checked).toBe(false)
    expect(forceSubmitCheckbox.disabled).toBe(false)

    fireEvent.click(forceSubmitCheckbox)
    expect(screen.getByText('Escalation rules: 1')).toBeTruthy()
    expect(forceSubmitCheckbox.checked).toBe(true)

    fireEvent.click(forceSubmitCheckbox)
    expect(screen.getByText('Escalation rules: 0')).toBeTruthy()
    expect(forceSubmitCheckbox.checked).toBe(false)

    fireEvent.click(forceSubmitCheckbox)
    expect(screen.getByText('Escalation rules: 1')).toBeTruthy()

    const fullscreenCard = screen.getByText('Fullscreen lock').closest('button')
    fireEvent.click(fullscreenCard)
    expect(forceSubmitCheckbox.disabled).toBe(true)
  })

  it('adds one alert rule per underlying event when force-submit covers more than one event type', async () => {
    renderWizard()

    fireEvent.change(await screen.findByLabelText(/Test Name/i), {
      target: { value: 'Core Cycle Test' },
    })

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByText('Test Creation Method')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Proctoring & Test Settings' })).toBeTruthy())

    fireEvent.click(screen.getByTestId('force-submit-tab_switch_detect'))
    expect(screen.getByText('Escalation rules: 2')).toBeTruthy()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

`frontend/package.json`'s `test` script (`node scripts/run-vitest.mjs`) copies
`frontend/src` and `_workspace_nonruntime/tests/frontend/src` into a merged
`frontend/.generated-tests/unit/src`, then runs Vitest there — so tests are edited
under `_workspace_nonruntime/tests/frontend/src/...` (as above) but **run** from
`frontend/`:

Run: `cd frontend && npm run test -- src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.test.jsx`

Expected: both new tests FAIL with `Unable to find an element by: [data-testid="force-submit-fullscreen_enforce"]` (or similar) — the checkbox doesn't exist yet.

- [ ] **Step 3: Add `FORCE_SUBMIT_EVENT_MAP` and the pure helper functions**

In `frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.jsx`, after the
`describeAlertRule` function (ends at line 264, just before the blank line at 265),
insert:

```js

const FORCE_SUBMIT_EVENT_MAP = {
  fullscreen_enforce: ['FULLSCREEN_EXIT'],
  tab_switch_detect: ['TAB_SWITCH', 'FOCUS_LOSS'],
  copy_paste_block: ['COPY_PASTE_ATTEMPT'],
  camera_required: ['CAMERA_COVERED'],
  face_detection: ['FACE_DISAPPEARED'],
  multi_face: ['MULTIPLE_FACES'],
  audio_detection: ['LOUD_AUDIO', 'AUDIO_ANOMALY'],
  object_detection: ['FORBIDDEN_OBJECT'],
  eye_tracking: ['EYE_MOVEMENT'],
  head_pose_detection: ['HEAD_POSE'],
  mouth_detection: ['MOUTH_MOVEMENT'],
}

function forceSubmitRuleId(featureKey, eventType) {
  return `force_submit:${featureKey}:${eventType}`
}

function isForceSubmitEnabled(proctoring, featureKey) {
  const events = FORCE_SUBMIT_EVENT_MAP[featureKey]
  if (!events) return false
  const rules = proctoring.alert_rules || []
  return events.every((eventType) => {
    const rule = rules.find((r) => r.id === forceSubmitRuleId(featureKey, eventType))
    return Boolean(rule && rule.action === 'AUTO_SUBMIT')
  })
}
```

- [ ] **Step 4: Add `toggleForceSubmit` and `renderForceSubmitToggle` inside the component**

In the same file, immediately after `updateProctoringFlag` (currently lines
1248-1251, right before `updateProctoringNumber`), insert:

```js
  const toggleForceSubmit = (featureKey, checked) => {
    const events = FORCE_SUBMIT_EVENT_MAP[featureKey]
    if (!events) return
    setProctoring((prev) => {
      const kept = (prev.alert_rules || []).filter(
        (rule) => !events.some((eventType) => rule.id === forceSubmitRuleId(featureKey, eventType)),
      )
      if (!checked) {
        return { ...prev, alert_rules: kept }
      }
      const threshold = featureKey === 'tab_switch_detect'
        ? Math.max(1, Number(prev.max_tab_blurs) || 3)
        : 1
      const added = events.map((eventType) => createAlertRule({
        id: forceSubmitRuleId(featureKey, eventType),
        event_type: eventType,
        threshold,
        severity: 'HIGH',
        action: 'AUTO_SUBMIT',
      }))
      return { ...prev, alert_rules: [...kept, ...added] }
    })
    if (examId) autoPersist()
  }
  const renderForceSubmitToggle = (featureKey) => {
    if (!FORCE_SUBMIT_EVENT_MAP[featureKey]) return null
    return (
      <label className={styles.checkItem}>
        <input
          type="checkbox"
          data-testid={`force-submit-${featureKey}`}
          checked={isForceSubmitEnabled(proctoring, featureKey)}
          disabled={!proctoring[featureKey]}
          onChange={(e) => toggleForceSubmit(featureKey, e.target.checked)}
        />
        <span>{t('admin_wizard_force_submit_on_violation')}</span>
      </label>
    )
  }
```

- [ ] **Step 5: Wire the checkbox into the requirement-card grid**

In the same file, replace the requirement-card render block (currently lines
2259-2274, inside `<div className={styles.requirementGrid}>`):

```jsx
              {PROCTORING_REQUIREMENTS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`${styles.requirementCard} ${proctoring[item.key] ? styles.requirementCardActive : ''}`}
                  onClick={() => updateProctoringFlag(item.key, !proctoring[item.key])}
                >
                  <div className={styles.requirementCardHead}>
                    <div className={styles.requirementCardTitle}>{t(item.labelKey)}</div>
                    <div className={`${styles.toggleTrack} ${proctoring[item.key] ? styles.toggleTrackOn : ''}`}>
                      <div className={styles.toggleThumb} />
                    </div>
                  </div>
                  <div className={styles.requirementCardDesc}>{t(item.descKey)}</div>
                </button>
              ))}
```

with:

```jsx
              {PROCTORING_REQUIREMENTS.map((item) => (
                <div key={item.key} className={styles.forceSubmitCardWrap}>
                  <button
                    type="button"
                    className={`${styles.requirementCard} ${proctoring[item.key] ? styles.requirementCardActive : ''}`}
                    onClick={() => updateProctoringFlag(item.key, !proctoring[item.key])}
                  >
                    <div className={styles.requirementCardHead}>
                      <div className={styles.requirementCardTitle}>{t(item.labelKey)}</div>
                      <div className={`${styles.toggleTrack} ${proctoring[item.key] ? styles.toggleTrackOn : ''}`}>
                        <div className={styles.toggleThumb} />
                      </div>
                    </div>
                    <div className={styles.requirementCardDesc}>{t(item.descKey)}</div>
                  </button>
                  {renderForceSubmitToggle(item.key)}
                </div>
              ))}
```

- [ ] **Step 6: Add the wrapper CSS class**

In `frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.module.scss`,
immediately after the `.requirementCardDesc` rule (ends at line 789), insert:

```scss
.forceSubmitCardWrap {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
```

(Flexbox's default `align-items: stretch` on a column container makes the
`<button>`/`<div>` card fill the wrapper's width without extra CSS, so no changes
are needed to `.requirementCard` or `.detectorCard`.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: same command as Step 2.
Expected: PASS — both new tests, and no regressions among the existing tests in
this file (they don't touch `PROCTORING_REQUIREMENTS` rendering except through text
content that's unchanged).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.jsx \
        frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.module.scss \
        _workspace_nonruntime/tests/frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.test.jsx
git commit -m "$(cat <<'EOF'
Add force-submit-on-violation checkbox to proctoring requirement cards

Checking it upserts an AUTO_SUBMIT alert_rules entry for that feature's
violation event(s); unchecking removes it. Reuses the existing
alert_rules engine end-to-end, no backend changes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire the checkbox into the AI-detector cards

**Files:**
- Modify: `frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.jsx`
- Test: `_workspace_nonruntime/tests/frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.test.jsx`

- [ ] **Step 1: Write the failing test**

Add this test after the two added in Task 2:

```js
  it('shows a force-submit checkbox on detector cards and keeps mic/lighting requirements without one', async () => {
    renderWizard()

    fireEvent.change(await screen.findByLabelText(/Test Name/i), {
      target: { value: 'Core Cycle Test' },
    })

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByText('Test Creation Method')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Proctoring & Test Settings' })).toBeTruthy())

    expect(screen.getByTestId('force-submit-face_detection')).toBeTruthy()
    expect(screen.getByTestId('force-submit-eye_tracking')).toBeTruthy()
    expect(screen.getByTestId('force-submit-head_pose_detection')).toBeTruthy()
    expect(screen.getByTestId('force-submit-mouth_detection')).toBeTruthy()
    expect(screen.getByTestId('force-submit-object_detection')).toBeTruthy()
    expect(screen.getByTestId('force-submit-multi_face')).toBeTruthy()
    expect(screen.getByTestId('force-submit-audio_detection')).toBeTruthy()

    expect(screen.queryByTestId('force-submit-mic_required')).toBeNull()
    expect(screen.queryByTestId('force-submit-lighting_required')).toBeNull()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm run test -- src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.test.jsx`
Expected: FAIL on the first detector `getByTestId` call — detector cards don't
render the checkbox yet (only requirement cards do, from Task 2).

- [ ] **Step 3: Wire the checkbox into the detector-card grid**

In `frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.jsx`, replace
the detector-card render block (currently lines 2395-2407, inside
`<div className={styles.detectorsGrid}>`):

```jsx
              {DETECTORS.map(d => (
                <div key={d.key} className={`${styles.detectorCard} ${proctoring[d.key] ? styles.detectorOn : ''}`} onClick={() => toggleDetector(d.key)}>
                  <div className={styles.detectorToggle}>
                    <div className={`${styles.toggleTrack} ${proctoring[d.key] ? styles.toggleTrackOn : ''}`}>
                      <div className={styles.toggleThumb} />
                    </div>
                  </div>
                  <div>
                    <div className={styles.detectorName}>{t(d.labelKey)}</div>
                    <div className={styles.detectorDesc}>{t(d.descKey)}</div>
                  </div>
                </div>
              ))}
```

with:

```jsx
              {DETECTORS.map(d => (
                <div key={d.key} className={styles.forceSubmitCardWrap}>
                  <div className={`${styles.detectorCard} ${proctoring[d.key] ? styles.detectorOn : ''}`} onClick={() => toggleDetector(d.key)}>
                    <div className={styles.detectorToggle}>
                      <div className={`${styles.toggleTrack} ${proctoring[d.key] ? styles.toggleTrackOn : ''}`}>
                        <div className={styles.toggleThumb} />
                      </div>
                    </div>
                    <div>
                      <div className={styles.detectorName}>{t(d.labelKey)}</div>
                      <div className={styles.detectorDesc}>{t(d.descKey)}</div>
                    </div>
                  </div>
                  {renderForceSubmitToggle(d.key)}
                </div>
              ))}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npm run test -- src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.jsx \
        _workspace_nonruntime/tests/frontend/src/pages/Admin/AdminNewTestWizard/AdminNewTestWizard.test.jsx
git commit -m "$(cat <<'EOF'
Add force-submit-on-violation checkbox to AI detector cards

Same mechanism as the requirement cards in the previous commit, now
covering all 7 detectors. mic_required/lighting_required intentionally
have no toggle — they're one-time entry checks with no ongoing
violation signal to react to.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Retire tab-switch's hardcoded force-submit path

**Files:**
- Modify: `frontend/src/pages/Proctoring/Proctoring.jsx:1379-1389`
- Test: `_workspace_nonruntime/tests/frontend/src/pages/Proctoring/Proctoring.test.jsx`

- [ ] **Step 1: Fix a stale test mock that currently crashes every test in this file**

Before writing the new test, note: as of this plan, running
`cd frontend && npm run test -- src/pages/Proctoring/Proctoring.test.jsx` fails
**all 9** existing tests (verified while writing this plan), not just the one this
task will add. The cause: `Proctoring.jsx` imports `getLearnerSections` and
`finishAttemptSection` from `../../services/test.service` (used for the exam's
section hub, unrelated to this feature) and calls `getLearnerSections` unconditionally
during bootstrap — but the test file's `vi.mock('../../services/test.service', ...)`
factory only mocks `getTest`/`getTestQuestions`, so `getLearnerSections` is
`undefined` and calling it throws before any test can render. This is a stale mock
(the component gained section support after this mock was last updated), not
something new — but it must be fixed here since it blocks writing a working test
for this task.

In `_workspace_nonruntime/tests/frontend/src/pages/Proctoring/Proctoring.test.jsx`,
change line 12-13 from:

```js
const getTestQuestionsMock = vi.fn()
const getTestMock = vi.fn()
```

to:

```js
const getTestQuestionsMock = vi.fn()
const getTestMock = vi.fn()
const getLearnerSectionsMock = vi.fn()
const finishAttemptSectionMock = vi.fn()
```

Change the `vi.mock('../../services/test.service', ...)` factory (lines 80-83) from:

```js
vi.mock('../../services/test.service', () => ({
  getTest: (...args) => getTestMock(...args),
  getTestQuestions: (...args) => getTestQuestionsMock(...args),
}))
```

to:

```js
vi.mock('../../services/test.service', () => ({
  getTest: (...args) => getTestMock(...args),
  getTestQuestions: (...args) => getTestQuestionsMock(...args),
  getLearnerSections: (...args) => getLearnerSectionsMock(...args),
  finishAttemptSection: (...args) => finishAttemptSectionMock(...args),
}))
```

And in the `beforeEach` block, change line 160 from:

```js
    getAttemptAnswersMock.mockResolvedValue({ data: [] })
  })
```

to:

```js
    getAttemptAnswersMock.mockResolvedValue({ data: [] })
    getLearnerSectionsMock.mockResolvedValue({ data: [] })
    finishAttemptSectionMock.mockResolvedValue({ data: {} })
  })
```

Run: `cd frontend && npm run test -- src/pages/Proctoring/Proctoring.test.jsx`
Expected: 6 of the 9 existing tests now PASS (up from 0/9). The remaining 3
(`'shows an explicit empty state...'`, `'submits first and uploads recordings...'`,
`'blocks result navigation...'`) fail for unrelated, pre-existing reasons — verified
while writing this plan, not caused by this change. Do not attempt to fix those here;
confirm the count is 6 passing / 3 failing, not worse.

- [ ] **Step 2: Write the failing test**

Add this test inside the `describe('Proctoring page', ...)` block in
`_workspace_nonruntime/tests/frontend/src/pages/Proctoring/Proctoring.test.jsx`,
directly after the closing `})` of the last existing test (`'shows a 10-second
countdown before finalizing a forced submit'`), before the `describe` block's own
closing `})`:

```js

  it('does not auto-submit on the tab-switch limit unless the server says forced_submit is true', async () => {
    proctoringPingMock.mockResolvedValue({
      data: { alerts: [], forced_submit: false, submit_reason: null },
    })
    getTestMock.mockResolvedValueOnce({
      data: {
        id: 'exam-1',
        title: 'Physics Final',
        proctoring_config: { tab_switch_detect: true, max_tab_blurs: 1 },
      },
    })

    renderPage()
    await flushPromises()
    expect(screen.getByText('Physics Final')).toBeTruthy()

    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    fireEvent(window, new Event('blur'))
    await flushPromises()
    await flushPromises()

    expect(submitAttemptMock).not.toHaveBeenCalled()
  })
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npm run test -- src/pages/Proctoring/Proctoring.test.jsx`

Expected: the new test FAILS — `submitAttemptMock` **was** called, because the
still-present hardcoded check in `Proctoring.jsx` force-submits as soon as
`tabBlurs >= max_tab_blurs` (here `max_tab_blurs: 1`), regardless of the ping
response. The 6 tests fixed in Step 1 still pass; the same pre-existing 3 still fail.

- [ ] **Step 4: Remove the hardcoded force-submit call**

In `frontend/src/pages/Proctoring/Proctoring.jsx`, replace lines 1379-1389:

```js
  useEffect(() => {
    const max = proctorCfg.max_tab_blurs
    if (max && tabBlurs >= max) {
      setToast({ severity: 'HIGH', event_type: 'TAB_SWITCH', detail: t('proctor_too_many_tabs') })
      lastToastBlursRef.current = tabBlurs
      void runSubmissionFlow({ forceSubmit: true })
    } else if (tabBlurs > 0 && tabBlurs !== lastToastBlursRef.current && proctorCfg.tab_switch_detect) {
      lastToastBlursRef.current = tabBlurs
      setToast({ severity: 'MEDIUM', event_type: 'TAB_SWITCH', detail: t('proctor_tab_count', { count: tabBlurs }) })
    }
  }, [runSubmissionFlow, tabBlurs, proctorCfg.max_tab_blurs, proctorCfg.tab_switch_detect])
```

with:

```js
  useEffect(() => {
    const max = proctorCfg.max_tab_blurs
    if (max && tabBlurs >= max) {
      // Force-submitting on this limit now happens the same way as every other
      // proctoring feature: the server evaluates `alert_rules` on each ping/WS
      // event and reports `forced_submit`, handled by applyPingResponse /
      // ProctorOverlay's forced_submit message. This effect only owns the toast.
      setToast({ severity: 'HIGH', event_type: 'TAB_SWITCH', detail: t('proctor_too_many_tabs') })
      lastToastBlursRef.current = tabBlurs
    } else if (tabBlurs > 0 && tabBlurs !== lastToastBlursRef.current && proctorCfg.tab_switch_detect) {
      lastToastBlursRef.current = tabBlurs
      setToast({ severity: 'MEDIUM', event_type: 'TAB_SWITCH', detail: t('proctor_tab_count', { count: tabBlurs }) })
    }
  }, [tabBlurs, proctorCfg.max_tab_blurs, proctorCfg.tab_switch_detect])
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npm run test -- src/pages/Proctoring/Proctoring.test.jsx`
Expected: the new test PASSES, along with the 6 fixed in Step 1 (including the
pre-existing `'shows a 10-second countdown before finalizing a forced submit'`
test, which drives `forced_submit` through the `ProctorOverlay` mock's button, not
through this effect, so it's unaffected by the removal). The same 3 pre-existing,
unrelated failures remain — 7 passing / 3 failing overall for this file.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/Proctoring/Proctoring.jsx \
        _workspace_nonruntime/tests/frontend/src/pages/Proctoring/Proctoring.test.jsx
git commit -m "$(cat <<'EOF'
Retire tab-switch's hardcoded force-submit, use the shared alert_rules engine

The tab-blur-limit toast stays, but the direct runSubmissionFlow(forceSubmit)
call is removed. Tab-switch violations already reach the server via /ping
(FOCUS_LOSS) and the WebSocket client-event path (TAB_SWITCH); force-submit
now only happens when a matching alert_rules entry exists and the server
returns forced_submit: true, exactly like every other proctoring feature.

Also fixes a stale test mock (missing getLearnerSections/finishAttemptSection)
that was crashing every test in this file before this change.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Backfill existing exams so tab-switch force-submit stays on

**Files:**
- Create: `backend/alembic/versions/202608171200_backfill_tab_switch_force_submit.py`

- [ ] **Step 1: Write the migration**

```python
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
```

- [ ] **Step 2: Verify the migration is syntactically valid and chains correctly**

Run: `cd backend && source .venv/bin/activate 2>/dev/null || source .venv/Scripts/activate; PYTHONPATH=src alembic heads`
Expected: `202608171200 (head)` — confirms the file parses and is now the single
head, chained after `202607091000`.

- [ ] **Step 3: Verify upgrade/downgrade against a real Postgres database**

This repo has no automated migration tests (none of the existing files under
`backend/alembic/versions/` have one), so this is a manual check against a
scratch/dev database — do not skip it, since this migration's SQL can't be
exercised any other way.

Against a dev/staging Postgres with representative data (or a local Postgres
seeded via `docker compose up -d --build` per the project's Docker setup):

```bash
PYTHONPATH=src alembic upgrade head
```
Expected: no errors. Then spot-check:
```sql
SELECT exam_id, rule_key, event_type, threshold, action
FROM exam_proctoring_alert_rules
WHERE rule_key LIKE 'force_submit:tab_switch_detect:%';
```
Expected: exactly two rows per exam that has `tab_switch_detect = true` in
`exam_proctoring_configs`, one `TAB_SWITCH` and one `FOCUS_LOSS`, both
`action = 'AUTO_SUBMIT'`, `threshold` matching that exam's `max_tab_blurs` (or 3
if it was null).

Then confirm idempotency and reversibility:
```bash
PYTHONPATH=src alembic upgrade head   # re-run: should insert nothing new
PYTHONPATH=src alembic downgrade -1
```
Expected: the second `upgrade head` makes no changes (same row count as before),
and `downgrade -1` removes all rows matching the `force_submit:tab_switch_detect:%`
prefix and leaves everything else untouched.

- [ ] **Step 4: Commit**

```bash
git add backend/alembic/versions/202608171200_backfill_tab_switch_force_submit.py
git commit -m "$(cat <<'EOF'
Backfill tab-switch force-submit alert rules for existing exams

Preserves current behavior for exams that relied on the hardcoded
tab-switch auto-submit removed in the previous commit. New exams start
with this checkbox off, same as every other force-submit toggle.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (event mapping) → Task 2/3's `FORCE_SUBMIT_EVENT_MAP`. §2
  (rule upsert/remove) → Task 2's `toggleForceSubmit`. §3 (UI placement) → Task
  2/3's card wiring. §4 (retiring tab-switch hardcode) → Task 4. §5 (migration) →
  Task 5. §6 (no backend changes) → confirmed, no backend Python files touched.
  §7 (locale) → Task 1. "Out of scope" items (mic/lighting, `ALERT_RULE_EVENT_OPTIONS`
  gaps, `AdminManageTestPage.jsx`) are correctly untouched by every task above.
- **Placeholder scan:** no TBD/TODO; every step has complete, runnable code.
- **Type consistency:** `toggleForceSubmit(featureKey, checked)` (Task 2 Step 4) is
  called with exactly that signature from `renderForceSubmitToggle`'s `onChange`
  (same step) and nowhere else. `isForceSubmitEnabled(proctoring, featureKey)` is
  defined once (Task 2 Step 3) and used once (Task 2 Step 4) with matching
  argument order. `FORCE_SUBMIT_EVENT_MAP` keys match exactly the `PROCTORING_REQUIREMENTS`/`DETECTORS`
  `key` values already defined earlier in the file (checked against lines 45-53
  and 101-110).
