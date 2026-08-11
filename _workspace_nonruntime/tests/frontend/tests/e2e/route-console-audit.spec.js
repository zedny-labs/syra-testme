import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ensureAdmin, createLearner } from './helpers/api'

const API_BASE = process.env.API_BASE_URL || 'http://127.0.0.1:8000/api/'

const ADMIN_ROUTES = [
  '/admin/dashboard',
  '/admin/tests',
  '/admin/tests/new',
  '/admin/categories',
  '/admin/grading-scales',
  '/admin/question-pools',
  '/admin/sessions',
  '/admin/candidates',
  '/admin/attempt-analysis',
  '/admin/users',
  '/admin/templates',
  '/admin/certificates',
  '/admin/reports',
  '/admin/courses',
  '/admin/user-groups',
  '/admin/settings',
  '/admin/surveys',
  '/admin/predefined-reports',
  '/admin/favorite-reports',
  '/admin/report-builder',
  '/admin/integrations',
  '/admin/maintenance',
  '/admin/subscribers',
  '/admin/audit-log',
]

const LEARNER_ROUTES = [
  '/',
  '/tests',
  '/training',
  '/surveys',
  '/attempts',
  '/schedule',
  '/profile',
]

async function attachIssueCollectors(page) {
  await page.addInitScript(() => {
    window.__syraApiErrors = []
    window.addEventListener('syra:api-error', (event) => {
      window.__syraApiErrors.push({
        message: event?.detail?.message || '',
        code: event?.detail?.code || '',
        url: window.location.href,
      })
    })
  })

  const issues = {
    console: [],
    pageErrors: [],
    responses: [],
    apiErrors: [],
    visibleFailures: [],
  }

  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      issues.console.push({
        type: msg.type(),
        text: msg.text(),
        url: page.url(),
      })
    }
  })

  page.on('pageerror', (error) => {
    issues.pageErrors.push({
      message: error.message,
      url: page.url(),
    })
  })

  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().startsWith(API_BASE)) {
      issues.responses.push({
        status: response.status(),
        url: response.url(),
        route: page.url(),
      })
    }
  })

  return issues
}

function formatIssues(label, issues) {
  return [
    `${label} console issues: ${JSON.stringify(issues.console, null, 2)}`,
    `${label} page errors: ${JSON.stringify(issues.pageErrors, null, 2)}`,
    `${label} failed API responses: ${JSON.stringify(issues.responses, null, 2)}`,
    `${label} emitted api errors: ${JSON.stringify(issues.apiErrors, null, 2)}`,
    `${label} visible failure banners: ${JSON.stringify(issues.visibleFailures, null, 2)}`,
  ].join('\n')
}

function isExpectedPageError(issue) {
  return issue?.message === 'canceled' && String(issue?.url || '').endsWith('/access-denied')
}

async function bootstrapSession(page, token) {
  await page.goto('/login')
  await page.evaluate((accessToken) => {
    localStorage.setItem('syra_tokens', JSON.stringify({ access_token: accessToken }))
  }, token)
}

async function drainApiErrors(page) {
  return page.evaluate(() => {
    const captured = Array.isArray(window.__syraApiErrors) ? [...window.__syraApiErrors] : []
    window.__syraApiErrors = []
    return captured
  })
}

async function visibleFailureMessages(page) {
  const messages = []
  for (const text of [
    'Internal server error',
    'The server took too long to respond. Please try again.',
  ]) {
    const locator = page.getByText(text, { exact: false })
    const count = await locator.count()
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index)
      if (await candidate.isVisible().catch(() => false)) {
        messages.push(text)
        break
      }
    }
  }
  return messages
}

async function visitRoutes(page, routes, issues) {
  for (const route of routes) {
    await page.goto(route, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    issues.apiErrors.push(
      ...(await drainApiErrors(page)).map((item) => ({
        route,
        ...item,
      })),
    )
    const failureMessages = await visibleFailureMessages(page)
    if (failureMessages.length > 0) {
      issues.visibleFailures.push({
        route,
        messages: failureMessages,
      })
    }
  }
}

test('primary admin and learner route groups stay free of console, page, and API failures', async ({ page, context }) => {
  const admin = await ensureAdmin(context)
  const requestContext = await playwrightRequest.newContext({ baseURL: API_BASE })
  const learner = await createLearner(context, admin.token)
  const learnerLogin = await requestContext.post('auth/login', {
    data: { email: learner.email, password: learner.password },
  })
  const learnerBody = await learnerLogin.json()
  expect(learnerLogin.ok(), `learner login failed: ${learnerLogin.status()} ${JSON.stringify(learnerBody)}`).toBeTruthy()

  const learnerPage = await context.newPage()
  const adminIssues = await attachIssueCollectors(page)
  const learnerIssues = await attachIssueCollectors(learnerPage)

  await bootstrapSession(page, admin.token)
  await bootstrapSession(learnerPage, learnerBody.access_token)

  await visitRoutes(page, ADMIN_ROUTES, adminIssues)
  await visitRoutes(learnerPage, LEARNER_ROUTES, learnerIssues)

  expect(
    [
      ...adminIssues.console,
      ...adminIssues.pageErrors.filter((issue) => !isExpectedPageError(issue)),
      ...adminIssues.responses,
      ...adminIssues.apiErrors,
      ...adminIssues.visibleFailures,
    ],
    formatIssues('admin', adminIssues),
  ).toEqual([])
  expect(
    [
      ...learnerIssues.console,
      ...learnerIssues.pageErrors.filter((issue) => !isExpectedPageError(issue)),
      ...learnerIssues.responses,
      ...learnerIssues.apiErrors,
      ...learnerIssues.visibleFailures,
    ],
    formatIssues('learner', learnerIssues),
  ).toEqual([])

  await learnerPage.close()
  await requestContext.dispose()
})
