import { describe, expect, it } from 'vitest'

import { formatSeconds, pointerPositionToSeconds } from './VimeoControlsBar'

describe('formatSeconds', () => {
  it('formats seconds under an hour as m:ss', () => {
    expect(formatSeconds(75)).toBe('1:15')
    expect(formatSeconds(5)).toBe('0:05')
  })

  it('formats seconds over an hour as h:mm:ss', () => {
    expect(formatSeconds(3661)).toBe('1:01:01')
  })

  it('returns a placeholder for non-finite input', () => {
    expect(formatSeconds(NaN)).toBe('--:--')
    expect(formatSeconds(undefined)).toBe('--:--')
  })
})

describe('pointerPositionToSeconds', () => {
  const rect = { left: 100, width: 200 }

  it('maps a click at the start of the track to 0 seconds', () => {
    expect(pointerPositionToSeconds(100, rect, 60)).toBe(0)
  })

  it('maps a click at the midpoint of the track to half the duration', () => {
    expect(pointerPositionToSeconds(200, rect, 60)).toBe(30)
  })

  it('maps a click at the end of the track to the full duration', () => {
    expect(pointerPositionToSeconds(300, rect, 60)).toBe(60)
  })

  it('clamps clicks outside the track bounds', () => {
    expect(pointerPositionToSeconds(0, rect, 60)).toBe(0)
    expect(pointerPositionToSeconds(1000, rect, 60)).toBe(60)
  })

  it('returns 0 for a non-finite or non-positive duration', () => {
    expect(pointerPositionToSeconds(200, rect, 0)).toBe(0)
    expect(pointerPositionToSeconds(200, rect, NaN)).toBe(0)
  })
})
