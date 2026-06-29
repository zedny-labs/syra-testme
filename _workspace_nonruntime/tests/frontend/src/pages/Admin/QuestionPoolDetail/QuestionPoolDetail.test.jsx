import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import QuestionPoolDetail from './QuestionPoolDetail'

const getQuestionPoolMock = vi.fn()
const getPoolQuestionsMock = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    getQuestionPool: (...args) => getQuestionPoolMock(...args),
    getPoolQuestions: (...args) => getPoolQuestionsMock(...args),
    updateQuestionPool: vi.fn(),
    updatePoolQuestion: vi.fn(),
    createPoolQuestion: vi.fn(),
    deletePoolQuestion: vi.fn(),
  },
}))

vi.mock('../../../hooks/useAuth', () => ({
  default: () => ({
    user: { id: 'instructor-1', role: 'INSTRUCTOR' },
  }),
}))

describe('QuestionPoolDetail instructor permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getQuestionPoolMock.mockResolvedValue({
      data: {
        id: 'pool-1',
        name: 'Shared Algebra Pool',
        description: '',
        created_by_id: 'owner-2',
      },
    })
    getPoolQuestionsMock.mockResolvedValue({
      data: [
        {
          id: 'question-1',
          question_type: 'MCQ',
          text: '2 + 2 = ?',
          correct_answer: '4',
        },
      ],
    })
  })

  it('renders shared pools as read-only and keeps clean answer copy', async () => {
    render(
      <MemoryRouter
        initialEntries={['/admin/question-pools/pool-1']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/admin/question-pools/:id" element={<QuestionPoolDetail />} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Shared Algebra Pool')).toBeTruthy())
    expect(screen.getByText('Read-only. You do not have permission to edit this pool.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit Pool' })).toBeNull()
    expect(screen.queryByRole('button', { name: '+ Add Question' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.getByText('Correct answer: 4')).toBeTruthy()
    expect(screen.getAllByText('-').length).toBeGreaterThan(0)
  })

  it('keeps pool details visible when the question list fails and exposes retry', async () => {
    getPoolQuestionsMock
      .mockRejectedValueOnce(new Error('question list failed'))
      .mockResolvedValueOnce({
        data: [
          {
            id: 'question-1',
            question_type: 'MCQ',
            text: '2 + 2 = ?',
            correct_answer: '4',
          },
        ],
      })

    render(
      <MemoryRouter
        initialEntries={['/admin/question-pools/pool-1']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/admin/question-pools/:id" element={<QuestionPoolDetail />} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Shared Algebra Pool')).toBeTruthy())
    expect(screen.getByText('Could not load questions.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('Correct answer: 4')).toBeTruthy())
  })
})
