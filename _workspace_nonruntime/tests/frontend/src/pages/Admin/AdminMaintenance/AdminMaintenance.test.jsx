import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminMaintenance from './AdminMaintenance'

const settings = vi.fn()
const updateSetting = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    settings: (...args) => settings(...args),
    updateSetting: (...args) => updateSetting(...args),
  },
}))

describe('AdminMaintenance page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings.mockResolvedValue({
      data: [
        { key: 'maintenance_mode', value: 'off' },
        { key: 'maintenance_banner', value: '  Existing banner  ' },
      ],
    })
    updateSetting.mockResolvedValue({ data: {} })
  })

  afterEach(() => {
    cleanup()
  })

  it('trims the banner before saving and exposes reset behavior', async () => {
    render(<AdminMaintenance />)

    await waitFor(() => expect(screen.getByText('Settings loaded')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Maintenance Mode'), { target: { value: 'down' } })
    fireEvent.change(screen.getByLabelText('Banner Message'), { target: { value: '  Planned maintenance at 10 PM  ' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(updateSetting).toHaveBeenNthCalledWith(1, 'maintenance_mode', 'down'))
    await waitFor(() => expect(updateSetting).toHaveBeenNthCalledWith(2, 'maintenance_banner', 'Planned maintenance at 10 PM'))
    await waitFor(() => expect(screen.getByText('Maintenance settings saved successfully.')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Banner Message'), { target: { value: 'Temporary text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reset Changes' }))

    expect(screen.getByLabelText('Banner Message').value).toBe('Planned maintenance at 10 PM')
  })

  it('applies the selected mode default banner from the helper action', async () => {
    render(<AdminMaintenance />)

    await waitFor(() => expect(screen.getByText('Settings loaded')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Maintenance Mode'), { target: { value: 'read-only' } })
    fireEvent.change(screen.getByLabelText('Banner Message'), { target: { value: 'Custom temporary banner' } })

    fireEvent.click(screen.getByRole('button', { name: 'Use Default Banner' }))

    expect(screen.getByLabelText('Banner Message').value).toBe('The system is currently in read-only mode. Some features may be unavailable.')
  })
})
