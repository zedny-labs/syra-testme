import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ExamQuestionPanel from './ExamQuestionPanel'

const addQuestion = vi.fn()
const updateQuestion = vi.fn()
const deleteQuestion = vi.fn()
const getQuestions = vi.fn()

vi.mock('../../../services/admin.service', () => ({
  adminApi: {
    addQuestion: (...args) => addQuestion(...args),
    updateQuestion: (...args) => updateQuestion(...args),
    deleteQuestion: (...args) => deleteQuestion(...args),
    getQuestions: (...args) => getQuestions(...args),
  },
}))

describe('ExamQuestionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    addQuestion.mockResolvedValue({ data: {} })
    updateQuestion.mockResolvedValue({ data: {} })
    deleteQuestion.mockResolvedValue({ data: {} })
    getQuestions.mockResolvedValue({ data: [] })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders quick-add actions for the available types and blocks invalid MCQ saves', async () => {
    render(
      <ExamQuestionPanel
        examId="test-1"
        questions={[]}
        onUpdate={vi.fn()}
        questionTypes={[
          { value: 'MCQ', label: 'Single Choice' },
          { value: 'TEXT', label: 'Essay' },
        ]}
      />,
    )

    expect(screen.getByRole('button', { name: 'Add Single Choice' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add Essay' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Add Single Choice' }))
    fireEvent.change(screen.getByPlaceholderText('Enter question...'), { target: { value: 'What is 2 + 2?' } })

    expect(screen.getByRole('button', { name: 'Add Question' }).disabled).toBe(true)
    expect(screen.getByText('Add at least two options.')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('Option A'), { target: { value: '4' } })
    fireEvent.change(screen.getByPlaceholderText('Option B'), { target: { value: '5' } })
    fireEvent.click(screen.getByLabelText('Mark correct A'))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Question' }).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Add Question' }))

    await waitFor(() => expect(addQuestion).toHaveBeenCalledWith(expect.objectContaining({
      exam_id: 'test-1',
      text: 'What is 2 + 2?',
      type: 'MCQ',
      options: ['4', '5'],
      correct_answer: '4',
    })))
    await waitFor(() => expect(getQuestions).toHaveBeenCalledWith('test-1'))
  })

  it('keeps quick-add disabled until the test exists', () => {
    render(<ExamQuestionPanel examId="" questions={[]} onUpdate={vi.fn()} />)

    expect(screen.getByText('Save the test first, then add questions here.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add Multiple Choice' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Add Text / Essay' }).disabled).toBe(true)
  })
})
