import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./api', () => {
  const api = { get: vi.fn(() => Promise.resolve({ data: [] })), post: vi.fn(() => Promise.resolve({ data: {} })), put: vi.fn(), delete: vi.fn() }
  return { default: api }
})

import api from './api'
import { adminApi } from './admin.service'

describe('adminApi section methods', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('lists sections for an exam', () => {
    adminApi.getExamSections('exam-1')
    expect(api.get).toHaveBeenCalledWith('exams/exam-1/sections')
  })

  it('creates a section from picked pool questions', () => {
    adminApi.createSectionFromPool('exam-1', { pool_id: 'p1', question_ids: ['q1'], title: 'Algebra' })
    expect(api.post).toHaveBeenCalledWith('exams/exam-1/sections/from-pool', { pool_id: 'p1', question_ids: ['q1'], title: 'Algebra' })
  })

  it('reorders sections', () => {
    adminApi.reorderSections('exam-1', [{ id: 's1', order: 0 }])
    expect(api.post).toHaveBeenCalledWith('exams/exam-1/sections/reorder', { sections: [{ id: 's1', order: 0 }] })
  })
})
