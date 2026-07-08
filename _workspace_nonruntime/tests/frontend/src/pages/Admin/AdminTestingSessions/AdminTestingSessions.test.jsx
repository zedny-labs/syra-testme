import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminTestingSessions from './AdminTestingSessions'

const schedules = vi.fn()
const schedulableTests = vi.fn()
const learnersForScheduling = vi.fn()
const createSchedule = vi.fn()
const updateSchedule = vi.fn()
const deleteSchedule = vi.fn()

vi.mock('../../../hooks/useAuth', () => ({
  default: () => ({
    hasPermission: (feature) => feature === 'Assign Schedules',
  }),
}))

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    schedules: (...args) => schedules(...args),
    schedulableTests: (...args) => schedulableTests(...args),
    learnersForScheduling: (...args) => learnersForScheduling(...args),
    createSchedule: (...args) => createSchedule(...args),
    updateSchedule: (...args) => updateSchedule(...args),
    deleteSchedule: (...args) => deleteSchedule(...args),
  },
}))

describe('AdminTestingSessions page', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    createSchedule.mockResolvedValue({ data: {} })
    updateSchedule.mockResolvedValue({ data: {} })
    deleteSchedule.mockResolvedValue({ data: { detail: 'Deleted' } })
    schedules.mockResolvedValue({
      data: [
        {
          id: 'session-1',
          exam_id: 'exam-1',
          user_id: 'user-1',
          test_title: 'Physics Final',
          user_name: 'Learner One',
          scheduled_at: '2026-03-09T09:00:00Z',
          access_mode: 'OPEN',
        },
      ],
    })
    schedulableTests.mockRejectedValue(new Error('tests unavailable'))
    learnersForScheduling.mockRejectedValue(new Error('users unavailable'))
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps existing sessions visible when lookup data fails and disables new-session creation', async () => {
    render(<AdminTestingSessions />)

    await waitFor(() => expect(screen.getByText('Physics Final')).toBeTruthy())
    expect(screen.getByText('Some lookup data could not be loaded. Existing sessions remain visible, but creating new sessions is temporarily disabled.')).toBeTruthy()
    expect(screen.getByRole('button', { name: '+ New Session' }).disabled).toBe(true)
  })

  it('locks the confirm-delete controls while deletion is in flight', async () => {
    let resolveDelete
    deleteSchedule.mockReturnValueOnce(new Promise((resolve) => {
      resolveDelete = resolve
    }))
    schedulableTests.mockResolvedValue({ data: [] })
    learnersForScheduling.mockResolvedValue({ data: [] })

    render(<AdminTestingSessions />)

    await waitFor(() => expect(screen.getByText('Physics Final')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /delete session for learner one for physics final/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /confirm delete for session learner one for physics final/i })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /confirm delete for session learner one for physics final/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /confirm delete for session learner one for physics final/i }).disabled).toBe(true))
    expect(screen.getByRole('button', { name: /keep session for learner one for physics final/i }).disabled).toBe(true)

    resolveDelete({ data: { detail: 'Deleted' } })
    await waitFor(() => expect(deleteSchedule).toHaveBeenCalledWith('session-1'))
  })

  it('shows a filter-specific empty state and restores the full list when filters are cleared', async () => {
    schedulableTests.mockResolvedValue({ data: [] })
    learnersForScheduling.mockResolvedValue({ data: [] })

    render(<AdminTestingSessions />)

    await waitFor(() => expect(screen.getByText('Physics Final')).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText('Search by test, learner, or code...'), {
      target: { value: 'chemistry' },
    })

    await waitFor(() => expect(screen.getByText('No sessions match the current filters.')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' }).at(-1))

    await waitFor(() => expect(screen.getByText('Physics Final')).toBeTruthy())
  })
})
