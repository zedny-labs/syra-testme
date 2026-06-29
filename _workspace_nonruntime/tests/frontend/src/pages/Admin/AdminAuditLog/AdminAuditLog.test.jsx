import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminAuditLog from './AdminAuditLog'

const auditLogMock = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    auditLog: (...args) => auditLogMock(...args),
  },
}))

describe('AdminAuditLog page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows a retry path when loading the audit log fails', async () => {
    auditLogMock
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({
        data: [
          {
            id: 'log-1',
            created_at: '2026-03-07T09:00:00Z',
            user: { email: 'admin@example.com' },
            action: 'login',
            resource_type: 'session',
            resource_id: 'session-1',
            ip_address: '127.0.0.1',
            detail: 'Admin signed in',
          },
        ],
      })

    render(<AdminAuditLog />)

    await waitFor(() => expect(screen.getByText('Failed to load audit log entries.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.getByText('admin@example.com')).toBeTruthy())
  })

  it('shows summary stats and expands details through the explicit row action', async () => {
    auditLogMock.mockResolvedValue({
      data: [
        {
          id: 'log-1',
          created_at: '2026-03-07T09:00:00Z',
          user: { email: 'admin@example.com' },
          action: 'login',
          resource_type: 'session',
          resource_id: 'session-1',
          ip_address: '127.0.0.1',
          detail: 'Admin signed in from Cairo',
        },
        {
          id: 'log-2',
          created_at: '2026-03-07T10:00:00Z',
          user: { email: 'reviewer@example.com' },
          action: 'export',
          resource_type: 'report',
          resource_id: 'report-1',
          ip_address: '127.0.0.2',
          detail: 'Exported report',
        },
      ],
    })

    render(<AdminAuditLog />)

    await waitFor(() => expect(screen.getByText('admin@example.com')).toBeTruthy())
    expect(screen.getByText('Matching Entries')).toBeTruthy()
    expect(screen.getByText(/2 matching entries/)).toBeTruthy()
    expect(screen.getByText('Visible on Page')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[0])

    await waitFor(() => expect(screen.getByText('Full Detail')).toBeTruthy())
    expect(screen.getAllByText('Admin signed in from Cairo').length).toBeGreaterThan(1)
  })
})
