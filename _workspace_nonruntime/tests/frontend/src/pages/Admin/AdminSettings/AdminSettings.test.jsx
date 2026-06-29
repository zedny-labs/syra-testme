import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import AdminSettings from './AdminSettings'

const settingsMock = vi.fn()
const updateSettingMock = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    settings: (...args) => settingsMock(...args),
    updateSetting: (...args) => updateSettingMock(...args),
  },
}))

describe('AdminSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settingsMock.mockResolvedValue({ data: [] })
    updateSettingMock.mockResolvedValue({ data: {} })
  })

  it('shows a retry path and keeps self-registration locked until settings load succeeds', async () => {
    settingsMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ data: [{ id: '1', key: 'allow_signup', value: 'true' }] })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminSettings />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Failed to load settings. Please try again.')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Save Self-Registration' }).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(settingsMock).toHaveBeenCalledTimes(2))
  })
})
