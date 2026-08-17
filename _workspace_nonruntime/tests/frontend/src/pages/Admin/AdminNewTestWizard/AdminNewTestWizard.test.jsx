import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import AdminNewTestWizard from './AdminNewTestWizard'

const coursesMock = vi.fn()
const nodesMock = vi.fn()
const createNodeMock = vi.fn()
const categoriesMock = vi.fn()
const gradingScalesMock = vi.fn()
const questionPoolsMock = vi.fn()
const usersMock = vi.fn()
const learnersForSchedulingMock = vi.fn()
const examTemplatesMock = vi.fn()
const createTestMock = vi.fn()
const updateTestMock = vi.fn()
const getTestMock = vi.fn()
const getQuestionsMock = vi.fn()
const seedExamFromPoolMock = vi.fn()
const attemptsMock = vi.fn()
const schedulesMock = vi.fn()
const createScheduleMock = vi.fn()
const updateScheduleMock = vi.fn()
const deleteScheduleMock = vi.fn()
const pauseAttemptMock = vi.fn()
const resumeAttemptMock = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    courses: (...args) => coursesMock(...args),
    nodes: (...args) => nodesMock(...args),
    createNode: (...args) => createNodeMock(...args),
    categories: (...args) => categoriesMock(...args),
    gradingScales: (...args) => gradingScalesMock(...args),
    questionPools: (...args) => questionPoolsMock(...args),
    users: (...args) => usersMock(...args),
    learnersForScheduling: (...args) => learnersForSchedulingMock(...args),
    examTemplates: (...args) => examTemplatesMock(...args),
    createTest: (...args) => createTestMock(...args),
    updateTest: (...args) => updateTestMock(...args),
    getTest: (...args) => getTestMock(...args),
    getQuestions: (...args) => getQuestionsMock(...args),
    seedExamFromPool: (...args) => seedExamFromPoolMock(...args),
    attempts: (...args) => attemptsMock(...args),
    schedules: (...args) => schedulesMock(...args),
    createSchedule: (...args) => createScheduleMock(...args),
    updateSchedule: (...args) => updateScheduleMock(...args),
    deleteSchedule: (...args) => deleteScheduleMock(...args),
    pauseAttempt: (...args) => pauseAttemptMock(...args),
    resumeAttempt: (...args) => resumeAttemptMock(...args),
  },
}))

vi.mock('../../../services/ai.service', () => ({
  generateQuestionsAI: vi.fn(),
}))

vi.mock('../../../hooks/useUnsavedChanges', () => ({
  default: () => {},
}))

vi.mock('../ExamQuestionPanel/ExamQuestionPanel', () => ({
  default: () => <div>Question Panel</div>,
}))

function renderWizard(initialEntry = '/admin/tests/new', routePath = '/admin/tests/new') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path={routePath} element={<AdminNewTestWizard />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('AdminNewTestWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    coursesMock.mockResolvedValue({ data: [] })
    nodesMock.mockResolvedValue({ data: [{ id: 'node-1', title: 'Module 1' }] })
    createNodeMock.mockResolvedValue({ data: { id: 'node-1', title: 'Module 1' } })
    categoriesMock.mockResolvedValue({ data: [] })
    gradingScalesMock.mockResolvedValue({ data: [] })
    questionPoolsMock.mockResolvedValue({ data: [] })
    usersMock.mockResolvedValue({ data: [] })
    learnersForSchedulingMock.mockResolvedValue({ data: [] })
    examTemplatesMock.mockResolvedValue({ data: [] })
    createTestMock.mockResolvedValue({ data: { id: 'test-1' } })
    updateTestMock.mockResolvedValue({ data: {} })
    getTestMock.mockResolvedValue({ data: null })
    getQuestionsMock.mockResolvedValue({ data: [] })
    seedExamFromPoolMock.mockResolvedValue({ data: {} })
    attemptsMock.mockResolvedValue({ data: [] })
    schedulesMock.mockResolvedValue({ data: [] })
    createScheduleMock.mockResolvedValue({ data: { id: 'schedule-1' } })
    updateScheduleMock.mockResolvedValue({ data: {} })
    deleteScheduleMock.mockResolvedValue({ data: {} })
    pauseAttemptMock.mockResolvedValue({ data: {} })
    resumeAttemptMock.mockResolvedValue({ data: {} })
  })

  afterEach(() => {
    cleanup()
  })

  it('labels the core test information fields for the first step', async () => {
    renderWizard()

    expect(await screen.findByLabelText(/Test Name/i)).toBeTruthy()
    expect(screen.getByLabelText('Description')).toBeTruthy()
    expect(screen.getByLabelText('Course')).toBeTruthy()
    expect(screen.getByLabelText('Module')).toBeTruthy()
    expect(screen.getByLabelText('External Code / ID')).toBeTruthy()
    expect(screen.getByLabelText('Category')).toBeTruthy()
  })

  it('does not advance to the next phase when saving the current step fails', async () => {
    createTestMock.mockRejectedValue({ response: { data: { detail: 'Save failed.' } } })

    renderWizard()

    fireEvent.change(await screen.findByLabelText(/Test Name/i), {
      target: { value: 'Core Cycle Test' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))

    await waitFor(() => expect(screen.getByText('Save failed.')).toBeTruthy())
    expect(screen.getByRole('heading', { name: 'Test Information' })).toBeTruthy()
    expect(screen.queryByText('Test Creation Method')).toBeNull()
  })

  it('validates the external code length before saving', async () => {
    renderWizard()

    fireEvent.change(await screen.findByLabelText(/Test Name/i), {
      target: { value: 'Core Cycle Test' },
    })
    fireEvent.change(screen.getByLabelText('External Code / ID'), {
      target: { value: 'CODE-TOO-LONG-123' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))

    await waitFor(() => expect(screen.getAllByText('External code / ID must be between 6 and 12 characters.').length).toBeGreaterThan(0))
    expect(createTestMock).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Test Information' })).toBeTruthy()
  })

  it('renders validation payloads without crashing when the API returns detail objects', async () => {
    createTestMock.mockRejectedValue({
      response: {
        data: {
          detail: [
            { loc: ['body', 'code'], msg: 'code must be between 6 and 12 characters' },
          ],
        },
      },
    })

    renderWizard()

    fireEvent.change(await screen.findByLabelText(/Test Name/i), {
      target: { value: 'Core Cycle Test' },
    })
    fireEvent.change(screen.getByLabelText('External Code / ID'), {
      target: { value: 'VALID12' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))

    await waitFor(() => expect(screen.getByText('code: code must be between 6 and 12 characters')).toBeTruthy())
    expect(screen.getByRole('heading', { name: 'Test Information' })).toBeTruthy()
    expect(screen.queryByText('Something went wrong.')).toBeNull()
  })

  it('keeps the wizard usable when a non-critical bootstrap lookup fails', async () => {
    coursesMock.mockResolvedValue({
      data: [{ id: 'course-1', title: 'Course One' }],
    })
    categoriesMock.mockRejectedValue(new Error('categories unavailable'))

    renderWizard()

    expect(await screen.findByText('Some setup data failed to load. The wizard is still usable with the data that is available.')).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Course One' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Module 1' })).toBeTruthy()
  })

  it('blocks seeding from an empty pool and explains why', async () => {
    questionPoolsMock.mockResolvedValue({
      data: [{ id: 'pool-1', name: 'Empty Pool', question_count: 0 }],
    })

    renderWizard()

    fireEvent.change(await screen.findByLabelText(/Test Name/i), {
      target: { value: 'Core Cycle Test' },
    })

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByText('Test Creation Method')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Proctoring & Test Settings' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Questions' })).toBeTruthy())

    fireEvent.change(screen.getByDisplayValue('Select pool...'), { target: { value: 'pool-1' } })

    expect(screen.getByText('This pool is empty. Open Question Pools and add questions before seeding.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Seed' }).disabled).toBe(true)
    expect(seedExamFromPoolMock).not.toHaveBeenCalled()
  })

  it('makes the proctoring phase explicit and supports bulk learner selection', async () => {
    learnersForSchedulingMock.mockResolvedValue({
      data: [
        { id: 'learner-1', role: 'LEARNER', user_id: 'LIV1001', name: 'Learner One', email: 'one@example.com' },
        { id: 'learner-2', role: 'LEARNER', user_id: 'LIV1002', name: 'Learner Two', email: 'two@example.com' },
        { id: 'admin-1', role: 'ADMIN', user_id: 'ADM1001', name: 'Admin User', email: 'admin@example.com' },
      ],
    })

    renderWizard()

    expect((await screen.findAllByText('Proctoring')).length).toBeGreaterThan(0)

    fireEvent.change(await screen.findByLabelText(/Test Name/i), {
      target: { value: 'Core Cycle Test' },
    })

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByText('Test Creation Method')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Proctoring & Test Settings' })).toBeTruthy())
    expect(screen.getByText(/dedicated proctoring phase/i)).toBeTruthy()
    expect(screen.getByText('Identity verification')).toBeTruthy()
    expect(screen.getByText('Head Pose Detection')).toBeTruthy()
    expect(screen.getByText('Eye deviation angle')).toBeTruthy()
    expect(screen.getByText('Advanced detector tuning')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByText('Add questions directly or seed from a question pool.')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Grading Configuration' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Certificates' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Review' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Testing Sessions' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Select all learners (2)' }))
    expect(screen.getByText('Selected: 2')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'All learners selected' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save assignments (2)' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.getByText('Selected: 0')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Bulk learners'), {
      target: { value: 'one@example.com\nLIV1002' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add pasted learners' }))

    await waitFor(() => expect(screen.getByText('Matched 2 learners.')).toBeTruthy())
    expect(screen.getByText('Selected: 2')).toBeTruthy()
  }, 10000)

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

  it('unchecks a force-submit checkbox when its alert rule is removed via the manual escalation rules builder', async () => {
    renderWizard()

    fireEvent.change(await screen.findByLabelText(/Test Name/i), {
      target: { value: 'Core Cycle Test' },
    })

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByText('Test Creation Method')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Proctoring & Test Settings' })).toBeTruthy())

    const forceSubmitCheckbox = screen.getByTestId('force-submit-fullscreen_enforce')
    fireEvent.click(forceSubmitCheckbox)
    expect(forceSubmitCheckbox.checked).toBe(true)
    expect(screen.getByText('Escalation rules: 1')).toBeTruthy()

    // The force-submit toggle created exactly one alert rule, so it is the only
    // row in the manual "Escalation rules" builder below — remove it there,
    // through the same UI an admin would use to hand-edit rules, rather than
    // through the checkbox's own onChange handler.
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(screen.getByText('Escalation rules: 0')).toBeTruthy()
    expect(forceSubmitCheckbox.checked).toBe(false)
  })

  it('does not reload assigned sessions again when learner lookups finish in edit mode', async () => {
    let resolveLearners
    const learnersPromise = new Promise((resolve) => {
      resolveLearners = resolve
    })

    getTestMock.mockResolvedValue({
      data: {
        id: 'test-1',
        name: 'Existing Test',
        type: 'MCQ',
        status: 'DRAFT',
        course_id: 'course-1',
        node_id: 'node-1',
        attempts_allowed: 1,
        time_limit_minutes: 30,
        runtime_settings: {},
        proctoring_config: {},
        certificate: null,
      },
    })
    schedulesMock.mockResolvedValue({
      data: [
        {
          id: 'schedule-1',
          exam_id: 'test-1',
          user_id: 'learner-1',
          user_student_id: 'LIV1001',
          user_name: 'Learner One',
          scheduled_at: '2026-03-27T10:00:00Z',
          access_mode: 'OPEN',
        },
      ],
    })
    learnersForSchedulingMock.mockImplementation(() => learnersPromise)

    renderWizard('/admin/tests/test-1/edit', '/admin/tests/:id/edit')

    await waitFor(() => expect(getTestMock).toHaveBeenCalledWith('test-1'))
    await waitFor(() => expect(schedulesMock).toHaveBeenCalledTimes(1))

    resolveLearners({
      data: [
        { id: 'learner-1', role: 'LEARNER', user_id: 'LIV1001', name: 'Learner One', email: 'one@example.com' },
        { id: 'learner-2', role: 'LEARNER', user_id: 'LIV1002', name: 'Learner Two', email: 'two@example.com' },
      ],
    })

    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(schedulesMock).toHaveBeenCalledTimes(1)
  })

})
