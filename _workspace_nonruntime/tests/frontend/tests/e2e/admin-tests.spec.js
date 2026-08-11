import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ensureAdmin } from './helpers/api'

const API_BASE = process.env.API_BASE_URL || 'http://127.0.0.1:8000/api/'

async function createDraftTest(token, name, type = 'MCQ', withQuestion = false) {
  const api = await playwrightRequest.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })
  const res = await api.post('admin/tests', { data: { name, type } })
  if (!res.ok()) throw new Error(`createDraftTest failed: ${res.status()} ${await res.text()}`)
  const created = await res.json()
  if (withQuestion) {
    const questionRes = await api.post('questions/', {
      data: {
        exam_id: created.id,
        text: 'Publishable question',
        type: 'MCQ',
        options: ['Option A', 'Option B'],
        correct_answer: 'A',
        order: 0,
      },
    })
    if (!questionRes.ok()) throw new Error(`question create failed: ${questionRes.status()} ${await questionRes.text()}`)
  }
  return created
}

test.describe('Admin Manage Tests page', () => {
  test('admin can publish, archive, unarchive, and delete tests from list actions', async ({ page, context }) => {
    const { token } = await ensureAdmin(context)
    const unique = Date.now()
    const publishName = `UI Publish ${unique}`
    const deleteName = `UI Delete ${unique}`

    const publishDraft = await createDraftTest(token, publishName, 'MCQ', true)
    const deleteDraft = await createDraftTest(token, deleteName)
    const api = await playwrightRequest.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    })

    await page.goto('/login')
    await page.evaluate((accessToken) => {
      localStorage.setItem('syra_tokens', JSON.stringify({ access_token: accessToken }))
    }, token)
    await page.goto('/admin/dashboard')

    await page.goto('/admin/tests')
    await expect(page).toHaveURL(/\/admin\/tests/)
    await page.getByRole('button', { name: 'Edit columns', exact: true }).click()
    await page.getByLabel('Code').uncheck()
    await page.getByRole('button', { name: 'Save displayed column set', exact: true }).click()
    await expect(page.locator('table thead th', { hasText: 'Code' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Edit columns', exact: true }).click()
    await page.getByLabel('Code').check()
    await page.getByRole('button', { name: 'Save displayed column set', exact: true }).click()
    await expect(page.locator('table thead th', { hasText: 'Code' })).toBeVisible()

    const openFilterPanel = async () => {
      const panel = page.locator('div[class*="filterPanel"]')
      if (await panel.count()) return
      await page.getByRole('button', { name: 'Show filters', exact: true }).click()
      await expect(page.locator('div[class*="filterPanel"]')).toBeVisible()
    }

    const statusFilter = page
      .locator('div[class*="filterPanel"] select')
      .filter({ has: page.locator('option[value="ARCHIVED"]') })
      .first()

    const openRowMenu = async (row) => {
      await row.getByRole('button', { name: /More actions for/i }).click()
    }

    const postTestAction = async (testId, action) => {
      const res = await api.post(`admin/tests/${testId}/${action}`)
      expect(res.ok(), `${action} failed: ${res.status()} ${await res.text()}`).toBeTruthy()
    }

    const deleteTest = async (testId) => {
      const res = await api.delete(`admin/tests/${testId}`)
      expect(res.ok(), `delete failed: ${res.status()} ${await res.text()}`).toBeTruthy()
    }

    const reloadAndSearch = async (name) => {
      await page.goto('/admin/tests', { waitUntil: 'networkidle' })
      await page.fill('input[placeholder="Search by name or code..."]', name)
      const row = page.locator('tbody tr', { hasText: name }).first()
      await expect(row).toBeVisible()
      return row
    }

    // Publish -> Archive -> Unarchive flow on first draft
    await page.fill('input[placeholder="Search by name or code..."]', publishName)
    const publishRow = page.locator('tbody tr', { hasText: publishName }).first()
    await expect(publishRow).toBeVisible()
    await openRowMenu(publishRow)
    await expect(publishRow.getByRole('button', { name: 'Testing sessions' }).first()).toBeVisible()
    await expect(publishRow.getByRole('button', { name: 'Candidates' }).first()).toBeVisible()
    await page.goto(`/admin/tests/${publishDraft.id}/manage?tab=sessions`)
    await expect(page).toHaveURL(/\/admin\/tests\/.+\/manage\?tab=sessions/)
    await expect(page.getByRole('heading', { name: /Testing Sessions/i })).toBeVisible()
    await page.goto(`/admin/tests/${publishDraft.id}/manage?tab=candidates`)
    await expect(page).toHaveURL(/\/admin\/tests\/.+\/manage\?tab=candidates/)
    await expect(page.getByRole('heading', { name: /Candidates/i })).toBeVisible()
    await postTestAction(publishDraft.id, 'publish')
    await expect.poll(async () => {
      const testRes = await api.get(`admin/tests/${publishDraft.id}`)
      if (!testRes.ok()) return null
      const body = await testRes.json()
      return body.status || null
    }, { timeout: 15000 }).toBe('PUBLISHED')

    await postTestAction(publishDraft.id, 'archive')
    await expect.poll(async () => {
      const testRes = await api.get(`admin/tests/${publishDraft.id}`)
      if (!testRes.ok()) return null
      const body = await testRes.json()
      return body.status || null
    }, { timeout: 15000 }).toBe('ARCHIVED')

    await page.goto('/admin/tests', { waitUntil: 'networkidle' })
    await openFilterPanel()
    await statusFilter.selectOption('ARCHIVED')
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    const archivedRow = page.locator('tbody tr', { hasText: publishName }).first()
    await expect(archivedRow).toBeVisible()
    await openRowMenu(archivedRow)
    await expect(archivedRow.getByRole('button', { name: 'Unarchive', exact: true })).toBeVisible()
    await postTestAction(publishDraft.id, 'unarchive')
    await expect.poll(async () => {
      const testRes = await api.get(`admin/tests/${publishDraft.id}`)
      if (!testRes.ok()) return null
      const body = await testRes.json()
      return body.status || null
    }, { timeout: 15000 }).toBe('PUBLISHED')

    // Delete flow on second draft
    const deleteRow = await reloadAndSearch(deleteName)
    await openRowMenu(deleteRow)
    await expect(deleteRow.getByRole('button', { name: 'Delete', exact: true })).toBeVisible()
    await deleteTest(deleteDraft.id)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(deleteRow).toHaveCount(0)
  })
})
