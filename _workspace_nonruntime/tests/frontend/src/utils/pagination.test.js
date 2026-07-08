import { describe, expect, it } from 'vitest'

import { readPaginatedItems, readPaginatedTotal } from './pagination'

describe('readPaginatedItems', () => {
  it('returns the array when payload itself is an array', () => {
    expect(readPaginatedItems([1, 2, 3])).toEqual([1, 2, 3])
  })

  it('returns payload.items when present as array', () => {
    expect(readPaginatedItems({ items: ['a', 'b'] })).toEqual(['a', 'b'])
  })

  it('returns empty array for null, undefined, or malformed payloads', () => {
    expect(readPaginatedItems(null)).toEqual([])
    expect(readPaginatedItems(undefined)).toEqual([])
    expect(readPaginatedItems({})).toEqual([])
    expect(readPaginatedItems({ items: 'not-array' })).toEqual([])
  })
})

describe('readPaginatedTotal', () => {
  it('prefers numeric total field when present', () => {
    expect(readPaginatedTotal({ items: [1, 2], total: 42 })).toBe(42)
  })

  it('falls back to item count when total missing or non-numeric', () => {
    expect(readPaginatedTotal({ items: [1, 2, 3] })).toBe(3)
    expect(readPaginatedTotal({ items: [1], total: '5' })).toBe(1)
    expect(readPaginatedTotal([1, 2, 3, 4])).toBe(4)
  })

  it('returns 0 for empty or missing payloads', () => {
    expect(readPaginatedTotal(null)).toBe(0)
    expect(readPaginatedTotal({})).toBe(0)
  })
})
