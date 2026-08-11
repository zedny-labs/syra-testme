import { test, expect } from '@playwright/test'
import { ensureAdmin } from './helpers/api'

async function bootstrapSession(page, token) {
  await page.goto('/login')
  await page.evaluate((accessToken) => {
    localStorage.setItem('syra_tokens', JSON.stringify({ access_token: accessToken }))
  }, token)
}

test.describe('Admin favorite reports', () => {
  test('favorites persist after reload through the backend preference API', async ({ page, context }) => {
    const { token } = await ensureAdmin(context)
    await bootstrapSession(page, token)

    const title = `Risk Alerts ${Date.now()}`
    await page.goto('/admin/favorite-reports')
    await page.getByRole('button', { name: 'Add Favorite' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add Favorite Report' })
    await dialog.getByLabel('Title').fill(title)
    await dialog.getByLabel('URL or path').fill('/admin/reports')
    await dialog.getByRole('button', { name: 'Add Favorite' }).click()

    await expect(page.getByText(title, { exact: false })).toBeVisible()
    await page.reload()
    await expect(page.getByText(title, { exact: false })).toBeVisible()
  })
})
