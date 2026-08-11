import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminSchedules from './AdminSchedules'

const schedulesMock = vi.fn()
const allTestsMock = vi.fn()
const usersMock = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    schedules: (...args) => schedulesMock(...args),
    allTests: (...args) => allTestsMock(...args),
    users: (...args) => usersMock(...args),
    createSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
  },
}))

describe('AdminSchedules', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    schedulesMock.mockResolvedValue({ data: [] })
    allTestsMock.mockResolvedValue({
      data: { items: [{ id: 'test-1', title: 'Physics Quiz' }] },
    })
    usersMock.mockResolvedValue({
      data: [{ id: 'user-1', user_id: 'STU-1', name: 'Learner One' }],
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps existing schedules visible when lookup data fails and disables new assignments', async () => {
    schedulesMock.mockResolvedValueOnce({
      data: [{
        id: 'schedule-1',
        user_name: 'Learner One',
        test_title: 'Physics Quiz',
        scheduled_at: '2026-03-08T09:30:00Z',
        access_mode: 'OPEN',
        notes: 'Morning lab',
      }],
    })
    allTestsMock.mockRejectedValueOnce(new Error('tests unavailable'))
    usersMock.mockRejectedValueOnce(new Error('users unavailable'))

    render(<AdminSchedules />)

    await waitFor(() => expect(screen.getByText('Learner One')).toBeTruthy())
    expect(screen.getByText('Some assignment lookup data could not be loaded. Existing schedules remain visible, but assigning new schedules is temporarily disabled.')).toBeTruthy()
    expect(screen.getByRole('button', { name: '+ Assign' }).disabled).toBe(true)
  })

  it('keeps the assign action disabled until a scheduled time is provided', async () => {
    render(<AdminSchedules />)

    await waitFor(() => expect(screen.getByText('No schedules yet.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '+ Assign' }))

    fireEvent.change(screen.getByLabelText('User'), { target: { value: 'user-1' } })
    fireEvent.change(screen.getByLabelText('Test'), { target: { value: 'test-1' } })

    const assignButton = screen.getByRole('button', { name: 'Assign' })
    expect(assignButton.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Scheduled At'), { target: { value: '2026-03-08T09:30' } })
    expect(screen.getByRole('button', { name: 'Assign' }).disabled).toBe(false)
  })

  it('shows a filter-specific empty state and restores the schedule list when filters are cleared', async () => {
    schedulesMock.mockResolvedValueOnce({
      data: [{
        id: 'schedule-1',
        user_name: 'Learner One',
        test_title: 'Physics Quiz',
        scheduled_at: '2026-03-08T09:30:00Z',
        access_mode: 'OPEN',
        notes: 'Morning lab',
      }],
    })

    render(<AdminSchedules />)

    await waitFor(() => expect(screen.getByText((_, element) => element?.textContent === 'Showing 1 schedule(s) across 1 loaded.')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search schedules'), { target: { value: 'chemistry' } })

    await waitFor(() => expect(screen.getByText('No schedules match the current filters.')).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0])

    await waitFor(() => expect(screen.getByText('Learner One')).toBeTruthy())
    expect(screen.getByText((_, element) => element?.textContent === 'Showing 1 schedule(s) across 1 loaded.')).toBeTruthy()
  })
})
