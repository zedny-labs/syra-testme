import { describe, expect, it } from 'vitest'

import { readTestAccessError } from './testAccessError'

describe('readTestAccessError', () => {
  const ACCESS_DENIED = 'This test is not assigned to you or is no longer available.'

  it('returns the access-denied message for 403', () => {
    expect(readTestAccessError({ response: { status: 403 } }, 'fallback')).toBe(ACCESS_DENIED)
  })

  it('returns the access-denied message for 404', () => {
    expect(readTestAccessError({ response: { status: 404, data: { detail: 'nope' } } }, 'fallback')).toBe(ACCESS_DENIED)
  })

  it('uses server detail string for other statuses when provided', () => {
    expect(readTestAccessError({ response: { status: 500, data: { detail: '  boom  ' } } }, 'fallback')).toBe('boom')
  })

  it('falls back when detail is missing, empty, or non-string', () => {
    expect(readTestAccessError({ response: { status: 500 } }, 'fallback')).toBe('fallback')
    expect(readTestAccessError({ response: { status: 500, data: { detail: '   ' } } }, 'fallback')).toBe('fallback')
    expect(readTestAccessError({ response: { status: 500, data: { detail: 42 } } }, 'fallback')).toBe('fallback')
  })

  it('falls back when error has no response at all', () => {
    expect(readTestAccessError(new Error('network'), 'fallback')).toBe('fallback')
    expect(readTestAccessError(null, 'fallback')).toBe('fallback')
  })
})
