import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AdminTemplates from './AdminTemplates'

const examTemplatesMock = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    examTemplates: (...args) => examTemplatesMock(...args),
    createExamTemplate: vi.fn(),
    updateExamTemplate: vi.fn(),
    deleteExamTemplate: vi.fn(),
  },
}))

vi.mock('../../../hooks/useAuth', () => ({
  default: () => ({
    user: { id: 'instructor-1', role: 'INSTRUCTOR' },
  }),
}))

describe('AdminTemplates instructor permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    examTemplatesMock.mockResolvedValue({
      data: [
        {
          id: 'template-1',
          name: 'Shared Template',
          description: 'Owned by another instructor',
          created_by_id: 'owner-2',
          config: {},
        },
      ],
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows shared templates as read-only for instructors', async () => {
    render(<AdminTemplates />)

    await waitFor(() => expect(screen.getByText('Shared Template')).toBeTruthy())
    expect(screen.getByText('Read-only template. Only the owner or an admin can edit this template.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('shows a filter-specific empty state and restores the templates when filters are cleared', async () => {
    examTemplatesMock.mockResolvedValueOnce({
      data: [
        {
          id: 'template-1',
          name: 'Shared Template',
          description: 'Owned by another instructor',
          created_by_id: 'owner-2',
          config: { time_limit_minutes: 60 },
        },
        {
          id: 'template-2',
          name: 'My Physics Template',
          description: 'Owned by the signed-in instructor',
          created_by_id: 'instructor-1',
          config: { attempts_allowed: 1, passing_score: 70 },
        },
      ],
    })

    render(<AdminTemplates />)

    await waitFor(() => expect(screen.getAllByText('Showing 2 template(s) across 2 loaded.')[0]).toBeTruthy())

    fireEvent.change(screen.getByPlaceholderText('Search name or description...'), { target: { value: 'biology' } })

    await waitFor(() => expect(screen.getAllByText('No templates match the current filters.')[0]).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0])

    await waitFor(() => expect(screen.getByText('My Physics Template')).toBeTruthy())
    expect(screen.getAllByText('Showing 2 template(s) across 2 loaded.')[0]).toBeTruthy()
  })
})
