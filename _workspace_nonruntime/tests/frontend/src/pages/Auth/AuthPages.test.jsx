import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import ForgotPassword from './ForgotPassword'
import ResetPassword from './ResetPassword'
import ChangePassword from './ChangePassword'
import SignUp from './SignUp'

const forgotPasswordMock = vi.fn()
const resetPasswordMock = vi.fn()
const changePasswordMock = vi.fn()
const signupMock = vi.fn()
const signupStatusMock = vi.fn()

vi.mock('../../services/auth.service', () => ({
  forgotPassword: (...args) => forgotPasswordMock(...args),
  resetPassword: (...args) => resetPasswordMock(...args),
  changePassword: (...args) => changePasswordMock(...args),
  signup: (...args) => signupMock(...args),
  signupStatus: (...args) => signupStatusMock(...args),
}))

function renderWithRouter(ui, initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="*" element={ui} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Auth recovery pages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the backend delivery error on forgot password', async () => {
    forgotPasswordMock.mockRejectedValue({
      response: { data: { detail: 'Email transport not configured: set BREVO_API_KEY or SMTP settings.' } },
    })

    renderWithRouter(<ForgotPassword />)
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'admin@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send Reset Link' }))

    expect(await screen.findByText('Email transport not configured: set BREVO_API_KEY or SMTP settings.')).toBeTruthy()
  })

  it('prevents reset password submission when confirmation does not match', () => {
    renderWithRouter(<ResetPassword />, '/reset-password?token=abc123')

    fireEvent.change(screen.getByPlaceholderText('New password'), { target: { value: 'Password123!' } })
    fireEvent.change(screen.getByPlaceholderText('Confirm new password'), { target: { value: 'Password1234!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reset Password' }))

    expect(screen.getByText('Passwords do not match.')).toBeTruthy()
    expect(resetPasswordMock).not.toHaveBeenCalled()
  })

  it('prevents change password submission when confirmation does not match', () => {
    renderWithRouter(<ChangePassword />, '/change-password')

    fireEvent.change(screen.getByPlaceholderText('Current password'), { target: { value: 'OldPassword123!' } })
    fireEvent.change(screen.getByPlaceholderText('New password'), { target: { value: 'Password123!' } })
    fireEvent.change(screen.getByPlaceholderText('Confirm new password'), { target: { value: 'Password1234!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Update Password' }))

    expect(screen.getByText('Passwords do not match.')).toBeTruthy()
    expect(changePasswordMock).not.toHaveBeenCalled()
  })

  it('retries self-registration availability after a bootstrap failure', async () => {
    signupStatusMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ data: { allowed: true } })

    renderWithRouter(<SignUp />, '/signup')

    await waitFor(() => expect(screen.getByText('Could not check registration availability. Please try again later.')).toBeTruthy())
    expect(screen.getByPlaceholderText('Full name').disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Retry availability check' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign Up' }).disabled).toBe(false))
  })

  it('prevents signup submission when confirmation does not match', async () => {
    signupStatusMock.mockResolvedValue({ data: { allowed: true } })

    renderWithRouter(<SignUp />, '/signup')

    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign Up' }).disabled).toBe(false))
    fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: 'Learner One' } })
    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: 'learner@example.com' } })
    fireEvent.change(screen.getByPlaceholderText('Student ID / Username'), { target: { value: 'STD-001' } })
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'Password123!' } })
    fireEvent.change(screen.getByPlaceholderText('Confirm password'), { target: { value: 'Password1234!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign Up' }))

    expect(screen.getByText('Passwords do not match.')).toBeTruthy()
    expect(signupMock).not.toHaveBeenCalled()
  })
})
