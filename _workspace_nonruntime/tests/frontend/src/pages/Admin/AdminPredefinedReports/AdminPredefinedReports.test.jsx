import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AdminPredefinedReports from './AdminPredefinedReports'

const generatePredefinedReport = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    generatePredefinedReport: (...args) => generatePredefinedReport(...args),
  },
}))

describe('AdminPredefinedReports page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    generatePredefinedReport.mockRejectedValue({
      response: {
        data: new Blob([JSON.stringify({ detail: 'Unknown report slug' })], { type: 'application/json' }),
      },
    })
  })

  it('surfaces blob-backed API errors instead of a generic failure message', async () => {
    render(<AdminPredefinedReports />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Generate & Download' })[0])

    await waitFor(() => expect(screen.getByText('Unknown report slug')).toBeTruthy())
  })

  it('shows a success notice after a predefined report download starts', async () => {
    generatePredefinedReport.mockResolvedValueOnce({ data: new Blob(['ok'], { type: 'text/csv' }) })
    global.URL.createObjectURL = vi.fn(() => 'blob:report')
    global.URL.revokeObjectURL = vi.fn()
    HTMLAnchorElement.prototype.click = vi.fn()

    render(<AdminPredefinedReports />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Generate & Download' })[0])

    await waitFor(() => expect(screen.getByText('Downloaded Test Performance Summary as CSV.')).toBeTruthy())
    expect(generatePredefinedReport).toHaveBeenCalledWith('test-performance')
  })
})
