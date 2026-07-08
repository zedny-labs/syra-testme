import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import TrainingCourses from './TrainingCourses'

const listTestsMock = vi.fn()
const apiGetMock = vi.fn()

vi.mock('../../services/test.service', () => ({
  listTests: (...args) => listTestsMock(...args),
}))

vi.mock('../../services/api', () => ({
  default: {
    get: (...args) => apiGetMock(...args),
  },
}))

describe('TrainingCourses page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps course and module information visible when test links fail to load', async () => {
    apiGetMock.mockImplementation((path) => {
      if (path === 'courses/') {
        return Promise.resolve({
          data: [{ id: 'course-1', title: 'Biology 101', description: 'Core biology fundamentals' }],
        })
      }
      if (path === 'nodes/') {
        return Promise.resolve({
          data: [{ id: 'node-1', course_id: 'course-1', title: 'Introduction' }],
        })
      }
      throw new Error(`Unexpected path ${path}`)
    })
    listTestsMock.mockRejectedValue(new Error('tests unavailable'))

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <TrainingCourses />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Biology 101')).toBeTruthy())
    expect(screen.getByText('Some training details are temporarily unavailable. Course info is shown, but module or test links may be incomplete.')).toBeTruthy()
    expect(screen.getByText('Introduction')).toBeTruthy()
    expect(screen.getByText('No tests available')).toBeTruthy()
  })

  it('retries after course loading fails', async () => {
    let courseCalls = 0
    apiGetMock.mockImplementation((path) => {
      if (path === 'courses/') {
        courseCalls += 1
        if (courseCalls === 1) {
          return Promise.reject(new Error('courses unavailable'))
        }
        return Promise.resolve({
          data: [{ id: 'course-1', title: 'Biology 101', description: 'Core biology fundamentals' }],
        })
      }
      if (path === 'nodes/') {
        return Promise.resolve({ data: [] })
      }
      throw new Error(`Unexpected path ${path}`)
    })
    listTestsMock.mockResolvedValue({ data: [] })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <TrainingCourses />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Could not load training courses.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.getByText('Biology 101')).toBeTruthy())
  })

  it('shows a filter-specific empty state and restores courses when filters are cleared', async () => {
    apiGetMock.mockImplementation((path) => {
      if (path === 'courses/') {
        return Promise.resolve({
          data: [
            { id: 'course-1', title: 'Biology 101', description: 'Core biology fundamentals' },
            { id: 'course-2', title: 'Chemistry Basics', description: 'Intro chemistry concepts' },
          ],
        })
      }
      if (path === 'nodes/') {
        return Promise.resolve({
          data: [
            { id: 'node-1', course_id: 'course-1', title: 'Introduction' },
            { id: 'node-2', course_id: 'course-2', title: 'Atoms' },
          ],
        })
      }
      throw new Error(`Unexpected path ${path}`)
    })
    listTestsMock.mockResolvedValue({ data: [] })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <TrainingCourses />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Showing 2 courses across 2 available.')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search courses'), { target: { value: 'physics' } })

    await waitFor(() => expect(screen.getByText('No courses match your search.')).toBeTruthy())

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0])

    await waitFor(() => expect(screen.getByText('Biology 101')).toBeTruthy())
    expect(screen.getByText('Showing 2 courses across 2 available.')).toBeTruthy()
  })

  it('hides the internal question-pool library course from learner training', async () => {
    apiGetMock.mockImplementation((path) => {
      if (path === 'courses/') {
        return Promise.resolve({
          data: [
            { id: 'course-1', title: 'Biology 101', description: 'Core biology fundamentals' },
            { id: 'course-2', title: 'Question Pool Library', description: 'Hidden library course for question pool storage' },
          ],
        })
      }
      if (path === 'nodes/') {
        return Promise.resolve({ data: [] })
      }
      throw new Error(`Unexpected path ${path}`)
    })
    listTestsMock.mockResolvedValue({ data: [] })

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <TrainingCourses />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Biology 101')).toBeTruthy())
    expect(screen.queryByText('Question Pool Library')).toBeNull()
    expect(screen.getByText('Showing 1 course across 1 available.')).toBeTruthy()
  })
})
