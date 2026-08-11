import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminReports from './AdminReports'

const reportSchedules = vi.fn()
const createReportSchedule = vi.fn()
const deleteReportSchedule = vi.fn()
const runReportSchedule = vi.fn()
const settings = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    reportSchedules: (...args) => reportSchedules(...args),
    createReportSchedule: (...args) => createReportSchedule(...args),
    deleteReportSchedule: (...args) => deleteReportSchedule(...args),
    runReportSchedule: (...args) => runReportSchedule(...args),
    settings: (...args) => settings(...args),
  },
}))

describe('AdminReports page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reportSchedules.mockResolvedValue({ data: [] })
    createReportSchedule.mockResolvedValue({ data: {} })
    deleteReportSchedule.mockResolvedValue({ data: { detail: 'Deleted' } })
    runReportSchedule.mockResolvedValue({ data: { detail: 'Ran', report_url: 'https://example.com/report.html' } })
    settings.mockResolvedValue({ data: [] })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows a retry path when loading schedules fails', async () => {
    reportSchedules
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ data: [] })

    render(<AdminReports />)

    await waitFor(() => expect(screen.getByText('Failed to load schedules.')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(reportSchedules).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('No schedules yet')).toBeTruthy())
  })

  it('requires explicit confirmation before deleting a schedule', async () => {
    reportSchedules
      .mockResolvedValueOnce({
        data: [
          {
            id: 'schedule-1',
            name: 'Daily Summary',
            report_type: 'attempt-summary',
            schedule_cron: '0 8 * * *',
            recipients: ['ops@example.com'],
            last_run_at: null,
            created_at: '2026-03-07T09:00:00Z',
          },
        ],
      })
      .mockResolvedValueOnce({ data: [] })

    render(<AdminReports />)

    await waitFor(() => expect(screen.getByText('Daily Summary')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(deleteReportSchedule).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Confirm Delete' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Delete' }))

    await waitFor(() => expect(deleteReportSchedule).toHaveBeenCalledWith('schedule-1'))
    await waitFor(() => expect(screen.getByText('Schedule deleted successfully.')).toBeTruthy())
  })

  it('shows a filter-specific empty state and restores report schedules when filters are cleared', async () => {
    reportSchedules.mockResolvedValueOnce({
      data: [
        {
          id: 'schedule-1',
          name: 'Daily Summary',
          report_type: 'attempt-summary',
          schedule_cron: '0 8 * * *',
          recipients: ['ops@example.com'],
          last_run_at: null,
          created_at: '2026-03-07T09:00:00Z',
        },
        {
          id: 'schedule-2',
          name: 'Usage Snapshot',
          report_type: 'usage',
          schedule_cron: '0 12 * * 1',
          recipients: ['analytics@example.com'],
          last_run_at: '2026-03-06T12:00:00Z',
          created_at: '2026-03-05T09:00:00Z',
        },
      ],
    })

    render(<AdminReports />)

    await waitFor(() => expect(screen.getByText((_, element) => element?.textContent === 'Showing 2 schedules across 2 loaded.')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search Schedules'), { target: { value: 'missing schedule' } })

    await waitFor(() => expect(screen.getByText('No schedules match filters')).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear Filters' })[0])

    await waitFor(() => expect(screen.getByText('Daily Summary')).toBeTruthy())
    expect(screen.getByText((_, element) => element?.textContent === 'Showing 2 schedules across 2 loaded.')).toBeTruthy()
  })
})
