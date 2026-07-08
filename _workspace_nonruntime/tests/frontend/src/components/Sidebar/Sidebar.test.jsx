import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import Sidebar from './Sidebar'

const useAuthMock = vi.fn()

vi.mock('../../hooks/useAuth', () => ({
  default: () => useAuthMock(),
}))

afterEach(() => {
  cleanup()
})

describe('Sidebar role visibility', () => {
  it('hides admin sections for INSTRUCTOR', () => {
    useAuthMock.mockReturnValue({ user: { role: 'INSTRUCTOR' }, hasPermission: () => false })
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Sidebar />
      </MemoryRouter>
    )
    expect(screen.queryByText('Manage Tests')).toBeNull()
    expect(screen.queryByText('Testing Center')).toBeNull()
  })

  it('shows instructor-safe sections when permissions are granted', async () => {
    const allowed = new Set(['Assign Schedules', 'Manage Users'])
    useAuthMock.mockReturnValue({
      user: { role: 'INSTRUCTOR' },
      hasPermission: (feature) => allowed.has(feature),
    })
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Sidebar />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand Testing Center' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand Users' }))
    await waitFor(() => expect(screen.getByText('Testing Sessions')).toBeTruthy())
    await waitFor(() => expect(screen.getByText('User Profiles')).toBeTruthy())
    expect(screen.queryByRole('link', { name: 'Training' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Surveys' })).toBeNull()
    expect(screen.queryByText('Manage Tests')).toBeNull()
  })

  it('shows admin sections for ADMIN', async () => {
    useAuthMock.mockReturnValue({ user: { role: 'ADMIN' }, hasPermission: () => true })
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Sidebar />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand Tests' }))
    await waitFor(() => expect(screen.getByText('Manage Tests')).toBeTruthy())
    expect(screen.getAllByText('Testing Center').length).toBeGreaterThan(0)
  })
})
