import { describe, expect, it } from 'vitest'
import { buildHub, sectionStatus } from './sectionNavigation'

const sections = [
  { id: 's1', title: 'One', order: 0 },
  { id: 's2', title: 'Two', order: 1 },
]
const questions = [
  { id: 'q1', section_id: 's1' },
  { id: 'q2', section_id: 's2' },
]

describe('buildHub', () => {
  it('orders sections and attaches their questions', () => {
    const hub = buildHub(sections, questions)
    expect(hub.map((s) => s.title)).toEqual(['One', 'Two'])
    expect(hub[0].questions.map((q) => q.id)).toEqual(['q1'])
  })
})

describe('sectionStatus', () => {
  const hub = buildHub(sections, questions)
  it('marks finished sections', () => {
    expect(sectionStatus(hub, 0, { finished: ['s1'], answers: {}, sequential: false })).toBe('finished')
  })
  it('locks later sections when sequential and prior unfinished', () => {
    expect(sectionStatus(hub, 1, { finished: [], answers: {}, sequential: true })).toBe('locked')
  })
  it('does not lock when sequential is off', () => {
    expect(sectionStatus(hub, 1, { finished: [], answers: {}, sequential: false })).toBe('not_started')
  })
  it('reports in_progress when some answers exist', () => {
    expect(sectionStatus(hub, 0, { finished: [], answers: { q1: 'A' }, sequential: false })).toBe('in_progress')
  })
})
