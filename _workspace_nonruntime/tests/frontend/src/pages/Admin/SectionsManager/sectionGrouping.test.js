import { describe, expect, it } from 'vitest'
import { groupQuestionsBySection } from './sectionGrouping'

describe('groupQuestionsBySection', () => {
  it('groups questions under their section in section order', () => {
    const sections = [
      { id: 's2', title: 'Second', order: 1 },
      { id: 's1', title: 'First', order: 0 },
    ]
    const questions = [
      { id: 'q1', section_id: 's1', order: 0, text: 'A' },
      { id: 'q2', section_id: 's2', order: 0, text: 'B' },
      { id: 'q3', section_id: 's1', order: 1, text: 'C' },
    ]
    const grouped = groupQuestionsBySection(sections, questions)
    expect(grouped.map((g) => g.section.title)).toEqual(['First', 'Second'])
    expect(grouped[0].questions.map((q) => q.text)).toEqual(['A', 'C'])
    expect(grouped[1].questions.map((q) => q.text)).toEqual(['B'])
  })

  it('puts questions with unknown section into a trailing bucket', () => {
    const grouped = groupQuestionsBySection([], [{ id: 'q1', section_id: null, order: 0, text: 'X' }])
    expect(grouped).toHaveLength(1)
    expect(grouped[0].section.title).toBe('General')
  })
})
