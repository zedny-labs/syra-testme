import { test, expect } from '@playwright/test'
import { ensureAdmin } from './helpers/api'

async function bootstrapSession(page, token) {
  await page.goto('/login')
  await page.evaluate((accessToken) => {
    localStorage.setItem('syra_tokens', JSON.stringify({ access_token: accessToken }))
  }, token)
}

function tableRow(page, text) {
  return page.locator('tr').filter({ hasText: text }).first()
}

test.describe('Admin CRUD pages', () => {
  test('users support real user_id updates and groups manage learner membership', async ({ page, context }) => {
    const { token } = await ensureAdmin(context)
    await bootstrapSession(page, token)

    const suffix = Date.now()
    const learnerName = `Group Learner ${suffix}`
    const learnerEmail = `group-learner-${suffix}@example.com`
    const learnerUserId = `GL${suffix}`
    const updatedUserId = `GLU${suffix}`
    const groupName = `Cohort ${suffix}`

    await page.goto('/admin/users')
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()

    await page.getByRole('button', { name: '+ New User' }).click()
    await page.locator('label:has-text("User ID") + input').fill(learnerUserId)
    await page.locator('label:has-text("Name") + input').fill(learnerName)
    await page.locator('label:has-text("Email") + input').fill(learnerEmail)
    await page.locator('label:has-text("Password") + input').fill('Password123!')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('User created successfully.')).toBeVisible()

    const learnerRow = tableRow(page, learnerEmail)
    await expect(learnerRow).toBeVisible()
    await learnerRow.getByRole('button', { name: 'Edit' }).click()

    await page.locator('label:has-text("User ID") + input').fill(updatedUserId)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('User updated successfully.')).toBeVisible()

    await page.reload()
    await page.getByPlaceholder('Search by name, email, or ID...').fill(learnerEmail)
    await expect(tableRow(page, learnerEmail)).toContainText(updatedUserId)

    await page.goto('/admin/user-groups')
    await expect(page.getByRole('heading', { name: 'User Groups' })).toBeVisible()

    const groupsMain = page.locator('main')
    await groupsMain.getByRole('button', { name: 'New Group' }).click()
    const groupDialog = page.getByRole('dialog', { name: 'New Group' })
    await groupDialog.getByLabel('Name').fill(groupName)
    await groupDialog.getByLabel('Description').fill('E2E learner cohort')
    await groupDialog.getByRole('button', { name: 'Save Group' }).click()
    await expect(page.getByText('Group created.')).toBeVisible()
    const groupCard = groupsMain.locator(`[data-user-group-name="${groupName}"]`)
    await expect(groupCard).toBeVisible()
    await groupCard.getByRole('button', { name: 'Show members' }).click()

    await groupCard.getByRole('combobox').selectOption({ label: `${learnerName} (${learnerEmail})` })
    await groupCard.getByRole('button', { name: 'Add' }).click()
    await expect(page.getByText('Member added.')).toBeVisible()
    await expect(groupCard.locator('div').filter({ hasText: learnerEmail }).filter({ has: page.getByRole('button', { name: 'Remove' }) }).first()).toBeVisible()

    const memberRow = groupCard.locator('div').filter({ hasText: learnerEmail }).filter({ has: page.getByRole('button', { name: 'Remove' }) }).first()
    await memberRow.getByRole('button', { name: 'Remove' }).click()
    await expect(page.getByText('Member removed.')).toBeVisible()
    await expect(groupCard.getByText('No members in this group.')).toBeVisible()
  })

  test('courses, templates, and surveys persist real create and update flows', async ({ page, context }) => {
    const { token } = await ensureAdmin(context)
    await bootstrapSession(page, token)

    const suffix = Date.now()
    const courseTitle = `Course ${suffix}`
    const moduleTitle = `Module ${suffix}`
    const templateName = `Template ${suffix}`
    const updatedTemplateName = `Template ${suffix} Updated`
    const surveyTitle = `Survey ${suffix}`

    await page.goto('/admin/courses')
    await expect(page.getByRole('heading', { name: 'Courses' })).toBeVisible()

    const coursesMain = page.locator('main')
    await coursesMain.getByRole('button', { name: 'New Course' }).click()
    const courseDialog = page.getByRole('dialog', { name: 'Create New Course' })
    await courseDialog.getByLabel('Title').fill(courseTitle)
    await courseDialog.getByLabel('Description').fill('Course created in e2e')
    await courseDialog.getByRole('button', { name: 'Save Course' }).click()
    await expect(page.getByText('Course created.')).toBeVisible()

    const courseCard = coursesMain.locator(`[data-course-title="${courseTitle}"]`)
    await expect(courseCard).toBeVisible()
    await courseCard.getByPlaceholder('Module title').fill(moduleTitle)
    await courseCard.getByRole('button', { name: 'Add' }).click()
    await expect(page.getByText('Module added.')).toBeVisible()
    await expect(coursesMain.getByText('Loading...')).toHaveCount(0)
    await expect(page.getByText(moduleTitle)).toBeVisible()

    await page.goto('/admin/templates')
    await expect(page.getByRole('heading', { name: 'Test Templates' })).toBeVisible()

    await page.getByRole('button', { name: 'New Template' }).click()
    const templateDialog = page.getByRole('dialog', { name: 'New Template' })
    await templateDialog.getByLabel('Name').fill(templateName)
    await templateDialog.getByLabel('Description').fill('Template created in e2e')
    await templateDialog.getByRole('button', { name: 'Save Template' }).click()
    await expect(page.getByText('Template created.')).toBeVisible()

    const templateCard = page.locator(`[data-template-name="${templateName}"]`)
    await templateCard.getByRole('button', { name: `Edit ${templateName}` }).click()
    const editTemplateDialog = page.getByRole('dialog', { name: 'Edit Template' })
    await editTemplateDialog.getByLabel('Name').fill(updatedTemplateName)
    await editTemplateDialog.getByRole('button', { name: 'Update Template' }).click()
    await expect(page.getByText('Template updated.')).toBeVisible()
    await expect(page.getByText(updatedTemplateName)).toBeVisible()

    await page.goto('/admin/surveys')
    await expect(page.getByRole('heading', { name: 'Surveys' })).toBeVisible()

    const surveysMain = page.locator('main')
    await surveysMain.getByRole('button', { name: 'New Survey' }).click()
    const surveyDialog = page.getByRole('dialog', { name: 'New Survey' })
    await surveyDialog.getByLabel('Title').fill(surveyTitle)
    await surveyDialog.getByPlaceholder('Question 1').fill('Was the workflow clear?')
    await surveyDialog.getByRole('button', { name: 'Save Survey' }).click()
    await expect(page.getByText('Survey created.')).toBeVisible()

    const deactivateButtonName = `Deactivate ${surveyTitle}`
    const surveyRow = surveysMain.locator(`[data-survey-title="${surveyTitle}"]`)
    await expect(surveyRow).toBeVisible()
    await surveyRow.getByRole('button', { name: deactivateButtonName }).click()
    await expect(page.getByText('Survey deactivated.')).toBeVisible()
  })
})
