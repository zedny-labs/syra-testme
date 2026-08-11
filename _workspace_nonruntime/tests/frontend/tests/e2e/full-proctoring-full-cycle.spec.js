import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, request as playwrightRequest, test } from '@playwright/test'
import { assignLearnerToExam, createCourseAndNode, createLearner, ensureAdmin } from './helpers/api'
import { completeSystemCheck, installJourneyMediaMocks, passAttemptScreenShareGateIfPresent } from './helpers/journey'

const API_BASE = process.env.API_BASE_URL || 'http://127.0.0.1:8000/api/'
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
  if (!response.ok()) throw new Error(`Fetch tests failed: ${response.status()}`)
  const payload = await response.json()
  return (payload.items || []).find((item) => item.name === name) || null
}

async function seedAccessToken(page, token) {
  await page.goto('/login')
  await page.evaluate((accessToken) => {
    localStorage.setItem('syra_tokens', JSON.stringify({ access_token: accessToken }))
  }, token)
}

async function waitForNextButtonReady(page, timeout = LONG_STEP_TIMEOUT) {
  const nextButton = page.getByRole('button', { name: /^(Next|Continue)$/i })
  await expect(nextButton).toBeEnabled({ timeout })
  return nextButton
}

function attemptIdFromTakeUrl(url) {
  return url.match(/\/attempts\/([^/]+)\/take/)?.[1] || null
}

async function answerAttemptThroughApi(api, attemptId, examId) {
  const questionRes = await api.get('questions/', { params: { exam_id: examId } })
  if (!questionRes.ok()) throw new Error(`Questions load failed: ${questionRes.status()} ${await questionRes.text()}`)
  const questionRows = await questionRes.json()
  if (!Array.isArray(questionRows) || questionRows.length === 0) throw new Error('Attempt has no questions')

  for (const question of questionRows.slice(0, 3)) {
    const answerResponse = await api.post(`attempts/${attemptId}/answers`, {
      data: {
        question_id: question.id,
        answer: 'A',
      },
    })
    if (!answerResponse.ok()) {
      throw new Error(`Answer submit failed for ${question.id}: ${answerResponse.status()} ${await answerResponse.text()}`)
    }
  }
}

async function triggerProctoringSignals(api, attemptId) {
  const response = await api.post(`proctoring/${attemptId}/ping`, {
    data: {
      focus: false,
      visibility: 'hidden',
      blurs: 2,
      fullscreen: false,
      camera_dark: true,
    },
  })
  if (!response.ok()) {
    throw new Error(`Proctoring ping failed: ${response.status()} ${await response.text()}`)
  }
}

async function ensureVideoRecords(api, attemptId) {
  const sessionId = `e2e-${Date.now()}`
  const sources = ['camera', 'screen']
  const result = { camera: false, screen: false }

  for (const source of sources) {
    const response = await api.post(`proctoring/${attemptId}/video/register`, {
      data: {
        session_id: `${sessionId}-${source}`,
        source,
        name: `${attemptId}-${source}.m3u8`,
        playback_url: `https://example.com/videos/${attemptId}/${source}.m3u8`,
      },
    })

    if (response.ok()) {
      result[source] = true
      continue
    }

    // Registration depends on the runtime video provider in the test environment.
    if (response.status() !== 503) {
      throw new Error(`Video register failed: ${source}: ${response.status()} ${await response.text()}`)
    }
  }

  return result
}

async function listVideoSources(api, attemptId) {
  const response = await api.get(`proctoring/${attemptId}/videos`)
  if (!response.ok()) {
    return []
  }
  const videos = await response.json()
  return Array.from(new Set((videos || []).map((video) => String(video.source || '').toLowerCase()).filter(Boolean)))
}

async function ensureCardOn(page, label, activeMarker) {
  const labelRef = page.getByText(label, { exact: true }).first()
  const total = await labelRef.count()
  if (!total) throw new Error(`Missing proctoring card: ${label}`)

  const card = labelRef.locator("xpath=ancestor::*[(contains(@class, 'detectorCard') or contains(@class, 'requirementCard')) and not(contains(@class, 'CardHead')) and not(contains(@class, 'CardTitle')) and not(contains(@class, 'CardDesc'))][1]")
  const active = await card.evaluate((element, marker) => (element.className || '').includes(marker), activeMarker)
  if (!active) {
    await labelRef.click()
    await expect(card).toHaveClass(new RegExp(activeMarker))
  }
}

test.describe('Full proctoring cycle', () => {
  test('admin creates all proctoring toggles, learner takes exam, and admin reviews attempts + videos', async ({ page, context, browser }) => {
    test.setTimeout(600000)
    await installJourneyMediaMocks(page)

    const { token: adminToken } = await ensureAdmin(context)
    const learner = await createLearner(context, adminToken)
    const { node } = await createCourseAndNode(adminToken)
    const fixtures = await loadIdentityFixtures()

    const adminApi = await playwrightRequest.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
    })

    const testTitle = `Full Proctoring Test ${Date.now()}`
    const examCode = `FP${String(Date.now()).slice(-6)}`

    await seedAccessToken(page, adminToken)
    await page.goto('/admin/tests/new')

    // Step 0: Information
    await page.fill('input[name="title"]', testTitle)
    await page.fill('textarea[name="description"]', 'Automated full-cycle proctoring test.')
    await page.fill('input[name="exam_code"]', examCode)
    await page.selectOption('select[name="course"]', node.course_id)
    await expect.poll(async () => page.locator('select[name="node"] option').count(), { timeout: 15000 }).toBeGreaterThan(0)
    await page.selectOption('select[name="node"]', node.id)
    await (await waitForNextButtonReady(page)).click()

    // Step 1: Method
    await expect(page.getByRole('heading', { name: 'Test Creation Method' })).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    await page.getByText('Manual Selection', { exact: true }).click()
    await (await waitForNextButtonReady(page)).click()

    // Step 2: Proctoring / Settings (all required toggles)
    await expect(page.getByRole('heading', { level: 3, name: /Proctoring/i })).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    await ensureCardOn(page, 'Face Detection', 'detectorOn')
    await ensureCardOn(page, 'Multi-Face Alert', 'detectorOn')
    await ensureCardOn(page, 'Eye Tracking', 'detectorOn')
    await ensureCardOn(page, 'Head Pose Detection', 'detectorOn')
    await ensureCardOn(page, 'Audio Detection', 'detectorOn')
    await ensureCardOn(page, 'Object Detection', 'detectorOn')
    await ensureCardOn(page, 'Mouth Movement', 'detectorOn')
    await ensureCardOn(page, 'Fullscreen lock', 'requirementCardActive')
    await ensureCardOn(page, 'Tab / blur detection', 'requirementCardActive')
    await ensureCardOn(page, 'Screen recording', 'requirementCardActive')
    await ensureCardOn(page, 'Clipboard blocking', 'requirementCardActive')
    await page.fill('input[name="time_limit"]', '30')
    await (await waitForNextButtonReady(page)).click()

    // Step 3: Questions
    await expect(page.getByRole('heading', { name: /Questions/i }).first()).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    const questions = [
      {
        text: 'What is 2 + 2?',
        a: '4',
        b: '3',
        c: '5',
        d: '6',
      },
      {
        text: 'Which is an even number?',
        a: '2',
        b: '7',
        c: '9',
        d: '11',
      },
      {
        text: 'What is 9 - 4?',
        a: '5',
        b: '10',
        c: '4',
        d: '6',
      },
    ]

    for (const q of questions) {
      await page.getByRole('button', { name: /Add Single Choice/i }).click()
      await page.fill('input[placeholder="Enter question..."]', q.text)
      await page.fill('input[placeholder="Option A"]', q.a)
      await page.fill('input[placeholder="Option B"]', q.b)
      await page.fill('input[placeholder="Option C"]', q.c)
      await page.fill('input[placeholder="Option D"]', q.d)
      await page.getByRole('radio', { name: 'Mark correct A' }).check()
      await page.getByRole('button', { name: /Add Question/i }).click()
      await expect(page.getByText(q.text)).toBeVisible()
    }

    await (await waitForNextButtonReady(page)).click()

    // Step 4: Grading
    await expect(page.getByRole('heading', { name: 'Grading Configuration' })).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    await page.fill('#wizard-passing-score', '60')
    await page.fill('#wizard-max-attempts', '2')
    await (await waitForNextButtonReady(page)).click()

    // Step 5 (Certificates) / Step 6 (Review) / Step 7 (Sessions)
    await (await waitForNextButtonReady(page)).click()
    await (await waitForNextButtonReady(page)).click()
    await (await waitForNextButtonReady(page)).click()

    // Step 8: Save & publish
    await expect(page.getByRole('heading', { name: 'Save Test' })).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    await page.getByLabel('Published').check()
    await page.getByRole('button', { name: /Publish Test/i }).click()
    await expect(page).toHaveURL(/\/admin\/tests$/)

    await expect.poll(async () => {
      const created = await fetchTestByName(adminApi, testTitle)
      return created?.status || null
    }, { timeout: 30000 }).toBe('PUBLISHED')

    const createdTest = await fetchTestByName(adminApi, testTitle)
    if (!createdTest?.id) throw new Error('Created full proctoring test not found')
    await assignLearnerToExam(adminToken, learner.user_id, createdTest.id)

    // Learner journey: instructions -> system check -> identity -> rules -> take test.
    await page.evaluate(() => localStorage.removeItem('syra_tokens'))
    await page.goto('/login')
    await page.fill('input[type="email"]', learner.email)
    await page.fill('input[type="password"]', learner.password)
    await page.getByRole('button', { name: /Sign In/i }).click()

    await expect.poll(async () => page.evaluate(() => {
      const raw = localStorage.getItem('syra_tokens')
      if (!raw) return ''
      try {
        return JSON.parse(raw).access_token || ''
      } catch {
        return ''
      }
    }), { timeout: 15000 }).not.toBe('')

    const learnerToken = await page.evaluate(() => JSON.parse(localStorage.getItem('syra_tokens') || '{}').access_token || '')
    const learnerApi = await playwrightRequest.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${learnerToken}` },
    })
    const identityFixture = await readImageAsDataUrl(fixtures.selfiePath)
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
    await expect(page.getByText(testTitle)).toBeVisible({ timeout: 30000 })
    await page.getByRole('link', { name: new RegExp(`Open instructions for ${testTitle}`, 'i') }).click()

    await expect(page.getByRole('button', { name: /Continue to system check/i })).toBeVisible()
    await page.getByRole('button', { name: /Continue to system check/i }).click()

    await completeSystemCheck(page, LONG_STEP_TIMEOUT)
    await page.goto(`/tests/${createdTest.id}/rules`)

    await expect(page).toHaveURL(new RegExp(`/tests/${createdTest.id}/rules`), { timeout: 20000 })
    await expect(page.getByRole('heading', { name: 'Test Rules' })).toBeVisible()
    await page.getByLabel(/I have read and agree/i).check()
    await page.getByRole('button', { name: /Start Test/i }).click()

    await expect(page).toHaveURL(/\/attempts\/.+\/take/, { timeout: 30000 })
    await passAttemptScreenShareGateIfPresent(page, LONG_STEP_TIMEOUT)
    const attemptId = attemptIdFromTakeUrl(page.url())
    if (!attemptId) throw new Error('Attempt id not found in URL')

    await expect(page.getByLabel('Proctoring panel')).toBeVisible()
    await answerAttemptThroughApi(learnerApi, attemptId, createdTest.id)
    await triggerProctoringSignals(learnerApi, attemptId)

    const submitButton = page.getByRole('button', { name: /Submit Test/i })
    if (await submitButton.isVisible().catch(() => false)) {
      await submitButton.click()
      if (await page.getByText('Ready to submit?').isVisible().catch(() => false)) {
        await page.getByRole('button', { name: /Confirm Submit/i }).click({ force: true })
      }
      await expect(page).toHaveURL(new RegExp(`/attempts/${attemptId}(\\?|$)`), { timeout: 30000 })
    } else {
      const submitResponse = await learnerApi.post(`attempts/${attemptId}/submit`)
      if (!submitResponse.ok()) throw new Error(`Attempt submit failed: ${submitResponse.status()} ${await submitResponse.text()}`)
      await page.goto(`/attempts/${attemptId}`)
      await expect(page.getByText('Proctoring Summary')).toBeVisible({ timeout: 30000 })
    }

    await expect(page.getByText('Proctoring Summary')).toBeVisible({ timeout: 30000 })

    // Seed recordings when the provider supports it, then verify attempt review + video sources.
    const seededRecording = await ensureVideoRecords(adminApi, attemptId)
    const discoveredSources = await listVideoSources(adminApi, attemptId)
    const hasCameraSource = discoveredSources.includes('camera') || seededRecording.camera
    const hasScreenSource = discoveredSources.includes('screen') || seededRecording.screen

    const adminContext = await browser.newContext()
    const adminPage = await adminContext.newPage()
    await seedAccessToken(adminPage, adminToken)

    await adminPage.goto(`/admin/tests/${createdTest.id}/manage?tab=candidates`)
    const candidateRow = adminPage.locator('tr', { hasText: attemptId.slice(0, 8) }).first()
    await expect(candidateRow).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    await adminPage.goto(`/admin/attempt-analysis?id=${attemptId}`)

    await expect(adminPage).toHaveURL(new RegExp(`/admin/attempt-analysis\\?id=${attemptId}`))
    await expect(adminPage.getByRole('heading', { name: 'Attempt Analysis' })).toBeVisible({ timeout: LONG_STEP_TIMEOUT })
    await expect(adminPage.getByRole('button', { name: 'Overview' })).toBeVisible({ timeout: LONG_STEP_TIMEOUT })

    await adminPage.getByRole('button', { name: 'Timeline' }).click()
    await expect(adminPage.getByText(/FOCUS LOSS|FULLSCREEN EXIT|CAMERA COVERED/i).first()).toBeVisible()

    await adminPage.getByRole('button', { name: 'Answers' }).click()
    await expect(adminPage.getByText('What is 2 + 2?')).toBeVisible()

    await adminPage.getByRole('button', { name: 'Evidence' }).click()
    const evidenceCard = adminPage.locator('button[aria-label^="Evidence "]')
    if (await evidenceCard.count()) {
      await expect(evidenceCard.first()).toBeVisible()
    } else {
      await expect(adminPage.getByText('No evidence screenshots captured.')).toBeVisible()
    }

    await adminPage.goto(`/admin/attempts/${attemptId}/videos`)
    await expect(adminPage.getByRole('heading', { name: 'Video Review' })).toBeVisible({ timeout: 15000 })

    if (hasCameraSource) {
      await expect(adminPage.getByRole('button', { name: 'Camera' }).first()).toBeVisible()
      await adminPage.getByRole('button', { name: 'Camera' }).first().click()
    }
    if (hasScreenSource) {
      await expect(adminPage.getByRole('button', { name: 'Screen' }).first()).toBeVisible()
      await adminPage.getByRole('button', { name: 'Screen' }).first().click()
    }

    if (!hasCameraSource && !hasScreenSource) {
      await expect(adminPage.getByText('No video recordings are saved yet for this attempt.')).toBeVisible()
      await adminContext.close()
      await adminApi.dispose()
      await learnerApi.dispose()
      return
    }

    if (seededRecording.camera && seededRecording.screen) {
      await expect(discoveredSources).toContain('camera')
      await expect(discoveredSources).toContain('screen')
    }

    await adminContext.close()
    await adminApi.dispose()
    await learnerApi.dispose()
  })
})
