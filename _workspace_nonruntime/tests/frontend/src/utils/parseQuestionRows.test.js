import { describe, expect, it } from 'vitest'

import {
  buildQuestions,
  mapQuestion,
  templateAnswers,
  templateLegend,
  templateQuestions,
} from './parseQuestionRows'

const ans = (answer_text, ordinal, correct = 'N') => ({ answer_text, ordinal, correct })

const QHEAD = ['Common ID (Question ID)', 'Question Text', 'Question Type', 'Points']
const AHEAD = ['Common ID (Question ID)', 'Answer Text', 'Answer Ordinal Number', 'Correct Answer']

describe('mapQuestion', () => {
  it('maps a single-choice MCQ from answer rows, deriving the correct option', () => {
    expect(mapQuestion({ text: 'Q', type: 'MCQ', points: '2' }, [ans('3', '1'), ans('4', '2', 'Y'), ans('5', '3')]))
      .toEqual({ payload: { text: 'Q', question_type: 'MCQ', options: ['3', '4', '5'], correct_answer: '4', points: 2 } })
  })

  it('maps MULTI joining every Y-marked option', () => {
    expect(mapQuestion({ text: 'Q', type: 'MULTI' }, [ans('2', '1', 'Y'), ans('3', '2', 'Y'), ans('4', '3')]).payload)
      .toEqual({ text: 'Q', question_type: 'MULTI', options: ['2', '3', '4'], correct_answer: '2,3', points: 1 })
  })

  it('maps TRUEFALSE from the True/False rows', () => {
    expect(mapQuestion({ text: 'Q', type: 'TRUEFALSE' }, [ans('True', '1', 'Y'), ans('False', '2')]).payload)
      .toEqual({ text: 'Q', question_type: 'TRUEFALSE', options: ['True', 'False'], correct_answer: 'True', points: 1 })
  })

  it('maps TEXT with an optional model answer and no options', () => {
    expect(mapQuestion({ text: 'Q', type: 'TEXT' }, [ans('model answer', '1', 'Y')]).payload)
      .toEqual({ text: 'Q', question_type: 'TEXT', options: null, correct_answer: 'model answer', points: 1 })
  })

  it('maps TEXT with no answer rows to a null model answer', () => {
    expect(mapQuestion({ text: 'Q', type: 'TEXT' }, []).payload)
      .toEqual({ text: 'Q', question_type: 'TEXT', options: null, correct_answer: null, points: 1 })
  })

  it('maps ORDERING preserving the given order with a null answer', () => {
    expect(mapQuestion({ text: 'Q', type: 'ORDERING' }, [ans('a', '1'), ans('b', '2'), ans('c', '3')]).payload)
      .toEqual({ text: 'Q', question_type: 'ORDERING', options: ['a', 'b', 'c'], correct_answer: null, points: 1 })
  })

  it('maps FILLINBLANK acceptable answers', () => {
    expect(mapQuestion({ text: 'Q [blank]', type: 'FILLINBLANK' }, [ans('Paris', '1'), ans('paris', '2')]).payload)
      .toEqual({ text: 'Q [blank]', question_type: 'FILLINBLANK', options: ['Paris', 'paris'], correct_answer: null, points: 1 })
  })

  it('maps MATCHING pairs', () => {
    expect(mapQuestion({ text: 'Q', type: 'MATCHING' }, [ans('France | Paris', '1'), ans('Egypt | Cairo', '2')]).payload)
      .toEqual({ text: 'Q', question_type: 'MATCHING', options: ['France | Paris', 'Egypt | Cairo'], correct_answer: null, points: 1 })
  })

  it('flags missing text', () => {
    expect(mapQuestion({ text: '   ', type: 'MCQ' }, [ans('a', '1', 'Y'), ans('b', '2')])).toEqual({ error: 'missing_text' })
  })

  it('flags an unknown type', () => {
    expect(mapQuestion({ text: 'Q', type: 'NOPE' }, [])).toEqual({ error: 'unknown_type' })
  })

  it('flags MCQ with fewer than two options', () => {
    expect(mapQuestion({ text: 'Q', type: 'MCQ' }, [ans('only', '1', 'Y')])).toEqual({ error: 'need_2_options' })
  })

  it('flags MCQ with no correct answer marked', () => {
    expect(mapQuestion({ text: 'Q', type: 'MCQ' }, [ans('a', '1'), ans('b', '2')])).toEqual({ error: 'missing_correct_answer' })
  })

  it('flags MCQ with more than one answer marked correct', () => {
    expect(mapQuestion({ text: 'Q', type: 'MCQ' }, [ans('a', '1', 'Y'), ans('b', '2', 'Y')])).toEqual({ error: 'one_correct' })
  })

  it('flags MULTI with no correct answer marked', () => {
    expect(mapQuestion({ text: 'Q', type: 'MULTI' }, [ans('a', '1'), ans('b', '2')])).toEqual({ error: 'missing_correct_answer' })
  })

  it('flags a TRUEFALSE whose correct row is not True/False', () => {
    expect(mapQuestion({ text: 'Q', type: 'TRUEFALSE' }, [ans('Maybe', '1', 'Y'), ans('Nope', '2')])).toEqual({ error: 'truefalse_answer' })
  })

  it('flags ORDERING with fewer than two items', () => {
    expect(mapQuestion({ text: 'Q', type: 'ORDERING' }, [ans('only', '1')])).toEqual({ error: 'need_2_options' })
  })

  it('flags FILLINBLANK with no answers', () => {
    expect(mapQuestion({ text: 'Q', type: 'FILLINBLANK' }, [])).toEqual({ error: 'need_1_option' })
  })

  it('flags MATCHING with no pairs', () => {
    expect(mapQuestion({ text: 'Q', type: 'MATCHING' }, [])).toEqual({ error: 'need_1_option' })
  })

  it('flags a malformed MATCHING pair', () => {
    expect(mapQuestion({ text: 'Q', type: 'MATCHING' }, [ans('no pipe here', '1')])).toEqual({ error: 'matching_pair_format' })
  })

  it('defaults invalid points to 1', () => {
    expect(mapQuestion({ text: 'Q', type: 'TEXT', points: 'abc' }, []).payload.points).toBe(1)
  })
})

describe('buildQuestions', () => {
  it('joins answers to questions by Common ID', () => {
    const out = buildQuestions(
      [QHEAD, ['1', 'Q one', 'MCQ', '1']],
      [AHEAD, ['1', 'a', '1', 'N'], ['1', 'b', '2', 'Y']],
    )
    expect(out).toEqual([
      { row: 2, commonId: '1', payload: { text: 'Q one', question_type: 'MCQ', options: ['a', 'b'], correct_answer: 'b', points: 1 } },
    ])
  })

  it('orders answers by Answer Ordinal Number regardless of sheet order', () => {
    const out = buildQuestions(
      [QHEAD, ['1', 'Q', 'ORDERING', '1']],
      [AHEAD, ['1', 'b', '2', 'N'], ['1', 'a', '1', 'N'], ['1', 'c', '3', 'N']],
    )
    expect(out[0].payload.options).toEqual(['a', 'b', 'c'])
  })

  it('flags a duplicate Common ID', () => {
    const out = buildQuestions([QHEAD, ['1', 'Q', 'TEXT', '1'], ['1', 'Q2', 'TEXT', '1']], [AHEAD])
    expect(out[1]).toEqual({ row: 3, commonId: '1', error: 'duplicate_id' })
  })

  it('flags an answer whose Common ID has no matching question', () => {
    const out = buildQuestions(
      [QHEAD, ['1', 'Q', 'TEXT', '1']],
      [AHEAD, ['1', 'm', '1', 'Y'], ['99', 'orphan', '1', 'N']],
    )
    expect(out.some((r) => r.error === 'orphan_answer' && r.commonId === '99')).toBe(true)
  })

  it('returns [] when there are no question rows', () => {
    expect(buildQuestions([QHEAD], [AHEAD])).toEqual([])
  })
})

describe('templates', () => {
  it('Questions sheet has the reference headers and one row per supported type', () => {
    const matrix = templateQuestions()
    expect(matrix[0]).toEqual(['Common ID (Question ID)', 'Question Text', 'Question Type', 'Points'])
    expect(matrix.slice(1).map((row) => row[2])).toEqual(['MCQ', 'MULTI', 'TRUEFALSE', 'TEXT', 'ORDERING', 'FILLINBLANK', 'MATCHING'])
  })

  it('Answers sheet has the reference headers', () => {
    expect(templateAnswers()[0]).toEqual(['Common ID (Question ID)', 'Answer Text', 'Answer Ordinal Number', 'Correct Answer'])
  })

  it('round-trips the template into 7 valid payloads', () => {
    const out = buildQuestions(templateQuestions(), templateAnswers())
    expect(out).toHaveLength(7)
    expect(out.every((row) => row.payload)).toBe(true)
  })

  it('Legend mentions every supported type code', () => {
    const flat = templateLegend().flat().join(' ')
    for (const type of ['MCQ', 'MULTI', 'TRUEFALSE', 'TEXT', 'ORDERING', 'FILLINBLANK', 'MATCHING']) {
      expect(flat).toContain(type)
    }
  })
})
