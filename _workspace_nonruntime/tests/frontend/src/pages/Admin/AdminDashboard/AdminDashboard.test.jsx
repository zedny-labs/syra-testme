import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import AdminDashboard from './AdminDashboard'

const usersMock = vi.fn()
const attemptsMock = vi.fn()
const dashboardMock = vi.fn()
const auditLogMock = vi.fn()
const allTestsMock = vi.fn()
const getAttemptEventsMock = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    users: (...args) => usersMock(...args),
    attempts: (...args) => attemptsMock(...args),
    dashboard: (...args) => dashboardMock(...args),
    auditLog: (...args) => auditLogMock(...args),
    allTests: (...args) => allTestsMock(...args),
    getAttemptEvents: (...args) => getAttemptEventsMock(...args),
  },
}))

vi.mock('../../../hooks/useAuth', () => ({
  default: () => ({ user: { name: 'Admin User', user_id: 'ADM001', role: 'ADMIN' } }),
}))

describe('AdminDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usersMock.mockResolvedValue({ data: [] })
    attemptsMock.mockResolvedValue({ data: [] })
    dashboardMock.mockResolvedValue({ data: { total_attempts: 7, total_exams: 4 } })
    auditLogMock.mockResolvedValue({ data: [] })
    allTestsMock.mockResolvedValue({ data: { items: [] } })
    getAttemptEventsMock.mockResolvedValue({ data: [] })
  })

  it('keeps the page usable when one dashboard panel fails', async () => {
    auditLogMock.mockRejectedValue(new Error('audit unavailable'))

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminDashboard />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Some dashboard panels could not be loaded in time. Refresh to retry.')).toBeTruthy())
    expect(screen.getByText('Total attempts')).toBeTruthy()
    expect(screen.getAllByText('7').length).toBeGreaterThan(0)
    expect(screen.getByText('No recent audit activity has been recorded yet.')).toBeTruthy()
  })

  it('retries dashboard loading from the refresh action', async () => {
    auditLogMock
      .mockRejectedValueOnce(new Error('audit unavailable'))
      .mockResolvedValueOnce({ data: [] })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminDashboard />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Some dashboard panels could not be loaded in time. Refresh to retry.')).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh' })[0])

    await waitFor(() => expect(auditLogMock).toHaveBeenCalledTimes(2))
  })
})
