import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import AdminManageTestPage from './AdminManageTestPage'

const getTestMock = vi.fn()
const allTestsMock = vi.fn()
const attemptsMock = vi.fn()
const schedulesMock = vi.fn()
const usersMock = vi.fn()
const learnersForSchedulingMock = vi.fn()
const getQuestionsMock = vi.fn()
const categoriesMock = vi.fn()
const createCategoryMock = vi.fn()
const getAttemptEventsMock = vi.fn()
const listAttemptVideosMock = vi.fn()
const listExamVideoUploadStatusMock = vi.fn()
const pauseAttemptMock = vi.fn()
const resumeAttemptMock = vi.fn()
const gradeAttemptMock = vi.fn()
const updateTestMock = vi.fn()
const publishTestMock = vi.fn()
const archiveTestMock = vi.fn()
const unarchiveTestMock = vi.fn()
const duplicateTestMock = vi.fn()
const deleteTestMock = vi.fn()
const updateScheduleMock = vi.fn()
const createScheduleMock = vi.fn()
const deleteScheduleMock = vi.fn()
const addQuestionMock = vi.fn()
const updateQuestionMock = vi.fn()
const deleteQuestionMock = vi.fn()
const generateReportMock = vi.fn()
const testReportCsvMock = vi.fn()
const generateTestReportPdfMock = vi.fn()

vi.mock('../../../hooks/useUnsavedChanges', () => ({
  default: () => {},
}))

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    allTests: (...args) => allTestsMock(...args),
    getTest: (...args) => getTestMock(...args),
    attempts: (...args) => attemptsMock(...args),
    schedules: (...args) => schedulesMock(...args),
    users: (...args) => usersMock(...args),
    learnersForScheduling: (...args) => learnersForSchedulingMock(...args),
    getQuestions: (...args) => getQuestionsMock(...args),
    categories: (...args) => categoriesMock(...args),
    createCategory: (...args) => createCategoryMock(...args),
    getAttemptEvents: (...args) => getAttemptEventsMock(...args),
    listAttemptVideos: (...args) => listAttemptVideosMock(...args),
    listExamVideoUploadStatus: (...args) => listExamVideoUploadStatusMock(...args),
    pauseAttempt: (...args) => pauseAttemptMock(...args),
    resumeAttempt: (...args) => resumeAttemptMock(...args),
    gradeAttempt: (...args) => gradeAttemptMock(...args),
    updateTest: (...args) => updateTestMock(...args),
    publishTest: (...args) => publishTestMock(...args),
    archiveTest: (...args) => archiveTestMock(...args),
    unarchiveTest: (...args) => unarchiveTestMock(...args),
    duplicateTest: (...args) => duplicateTestMock(...args),
    deleteTest: (...args) => deleteTestMock(...args),
    updateSchedule: (...args) => updateScheduleMock(...args),
    createSchedule: (...args) => createScheduleMock(...args),
    deleteSchedule: (...args) => deleteScheduleMock(...args),
    addQuestion: (...args) => addQuestionMock(...args),
    updateQuestion: (...args) => updateQuestionMock(...args),
    deleteQuestion: (...args) => deleteQuestionMock(...args),
    generateReport: (...args) => generateReportMock(...args),
    testReportCsv: (...args) => testReportCsvMock(...args),
    generateTestReportPdf: (...args) => generateTestReportPdfMock(...args),
  },
}))

const adminTest = {
  id: 'test-1',
  name: 'Midterm',
  status: 'DRAFT',
  type: 'MCQ',
  description: '',
  time_limit_minutes: 60,
  attempts_allowed: 1,
}

function renderPage(initialEntries = ['/admin/tests/test-1/manage']) {
  function LocationEcho() {
    const location = useLocation()
    return (
      <>
        <div data-testid="location-pathname">{location.pathname}</div>
        <div data-testid="location-search">{location.search}</div>
      </>
    )
  }

  return render(
    <MemoryRouter initialEntries={initialEntries} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <LocationEcho />
      <Routes>
        <Route path="/admin/tests/:id/manage" element={<AdminManageTestPage />} />
        <Route path="/admin/tests" element={<div>All tests</div>} />
        <Route path="/admin/attempts/:attemptId/videos" element={<div>Attempt videos route</div>} />
        <Route path="/attempts/:id" element={<div>Attempt result route</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('AdminManageTestPage', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.resetAllMocks()

    getTestMock.mockResolvedValue({ data: adminTest })
    allTestsMock.mockResolvedValue({ data: { items: [] } })
    attemptsMock.mockResolvedValue({ data: [] })
    schedulesMock.mockResolvedValue({ data: [] })
    usersMock.mockResolvedValue({
      data: [{ id: 'learner-1', user_id: 'L-001', name: 'Learner One', role: 'LEARNER' }],
    })
    learnersForSchedulingMock.mockResolvedValue({
      data: [{ id: 'learner-1', user_id: 'L-001', name: 'Learner One', role: 'LEARNER' }],
    })
    getQuestionsMock.mockResolvedValue({ data: [] })
    categoriesMock.mockResolvedValue({ data: [] })
    createCategoryMock.mockResolvedValue({ data: { id: 'cat-2', name: 'Security', type: 'TEST', description: '' } })
    getAttemptEventsMock.mockResolvedValue({ data: [] })
    listAttemptVideosMock.mockResolvedValue({ data: [] })
    listExamVideoUploadStatusMock.mockResolvedValue({ data: [] })
    pauseAttemptMock.mockResolvedValue({ data: {} })
    resumeAttemptMock.mockResolvedValue({ data: {} })
    gradeAttemptMock.mockResolvedValue({ data: {} })
    updateTestMock.mockResolvedValue({ data: {} })
    publishTestMock.mockResolvedValue({ data: {} })
    archiveTestMock.mockResolvedValue({ data: {} })
    unarchiveTestMock.mockResolvedValue({ data: {} })
    duplicateTestMock.mockResolvedValue({ data: { id: 'test-2' } })
    deleteTestMock.mockResolvedValue({ data: { detail: 'Deleted' } })
    updateScheduleMock.mockResolvedValue({ data: {} })
    createScheduleMock.mockResolvedValue({ data: {} })
    deleteScheduleMock.mockResolvedValue({ data: { detail: 'Deleted' } })
    addQuestionMock.mockResolvedValue({ data: {} })
    updateQuestionMock.mockResolvedValue({ data: {} })
    deleteQuestionMock.mockResolvedValue({ data: { detail: 'Deleted' } })
    generateReportMock.mockResolvedValue({ data: '<html></html>' })
    testReportCsvMock.mockResolvedValue({ data: new Blob(['id']) })
    generateTestReportPdfMock.mockResolvedValue({ data: new Blob(['pdf']) })
  })

  it('shows a retry path when the initial bootstrap fails', async () => {
    getTestMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ data: adminTest })

    renderPage()

    await waitFor(() => expect(screen.getByText('offline')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(getTestMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByDisplayValue('Midterm')).toBeTruthy())
  })

  it('keeps session assignment disabled until learner and schedule are provided', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Testing sessions' }))

    const submitButton = await screen.findByRole('button', { name: 'Assign / Update session' })
    expect(submitButton.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Learner'), { target: { value: 'learner-1' } })
    expect(screen.getByRole('button', { name: 'Assign / Update session' }).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Schedule date/time' }))
    fireEvent.click(screen.getByRole('button', { name: 'In 1 hour' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Assign / Update session' }).disabled).toBe(false))
  })

  it('keeps tab changes stable and writes canonical manage-tab query values', async () => {
    renderPage(['/admin/tests/test-1/manage?tab=testing-sessions'])

    await screen.findByLabelText('Learner')
    expect(screen.getByTestId('location-search').textContent).toBe('?tab=testing-sessions')

    fireEvent.click(screen.getByRole('button', { name: 'Candidates' }))

    await screen.findByText('Assigned learners stay visible here even before they start the test, so the roster and attempt activity are tracked in one place.')
    await waitFor(() => expect(screen.getByTestId('location-search').textContent).toBe('?tab=candidates'))

    fireEvent.click(screen.getByRole('button', { name: 'Testing sessions' }))

    await screen.findByLabelText('Learner')
    await waitFor(() => expect(screen.getByTestId('location-search').textContent).toBe('?tab=sessions'))
  })

  it('shows a busy confirmation state while deleting a question', async () => {
    let resolveDelete

    getQuestionsMock
      .mockResolvedValueOnce({
        data: [{
          id: 'question-1',
          text: 'What is 2 + 2?',
          question_type: 'MCQ',
          points: 1,
          order: 1,
        }],
      })
      .mockResolvedValue({ data: [] })
    deleteQuestionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve
        }),
    )

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Test sections' }))
    await screen.findByText('What is 2 + 2?')

    fireEvent.click(screen.getByRole('button', { name: /delete what is 2 \+ 2\?/i }))
    fireEvent.click(screen.getByRole('button', { name: /confirm delete what is 2 \+ 2\?/i }))

    expect(screen.getByRole('button', { name: /confirm delete what is 2 \+ 2\?/i }).disabled).toBe(true)

    resolveDelete({ data: { detail: 'Deleted' } })

    await waitFor(() => expect(deleteQuestionMock).toHaveBeenCalledWith('question-1'))
    await waitFor(() => expect(screen.getByText('No questions found.')).toBeTruthy())
  })

  it('renders coupon management as its own settings page and saves generated draft coupons', async () => {
    renderPage()

    await screen.findByDisplayValue('Midterm')
    fireEvent.click(screen.getByRole('button', { name: 'Coupons' }))
    await waitFor(() => expect(screen.getByTestId('location-search').textContent).toBe('?section=coupons'))

    expect(screen.getByText('List of coupons')).toBeTruthy()
    expect(screen.getByText('No coupons created.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Generate coupons' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create coupon rows' }))
    await screen.findByText('SAVE-001')
    await screen.findByText('SAVE-003')

    fireEvent.change(screen.getByLabelText('Coupon code filter'), { target: { value: 'save-003' } })
    expect(screen.getByText('SAVE-003')).toBeTruthy()
    expect(screen.queryByText('SAVE-001')).toBeNull()
    expect(screen.getByText('Rows: 1 / 5')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Coupon code filter'), { target: { value: 'missing' } })
    expect(screen.getByText('No coupons match the current filters.')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Coupon code filter'), { target: { value: '' } })
    await screen.findByText('SAVE-001')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateTestMock).toHaveBeenCalledWith(
      'test-1',
      expect.objectContaining({
        runtime_settings: expect.objectContaining({
          coupons_enabled: true,
          coupon_code: 'SAVE-001',
          coupon_discount_value: 10,
          coupon_entries: expect.arrayContaining([
            expect.objectContaining({
              code: 'SAVE-001',
              discount_type: 'percentage',
              amount: 10,
            }),
          ]),
        }),
      }),
    ))
  })

  it('locks report review toggles when a test is already published', async () => {
    getTestMock.mockResolvedValueOnce({ data: { ...adminTest, status: 'PUBLISHED' } })

    renderPage()

    await screen.findByDisplayValue('Midterm')
    fireEvent.click(screen.getByRole('button', { name: 'Personal report settings' }))
    await waitFor(() => expect(screen.getByTestId('location-search').textContent).toBe('?section=personal-report'))

    expect(screen.getByLabelText('Show report').disabled).toBe(true)
    expect(screen.getByLabelText('Report content *').disabled).toBe(true)
    expect(screen.getByLabelText('Display score').disabled).toBe(true)
    expect(screen.getByLabelText('Configure report lifespan').disabled).toBe(true)
    expect(screen.getByLabelText('Export personal report as Excel file').disabled).toBe(true)
  })

  it('saves the latest score report customization state on an immediate save click', async () => {
    renderPage()

    await screen.findByDisplayValue('Midterm')
    fireEvent.click(screen.getByRole('button', { name: 'Score report settings' }))
    await waitFor(() => expect(screen.getByTestId('location-search').textContent).toBe('?section=score-report'))

    fireEvent.click(screen.getByRole('button', { name: 'Create custom settings' }))
    fireEvent.change(screen.getByLabelText('Report heading'), { target: { value: 'Operational Score Report' } })
    fireEvent.click(screen.getByLabelText('Include proctoring summary'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateTestMock).toHaveBeenCalledWith(
      'test-1',
      expect.objectContaining({
        runtime_settings: expect.objectContaining({
          custom_score_report_enabled: true,
          score_report_settings: expect.objectContaining({
            heading: 'Operational Score Report',
            include_proctoring_summary: true,
          }),
        }),
      }),
    ))
  })

  it('adds a certificate and saves it through the draft settings flow', async () => {
    renderPage()

    await screen.findByDisplayValue('Midterm')
    fireEvent.click(screen.getByRole('button', { name: 'Certificates' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add certificate' }))

    fireEvent.change(screen.getByLabelText('Certificate title'), { target: { value: 'Certificate of Mastery' } })
    fireEvent.change(screen.getByLabelText('Subtitle'), { target: { value: 'Awarded for excellent completion' } })
    fireEvent.change(screen.getByLabelText('Issuer'), { target: { value: 'SYRA Institute' } })
    fireEvent.change(screen.getByLabelText('Signer'), { target: { value: 'Dr. Review' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateTestMock).toHaveBeenCalledWith(
      'test-1',
      expect.objectContaining({
        certificate: expect.objectContaining({
          title: 'Certificate of Mastery',
          subtitle: 'Awarded for excellent completion',
          issuer: 'SYRA Institute',
          signer: 'Dr. Review',
          issue_rule: 'ON_PASS',
        }),
      }),
    ))
  })

  it('adds a translation row and persists it in runtime settings', async () => {
    renderPage()

    await screen.findByDisplayValue('Midterm')
    fireEvent.click(screen.getByRole('button', { name: 'Language settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add translation' }))

    fireEvent.change(screen.getByLabelText('Translated title'), { target: { value: 'الاختبار النصفي' } })
    fireEvent.change(screen.getByLabelText('Translated instructions'), { target: { value: 'اقرأ التعليمات بعناية' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save translation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateTestMock).toHaveBeenCalledWith(
      'test-1',
      expect.objectContaining({
        runtime_settings: expect.objectContaining({
          test_translations: [
            expect.objectContaining({
              language: 'en',
              title: 'الاختبار النصفي',
              instructions_body: 'اقرأ التعليمات بعناية',
            }),
          ],
        }),
      }),
    ))
  })

  it('imports attachment rows and persists structured attachment items', async () => {
    renderPage()

    await screen.findByDisplayValue('Midterm')
    fireEvent.click(screen.getByRole('button', { name: 'Attachments' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import from library' }))

    fireEvent.change(screen.getByLabelText('Attachment rows'), {
      target: {
        value: 'Guide | https://example.com/guide.pdf\nhttps://example.com/briefing.png',
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Import rows' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateTestMock).toHaveBeenCalledWith(
      'test-1',
      expect.objectContaining({
        runtime_settings: expect.objectContaining({
          attachment_items: [
            expect.objectContaining({
              title: 'Guide',
              url: 'https://example.com/guide.pdf',
            }),
            expect.objectContaining({
              url: 'https://example.com/briefing.png',
            }),
          ],
        }),
      }),
    ))
  })

  it('creates a category inline and assigns it before saving the draft', async () => {
    categoriesMock
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({ data: [{ id: 'cat-2', name: 'Security', type: 'TEST', description: 'Ops' }] })

    renderPage()

    await screen.findByDisplayValue('Midterm')
    fireEvent.click(screen.getByRole('button', { name: 'Test categories' }))

    fireEvent.change(screen.getByLabelText('Category name'), { target: { value: 'Security' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Ops' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create category' }))

    await waitFor(() => expect(createCategoryMock).toHaveBeenCalledWith({
      name: 'Security',
      type: 'TEST',
      description: 'Ops',
    }))

    await waitFor(() => expect(screen.getByLabelText('Assigned category').value).toBe('cat-2'))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateTestMock).toHaveBeenCalledWith(
      'test-1',
      expect.objectContaining({
        category_id: 'cat-2',
      }),
    ))
  })

  it('renders only the selected settings page and syncs the section query parameter', async () => {
    renderPage(['/admin/tests/test-1/manage?section=instructions'])

    await screen.findByLabelText('Instructions heading')
    expect(screen.getByLabelText('Instructions body')).toBeTruthy()
    expect(screen.getByTestId('location-search').textContent).toBe('?section=instructions')
    expect(screen.queryByLabelText('Test name *')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Basic information' }))

    await screen.findByLabelText('Test name *')
    await waitFor(() => expect(screen.getByTestId('location-search').textContent).toBe(''))
    expect(screen.queryByLabelText('Instructions heading')).toBeNull()
    expect(screen.queryByLabelText('Instructions body')).toBeNull()
  })

  it('shows a monitoring-specific empty state and restores attempts when filters are cleared', async () => {
    attemptsMock.mockResolvedValueOnce({
      data: [{
        id: 'attempt-1',
        exam_id: 'test-1',
        user_id: 'learner-1',
        status: 'IN_PROGRESS',
        started_at: '2026-03-07T10:00:00Z',
      }],
    })
    schedulesMock.mockResolvedValueOnce({
      data: [{
        id: 'schedule-1',
        exam_id: 'test-1',
        user_id: 'learner-1',
        access_mode: 'OPEN',
        scheduled_at: '2026-03-08T12:30:00Z',
      }],
    })

    renderPage(['/admin/tests/test-1/manage?tab=proctoring'])

    await screen.findByText('Showing attempts')
    await screen.findByText('L-001')

    fireEvent.change(screen.getAllByPlaceholderText('Search')[1], { target: { value: 'missing learner' } })

    await screen.findByText('No attempts match the current monitoring filters.')

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0])

    await screen.findByText('L-001')
    expect(screen.getByText('Showing attempts')).toBeTruthy()
  })

  it('renders lifecycle summary cards from persisted test, session, and alert data', async () => {
    getTestMock.mockResolvedValueOnce({
      data: {
        ...adminTest,
        status: 'PUBLISHED',
        runtime_status: 'OPEN',
        certificate: { signer: 'Dr. Review' },
        proctoring_config: { fullscreen_enforce: true, face_detection: true, tab_switch_detect: true },
        runtime_settings: {
          show_score_report: true,
          show_answer_review: true,
          allow_retake: true,
          retake_cooldown_hours: 24,
        },
      },
    })
    attemptsMock.mockResolvedValueOnce({
      data: [{
        id: 'attempt-1',
        exam_id: 'test-1',
        user_id: 'learner-1',
        status: 'SUBMITTED',
        started_at: '2026-03-07T10:00:00Z',
      }],
    })
    schedulesMock.mockResolvedValueOnce({
      data: [{
        id: 'schedule-1',
        exam_id: 'test-1',
        user_id: 'learner-1',
        access_mode: 'RESTRICTED',
        scheduled_at: '2026-03-08T12:30:00Z',
      }],
    })
    getAttemptEventsMock.mockResolvedValueOnce({
      data: [{ id: 'event-1', severity: 'HIGH', event_type: 'PHONE_DETECTED' }],
    })

    renderPage(['/admin/tests/test-1/manage?tab=reports'])

    await screen.findByText('Learner access')
    expect(screen.getByText('0 open / 1 restricted')).toBeTruthy()
    expect(screen.getByText('Proctoring profile')).toBeTruthy()
    expect(screen.getByText(/Fullscreen Enforce, Tab Switch Detection, Face Detection/)).toBeTruthy()
    expect(screen.getAllByText('Certificates').length).toBeGreaterThan(0)
    expect(screen.getByText('Issued by Dr. Review')).toBeTruthy()
    expect(screen.getByText('Retake policy')).toBeTruthy()
    expect(screen.getByText(/Cooldown 24/)).toBeTruthy()
    expect(screen.getByText('Review queue')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Proctoring' }).length).toBeGreaterThan(0)
  })

  it('allows grading a submitted attempt and opening its result from the candidates tab', async () => {
    attemptsMock
      .mockResolvedValueOnce({
        data: [{
          id: 'attempt-1',
          exam_id: 'test-1',
          user_id: 'learner-1',
          status: 'SUBMITTED',
          score: null,
          started_at: '2026-03-07T10:00:00Z',
          submitted_at: '2026-03-07T10:45:00Z',
        }],
      })
      .mockResolvedValue({
        data: [{
          id: 'attempt-1',
          exam_id: 'test-1',
          user_id: 'learner-1',
          status: 'GRADED',
          score: 88,
          started_at: '2026-03-07T10:00:00Z',
          submitted_at: '2026-03-07T10:45:00Z',
        }],
      })

    renderPage(['/admin/tests/test-1/manage?tab=candidates'])

    await screen.findByText('Awaiting manual grading')

    fireEvent.change(screen.getByLabelText('Grade for L-001'), { target: { value: '88' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save grade' }))

    await waitFor(() => expect(gradeAttemptMock).toHaveBeenCalledWith('attempt-1', 88))
    await waitFor(() => expect(screen.getByText('88%')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('Finalized')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Result L-001/i }))
    await screen.findByText('Attempt result route')
  })

  it('opens the canonical attempt-videos route from the candidates tab', async () => {
    attemptsMock.mockResolvedValueOnce({
      data: [{
        id: 'attempt-1',
        exam_id: 'test-1',
        user_id: 'learner-1',
        status: 'SUBMITTED',
        score: 75,
        started_at: '2026-03-07T10:00:00Z',
        submitted_at: '2026-03-07T10:45:00Z',
      }],
    })

    renderPage(['/admin/tests/test-1/manage?tab=candidates'])

    await screen.findByText('75%')

    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    fireEvent.click(screen.getByRole('button', { name: /Video L-001/i }))
    expect(openSpy).toHaveBeenCalledWith('/admin/attempts/attempt-1/videos', '_blank', 'noopener,noreferrer')
    openSpy.mockRestore()
  })

  it('does not bounce to the tests list when it is still mounted during a non-manage route transition', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/videos/attempt-1']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="*" element={<AdminManageTestPage />} />
          <Route path="/admin/tests" element={<div>All tests</div>} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.queryByText('All tests')).toBeNull())
    expect(getTestMock).not.toHaveBeenCalled()
  })

  it('shows scheduled learners in candidates even before they start and disables attempt-only actions', async () => {
    schedulesMock.mockResolvedValueOnce({
      data: [{
        id: 'schedule-1',
        exam_id: 'test-1',
        user_id: 'learner-1',
        access_mode: 'RESTRICTED',
        notes: 'Seat by the front desk',
        scheduled_at: '2026-03-08T12:30:00Z',
      }],
    })

    renderPage(['/admin/tests/test-1/manage?tab=candidates'])

    await screen.findByText('Assigned learners stay visible here even before they start the test, so the roster and attempt activity are tracked in one place.')
    expect(screen.getByText('L-001')).toBeTruthy()
    expect(screen.getByText('NOT STARTED')).toBeTruthy()
    expect(screen.getByText('Scheduled, not started')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Result L-001/i }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /Analyze L-001/i }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /Pause L-001/i }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /Video L-001/i }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /Report L-001/i }).disabled).toBe(true)
  })
})
