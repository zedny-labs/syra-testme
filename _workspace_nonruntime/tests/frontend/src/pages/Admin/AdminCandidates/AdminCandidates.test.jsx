import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import AdminCandidates from './AdminCandidates'

const attemptsMock = vi.fn()
const allTestsMock = vi.fn()
const getAttemptEventsMock = vi.fn()
const schedulesMock = vi.fn()
const updateScheduleMock = vi.fn()
const createScheduleMock = vi.fn()
const importAttemptsMock = vi.fn()
const generateReportMock = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    attempts: (...args) => attemptsMock(...args),
    allTests: (...args) => allTestsMock(...args),
    getAttemptEvents: (...args) => getAttemptEventsMock(...args),
    schedules: (...args) => schedulesMock(...args),
    updateSchedule: (...args) => updateScheduleMock(...args),
    createSchedule: (...args) => createScheduleMock(...args),
    importAttempts: (...args) => importAttemptsMock(...args),
    generateReport: (...args) => generateReportMock(...args),
  },
}))

vi.mock('../../../hooks/useAuth', () => ({
  default: () => ({
    hasPermission: () => true,
  }),
}))

describe('AdminCandidates', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    attemptsMock.mockResolvedValue({ data: [] })
    allTestsMock.mockResolvedValue({ data: { items: [] } })
    getAttemptEventsMock.mockResolvedValue({ data: [] })
    schedulesMock.mockResolvedValue({ data: [] })
    updateScheduleMock.mockResolvedValue({ data: {} })
    createScheduleMock.mockResolvedValue({ data: {} })
    importAttemptsMock.mockResolvedValue({ data: [] })
    generateReportMock.mockResolvedValue({ data: '<html></html>' })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows a retry path when candidates bootstrap fails', async () => {
    attemptsMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ data: [] })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminCandidates />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Failed to load candidate attempts.')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(attemptsMock).toHaveBeenCalledTimes(2))
  })

  it('redirects to access denied when supporting admin test data is forbidden', async () => {
    attemptsMock.mockResolvedValue({ data: [] })
    allTestsMock.mockRejectedValue({ response: { status: 403 } })

    render(
      <MemoryRouter initialEntries={['/admin/candidates']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/admin/candidates" element={<AdminCandidates />} />
          <Route path="/access-denied" element={<div>Access denied route</div>} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Access denied route')).toBeTruthy())
  })

  it('keeps reschedule confirmation disabled until a date is selected', async () => {
    attemptsMock.mockResolvedValue({
      data: [{
        id: 'attempt-1',
        exam_id: 'test-1',
        user_id: 'user-1',
        user_name: 'Learner One',
        test_title: 'Midterm',
        status: 'COMPLETED',
        score: 55,
        submitted_at: '2026-03-07T10:00:00Z',
      }],
    })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminCandidates />
      </MemoryRouter>,
    )

    const reschedulingTab = (await screen.findAllByRole('button', { name: 'Rescheduling' })).at(-1)
    fireEvent.click(reschedulingTab)
    fireEvent.click(screen.getByRole('button', { name: /open reschedule form/i }))

    const confirmButton = screen.getByRole('button', { name: /save reschedule/i })
    expect(confirmButton.disabled).toBe(true)

    const dateInput = document.querySelector('input[type="datetime-local"]')
    fireEvent.change(dateInput, { target: { value: '2026-03-08T12:00' } })

    expect(confirmButton.disabled).toBe(false)
  })

  it('shows a filter-specific empty state and clears filters back to the loaded row set', async () => {
    attemptsMock.mockResolvedValue({
      data: [{
        id: 'attempt-2',
        exam_id: 'test-1',
        user_id: 'user-2',
        user_name: 'Learner One',
        user_email: 'learner@example.com',
        test_title: 'Physics Final',
        status: 'COMPLETED',
        score: 82,
        started_at: '2026-03-07T08:00:00Z',
        submitted_at: '2026-03-07T08:45:00Z',
      }],
    })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminCandidates />
      </MemoryRouter>,
    )

    await screen.findByText('Learner One')

    fireEvent.change(screen.getAllByPlaceholderText('Search by name, email, or test...').at(-1), {
      target: { value: 'missing learner' },
    })

    await screen.findByText('No matches')

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' }).at(-1))

    await screen.findByText('Learner One')
  })

  it('blocks importing preview rows when required CSV columns are missing', async () => {
    class MockFileReader {
      constructor() {
        this.onload = null
      }

      readAsText() {
        this.onload?.({
          target: {
            result: 'user_id,score\nlearner-1,88',
          },
        })
      }
    }

    vi.stubGlobal('FileReader', MockFileReader)

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminCandidates />
      </MemoryRouter>,
    )

    fireEvent.click((await screen.findAllByRole('button', { name: 'Imported' })).at(-1))

    const fileInput = document.querySelector('input[type="file"]')
    fireEvent.change(fileInput, {
      target: {
        files: [new File(['user_id,score\nlearner-1,88'], 'results.csv', { type: 'text/csv' })],
      },
    })

    await screen.findByText(/Missing required columns:/)

    expect(screen.getByRole('button', { name: 'Import 1 result rows' }).disabled).toBe(true)
  })
})
