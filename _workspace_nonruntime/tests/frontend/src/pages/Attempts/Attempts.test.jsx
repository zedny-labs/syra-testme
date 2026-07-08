import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Attempts from './Attempts'

const listAttemptsMock = vi.fn()
const navigate = vi.fn()

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => navigate,
  }
})

vi.mock('../../services/attempt.service', () => ({
  listAttempts: (...args) => listAttemptsMock(...args),
}))

describe('Attempts page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('counts SUBMITTED and GRADED as completed stats', async () => {
    listAttemptsMock.mockResolvedValueOnce({
      data: [
        { id: 'a1', test_title: 'Test 1', status: 'SUBMITTED', score: 80, started_at: '2026-03-05T10:00:00Z', submitted_at: '2026-03-05T10:30:00Z' },
        { id: 'a2', test_title: 'Test 2', status: 'GRADED', score: 90, started_at: '2026-03-05T11:00:00Z', submitted_at: '2026-03-05T11:25:00Z' },
        { id: 'a3', test_title: 'Test 3', status: 'IN_PROGRESS', score: null, started_at: '2026-03-05T12:00:00Z', submitted_at: null },
      ],
    })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Attempts />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('Test 1')).toBeTruthy())
    expect(screen.getByText('SUBMITTED')).toBeTruthy()
    expect(screen.getByText('GRADED')).toBeTruthy()
    expect(screen.getByLabelText('Average score').textContent).toBe('85%')
    expect(screen.getByLabelText('Best score').textContent).toBe('90%')
    expect(screen.getByLabelText('Completed attempts').textContent).toBe('2')
  })

  it('routes in-progress attempts back to the take-test flow', async () => {
    listAttemptsMock.mockResolvedValueOnce({
      data: [
        { id: 'a3', test_title: 'Test 3', status: 'IN_PROGRESS', score: null, started_at: '2026-03-05T12:00:00Z', submitted_at: null },
      ],
    })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Attempts />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('Test 3')).toBeTruthy())
    screen.getByRole('button', { name: 'Resume attempt for Test 3' }).click()
    expect(navigate).toHaveBeenCalledWith('/attempts/a3/take')
  })

  it('retries once when the initial attempt load is empty', async () => {
    listAttemptsMock
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({
        data: {
          items: [
            { id: 'a4', test_title: 'Recovered Attempt', status: 'SUBMITTED', score: 75, started_at: '2026-03-05T13:00:00Z', submitted_at: '2026-03-05T13:20:00Z' },
          ],
        },
      })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Attempts />
      </MemoryRouter>
    )

    await waitFor(() => expect(listAttemptsMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(listAttemptsMock).toHaveBeenCalledTimes(2), { timeout: 3000 })
    await waitFor(() => expect(screen.getByText('Recovered Attempt')).toBeTruthy())
    expect(listAttemptsMock).toHaveBeenCalledTimes(2)
  })
})
