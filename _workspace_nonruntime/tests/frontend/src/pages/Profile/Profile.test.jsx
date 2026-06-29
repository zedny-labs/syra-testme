import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Profile from './Profile'

const updateProfileMock = vi.fn()
const changePasswordMock = vi.fn()
const useAuthMock = vi.fn()
const setUserMock = vi.fn()

vi.mock('../../hooks/useAuth', () => ({
  default: () => useAuthMock(),
}))

vi.mock('../../services/auth.service', () => ({
  updateProfile: (...args) => updateProfileMock(...args),
  changePassword: (...args) => changePasswordMock(...args),
}))

vi.mock('../../hooks/useUnsavedChanges', () => ({
  default: () => {},
}))

describe('Profile page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAuthMock.mockReturnValue({
      user: {
        name: 'Learner One',
        email: 'old@example.com',
        user_id: 'learner-1',
        role: 'LEARNER',
      },
      setUser: setUserMock,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('skips profile submission when nothing changed', async () => {
    render(<Profile />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(screen.getByText('No changes to save.')).toBeTruthy())
    expect(updateProfileMock).not.toHaveBeenCalled()
  })

  it('normalizes profile values before saving', async () => {
    updateProfileMock.mockResolvedValue({
      data: {
        name: 'Learner Prime',
        email: 'learner@example.com',
      },
    })

    render(<Profile />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Learner Prime  ' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: '  LEARNER@EXAMPLE.COM ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(updateProfileMock).toHaveBeenCalledWith({
      name: 'Learner Prime',
      email: 'learner@example.com',
    }))
    expect(setUserMock).toHaveBeenCalled()
    expect(await screen.findByText('Profile updated successfully.')).toBeTruthy()
  })

  it('requires the current password before changing the password', () => {
    render(<Profile />)

    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'Password123!' } })
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'Password123!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Update Password' }))

    expect(screen.getByText('Current password is required.')).toBeTruthy()
    expect(changePasswordMock).not.toHaveBeenCalled()
  })
})
