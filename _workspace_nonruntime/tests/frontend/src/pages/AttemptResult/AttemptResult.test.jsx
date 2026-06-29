import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import AttemptResult from './AttemptResult'

const getAttempt = vi.fn()
const getAttemptAnswers = vi.fn()
const getAttemptProctoringSummary = vi.fn()
const generateAttemptReport = vi.fn()
const reviewAttemptAnswer = vi.fn()
const finalizeAttemptReview = vi.fn()
const getTestQuestions = vi.fn()
const getTest = vi.fn()

vi.mock('../../services/attempt.service', () => ({
  getAttempt: (...args) => getAttempt(...args),
  getAttemptAnswers: (...args) => getAttemptAnswers(...args),
  getAttemptProctoringSummary: (...args) => getAttemptProctoringSummary(...args),
  generateAttemptReport: (...args) => generateAttemptReport(...args),
  reviewAttemptAnswer: (...args) => reviewAttemptAnswer(...args),
  finalizeAttemptReview: (...args) => finalizeAttemptReview(...args),
}))

vi.mock('../../services/test.service', () => ({
  getTestQuestions: (...args) => getTestQuestions(...args),
  getTest: (...args) => getTest(...args),
}))

vi.mock('../../services/api', () => ({
  default: {
    get: vi.fn(),
  },
}))

function renderResult(initialEntry = '/attempts/attempt-1') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/attempts/:id" element={<AttemptResult />} />
        <Route path="/admin/tests/:id/manage" element={<div>Manage test route</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('AttemptResult page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.open = vi.fn(() => ({
      closed: false,
      document: {
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
      },
      close: vi.fn(),
    }))
    window.URL.createObjectURL = vi.fn(() => 'blob:report')
    window.URL.revokeObjectURL = vi.fn()
    HTMLAnchorElement.prototype.click = vi.fn()
    getAttempt.mockResolvedValue({
      data: {
        id: 'attempt-1',
        exam_id: 'exam-1',
        test_title: 'Biology Quiz',
        status: 'SUBMITTED',
        score: 75,
        started_at: '2026-03-05T10:00:00Z',
        submitted_at: '2026-03-05T10:20:00Z',
      },
    })
    getTest.mockResolvedValue({
      data: {
        id: 'exam-1',
        title: 'Biology Quiz',
        settings: { show_answer_review: true, show_correct_answers: true },
        passing_score: 60,
      },
    })
    getAttemptProctoringSummary.mockResolvedValue({
      data: {
        saved_recordings: 0,
        expected_recordings: 0,
        total_events: 0,
        serious_alerts: 0,
        risk_score: 0,
        recent_events: [],
      },
    })
    reviewAttemptAnswer.mockResolvedValue({ data: { id: 'answer-1', question_id: 'question-1', answer: 'Detailed response', is_correct: null, points_earned: 4 } })
    finalizeAttemptReview.mockResolvedValue({
      data: {
        id: 'attempt-1',
        exam_id: 'exam-1',
        test_title: 'Biology Quiz',
        status: 'GRADED',
        score: 88,
        started_at: '2026-03-05T10:00:00Z',
        submitted_at: '2026-03-05T10:20:00Z',
      },
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps the result summary visible when secondary review data fails', async () => {
    getTestQuestions.mockResolvedValue({ data: [] })
    getAttemptAnswers.mockRejectedValue(new Error('answers down'))

    renderResult()

    await waitFor(() => expect(screen.getByText('Biology Quiz')).toBeTruthy())
    expect(screen.getByText('Some details could not be loaded. Try again to see the full review.')).toBeTruthy()
    expect(screen.getByText('75')).toBeTruthy()
  })

  it('formats JSON-encoded multi answers into readable review text', async () => {
    getTestQuestions.mockResolvedValue({
      data: [
        {
          id: 'question-1',
          text: 'Select two answers',
          correct_answer: '["A","C"]',
        },
      ],
    })
    getAttemptAnswers.mockResolvedValue({
      data: [
        {
          id: 'answer-1',
          question_id: 'question-1',
          answer: '["A","C"]',
          is_correct: true,
        },
      ],
    })

    renderResult()

    await waitFor(() => expect(screen.getByText('Your answer:')).toBeTruthy())
    expect(screen.getByText(/A, C/)).toBeTruthy()
  })

  it('loads and shows a proctoring violation summary', async () => {
    getTestQuestions.mockResolvedValue({ data: [] })
    getAttemptAnswers.mockResolvedValue({ data: [] })
    getAttemptProctoringSummary.mockResolvedValue({
      data: {
        saved_recordings: 2,
        expected_recordings: 2,
        total_events: 2,
        serious_alerts: 2,
        risk_score: 5,
        recent_events: [
          {
            id: 'event-1',
            event_type: 'PHONE_DETECTED',
            severity: 'HIGH',
            detail: 'Phone detected near desk',
            ai_confidence: 0.91,
            occurred_at: '2026-03-05T10:10:00Z',
          },
          {
            id: 'event-2',
            event_type: 'LOOKING_AWAY',
            severity: 'MEDIUM',
            detail: 'Eyes off screen for too long',
            ai_confidence: 0.63,
            occurred_at: '2026-03-05T10:12:00Z',
          },
        ],
      },
    })

    renderResult()

    await waitFor(() => expect(screen.getAllByText('Proctoring Summary').length).toBeGreaterThan(0))
    expect(screen.getByText('Total Alerts')).toBeTruthy()
    expect(screen.getByText('Serious Alerts')).toBeTruthy()
    expect(screen.getByText('Phone detected near desk')).toBeTruthy()
    expect(screen.getByText('91% confidence')).toBeTruthy()
  })

  it('opens the dedicated exam report and downloads the PDF version', async () => {
    getTestQuestions.mockResolvedValue({ data: [] })
    getAttemptAnswers.mockResolvedValue({ data: [] })
    generateAttemptReport.mockImplementation((attemptId, outputFormat) => {
      expect(attemptId).toBe('attempt-1')
      if (outputFormat === 'pdf') {
        return Promise.resolve({ data: new Blob(['pdf'], { type: 'application/pdf' }) })
      }
      return Promise.resolve({ data: '<html><body>Report</body></html>' })
    })

    renderResult()

    await waitFor(() => expect(screen.getByRole('button', { name: /Open exam report/i })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Open exam report/i }))
    await waitFor(() => expect(generateAttemptReport).toHaveBeenCalledWith('attempt-1', 'html'))
    expect(window.open).toHaveBeenCalled()
    expect(window.open.mock.results[0].value.document.write).toHaveBeenCalledWith('<html><body>Report</body></html>')

    fireEvent.click(screen.getByRole('button', { name: /Download PDF report/i }))
    await waitFor(() => expect(generateAttemptReport).toHaveBeenCalledWith('attempt-1', 'pdf'))
    expect(window.URL.createObjectURL).toHaveBeenCalled()
  })

  it('reuses a placeholder tab for the HTML report instead of surfacing a false popup error', async () => {
    const openMock = vi.fn()
    const writeMock = vi.fn()
    const closeMock = vi.fn()
    window.open = vi.fn(() => ({
      closed: false,
      document: {
        open: openMock,
        write: writeMock,
        close: closeMock,
      },
      close: vi.fn(),
    }))
    getTestQuestions.mockResolvedValue({ data: [] })
    getAttemptAnswers.mockResolvedValue({ data: [] })
    generateAttemptReport.mockResolvedValue({ data: '<html><body>Report</body></html>' })

    renderResult()

    await waitFor(() => expect(screen.getByRole('button', { name: /Open exam report/i })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Open exam report/i }))

    await waitFor(() => expect(writeMock).toHaveBeenCalledWith('<html><body>Report</body></html>'))
    expect(openMock).toHaveBeenCalled()
    expect(closeMock).toHaveBeenCalled()
    expect(screen.queryByText('Unable to open the report in a new tab.')).toBeNull()
  })

  it('shows an awaiting manual review state when the attempt has no final score yet', async () => {
    getAttempt.mockResolvedValueOnce({
      data: {
        id: 'attempt-1',
        exam_id: 'exam-1',
        test_title: 'Biology Quiz',
        status: 'SUBMITTED',
        score: null,
        started_at: '2026-03-05T10:00:00Z',
        submitted_at: '2026-03-05T10:20:00Z',
      },
    })
    getTestQuestions.mockResolvedValueOnce({
      data: [
        { id: 'question-1', text: 'Explain the process', question_type: 'TEXT' },
        { id: 'question-2', text: 'Pick one', question_type: 'MCQ', correct_answer: 'A' },
      ],
    })
    getAttemptAnswers.mockResolvedValueOnce({
      data: [
        { id: 'answer-1', question_id: 'question-1', answer: 'Detailed response', is_correct: null },
        { id: 'answer-2', question_id: 'question-2', answer: 'A', is_correct: true },
      ],
    })

    renderResult()

    await waitFor(() => expect(screen.getByText('Awaiting manual review')).toBeTruthy())
    expect(screen.getByText('Saved Answers')).toBeTruthy()
    expect(screen.queryByText('Answer Review')).toBeNull()
  })

  it('shows manual-review answers accurately and returns admins to Manage Test when opened from there', async () => {
    getAttempt.mockResolvedValueOnce({
      data: {
        id: 'attempt-1',
        exam_id: 'exam-1',
        test_title: 'Biology Quiz',
        status: 'GRADED',
        score: 88,
        started_at: '2026-03-05T10:00:00Z',
        submitted_at: '2026-03-05T10:20:00Z',
      },
    })
    getTestQuestions.mockResolvedValueOnce({
      data: [
        { id: 'question-1', text: 'Explain the process', question_type: 'TEXT', correct_answer: 'Reference rubric answer' },
      ],
    })
    getAttemptAnswers.mockResolvedValueOnce({
      data: [
        { id: 'answer-1', question_id: 'question-1', answer: 'Detailed response', is_correct: null },
      ],
    })

    renderResult('/attempts/attempt-1?from=manage-test&testId=test-1&tab=candidates')

    await waitFor(() => expect(screen.getByText('Opened from Manage Test')).toBeTruthy())
    expect(screen.getByText('Manual review')).toBeTruthy()
    expect(screen.queryByText('Wrong')).toBeNull()
    expect(screen.getByText(/Reference:/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Back to Manage Test/i }))
    await waitFor(() => expect(screen.getByText('Manage test route')).toBeTruthy())
  })

  it('allows admins to save manual review points and finalize the review from the shared result page', async () => {
    getAttempt.mockResolvedValueOnce({
      data: {
        id: 'attempt-1',
        exam_id: 'exam-1',
        test_title: 'Biology Quiz',
        status: 'SUBMITTED',
        score: null,
        started_at: '2026-03-05T10:00:00Z',
        submitted_at: '2026-03-05T10:20:00Z',
      },
    })
    getTestQuestions.mockResolvedValueOnce({
      data: [
        { id: 'question-1', text: 'Explain the process', question_type: 'TEXT', points: 5, correct_answer: 'Reference rubric answer' },
      ],
    })
    getAttemptAnswers.mockResolvedValueOnce({
      data: [
        { id: 'answer-1', question_id: 'question-1', answer: 'Detailed response', is_correct: null, points_earned: null },
      ],
    })

    renderResult('/attempts/attempt-1?from=manage-test&testId=test-1&tab=candidates')

    await waitFor(() => expect(screen.getByText('Manual review workflow')).toBeTruthy())
    const input = screen.getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: /Save review/i }))

    await waitFor(() => expect(reviewAttemptAnswer).toHaveBeenCalledWith('attempt-1', 'answer-1', 4))
    expect(screen.getByText(/Review points saved/)).toBeTruthy()
    expect(screen.getByText(/Awarded points:/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Finalize review/i }))
    await waitFor(() => expect(finalizeAttemptReview).toHaveBeenCalledWith('attempt-1'))
    expect(screen.getByText(/Attempt review finalized and score published/)).toBeTruthy()
  })
})
