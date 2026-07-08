import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearScreenStream,
  consumeScreenStream,
  peekScreenStream,
  storeScreenStream,
} from './screenShareState'

function makeStream() {
  const track = { stop: vi.fn() }
  return { getTracks: () => [track], _track: track }
}

afterEach(() => {
  clearScreenStream()
})

describe('screenShareState', () => {
  it('stores and peeks the current stream without consuming it', () => {
    const s = makeStream()
    storeScreenStream(s)
    expect(peekScreenStream()).toBe(s)
    expect(peekScreenStream()).toBe(s)
  })

  it('stops the previous stream when a new one replaces it', () => {
    const first = makeStream()
    const second = makeStream()
    storeScreenStream(first)
    storeScreenStream(second)
    expect(first._track.stop).toHaveBeenCalledTimes(1)
    expect(second._track.stop).not.toHaveBeenCalled()
    expect(peekScreenStream()).toBe(second)
  })

  it('does not stop the stream when re-storing the same reference', () => {
    const s = makeStream()
    storeScreenStream(s)
    storeScreenStream(s)
    expect(s._track.stop).not.toHaveBeenCalled()
  })

  it('consume returns the stream and clears the slot without stopping it', () => {
    const s = makeStream()
    storeScreenStream(s)
    expect(consumeScreenStream()).toBe(s)
    expect(peekScreenStream()).toBeNull()
    expect(s._track.stop).not.toHaveBeenCalled()
  })

  it('clear stops tracks and nulls the slot', () => {
    const s = makeStream()
    storeScreenStream(s)
    clearScreenStream()
    expect(s._track.stop).toHaveBeenCalledTimes(1)
    expect(peekScreenStream()).toBeNull()
  })

  it('storeScreenStream(null) clears without throwing', () => {
    storeScreenStream(null)
    expect(peekScreenStream()).toBeNull()
  })
})
