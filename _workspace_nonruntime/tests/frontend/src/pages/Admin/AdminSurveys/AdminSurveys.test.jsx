import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import AdminSurveys from './AdminSurveys'

const listSurveysMock = vi.fn()

vi.mock('../../../services/survey.service', () => ({
  listSurveys: (...args) => listSurveysMock(...args),
  createSurvey: vi.fn(),
  updateSurvey: vi.fn(),
  deleteSurvey: vi.fn(),
  listResponses: vi.fn(),
}))

vi.mock('../../../hooks/useAuth', () => ({
  default: () => ({
    user: { id: 'instructor-1', role: 'INSTRUCTOR' },
  }),
}))

describe('AdminSurveys instructor permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listSurveysMock.mockResolvedValue({
      data: [
        {
          id: 'survey-1',
          title: 'Program Feedback',
          description: 'Owned by another instructor',
          is_active: true,
          created_by_id: 'owner-2',
          questions: [{ text: 'Was the test clear?' }],
        },
      ],
    })
  })

  it('shows shared surveys as read-only for instructors', async () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminSurveys />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Program Feedback')).toBeTruthy())
    // Instructors can still create their own surveys; open the create modal to
    // confirm the form fields are available (the form is modal-gated).
    fireEvent.click(screen.getByRole('button', { name: 'New Survey' }))
    expect(screen.getByLabelText('Title')).toBeTruthy()
    expect(screen.getByLabelText('Description')).toBeTruthy()
    expect(screen.getByText('Read-only — only the owner or an admin can edit.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Responses' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull()
  })

  it('shows a retry path when survey bootstrap fails', async () => {
    listSurveysMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        data: [
          {
            id: 'survey-1',
            title: 'Program Feedback',
            description: 'Owned by another instructor',
            is_active: true,
            created_by_id: 'owner-2',
            questions: [{ text: 'Was the test clear?' }],
          },
        ],
      })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminSurveys />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Failed to load surveys')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.getByText('Program Feedback')).toBeTruthy())
  })
})
