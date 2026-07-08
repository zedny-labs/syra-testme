import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminSubscribers from './AdminSubscribers'

const settings = vi.fn()
const updateSetting = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    settings: (...args) => settings(...args),
    updateSetting: (...args) => updateSetting(...args),
  },
}))

describe('AdminSubscribers page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        data: [
          { key: 'subscribers', value: '["ops@example.com"]' },
        ],
      })
  })

  afterEach(() => {
    cleanup()
  })

  it('requires a successful settings load before subscriber edits are enabled', async () => {
    render(<AdminSubscribers />)

    await waitFor(() => expect(screen.getByText('Failed to load subscribers.')).toBeTruthy())
    const input = screen.getByLabelText('Add subscribers')
    expect(input.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.getByText('ops@example.com')).toBeTruthy())
    expect(screen.getByLabelText('Add subscribers').disabled).toBe(false)
  })

  it('normalizes loaded subscribers and requires explicit confirmation before removing one', async () => {
    settings.mockReset()
    settings.mockResolvedValue({
      data: [
        { key: 'subscribers', value: '["OPS@example.com","ops@example.com","audit@example.com"]' },
      ],
    })
    updateSetting.mockResolvedValue({ data: {} })

    render(<AdminSubscribers />)

    await waitFor(() => expect(screen.getByText('ops@example.com')).toBeTruthy())
    expect(screen.getAllByText('ops@example.com')).toHaveLength(1)

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0])
    expect(updateSetting).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Confirm remove' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }))

    await waitFor(() => expect(updateSetting).toHaveBeenCalled())
  })

  it('shows a filter-specific empty state and restores subscribers when filters are cleared', async () => {
    settings.mockReset()
    settings.mockResolvedValue({
      data: [
        { key: 'subscribers', value: '["ops@example.com","audit@example.com"]' },
      ],
    })

    render(<AdminSubscribers />)

    await waitFor(() => expect(screen.getByText('Showing subscribers.')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search subscribers'), { target: { value: 'missing-domain' } })

    await waitFor(() => expect(screen.getByText('No subscribers match the current search.')).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0])

    await waitFor(() => expect(screen.getByText('ops@example.com')).toBeTruthy())
    expect(screen.getByText('Showing subscribers.')).toBeTruthy()
  })
})
