import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import AdminUsers from './AdminUsers'

const usersMock = vi.fn()
const createUserMock = vi.fn()
const useAuthMock = vi.fn()
const baseUser = {
  id: 'user-1',
  user_id: 'learner01',
  name: 'Learner One',
  email: 'learner01@example.com',
  role: 'LEARNER',
  is_active: true,
  created_at: '2026-03-25T08:00:00.000Z',
  updated_at: '2026-03-25T08:00:00.000Z',
}
let usersData = []

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    users: (...args) => usersMock(...args),
    createUser: (...args) => createUserMock(...args),
  },
}))

vi.mock('../../../hooks/useAuth', () => ({
  default: () => useAuthMock(),
}))

describe('AdminUsers permission modes', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    usersData = [{ ...baseUser }]
    usersMock.mockImplementation((params = {}) => {
      const normalizedSearch = String(params.search || '').toLowerCase()
      const matchesSearch = (user) => {
        if (!normalizedSearch) return true
        return [user.name, user.email, user.user_id].some((value) => String(value || '').toLowerCase().includes(normalizedSearch))
      }
      const items = usersData.filter(matchesSearch)
      return Promise.resolve({
        data: {
          items,
          total: items.length,
          skip: params.skip ?? 0,
          limit: params.limit ?? 10,
        },
      })
    })
    createUserMock.mockImplementation((payload) => {
      const createdUser = {
        id: `user-${usersData.length + 1}`,
        role: 'LEARNER',
        is_active: true,
        created_at: '2026-03-26T09:00:00.000Z',
        updated_at: '2026-03-26T09:00:00.000Z',
        ...payload,
      }
      usersData = [createdUser, ...usersData]
      return Promise.resolve({ data: createdUser })
    })
  })

  it('renders read-only access for instructors', async () => {
    useAuthMock.mockReturnValue({ user: { role: 'INSTRUCTOR' } })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminUsers />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Learner One')).toBeTruthy())
    expect(screen.getByText('Read-only access')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '+ New User' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('shows a retry action when loading users fails', async () => {
    useAuthMock.mockReturnValue({ user: { role: 'ADMIN' } })
    usersMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        data: {
          items: [baseUser],
          total: 1,
          skip: 0,
          limit: 10,
        },
      })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminUsers />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Action failed.')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(usersMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getAllByText('Learner One').length).toBeGreaterThan(0))
  })

  it('shows a filter-specific empty state and restores the full list when filters are cleared', async () => {
    useAuthMock.mockReturnValue({ user: { role: 'ADMIN' } })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminUsers />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getAllByText('Learner One').length).toBeGreaterThan(0))

    fireEvent.change(screen.getAllByPlaceholderText('Search by name, email, or ID...').at(-1), {
      target: { value: 'missing-user' },
    })

    await waitFor(() => expect(screen.getByText('No matches found')).toBeTruthy())
    expect(screen.getByText('Try adjusting your search or filters.')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear Filters' }).at(-1))

    await waitFor(() => expect(screen.getAllByText('Learner One').length).toBeGreaterThan(0))
  })

  it('shows the newly created user immediately in the current newest-first view', async () => {
    useAuthMock.mockReturnValue({ user: { role: 'ADMIN', id: 'admin-1' } })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminUsers />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getAllByText('Learner One').length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole('button', { name: '+ New User' }))
    fireEvent.change(screen.getByLabelText('User ID'), { target: { value: 'fresh-user' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fresh User' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'fresh@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Password123!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(createUserMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('User created successfully.')).toBeTruthy())
    await waitFor(() => expect(screen.getAllByText('Fresh User').length).toBeGreaterThan(0))
    expect(screen.getAllByText('fresh@example.com').length).toBeGreaterThan(0)
  })
})
