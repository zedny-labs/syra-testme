import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ensureAdmin, createLearner } from './helpers/api'

const API_BASE = process.env.API_BASE_URL || 'http://127.0.0.1:8000/api/'

async function bootstrapSession(page, token) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await page.evaluate((accessToken) => {
    localStorage.setItem('syra_tokens', JSON.stringify({ access_token: accessToken }))
  }, token)
}

test.describe('Route smoke coverage', () => {
  test('public auth recovery and signup entry points stay reachable from login', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/forgot-password')
    await expect(page.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/signup')

    await page.goto('/forgot-password')
    await expect(page.getByRole('heading', { name: 'Forgot Password' })).toBeVisible()

    await page.goto('/reset-password?token=demo-token')
    await expect(page.getByRole('heading', { name: 'Reset Password' })).toBeVisible()
  })

  test('admin route groups load and redirects stay canonical', async ({ page, context }) => {
    const { token } = await ensureAdmin(context)
    await bootstrapSession(page, token)

    const routes = [
      ['/admin/dashboard', /Admin Dashboard/],
      ['/admin/tests', /Tests/],
      ['/admin/exams', /Tests/],
      ['/admin/categories', /Categories/],
      ['/admin/grading-scales', /Grading Scales/],
      ['/admin/question-pools', /Question Pools/],
      ['/admin/sessions', /Testing Sessions/],
      ['/admin/schedules', /Testing Sessions/],
      ['/admin/candidates', /Candidates/],
      ['/admin/attempt-analysis', /Attempt Analysis/],
      ['/admin/users', /Users/],
      ['/admin/roles', /Roles & Permissions/],
      ['/admin/templates', /Test Templates/],
      ['/admin/certificates', /Certificates/],
      ['/admin/reports', /Scheduled Reports/],
      ['/admin/courses', /Courses/],
      ['/admin/user-groups', /User Groups/],
      ['/admin/settings', /System Settings/],
      ['/admin/surveys', /Surveys/],
      ['/admin/predefined-reports', /Predefined Reports/],
      ['/admin/favorite-reports', /My Favorite Reports/],
      ['/admin/report-builder', /Custom Reports/],
      ['/admin/integrations', /Integrations/],
      ['/admin/maintenance', /Maintenance/],
      ['/admin/subscribers', /Subscribers/],
    ]

    for (const [path, heading] of routes) {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    }

    await expect(page).toHaveURL(/\/admin\/subscribers/)
  })

  test('learner route groups load with self-service session bootstrap', async ({ page, context }) => {
    test.setTimeout(180000)
    const { token: adminToken } = await ensureAdmin(context)
    const learner = await createLearner(context, adminToken)

    const api = await playwrightRequest.newContext({ baseURL: API_BASE })
    const login = await api.post('auth/login', {
      data: { email: learner.email, password: learner.password },
    })
    expect(login.ok()).toBeTruthy()
    const learnerToken = (await login.json()).access_token

    await bootstrapSession(page, learnerToken)

    const routes = [
      ['/', /Welcome,/],
      ['/tests', /Available Tests/],
      ['/schedule', /Test Schedule/],
      ['/attempts', /Your Attempts/],
      ['/training', /Training/],
      ['/surveys', /My Surveys/],
      ['/profile', /Profile/],
      ['/change-password', /Change Password/],
    ]

    for (const [path, heading] of routes) {
      await page.goto(path, { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    }

    await page.goto('/exams', { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(/\/tests$/)
    await page.goto('/surveys', { waitUntil: 'domcontentloaded' })

    const noSurveysState = page.getByText(/No surveys available right now\./i)
    const submitResponseButtons = page.getByRole('button', { name: /Submit Response/i })

    await expect.poll(async () => {
      return (await noSurveysState.count()) > 0 || (await submitResponseButtons.count()) > 0
    }, { timeout: 15000 }).toBe(true)

    if (await noSurveysState.count()) {
      await expect(noSurveysState).toBeVisible()
      await expect(submitResponseButtons).toHaveCount(0)
    } else {
      await expect(submitResponseButtons.first()).toBeVisible()
      await expect(page.getByRole('heading', { name: /My Surveys/i })).toBeVisible()
    }
  })
})
