import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminUserGroups from './AdminUserGroups'

const userGroups = vi.fn()
const users = vi.fn()
const allTests = vi.fn()
const schedules = vi.fn()
const getUserGroupMembersMock = vi.fn()
const createUserGroupMock = vi.fn()
const deleteUserGroupMock = vi.fn()
const addUserGroupMemberMock = vi.fn()
const removeUserGroupMemberMock = vi.fn()
const updateScheduleMock = vi.fn()
const createScheduleMock = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    userGroups: (...args) => userGroups(...args),
    users: (...args) => users(...args),
    allTests: (...args) => allTests(...args),
    schedules: (...args) => schedules(...args),
    getUserGroupMembers: (...args) => getUserGroupMembersMock(...args),
    createUserGroup: (...args) => createUserGroupMock(...args),
    deleteUserGroup: (...args) => deleteUserGroupMock(...args),
    addUserGroupMember: (...args) => addUserGroupMemberMock(...args),
    removeUserGroupMember: (...args) => removeUserGroupMemberMock(...args),
    updateSchedule: (...args) => updateScheduleMock(...args),
    createSchedule: (...args) => createScheduleMock(...args),
  },
}))

describe('AdminUserGroups page', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    vi.resetAllMocks()
    getUserGroupMembersMock.mockResolvedValue({ data: [] })
    createUserGroupMock.mockResolvedValue({ data: {} })
    deleteUserGroupMock.mockResolvedValue({ data: {} })
    addUserGroupMemberMock.mockResolvedValue({ data: {} })
    removeUserGroupMemberMock.mockResolvedValue({ data: {} })
    updateScheduleMock.mockResolvedValue({ data: {} })
    createScheduleMock.mockResolvedValue({ data: {} })
    userGroups.mockResolvedValue({
      data: [
        { id: 'group-1', name: 'Cohort A', description: 'March intake' },
      ],
    })
    users.mockRejectedValue(new Error('users failed'))
    allTests.mockRejectedValue(new Error('tests failed'))
    schedules.mockRejectedValue(new Error('schedules failed'))
  })

  it('keeps the group list usable when supporting bootstrap data fails', async () => {
    render(<AdminUserGroups />)

    await waitFor(() => expect(screen.getByText('Cohort A')).toBeTruthy())
    expect(screen.getByText('Some group management data could not be loaded. Retry to enable member assignment and bulk scheduling.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open group Cohort A' }))

    await waitFor(() => expect(screen.getByText('Learner lookup is temporarily unavailable. Retry to manage group members.')).toBeTruthy())
    expect(screen.getByText('Test and schedule data are temporarily unavailable. Retry before running bulk assignments.')).toBeTruthy()
    expect(screen.getByPlaceholderText('Search learners by name, email, or ID...').disabled).toBe(true)
  })

  it('shows a busy confirmation state while deleting a group', async () => {
    let resolveDelete

    deleteUserGroupMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve
        }),
    )

    render(<AdminUserGroups />)

    await waitFor(() => expect(screen.getByText('Cohort A')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Delete Cohort A' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Cohort A' }))

    expect(screen.getByRole('button', { name: 'Confirm delete Cohort A' }).disabled).toBe(true)

    resolveDelete({ data: {} })

    await waitFor(() => expect(deleteUserGroupMock).toHaveBeenCalledWith('group-1'))
  })
})
