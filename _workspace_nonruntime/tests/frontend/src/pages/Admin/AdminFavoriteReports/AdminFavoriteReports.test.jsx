import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminFavoriteReports from './AdminFavoriteReports'

const navigate = vi.fn()
const getMyPreference = vi.fn()
const updateMyPreference = vi.fn()

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}))

vi.mock('../../../hooks/useAuth', () => ({
  default: () => ({ user: { id: 'admin-1' } }),
}))

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    getMyPreference: (...args) => getMyPreference(...args),
    updateMyPreference: (...args) => updateMyPreference(...args),
  },
}))

describe('AdminFavoriteReports page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updateMyPreference.mockResolvedValue({ data: {} })
    getMyPreference.mockResolvedValue({
      data: {
        value: [
          { title: 'Legacy report', link: '/admin/legacy-report' },
        ],
      },
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('flags stale saved routes instead of navigating into dead pages', async () => {
    render(<AdminFavoriteReports />)

    await waitFor(() => expect(screen.getByText('Legacy report')).toBeTruthy())
    expect(screen.getByText('This saved route no longer exists in the current MVP navigation.')).toBeTruthy()

    const staleButton = screen.getByRole('button', { name: 'Open Legacy report' })
    expect(staleButton.disabled).toBe(true)

    fireEvent.click(staleButton)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('shows a retry path when loading favorites fails', async () => {
    getMyPreference
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ data: { value: [] } })

    render(<AdminFavoriteReports />)

    await waitFor(() => expect(screen.getByText('Could not load favorite reports.')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(getMyPreference).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('No favorites yet.')).toBeTruthy())
  })

  it('allows saving the same route with a different display title', async () => {
    getMyPreference.mockResolvedValueOnce({
      data: {
        value: [
          { title: 'Scheduled Reports', link: '/admin/reports' },
        ],
      },
    })

    render(<AdminFavoriteReports />)

    await waitFor(() => expect(screen.getByText('Scheduled Reports')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Add Favorite' }))

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Risk Alerts' } })
    fireEvent.change(screen.getByLabelText('URL or path'), { target: { value: '/admin/reports' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add Favorite' })[1])

    await waitFor(() => expect(updateMyPreference).toHaveBeenCalled())
    expect(screen.queryByText('That favorite is already saved.')).toBeNull()
  })

  it('shows a filter-specific empty state and restores favorites when filters are cleared', async () => {
    getMyPreference.mockResolvedValueOnce({
      data: {
        value: [
          { title: 'Scheduled Reports', link: '/admin/reports' },
          { title: 'Usage Snapshot', link: 'https://example.com/report' },
        ],
      },
    })

    render(<AdminFavoriteReports />)

    await waitFor(() => expect(screen.getByText('Showing 2 favorite(s) across 2 saved.')).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText('Search saved favorites...'), { target: { value: 'missing report' } })

    await waitFor(() => expect(screen.getByText('No favorites match the current filters.')).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0])

    await waitFor(() => expect(screen.getByText('Scheduled Reports')).toBeTruthy())
    expect(screen.getByText('Showing 2 favorite(s) across 2 saved.')).toBeTruthy()
  })
})
