import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ensureAdmin } from './helpers/api'

const API_BASE = process.env.API_BASE_URL || 'http://127.0.0.1:8000/api/'

async function bootstrapSession(page, token) {
  await page.goto('/login')
  await page.evaluate((accessToken) => {
    localStorage.setItem('syra_tokens', JSON.stringify({ access_token: accessToken }))
  }, token)
}

function integrationCard(page, title) {
  return page.getByTestId(`integration-card-${title.toLowerCase()}`)
}

function scheduleRow(page, title) {
  return page.getByTestId('report-schedule-row').filter({ hasText: title }).first()
}

test.describe('Admin system pages', () => {
  test('subscribers and scheduled reports validate and persist', async ({ page, context }) => {
    const { token } = await ensureAdmin(context)
    const api = await playwrightRequest.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    })
    await api.put('admin-settings/subscribers', { data: { value: '[]' } })
    await bootstrapSession(page, token)

    const email = `reports-${Date.now()}@example.com`
    const scheduleName = `Daily Risk ${Date.now()}`

    await page.goto('/admin/subscribers')
    await expect(page.getByRole('heading', { name: 'Subscribers' })).toBeVisible()
    await expect(page.getByPlaceholder('user@example.com')).toBeEnabled({ timeout: 15000 })

    await page.getByPlaceholder('user@example.com').fill('bad-email')
    await page.getByRole('button', { name: 'Add' }).click()
    await expect(page.getByText('Enter a valid email address.')).toBeVisible()

    await page.getByPlaceholder('user@example.com').fill(email)
    await page.getByRole('button', { name: 'Add' }).click()
    await expect(page.getByText('Subscriber added.')).toBeVisible()
    await page.reload()
    await expect(page.getByText(email)).toBeVisible()

    await page.goto('/admin/report-builder')
    await expect(page.getByRole('heading', { name: 'Custom Reports' })).toBeVisible()

    await page.goto('/admin/reports')
    await expect(page.getByRole('heading', { name: 'Scheduled Reports' })).toBeVisible()

    const main = page.locator('main')
    await main.getByRole('button', { name: '+ New Schedule' }).click()
    const scheduleDialog = page.getByRole('dialog', { name: 'New Report Schedule' })
    await scheduleDialog.getByLabel('Name').fill(scheduleName)
    await scheduleDialog.getByLabel('Cron').fill('bad cron')
    await scheduleDialog.getByLabel('Recipients (comma-separated emails)').fill(email)
    await scheduleDialog.getByRole('button', { name: 'Save Schedule' }).click()
    await expect(page.getByText('Invalid cron expression')).toBeVisible()

    await scheduleDialog.getByLabel('Cron').fill('0 8 * * *')
    await scheduleDialog.getByRole('button', { name: 'Save Schedule' }).click()
    await expect(page.getByText('Schedule created successfully.')).toBeVisible()

    const row = scheduleRow(page, scheduleName)
    await expect(row).toBeVisible()
    const runResponsePromise = page.waitForResponse((response) => (
      response.url().includes('/api/report-schedules/')
      && response.url().includes('/run')
      && response.request().method() === 'POST'
    ))
    await row.getByRole('button', { name: 'Run now' }).click()
    const runResponse = await runResponsePromise
    expect(runResponse.ok(), `schedule run failed: ${runResponse.status()} ${await runResponse.text()}`).toBeTruthy()
    const generatedReportLink = page.getByRole('link', { name: 'Open generated report' })
    await expect(generatedReportLink).toBeVisible({ timeout: 30000 })
    await expect(generatedReportLink).toHaveAttribute('href', /\/api\/media\/reports\//)

    await row.getByRole('button', { name: 'Delete' }).click()
    await row.getByRole('button', { name: 'Confirm delete' }).click()
    await expect(row).toHaveCount(0)

    await page.goto('/admin/subscribers')
    const subscriberRow = page.locator('div').filter({ hasText: email }).filter({ has: page.getByRole('button', { name: 'Remove' }) }).first()
    await subscriberRow.getByRole('button', { name: 'Remove' }).nth(0).click()
    await subscriberRow.getByRole('button', { name: 'Confirm remove' }).click()
    await expect(page.getByText('Subscriber removed.')).toBeVisible()
    await page.reload()
    await expect(page.getByText(email)).toHaveCount(0)
  })

  test('integrations require a URL before enabling and persist saved values', async ({ page, context }) => {
    const { token } = await ensureAdmin(context)
    const api = await playwrightRequest.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    })
    await api.put('admin-settings/integrations_config', { data: { value: '{}' } })
    await bootstrapSession(page, token)

    const slackUrl = `https://example.com/hooks/${Date.now()}`

    await page.goto('/admin/integrations')
    await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible()

    const slackCard = integrationCard(page, 'Slack')
    await slackCard.getByRole('button', { name: 'Enable' }).click()
    await expect(page.getByText('Slack requires a URL to enable.')).toBeVisible()

    await slackCard.getByLabel('Webhook URL').fill(slackUrl)
    await slackCard.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Slack settings saved.')).toBeVisible()

    await page.reload()
    const reloadedSlackCard = integrationCard(page, 'Slack')
    await expect(reloadedSlackCard.getByLabel('Webhook URL')).toHaveValue(slackUrl)

    await reloadedSlackCard.getByRole('button', { name: 'Enable' }).click()
    await expect(page.getByText('Slack has been enabled.')).toBeVisible()
    await expect(reloadedSlackCard.getByRole('button', { name: 'Disable' })).toBeVisible()
  })
})
