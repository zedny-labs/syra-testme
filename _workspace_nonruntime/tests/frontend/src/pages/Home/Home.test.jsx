import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import Home from './Home'

const apiGet = vi.fn()
const listAttemptsMock = vi.fn()

vi.mock('../../services/api', () => ({
  default: {
    get: (...args) => apiGet(...args),
  },
}))

vi.mock('../../hooks/useAuth', () => ({
  default: () => ({ user: { name: 'Learner One' } }),
}))

vi.mock('../../services/attempt.service', () => ({
  listAttempts: (...args) => listAttemptsMock(...args),
}))

describe('Home page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listAttemptsMock.mockResolvedValue({ data: [] })
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps learner navigation usable and retries after dashboard failure', async () => {
    apiGet
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({
        data: {
          total_exams: 3,
          total_attempts: 4,
          in_progress_attempts: 1,
          best_score: 92.5,
          upcoming_count: 1,
          upcoming_schedules: [
            {
              id: 'schedule-1',
              test_title: 'Biology Quiz',
              scheduled_at: '2026-03-08T09:00:00Z',
              access_mode: 'OPEN',
            },
          ],
        },
      })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Home />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText(/Dashboard data is temporarily unavailable/i)).toBeTruthy())
    expect(screen.getAllByRole('link', { name: 'Browse Tests' })[0]).toBeTruthy()
    expect(screen.getByText('No upcoming exams scheduled.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry dashboard' }))

    await waitFor(() => expect(screen.getAllByText('Biology Quiz').length).toBeGreaterThan(0))
  })

  it('falls back cleanly when the dashboard endpoint resolves without a payload', async () => {
    apiGet.mockReset()
    apiGet.mockResolvedValue(undefined)

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Home />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText(/Dashboard data is temporarily unavailable/i)).toBeTruthy())
    expect(screen.getAllByRole('link', { name: 'Browse Tests' })[0]).toBeTruthy()
  })
})
