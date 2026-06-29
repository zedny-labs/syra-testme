import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Exams from './Exams'

const listTestsMock = vi.fn()

vi.mock('../../services/test.service', () => ({
  listTests: (...args) => listTestsMock(...args),
}))

describe('Exams page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders canonical exam fields', async () => {
    listTestsMock.mockResolvedValueOnce({
      data: [
        {
          id: '1',
          title: 'Math Exam',
          exam_type: 'MCQ',
          time_limit_minutes: 30,
          max_attempts: 2,
        },
      ],
    })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Exams />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('Math Exam')).toBeTruthy())
    expect(screen.getByText('MCQ')).toBeTruthy()
    expect(screen.getByText('30 min')).toBeTruthy()
  })

  it('renders legacy fields through adapter fallback', async () => {
    listTestsMock.mockResolvedValueOnce({
      data: [
        {
          id: '2',
          title: 'Essay Exam',
          type: 'TEXT',
          time_limit: 45,
          max_attempts: 1,
        },
      ],
    })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Exams />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('Essay Exam')).toBeTruthy())
    expect(screen.getByText('TEXT')).toBeTruthy()
    expect(screen.getByText('45 min')).toBeTruthy()
  })

  it('shows a filter-specific empty state and restores tests when filters are cleared', async () => {
    listTestsMock.mockResolvedValueOnce({
      data: [
        {
          id: '1',
          title: 'Math Exam',
          exam_type: 'MCQ',
          time_limit_minutes: 30,
          max_attempts: 2,
        },
      ],
    })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Exams />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('Math Exam')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search tests'), { target: { value: 'biology' } })

    expect(screen.getByText('No tests match your search')).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0])

    expect(screen.getByText('Math Exam')).toBeTruthy()
  })

  it('shows the most recently updated tests first', async () => {
    listTestsMock.mockResolvedValueOnce({
      data: [
        {
          id: 'older',
          title: 'Older Test',
          exam_type: 'MCQ',
          time_limit_minutes: 30,
          max_attempts: 1,
          updated_at: '2026-03-07T10:00:00Z',
        },
        {
          id: 'newer',
          title: 'Newest Test',
          exam_type: 'MCQ',
          time_limit_minutes: 45,
          max_attempts: 1,
          updated_at: '2026-03-08T10:00:00Z',
        },
      ],
    })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Exams />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('Newest Test')).toBeTruthy())
    const titles = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)
    expect(titles.slice(0, 2)).toEqual(['Newest Test', 'Older Test'])
  })
})
