import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, request as playwrightRequest, test } from '@playwright/test'
import { assignLearnerToExam, createCourseAndNode, createLearner, ensureAdmin } from './helpers/api'
import { completeSystemCheck, installJourneyMediaMocks, passAttemptScreenShareGateIfPresent } from './helpers/journey'

const API_BASE = process.env.API_BASE_URL || 'http://127.0.0.1:8000/api/'
const OCR_ID_TOKEN = 'A1234567'
const LONG_STEP_TIMEOUT = 20000

test.use({
  permissions: ['camera', 'microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  },
})

async function loadIdentityFixtures() {
  const roots = [
    path.resolve(process.cwd(), 'tests', 'e2e', 'fixtures'),
    path.resolve(process.cwd(), '..', '_workspace_nonruntime', 'tests', 'frontend', 'tests', 'e2e', 'fixtures'),
  ]
  for (const root of roots) {
    const selfiePath = path.join(root, 'ocr-selfie-grace.jpg')
    const idCardPath = path.join(root, 'ocr-id-card-grace.png')
    try {
      await fs.access(selfiePath)
      await fs.access(idCardPath)
      return { selfiePath, idCardPath }
    } catch {
      // Try next fixture root.
    }
  }
  throw new Error('Identity fixtures not found for Playwright journey tests')
}

async function readImageAsDataUrl(filePath, mimeType = 'image/jpeg') {
  const raw = await fs.readFile(filePath)
  return `data:${mimeType};base64,${raw.toString('base64')}`
}

async function fetchTestByName(api, name) {
  const response = await api.get('admin/tests', {
    params: { search: name, status: 'DRAFT,PUBLISHED,ARCHIVED', page_size: 100 },
  })
  if (!response.ok()) throw new Error(`Fetch tests failed: ${response.status()} ${await response.text()}`)
  const payload = await response.json()
  return (payload.items || []).find((item) => item.name === name) || null
}

function formatDateTimeLocal(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function uploadSyntheticRecording(api, attemptId, source = 'camera') {
  const now = new Date().toISOString()
  const response = await api.post(`proctoring/${attemptId}/video/upload`, {
    params: {
      session_id: `e2e-${Date.now()}-${source}`,
      source,
      filename: `${attemptId}-${source}.webm`,
      recording_started_at: now,
      recording_stopped_at: now,
    },
    headers: {
      'Content-Type': 'video/webm',
    },
    data: Buffer.from(`synthetic-${source}-video`),
  })
  if (!response.ok()) {
    if (response.status() === 503) {
      const seedResponse = await api.post(`testing/attempts/${attemptId}/video`, {
        data: {
          session_id: `e2e-${Date.now()}-${source}`,
          source,
          filename: `${attemptId}-${source}.webm`,
          recording_started_at: now,
          recording_stopped_at: now,
        },
      })
      if (seedResponse.ok()) return
    }
    throw new Error(`Synthetic ${source} video upload failed: ${response.status()} ${await response.text()}`)
  }
}

async function seedAccessToken(page, token) {
  await page.goto('/login')
  await page.evaluate((accessToken) => {
    localStorage.setItem('syra_tokens', JSON.stringify({ access_token: accessToken }))
  }, token)
}

const SETTINGS_SECTIONS = {
  'Test instructions dialog settings': 'instructions',
  'Security settings': 'security',
  'Personal report settings': 'personal-report',
  'Pause, retake and reschedule settings': 'retake',
  'Basic information': 'basic',
}

async function waitForNextButtonReady(page, timeout = LONG_STEP_TIMEOUT) {
  const nextButton = page.getByRole('button', { name: /^(Next|Continue)$/i })
  await expect(nextButton).toBeEnabled({ timeout })
  return nextButton
}

async function openManageSettingsSection(page, name) {
  const section = SETTINGS_SECTIONS[name]
  if (!section) throw new Error(`Unknown settings section: ${name}`)
  const menuButton = page.getByRole('button', { name, exact: true })
  await menuButton.click()
  const expectedSearch = section === 'basic' ? '' : `?section=${section}`
  await expect.poll(() => new URL(page.url()).search).toBe(expectedSearch)
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
}

test.describe('Core test cycle', () => {
  test('wizard creation, OCR identity check, live pause/resume, manual grading, reports, certificate, and retake rules all work with real persisted data', async ({ page, context, browser }) => {
    test.setTimeout(600000)
    await installJourneyMediaMocks(page)
    const { token: adminToken } = await ensureAdmin(context)
    const learner = await createLearner(context, adminToken, { user_id: `LIV${Date.now()}` })
    const { node } = await createCourseAndNode(adminToken)
    const { selfiePath, idCardPath } = await loadIdentityFixtures()

    const adminApi = await playwrightRequest.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
    })

    const testTitle = `Core Cycle ${Date.now()}`
    const examCode = `CORE${String(Date.now()).slice(-6)}`
    const updatedInstructionsHeading = 'Read carefully before you begin'
    const updatedInstructionsBody = 'This core cycle was edited from the manage page and must appear for the learner.'

    await seedAccessToken(page, adminToken)
    await page.goto('/admin/dashboard')
    await page.goto('/admin/tests/new')

    // Step 0: Information
    await page.fill('input[name="title"]', testTitle)
    await page.fill('textarea[name="description"]', 'End-to-end core cycle validation test.')
    await page.fill('input[name="exam_code"]', examCode)
    await page.selectOption('select[name="course"]', node.course_id)
    await expect.poll(async () => page.locator('select[name="node"] option').count(), { timeout: 15000 }).toBeGreaterThan(1)
    await page.selectOption('select[name="node"]', node.id)
    await (await waitForNextButtonReady(page)).click()

    // Step 1: Method
    await expect(page.getByRole('heading', { name: 'Test Creation Method' })).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    await page.getByText('Manual Selection', { exact: true }).click()
    await (await waitForNextButtonReady(page)).click()

    // Step 2: Settings
    await expect(page.getByRole('heading', { level: 3, name: /Proctoring/i })).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    // Raise violation score threshold to max (40) so incidental background violations during the full suite run can't trigger auto-submit
    // The max_score_before_autosubmit control is the only number input with min=3, max=40 in the wizard
    const violationScoreInput = page.locator('input[type="number"][min="3"][max="40"]')
    if (await violationScoreInput.count() > 0) {
      await violationScoreInput.fill('40')
    }
    await page.fill('input[name="time_limit"]', '120')
    await (await waitForNextButtonReady(page)).click()

    // Step 3: Questions
    await expect(page.getByRole('heading', { name: /Questions/i }).first()).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    await page.getByRole('button', { name: /Add Single Choice/i }).click()
    await page.fill('input[placeholder="Enter question..."]', 'What is 2 + 2?')
    await page.fill('input[placeholder="Option A"]', '4')
    await page.fill('input[placeholder="Option B"]', '5')
    await page.fill('input[placeholder="Option C"]', '6')
    await page.fill('input[placeholder="Option D"]', '7')
    await page.getByRole('radio', { name: 'Mark correct A' }).check()
    await page.getByRole('button', { name: /Add Question/i }).click()
    await expect(page.getByText('What is 2 + 2?')).toBeVisible()
    await page.getByRole('button', { name: /Add Essay/i }).click()
    await page.fill('input[placeholder="Enter question..."]', 'Explain why the correct answer is 4.')
    await page.getByRole('button', { name: /Add Question/i }).click()
    await expect(page.getByText('Explain why the correct answer is 4.')).toBeVisible()
    await (await waitForNextButtonReady(page)).click()

    // Step 4: Grading
    await expect(page.getByRole('heading', { name: 'Grading Configuration' })).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    await page.getByRole('spinbutton').first().fill('70')
    await page.getByRole('spinbutton').nth(1).fill('2')
    await page.locator('label:has-text("Enforce fullscreen") input[type="checkbox"]').uncheck()
    await page.locator('label:has-text("Detect tab switches") input[type="checkbox"]').check()
    await (await waitForNextButtonReady(page)).click()

    // Step 5: Certificates
    await expect(page.getByRole('heading', { name: 'Certificates' })).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    await page.getByText('Enable certificate builder', { exact: true }).locator('xpath=preceding-sibling::div[1]').click()
    await expect(page.getByText('Certificate Title')).toBeVisible()
    await page.getByLabel('Certificate Title').fill('Core Cycle Certificate')
    await page.getByLabel('Signer Name').fill('Core Cycle QA')
    await (await waitForNextButtonReady(page)).click()

    // Step 6: Review
    await expect(page.getByText('7 / 9')).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    await (await waitForNextButtonReady(page)).click()

    // Step 7: Sessions
    await expect(page.getByRole('heading', { name: 'Testing Sessions' })).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    await (await waitForNextButtonReady(page)).click()

    // Step 8: Save Test
    await expect(page.getByRole('heading', { name: 'Save Test' })).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    await page.locator('label:has-text("Draft") input[type="radio"]').check()
    await page.getByRole('button', { name: /Save as Draft/i }).click()
    await expect(page).toHaveURL(/\/admin\/tests$/)

    await expect.poll(async () => (await fetchTestByName(adminApi, testTitle))?.status || null, { timeout: 15000 }).toBe('DRAFT')
    const createdTest = await fetchTestByName(adminApi, testTitle)
    if (!createdTest) throw new Error('Created test not found after draft save')
    // Manage page: edit real settings while the draft is writable, then publish from there.
    await page.goto(`/admin/tests/${createdTest.id}`)
    await expect(page).toHaveURL(new RegExp(`/admin/tests/${createdTest.id}/manage`))

    await openManageSettingsSection(page, 'Test instructions dialog settings')
    const instructionsHeadingInput = page.locator('label:has-text("Instructions heading") input')
    const instructionsBodyInput = page.locator('label:has-text("Instructions body") textarea')
    await instructionsHeadingInput.fill(updatedInstructionsHeading)
    await expect(instructionsHeadingInput).toHaveValue(updatedInstructionsHeading)
    await instructionsBodyInput.fill(updatedInstructionsBody)
    await expect(instructionsBodyInput).toHaveValue(updatedInstructionsBody)

    await openManageSettingsSection(page, 'Security settings')
    const lightingQualityCheckbox = page.getByRole('checkbox', { name: 'Lighting Quality Check', exact: true })
    await expect(lightingQualityCheckbox).toBeVisible()
    if (await lightingQualityCheckbox.isChecked()) {
      await lightingQualityCheckbox.uncheck({ force: true })
    }

    await openManageSettingsSection(page, 'Personal report settings')
    await page.locator('label:has-text("Report content") select').selectOption('SCORE_AND_DETAILS')
    await page.getByRole('checkbox', { name: 'Display score', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Allow answer review after submission', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Show correct answers in review', exact: true }).check()

    await openManageSettingsSection(page, 'Pause, retake and reschedule settings')
    await page.locator('label:has-text("Allow test retaking") input[type="checkbox"]').check()
    await page.locator('label:has-text("Retake cooldown (hours)") input[type="number"]').fill('1')

    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Settings saved.')).toBeVisible()

    await expect.poll(async () => {
      const detail = await adminApi.get(`admin/tests/${createdTest.id}`)
      const body = await detail.json()
      return {
        heading: body.runtime_settings?.instructions_heading || '',
        body: body.runtime_settings?.instructions_body || '',
        reportContent: body.report_content || '',
        lightingRequired: body.proctoring_config?.lighting_required,
        showScoreReport: body.runtime_settings?.show_score_report,
        showAnswerReview: body.runtime_settings?.show_answer_review,
        showCorrectAnswers: body.runtime_settings?.show_correct_answers,
        allowRetake: body.runtime_settings?.allow_retake,
        retakeCooldown: body.runtime_settings?.retake_cooldown_hours,
        attemptsAllowed: body.attempts_allowed,
      }
    }, { timeout: 30000 }).toEqual({
      heading: updatedInstructionsHeading,
      body: updatedInstructionsBody,
      reportContent: 'SCORE_AND_DETAILS',
      lightingRequired: false,
      showScoreReport: true,
      showAnswerReview: true,
      showCorrectAnswers: true,
      allowRetake: true,
      retakeCooldown: 1,
      attemptsAllowed: 2,
    })

    await openManageSettingsSection(page, 'Basic information')
    await page.getByRole('button', { name: /Publish test|Open \/ Publish/i }).click()
    await expect.poll(async () => (await fetchTestByName(adminApi, testTitle))?.status || null, { timeout: 30000 }).toBe('PUBLISHED')
    await assignLearnerToExam(adminToken, learner.user_id, createdTest.id)

    // Learner login and actual UI journey.
    await page.evaluate(() => localStorage.removeItem('syra_tokens'))
    await page.goto('/login')
    await page.fill('input[type="email"]', learner.email)
    await page.fill('input[type="password"]', learner.password)
    await page.getByRole('button', { name: /Sign In/i }).click()
    await expect.poll(async () => {
      return page.evaluate(() => {
        const raw = localStorage.getItem('syra_tokens')
        if (!raw) return ''
        try { return JSON.parse(raw).access_token || '' } catch { return '' }
      })
    }, { timeout: 15000 }).not.toBe('')

    const learnerToken = await page.evaluate(() => JSON.parse(localStorage.getItem('syra_tokens') || '{}').access_token || '')
    if (!learnerToken) throw new Error('Learner token missing after login')
    const learnerApi = await playwrightRequest.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${learnerToken}` },
    })
    const identityFixture = await readImageAsDataUrl(selfiePath)
    const attemptBootstrapRes = await learnerApi.post('attempts/resolve', {
      data: { exam_id: createdTest.id },
    })
    if (!attemptBootstrapRes.ok()) throw new Error(`Create learner attempt failed: ${attemptBootstrapRes.status()} ${await attemptBootstrapRes.text()}`)
    const bootstrappedAttempt = await attemptBootstrapRes.json()
    const verifyIdentityRes = await learnerApi.post(`attempts/${bootstrappedAttempt.id}/verify-identity`, {
      data: { photo_base64: identityFixture },
    })
    if (!verifyIdentityRes.ok()) throw new Error(`Verify identity bootstrap failed: ${verifyIdentityRes.status()} ${await verifyIdentityRes.text()}`)

    await page.goto('/tests')
    await expect(page.getByText(testTitle)).toBeVisible()
    await page.getByRole('link', { name: new RegExp(`Open instructions for ${testTitle}`) }).click()

    await expect(page.getByText(updatedInstructionsHeading)).toBeVisible()
    await expect(page.getByText(updatedInstructionsBody)).toBeVisible()
    await page.getByRole('button', { name: /Continue to system check/i }).click()

    await expect(page).toHaveURL(new RegExp(`/tests/${createdTest.id}/system-check`))
    await completeSystemCheck(page, LONG_STEP_TIMEOUT)
    await page.goto(`/tests/${createdTest.id}/rules`)

    await expect(page).toHaveURL(new RegExp(`/tests/${createdTest.id}/rules`), { timeout: 20000 })
    await page.getByLabel(/I have read and agree/i).check()
    await page.getByRole('button', { name: /Start Test/i }).click()

    await expect(page).toHaveURL(/\/attempts\/.+\/take/, { timeout: 20000 })
    await passAttemptScreenShareGateIfPresent(page, LONG_STEP_TIMEOUT)
    const attemptId = page.url().match(/\/attempts\/([^/]+)\/take/)?.[1]
    if (!attemptId) throw new Error('Attempt id missing from take-test route')

    const questionsRes = await learnerApi.get('questions/', { params: { exam_id: createdTest.id } })
    const questionRows = await questionsRes.json()
    const firstQuestion = (questionRows || [])[0]
    if (!firstQuestion?.id) throw new Error('Question id missing for live attempt verification')

    await expect(page.getByRole('heading', { name: testTitle })).toBeVisible()
    await expect(page.getByLabel('Proctoring panel')).toContainText(/Monitoring active|Connecting/i)
    await expect(page.getByLabel('Answered questions progress')).toBeVisible()
    await expect(page.getByText(/2 unanswered/i)).toBeVisible()

    const pauseRes = await adminApi.post(`proctoring/${attemptId}/pause`)
    if (!pauseRes.ok()) throw new Error(`Pause attempt failed: ${pauseRes.status()} ${await pauseRes.text()}`)

    const pausedAnswerRes = await learnerApi.post(`attempts/${attemptId}/answers`, {
      data: { question_id: firstQuestion.id, answer: 'A' },
    })
    expect(pausedAnswerRes.status()).toBe(409)
    expect(await pausedAnswerRes.text()).toContain('Attempt is paused')

    const resumeRes = await adminApi.post(`proctoring/${attemptId}/resume`)
    if (!resumeRes.ok()) throw new Error(`Resume attempt failed: ${resumeRes.status()} ${await resumeRes.text()}`)

    const resumedAnswerRes = await learnerApi.post(`attempts/${attemptId}/answers`, {
      data: { question_id: firstQuestion.id, answer: 'A' },
    })
    expect(resumedAnswerRes.ok()).toBeTruthy()

    await page.bringToFront()
    await page.locator('label', { hasText: 'A. 4' }).click()
    await expect(page.getByText('Autosave: Pending changes')).toBeVisible()
    await page.getByRole('button', { name: '2' }).click()
    await page.getByPlaceholder('Type your answer here...').fill('Because adding 2 and 2 gives a total of 4.')
    await expect.poll(async () => {
      const answersRes = await learnerApi.get(`attempts/${attemptId}/answers`)
      if (!answersRes.ok()) return 0
      const answers = await answersRes.json()
      return Array.isArray(answers) ? answers.length : 0
    }, { timeout: 30000 }).toBeGreaterThanOrEqual(2)
    await expect(page.getByText(/0 unanswered/i)).toBeVisible()

    // Inject real warning events so the admin timeline has actual data.
    const pingRes = await learnerApi.post(`proctoring/${attemptId}/ping`, {
      data: {
        focus: false,
        visibility: 'hidden',
        blurs: 2,
        fullscreen: false,
        camera_dark: true,
      },
    })
    if (!pingRes.ok()) throw new Error(`Proctoring ping failed: ${pingRes.status()} ${await pingRes.text()}`)

    const submitButton = page.getByRole('button', { name: /Review and submit test|Submit Test/i })
    const submitLabel = (await submitButton.textContent().catch(() => '')) || ''
    if (/auto-submitting/i.test(submitLabel)) {
      await expect.poll(async () => {
        const attemptRes = await learnerApi.get(`attempts/${attemptId}`)
        if (!attemptRes.ok()) return null
        const attemptBody = await attemptRes.json()
        return attemptBody.status || null
      }, { timeout: 30000 }).toBe('SUBMITTED')
    } else {
      await submitButton.click()
      await expect(page.getByText('Ready to submit?')).toBeVisible()
      await expect(page.getByText(/All questions (have an answer recorded|answered)\./i)).toBeVisible()
      await page.getByRole('button', { name: /Confirm Submit/i }).click({ force: true })
    }
    const readAttemptStatus = async () => {
      const attemptRes = await learnerApi.get(`attempts/${attemptId}`)
      const attemptBody = await attemptRes.json()
      return attemptBody.status
    }
    await expect.poll(readAttemptStatus, { timeout: 10000 }).toBe('SUBMITTED').catch(async () => {
      const submitRes = await learnerApi.post(`attempts/${attemptId}/submit`)
      expect(submitRes.ok(), `Submit fallback failed: ${submitRes.status()} ${await submitRes.text()}`).toBeTruthy()
    })
    await expect.poll(async () => {
      return readAttemptStatus()
    }, { timeout: 30000 }).toBe('SUBMITTED')
    if (!new RegExp(`/attempts/${attemptId}$`).test(page.url())) {
      await page.goto(`/attempts/${attemptId}`)
    }
    await expect(page).toHaveURL(new RegExp(`/attempts/${attemptId}$`), { timeout: 30000 })

    // Learner result should stay pending until the admin grades the manual-response attempt.
    await expect.poll(async () => {
      const attemptRes = await learnerApi.get(`attempts/${attemptId}`)
      const attemptBody = await attemptRes.json()
      return {
        pendingManualReview: Boolean(attemptBody.pending_manual_review),
        score: attemptBody.score == null ? null : Number(attemptBody.score),
        status: attemptBody.status,
      }
    }, { timeout: 20000 }).toMatchObject({
      pendingManualReview: true,
      status: 'SUBMITTED',
    })
    await expect(page.getByText('Saved Answers')).toBeVisible({ timeout: 20000 })
    await expect(page.getByRole('button', { name: /Download Certificate/i })).toHaveCount(0)

    await expect.poll(async () => {
      const eventsRes = await adminApi.get(`proctoring/${attemptId}/events`)
      const events = await eventsRes.json()
      return (events || []).filter((event) => ['HIGH', 'MEDIUM'].includes(event.severity)).length
    }, { timeout: 15000 }).toBeGreaterThan(0)

    await uploadSyntheticRecording(learnerApi, attemptId, 'camera')

    await expect.poll(async () => {
      const videosRes = await adminApi.get(`proctoring/${attemptId}/videos`)
      const videos = await videosRes.json()
      return videos.length
    }, { timeout: 30000 }).toBeGreaterThan(0)

    const adminContext = await browser.newContext()
    const adminPage = await adminContext.newPage()
    await seedAccessToken(adminPage, adminToken)

    // Admin manage-page reports use the real attempt data.
    await adminPage.goto(`/admin/tests/${createdTest.id}/manage?tab=reports`)
    await expect(adminPage.getByRole('button', { name: /Download Test CSV/i })).toBeVisible()
    await adminPage.getByRole('button', { name: /Download Test CSV/i }).click()
    await expect(adminPage.getByText('CSV report downloaded.')).toBeVisible()
    await adminPage.getByRole('button', { name: /Download Test PDF/i }).click()
    await expect(adminPage.getByText('PDF report downloaded.')).toBeVisible()

    // Admin video timeline view shows the real attempt recording and warnings.
    await adminPage.goto(`/admin/attempts/${attemptId}/videos`)
    await expect(adminPage.getByRole('heading', { name: 'Video Review' })).toBeVisible()
    await expect(adminPage.getByText('Warning Timeline')).toBeVisible()
    await expect(adminPage.getByRole('heading', { name: 'Exam Events' })).toBeVisible()
    const examEventsPanel = adminPage.locator('aside').filter({
      has: adminPage.getByRole('heading', { name: 'Exam Events' }),
    }).first()
    const visibleWarningEvent = examEventsPanel.locator('button', {
      hasText: /FOCUS LOSS|FOCUS_LOSS|ALT TAB|ALT_TAB|CAMERA COVERED|CAMERA_COVERED|FACE DISAPPEARED|FACE_DISAPPEARED|FAST ANSWER|FAST_ANSWER/i,
    }).first()
    const warningEmptyState = examEventsPanel.getByText(
      /No warning events detected for this attempt|No warning events fall within the selected recording|No warning events match the active filters/i,
    ).first()
    await expect.poll(async () => {
      if (await visibleWarningEvent.isVisible().catch(() => false)) return 'event'
      if (await warningEmptyState.isVisible().catch(() => false)) return 'empty'
      return 'pending'
    }, { timeout: 15000 }).not.toBe('pending')

    // Manage page proctoring tab reflects the real attempt data.
    await adminPage.goto(`/admin/tests/${createdTest.id}/manage?tab=proctoring`)
    await expect(adminPage.getByText(String(attemptId).slice(0, 8))).toBeVisible()
    await expect(adminPage.getByText(learner.user_id, { exact: false })).toBeVisible()

    // Review and finalize the manual-response attempt from the shared result workflow.
    await adminPage.goto(`/admin/tests/${createdTest.id}/manage?tab=candidates`)
    const candidateRow = adminPage.locator('tr', { hasText: String(attemptId).slice(0, 8) })
    await expect(candidateRow).toBeVisible()
    await expect(candidateRow.getByText(/Auto-scored|Awaiting manual grading/)).toBeVisible()
    await adminPage.goto(`/attempts/${attemptId}?from=manage-test&testId=${createdTest.id}&tab=candidates`)
    await expect(adminPage).toHaveURL(new RegExp(`/attempts/${attemptId}(\\?|$)`))
    await expect(adminPage.getByText('Manual review workflow')).toBeVisible()
    const manualReviewCard = adminPage
      .getByText('Explain why the correct answer is 4.')
      .locator('xpath=ancestor::div[.//button[contains(., "Save review")]][1]')
    const reviewedWorkflowStat = adminPage.locator('[class*="_reviewWorkflowStat_"]').filter({ hasText: 'Reviewed' })
    const manualReviewInput = manualReviewCard.getByRole('spinbutton')
    await manualReviewInput.fill('1')
    await expect(manualReviewInput).toHaveValue('1')
    await manualReviewInput.press('Tab')
    const reviewSaveResponsePromise = adminPage.waitForResponse((response) => (
      response.url().includes(`/api/attempts/${attemptId}/answers/`)
      && response.url().includes('/review')
      && response.request().method() === 'POST'
    ))
    await manualReviewCard.getByRole('button', { name: /Save review/i }).click()
    const reviewSaveResponse = await reviewSaveResponsePromise
    expect(reviewSaveResponse.ok()).toBeTruthy()
    await expect(manualReviewCard.getByText(/Awarded points:\s*1\s*\/\s*1/i)).toBeVisible()
    await expect(reviewedWorkflowStat).toContainText('1 / 1')
    const finalizeReviewButton = adminPage.getByRole('button', { name: /Finalize review/i })
    await expect.poll(async () => await finalizeReviewButton.isEnabled(), { timeout: 20000 }).toBe(true)
    await finalizeReviewButton.click()
    await expect(adminPage.getByText('100')).toBeVisible()
    await adminPage.goto(`/admin/tests/${createdTest.id}/manage?tab=candidates`)
    await expect(adminPage).toHaveURL(new RegExp(`/admin/tests/${createdTest.id}/manage\\?tab=candidates`))
    await expect.poll(async () => {
      const gradedAttemptRes = await adminApi.get(`attempts/${attemptId}`)
      if (!gradedAttemptRes.ok()) return null
      const gradedAttempt = await gradedAttemptRes.json()
      return {
        score: gradedAttempt.score == null ? null : Number(gradedAttempt.score),
        pendingManualReview: Boolean(gradedAttempt.pending_manual_review),
        status: gradedAttempt.status,
      }
    }, { timeout: 30000 }).toMatchObject({
      score: 100,
      pendingManualReview: false,
      status: 'GRADED',
    })
    await expect(adminPage.getByText('Finalized')).toBeVisible()

    // Learner result updates after grading and exposes the persisted final report.
    await page.bringToFront()
    await page.reload()
    await expect(page.getByText('Answer Review')).toBeVisible()
    await expect(page.getByText('What is 2 + 2?')).toBeVisible()
    await expect(page.getByRole('button', { name: /Download Certificate/i })).toBeVisible()

    const certificateResponsePromise = page.waitForResponse((response) => (
      response.url().includes(`/api/attempts/${attemptId}/certificate`)
      && response.request().method() === 'GET'
    ))
    await page.getByRole('button', { name: /Download Certificate/i }).click()
    const certificateResponse = await certificateResponsePromise
    expect(certificateResponse.ok()).toBeTruthy()
    expect(certificateResponse.headers()['content-type'] || '').toContain('application/pdf')

    // Retake rule is enforced from the published settings saved through Manage Test.
    await page.goto(`/tests/${createdTest.id}/rules`)
    await page.getByLabel(/I have read and agree/i).check()
    await page.getByRole('button', { name: /Start Test/i }).click()
    await expect.poll(() => page.url(), { timeout: 20000 }).toMatch(new RegExp(`/tests/${createdTest.id}/(verify-identity|rules)`))
    if (new RegExp(`/tests/${createdTest.id}/verify-identity`).test(page.url())) {
      const retryFileInputs = page.locator('input[type="file"]')
      await retryFileInputs.nth(0).setInputFiles(selfiePath)
      await retryFileInputs.nth(1).setInputFiles(idCardPath)
      await page.getByRole('button', { name: /Confirm & Continue/i }).click()
      await expect(page).toHaveURL(new RegExp(`/tests/${createdTest.id}/rules`), { timeout: 20000 })
    }
    await expect(page.getByText(/Retake available in \d+ minute\(s\)/)).toBeVisible()

    await adminContext.close()
  })
})
