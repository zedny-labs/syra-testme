import { describe, expect, it } from 'vitest'

import {
  normalizeQuestionType,
  emptyAnswerState,
  questionToAnswerState,
  answerStateToPayload,
  validateAnswerState,
} from './questionPayload'

describe('normalizeQuestionType', () => {
  it('maps legacy aliases to canonical type values', () => {
    expect(normalizeQuestionType('TRUE_FALSE')).toBe('TRUEFALSE')
    expect(normalizeQuestionType('SHORT_ANSWER')).toBe('TEXT')
    expect(normalizeQuestionType('FILL_IN_BLANK')).toBe('FILLINBLANK')
    expect(normalizeQuestionType('MULTIPLE_CHOICE')).toBe('MULTI')
  })

  it('passes canonical values through and defaults to MCQ', () => {
    expect(normalizeQuestionType('MATCHING')).toBe('MATCHING')
    expect(normalizeQuestionType(undefined)).toBe('MCQ')
    expect(normalizeQuestionType('')).toBe('MCQ')
  })
})

describe('emptyAnswerState', () => {
  it('gives MCQ four blank options and no correct selection', () => {
    expect(emptyAnswerState('MCQ')).toEqual({ options: ['', '', '', ''], correctIndices: [] })
  })

  it('gives MULTI four blank options and no correct selection', () => {
    expect(emptyAnswerState('MULTI')).toEqual({ options: ['', '', '', ''], correctIndices: [] })
  })

  it('gives TRUEFALSE a default boolean answer of True', () => {
    expect(emptyAnswerState('TRUEFALSE')).toEqual({ booleanAnswer: 'True' })
  })

  it('gives TEXT an empty model answer', () => {
    expect(emptyAnswerState('TEXT')).toEqual({ modelAnswer: '' })
  })

  it('gives ORDERING two blank items', () => {
    expect(emptyAnswerState('ORDERING')).toEqual({ options: ['', ''] })
  })

  it('gives FILLINBLANK one blank acceptable answer', () => {
    expect(emptyAnswerState('FILLINBLANK')).toEqual({ options: [''] })
  })

  it('gives MATCHING one blank pair', () => {
    expect(emptyAnswerState('MATCHING')).toEqual({ pairs: [{ left: '', right: '' }] })
  })
})

describe('answerStateToPayload', () => {
  it('serializes MCQ to the correct option text, dropping blank options', () => {
    expect(answerStateToPayload('MCQ', { options: ['3', '4', '5', ''], correctIndices: [1] }))
      .toEqual({ options: ['3', '4', '5'], correct_answer: '4' })
  })

  it('serializes MULTI to comma-joined correct option texts', () => {
    expect(answerStateToPayload('MULTI', { options: ['2', '3', '4', '6'], correctIndices: [0, 1] }))
      .toEqual({ options: ['2', '3', '4', '6'], correct_answer: '2,3' })
  })

  it('keeps correct selections aligned after blank options are removed', () => {
    // index 2 ('c') is correct; the blank at index 1 is dropped, so it must remain correct
    expect(answerStateToPayload('MULTI', { options: ['a', '', 'c'], correctIndices: [2] }))
      .toEqual({ options: ['a', 'c'], correct_answer: 'c' })
  })

  it('serializes TRUEFALSE to fixed options and the chosen value', () => {
    expect(answerStateToPayload('TRUEFALSE', { booleanAnswer: 'False' }))
      .toEqual({ options: ['True', 'False'], correct_answer: 'False' })
  })

  it('serializes TEXT to a null option list and the model answer', () => {
    expect(answerStateToPayload('TEXT', { modelAnswer: 'photosynthesis' }))
      .toEqual({ options: null, correct_answer: 'photosynthesis' })
  })

  it('serializes empty TEXT to null correct answer', () => {
    expect(answerStateToPayload('TEXT', { modelAnswer: '   ' }))
      .toEqual({ options: null, correct_answer: null })
  })

  it('serializes ORDERING items in order with no correct answer', () => {
    expect(answerStateToPayload('ORDERING', { options: ['Mercury', 'Venus', 'Earth', ''] }))
      .toEqual({ options: ['Mercury', 'Venus', 'Earth'], correct_answer: null })
  })

  it('serializes FILLINBLANK acceptable answers with no correct answer', () => {
    expect(answerStateToPayload('FILLINBLANK', { options: ['Paris', 'paris', ''] }))
      .toEqual({ options: ['Paris', 'paris'], correct_answer: null })
  })

  it('serializes MATCHING pairs to "Left | Right" options and an identity answer key', () => {
    expect(answerStateToPayload('MATCHING', {
      pairs: [{ left: 'France', right: 'Paris' }, { left: 'Egypt', right: 'Cairo' }],
    })).toEqual({ options: ['France | Paris', 'Egypt | Cairo'], correct_answer: 'A-1,B-2' })
  })

  it('drops MATCHING pairs missing either side', () => {
    expect(answerStateToPayload('MATCHING', {
      pairs: [{ left: 'France', right: 'Paris' }, { left: 'Egypt', right: '' }],
    })).toEqual({ options: ['France | Paris'], correct_answer: 'A-1' })
  })
})

describe('questionToAnswerState', () => {
  it('parses MCQ with a text correct answer', () => {
    expect(questionToAnswerState({ question_type: 'MCQ', options: ['3', '4', '5'], correct_answer: '4' }))
      .toEqual({ options: ['3', '4', '5'], correctIndices: [1] })
  })

  it('parses MCQ with a legacy letter correct answer', () => {
    expect(questionToAnswerState({ question_type: 'MCQ', options: ['3', '4', '5'], correct_answer: 'B' }))
      .toEqual({ options: ['3', '4', '5'], correctIndices: [1] })
  })

  it('parses MULTI with comma-joined text answers', () => {
    expect(questionToAnswerState({ question_type: 'MULTI', options: ['2', '3', '4'], correct_answer: '2,3' }))
      .toEqual({ options: ['2', '3', '4'], correctIndices: [0, 1] })
  })

  it('parses MULTI with legacy comma-joined letters', () => {
    expect(questionToAnswerState({ question_type: 'MULTI', options: ['2', '3', '4'], correct_answer: 'A,C' }))
      .toEqual({ options: ['2', '3', '4'], correctIndices: [0, 2] })
  })

  it('parses TRUEFALSE from value or legacy letter', () => {
    expect(questionToAnswerState({ question_type: 'TRUEFALSE', correct_answer: 'True' })).toEqual({ booleanAnswer: 'True' })
    expect(questionToAnswerState({ question_type: 'TRUEFALSE', correct_answer: 'B' })).toEqual({ booleanAnswer: 'False' })
  })

  it('parses TEXT model answer, tolerating null', () => {
    expect(questionToAnswerState({ question_type: 'TEXT', correct_answer: 'model' })).toEqual({ modelAnswer: 'model' })
    expect(questionToAnswerState({ question_type: 'TEXT', correct_answer: null })).toEqual({ modelAnswer: '' })
  })

  it('parses ORDERING items, falling back to empty state when absent', () => {
    expect(questionToAnswerState({ question_type: 'ORDERING', options: ['a', 'b'] })).toEqual({ options: ['a', 'b'] })
    expect(questionToAnswerState({ question_type: 'ORDERING', options: [] })).toEqual({ options: ['', ''] })
  })

  it('parses FILLINBLANK acceptable answers', () => {
    expect(questionToAnswerState({ question_type: 'FILLINBLANK', options: ['Paris', 'paris'] }))
      .toEqual({ options: ['Paris', 'paris'] })
  })

  it('parses MATCHING "Left | Right" options into pairs', () => {
    expect(questionToAnswerState({ question_type: 'MATCHING', options: ['France | Paris', 'Egypt | Cairo'] }))
      .toEqual({ pairs: [{ left: 'France', right: 'Paris' }, { left: 'Egypt', right: 'Cairo' }] })
  })

  it('normalizes the question type alias before parsing', () => {
    expect(questionToAnswerState({ type: 'MULTIPLE_CHOICE', options: ['a', 'b'], correct_answer: 'a' }))
      .toEqual({ options: ['a', 'b'], correctIndices: [0] })
  })

  it('round-trips a canonical payload through state and back', () => {
    const payload = { options: ['2', '3', '4', '6'], correct_answer: '2,3' }
    const state = questionToAnswerState({ question_type: 'MULTI', ...payload })
    expect(answerStateToPayload('MULTI', state)).toEqual(payload)
  })
})

describe('validateAnswerState', () => {
  it('requires at least two options for MCQ', () => {
    expect(validateAnswerState('MCQ', { options: ['only', '', '', ''], correctIndices: [0] })).toBe('qtf_err_min_options')
  })

  it('requires a correct selection for MCQ', () => {
    expect(validateAnswerState('MCQ', { options: ['a', 'b', '', ''], correctIndices: [] })).toBe('qtf_err_select_correct')
  })

  it('accepts a valid MCQ', () => {
    expect(validateAnswerState('MCQ', { options: ['a', 'b', '', ''], correctIndices: [1] })).toBe(null)
  })

  it('requires at least one correct selection for MULTI', () => {
    expect(validateAnswerState('MULTI', { options: ['a', 'b', '', ''], correctIndices: [] })).toBe('qtf_err_select_correct_multi')
  })

  it('rejects a MULTI answer key longer than 255 characters', () => {
    const long = Array.from({ length: 10 }, (_, i) => `option-with-a-fairly-long-label-${i}`)
    expect(validateAnswerState('MULTI', { options: long, correctIndices: long.map((_, i) => i) }))
      .toBe('qtf_err_answer_too_long')
  })

  it('always accepts TRUEFALSE and TEXT', () => {
    expect(validateAnswerState('TRUEFALSE', { booleanAnswer: 'True' })).toBe(null)
    expect(validateAnswerState('TEXT', { modelAnswer: '' })).toBe(null)
  })

  it('requires at least two items for ORDERING', () => {
    expect(validateAnswerState('ORDERING', { options: ['only', ''] })).toBe('qtf_err_min_items')
    expect(validateAnswerState('ORDERING', { options: ['a', 'b'] })).toBe(null)
  })

  it('requires at least one acceptable answer for FILLINBLANK', () => {
    expect(validateAnswerState('FILLINBLANK', { options: [''] })).toBe('qtf_err_min_answer')
    expect(validateAnswerState('FILLINBLANK', { options: ['Paris'] })).toBe(null)
  })

  it('requires at least one complete pair for MATCHING', () => {
    expect(validateAnswerState('MATCHING', { pairs: [{ left: 'France', right: '' }] })).toBe('qtf_err_min_pair')
    expect(validateAnswerState('MATCHING', { pairs: [{ left: 'France', right: 'Paris' }] })).toBe(null)
  })
})
