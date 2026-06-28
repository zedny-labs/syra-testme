import { describe, expect, it } from 'vitest'

import { mapRecordToQuestion, mapRecords, rowsToRecords, templateMatrix } from './parseQuestionRows'

describe('rowsToRecords', () => {
  it('maps a header row to lowercased keys and skips blank rows', () => {
    const matrix = [
      ['Text', 'Type', 'Options', 'Correct_Answer', 'Points'],
      ['Q1', 'MCQ', 'a\nb', 'a', '2'],
      ['', '', '', '', ''],
    ]
    expect(rowsToRecords(matrix)).toEqual([
      { text: 'Q1', type: 'MCQ', options: 'a\nb', correct_answer: 'a', points: '2' },
    ])
  })

  it('returns [] for empty input', () => {
    expect(rowsToRecords([])).toEqual([])
  })
})

describe('mapRecordToQuestion', () => {
  it('maps a valid MCQ', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'MCQ', options: '3\n4\n5', correct_answer: '4', points: '2' }))
      .toEqual({ payload: { text: 'Q', question_type: 'MCQ', options: ['3', '4', '5'], correct_answer: '4', points: 2 } })
  })

  it('maps MULTI with comma-separated answers', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'MULTI', options: '2\n3\n4', correct_answer: '2, 3' }).payload)
      .toEqual({ text: 'Q', question_type: 'MULTI', options: ['2', '3', '4'], correct_answer: '2,3', points: 1 })
  })

  it('maps TRUEFALSE and defaults options', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'true false', correct_answer: 'TRUE' }).payload)
      .toEqual({ text: 'Q', question_type: 'TRUEFALSE', options: ['True', 'False'], correct_answer: 'True', points: 1 })
  })

  it('maps TEXT with optional answer and no options', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'SHORT_ANSWER', correct_answer: 'model' }).payload)
      .toEqual({ text: 'Q', question_type: 'TEXT', options: null, correct_answer: 'model', points: 1 })
  })

  it('maps ORDERING with auto-derived (null) answer', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'ORDERING', options: 'a\nb\nc' }).payload)
      .toEqual({ text: 'Q', question_type: 'ORDERING', options: ['a', 'b', 'c'], correct_answer: null, points: 1 })
  })

  it('maps FILLINBLANK acceptable answers', () => {
    expect(mapRecordToQuestion({ text: 'Q [blank]', type: 'FILL_IN_BLANK', options: 'Paris\nparis' }).payload)
      .toEqual({ text: 'Q [blank]', question_type: 'FILLINBLANK', options: ['Paris', 'paris'], correct_answer: null, points: 1 })
  })

  it('maps MATCHING pairs', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'MATCHING', options: 'France | Paris\nEgypt | Cairo', correct_answer: 'A-1,B-2' }).payload)
      .toEqual({ text: 'Q', question_type: 'MATCHING', options: ['France | Paris', 'Egypt | Cairo'], correct_answer: 'A-1,B-2', points: 1 })
  })

  it('flags missing text', () => {
    expect(mapRecordToQuestion({ text: '   ', type: 'MCQ' })).toEqual({ error: 'missing_text' })
  })

  it('flags unknown type', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'ESSAYISH' })).toEqual({ error: 'unknown_type' })
  })

  it('flags MCQ with fewer than 2 options', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'MCQ', options: 'only', correct_answer: 'only' }))
      .toEqual({ error: 'mcq_need_2_options' })
  })

  it('flags MCQ answer not among options', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'MCQ', options: 'a\nb', correct_answer: 'c' }))
      .toEqual({ error: 'answer_not_in_options' })
  })

  it('flags bad TRUEFALSE answer', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'TRUEFALSE', correct_answer: 'maybe' }))
      .toEqual({ error: 'truefalse_answer' })
  })

  it('flags malformed MATCHING pair', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'MATCHING', options: 'no pipe here', correct_answer: 'A-1' }))
      .toEqual({ error: 'matching_pair_format' })
  })

  it('defaults invalid points to 1', () => {
    expect(mapRecordToQuestion({ text: 'Q', type: 'TEXT', points: 'abc' }).payload.points).toBe(1)
  })
})

describe('mapRecords', () => {
  it('tags each result with a 1-based row number offset by the header row', () => {
    const out = mapRecords([
      { text: 'Q1', type: 'TEXT' },
      { text: '', type: 'TEXT' },
    ])
    expect(out[0]).toEqual({ row: 2, payload: { text: 'Q1', question_type: 'TEXT', options: null, correct_answer: null, points: 1 } })
    expect(out[1]).toEqual({ row: 3, error: 'missing_text' })
  })
})

describe('templateMatrix', () => {
  it('has the expected header and one sample row per type', () => {
    const matrix = templateMatrix()
    expect(matrix[0]).toEqual(['text', 'type', 'options', 'correct_answer', 'points'])
    const types = matrix.slice(1).map((row) => row[1])
    expect(types).toEqual(['MCQ', 'MULTI', 'TRUEFALSE', 'TEXT', 'ORDERING', 'FILLINBLANK', 'MATCHING'])
  })
})
