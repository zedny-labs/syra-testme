import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import AdminAttemptAnalysis from './AdminAttemptAnalysis'

const attemptsMock = vi.fn()
const getAttemptMock = vi.fn()
const getAttemptEventsMock = vi.fn()
const getAttemptAnswersMock = vi.fn()
const fetchAuthenticatedMediaObjectUrlMock = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    attempts: (...args) => attemptsMock(...args),
    getAttempt: (...args) => getAttemptMock(...args),
    getAttemptEvents: (...args) => getAttemptEventsMock(...args),
    getAttemptAnswers: (...args) => getAttemptAnswersMock(...args),
  },
}))

vi.mock('../../../utils/authenticatedMedia', () => ({
  fetchAuthenticatedMediaObjectUrl: (...args) => fetchAuthenticatedMediaObjectUrlMock(...args),
  revokeObjectUrl: vi.fn(),
}))

describe('AdminAttemptAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    attemptsMock.mockResolvedValue({ data: [] })
    getAttemptMock.mockResolvedValue({ data: null })
    getAttemptEventsMock.mockResolvedValue({ data: [] })
    getAttemptAnswersMock.mockResolvedValue({ data: [] })
    fetchAuthenticatedMediaObjectUrlMock.mockResolvedValue('blob:evidence')
  })

  afterEach(() => {
    cleanup()
  })

  it('renders a stable empty state when no attempts exist', async () => {
    render(
      <MemoryRouter
        initialEntries={['/admin/attempt-analysis']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/admin/attempt-analysis" element={<AdminAttemptAnalysis />} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('No attempts are available yet.')).toBeTruthy())
    expect(getAttemptMock).not.toHaveBeenCalled()
    expect(getAttemptEventsMock).not.toHaveBeenCalled()
    expect(getAttemptAnswersMock).not.toHaveBeenCalled()
  })

  it('auto-selects the newest available attempt and loads its details', async () => {
    attemptsMock.mockResolvedValue({
      data: [
        {
          id: 'attempt-1',
          test_title: 'Physics Midterm',
          user_name: 'Grace Hopper',
          status: 'SUBMITTED',
          started_at: '2026-03-06T10:00:00Z',
          submitted_at: '2026-03-06T10:20:00Z',
          score: 91,
        },
      ],
    })
    getAttemptMock.mockResolvedValue({
      data: {
        id: 'attempt-1',
        test_title: 'Physics Midterm',
        user_name: 'Grace Hopper',
        status: 'SUBMITTED',
        started_at: '2026-03-06T10:00:00Z',
        submitted_at: '2026-03-06T10:20:00Z',
        score: 91,
      },
    })

    render(
      <MemoryRouter
        initialEntries={['/admin/attempt-analysis']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/admin/attempt-analysis" element={<AdminAttemptAnalysis />} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => expect(getAttemptMock).toHaveBeenCalledWith('attempt-1', expect.objectContaining({
      signal: expect.any(AbortSignal),
    })))
    await waitFor(() => expect(screen.getByText('Grace Hopper')).toBeTruthy())
    expect(screen.getAllByText('Integrity').length).toBeGreaterThan(0)
  })

  it('keeps the attempt visible when secondary analysis feeds fail', async () => {
    attemptsMock.mockResolvedValue({
      data: [
        {
          id: 'attempt-2',
          test_title: 'Chemistry Quiz',
          user_name: 'Ada Lovelace',
          status: 'SUBMITTED',
          started_at: '2026-03-06T12:00:00Z',
        },
      ],
    })
    getAttemptMock.mockResolvedValue({
      data: {
        id: 'attempt-2',
        test_title: 'Chemistry Quiz',
        user_name: 'Ada Lovelace',
        status: 'SUBMITTED',
        started_at: '2026-03-06T12:00:00Z',
      },
    })
    getAttemptEventsMock.mockRejectedValue(new Error('events unavailable'))

    render(
      <MemoryRouter
        initialEntries={['/admin/attempt-analysis']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/admin/attempt-analysis" element={<AdminAttemptAnalysis />} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy())
    expect(screen.getByText(/Some analysis data could not be loaded\. Retry to refresh\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }))
    await waitFor(() => expect(screen.getByText('No events recorded.')).toBeTruthy())
  })

  it('opens evidence in a lightbox with severity details', async () => {
    attemptsMock.mockResolvedValue({
      data: [
        {
          id: 'attempt-3',
          test_title: 'Security Audit',
          user_name: 'Grace Hopper',
          status: 'SUBMITTED',
          started_at: '2026-03-06T08:00:00Z',
        },
      ],
    })
    getAttemptMock.mockResolvedValue({
      data: {
        id: 'attempt-3',
        test_title: 'Security Audit',
        user_name: 'Grace Hopper',
        status: 'SUBMITTED',
        started_at: '2026-03-06T08:00:00Z',
      },
    })
    getAttemptEventsMock.mockResolvedValue({
      data: [
        {
          id: 'event-1',
          event_type: 'PHONE_DETECTED',
          severity: 'HIGH',
          detail: 'Phone detected near frame',
          ai_confidence: 0.95,
          occurred_at: '2026-03-06T08:05:00Z',
          meta: { evidence: '/api/media/evidence/event-1.png' },
        },
      ],
    })

    render(
      <MemoryRouter
        initialEntries={['/admin/attempt-analysis']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/admin/attempt-analysis" element={<AdminAttemptAnalysis />} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Grace Hopper')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Evidence' }))
    await waitFor(() => expect(screen.getByText('95% confidence')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Evidence 1/i }))

    const dialog = await screen.findByRole('dialog', { name: 'Evidence preview' })
    expect(within(dialog).getByText('Phone detected near frame')).toBeTruthy()
    expect(within(dialog).getByText('95% confidence')).toBeTruthy()
    expect(within(dialog).getByText('HIGH')).toBeTruthy()
  })
})
