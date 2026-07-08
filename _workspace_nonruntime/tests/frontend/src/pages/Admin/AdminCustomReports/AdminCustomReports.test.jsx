import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminCustomReports from './AdminCustomReports'

const previewCustomReport = vi.fn()
const exportCustomReport = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    previewCustomReport: (...args) => previewCustomReport(...args),
    exportCustomReport: (...args) => exportCustomReport(...args),
  },
}))

describe('AdminCustomReports page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    previewCustomReport.mockResolvedValue({
      data: {
        rows: [
          {
            id: 'a1',
            test_title: 'Physics',
            user_name: 'Grace Hopper',
            status: 'GRADED',
            score: 92,
            started_at: '2026-03-06T10:00:00Z',
            submitted_at: '2026-03-06T10:45:00Z',
          },
        ],
        total: 1,
        available_columns: ['id', 'test_title', 'user_name', 'status', 'score', 'started_at', 'submitted_at'],
      },
    })
    exportCustomReport.mockResolvedValue({ data: new Blob(['id\n1'], { type: 'text/csv' }) })
    global.URL.createObjectURL = vi.fn(() => 'blob:preview')
    global.URL.revokeObjectURL = vi.fn()
    HTMLAnchorElement.prototype.click = vi.fn()
  })

  afterEach(() => {
    cleanup()
  })

  it('loads preview rows from the backend and exports through the server endpoint', async () => {
    render(<AdminCustomReports />)

    await waitFor(() => expect(screen.getByText('Physics')).toBeTruthy())
    expect(screen.getByLabelText('Dataset')).toBeTruthy()
    expect(screen.getByLabelText('Search')).toBeTruthy()
    expect(previewCustomReport).toHaveBeenCalledWith({
      dataset: 'attempts',
      columns: ['id', 'test_title', 'user_name', 'status', 'score', 'started_at', 'submitted_at'],
      search: null,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))

    await waitFor(() => expect(exportCustomReport).toHaveBeenCalledWith({
      dataset: 'attempts',
      columns: ['id', 'test_title', 'user_name', 'status', 'score', 'started_at', 'submitted_at'],
      search: null,
    }))
  })

  it('shows an explicit empty-selection state when all columns are removed', async () => {
    render(<AdminCustomReports />)

    await waitFor(() => expect(screen.getByText('Physics')).toBeTruthy())

    ;['id', 'test_title', 'user_name', 'status', 'score', 'started_at', 'submitted_at'].forEach((column) => {
      fireEvent.click(screen.getAllByLabelText(column)[0])
    })

    await waitFor(() => expect(screen.getByText('Select at least one column to preview data.')).toBeTruthy())
    expect(screen.getAllByRole('button', { name: 'Export CSV' })[0].disabled).toBe(true)
  })

  it('shows a retry action when preview loading fails', async () => {
    previewCustomReport
      .mockRejectedValueOnce({ response: { data: { detail: 'Preview offline' } } })
      .mockResolvedValueOnce({
        data: {
          rows: [
            {
              id: 'a1',
              test_title: 'Physics',
              user_name: 'Grace Hopper',
              status: 'GRADED',
              score: 92,
              started_at: '2026-03-06T10:00:00Z',
              submitted_at: '2026-03-06T10:45:00Z',
            },
          ],
          total: 1,
          available_columns: ['id', 'test_title', 'user_name', 'status', 'score', 'started_at', 'submitted_at'],
        },
      })

    render(<AdminCustomReports />)

    await waitFor(() => expect(screen.getByText('Preview offline')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry Preview' })[0])

    await waitFor(() => expect(previewCustomReport).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('Physics')).toBeTruthy())
  })
})
