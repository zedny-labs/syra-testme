import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import AdminQuestionPools from './AdminQuestionPools'

const questionPoolsMock = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    questionPools: (...args) => questionPoolsMock(...args),
    getPoolQuestions: vi.fn(),
    createQuestionPool: vi.fn(),
    deleteQuestionPool: vi.fn(),
  },
}))

vi.mock('../../../hooks/useAuth', () => ({
  default: () => ({
    user: { id: 'admin-1', role: 'ADMIN' },
  }),
}))

describe('AdminQuestionPools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    questionPoolsMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        data: [
          { id: 'pool-1', name: 'Core Algebra', description: 'Reusable bank' },
        ],
      })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows a retry path after the pool list fails to load', async () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminQuestionPools />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Could not load question pools.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.getByText('Core Algebra')).toBeTruthy())
  })

  it('shows a filter-specific empty state and restores the list when filters are cleared', async () => {
    questionPoolsMock.mockReset()
    questionPoolsMock.mockResolvedValue({
      data: [
        { id: 'pool-1', name: 'Core Algebra', description: 'Reusable bank', question_count: 3 },
      ],
    })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AdminQuestionPools />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Core Algebra')).toBeTruthy())

    fireEvent.change(screen.getAllByPlaceholderText('Search pools by name or description...').at(-1), {
      target: { value: 'physics' },
    })

    await waitFor(() => expect(screen.getByText('No pools match your search')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' }).at(-1))

    await waitFor(() => expect(screen.getByText('Core Algebra')).toBeTruthy())
  })
})
