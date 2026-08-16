import { describe, expect, it } from 'vitest'

import { buildVimeoEmbedSrc, isVimeoEmbedUrl, isVimeoPlayback } from './vimeoPlayback'

describe('isVimeoEmbedUrl', () => {
  it('detects player.vimeo.com embed urls', () => {
    expect(isVimeoEmbedUrl('https://player.vimeo.com/video/123?h=abc')).toBe(true)
  })

  it('rejects non-vimeo urls and empties', () => {
    expect(isVimeoEmbedUrl('https://videodelivery.net/uid/manifest/video.m3u8')).toBe(false)
    expect(isVimeoEmbedUrl('')).toBe(false)
    expect(isVimeoEmbedUrl(null)).toBe(false)
  })
})

describe('isVimeoPlayback', () => {
  it('is true when playback_type is vimeo_embed', () => {
    expect(isVimeoPlayback({ playback_type: 'vimeo_embed', url: 'https://elsewhere' }, '')).toBe(true)
  })

  it('is true when the resolved url is a vimeo embed', () => {
    expect(isVimeoPlayback({ url: 'https://player.vimeo.com/video/9?h=z' }, '')).toBe(true)
    expect(isVimeoPlayback(null, 'https://player.vimeo.com/video/9?h=z')).toBe(true)
  })

  it('is false for cloudflare/supabase playback', () => {
    expect(isVimeoPlayback({ playback_type: 'hls', url: 'https://x/y.m3u8' }, 'https://x/y.m3u8')).toBe(false)
    expect(isVimeoPlayback({ playback_type: 'direct', url: 'https://x/y.mp4' }, 'https://x/y.mp4')).toBe(false)
  })
})

describe('buildVimeoEmbedSrc', () => {
  it('preserves the private hash and adds privacy-friendly params', () => {
    const src = buildVimeoEmbedSrc('https://player.vimeo.com/video/123?h=abc123')
    expect(src).toContain('h=abc123')
    expect(src).toContain('dnt=1')
    expect(src.startsWith('https://player.vimeo.com/video/123?')).toBe(true)
  })

  it('returns empty string for empty input', () => {
    expect(buildVimeoEmbedSrc('')).toBe('')
    expect(buildVimeoEmbedSrc(null)).toBe('')
  })

  it('hides the native Vimeo control bar', () => {
    const src = buildVimeoEmbedSrc('https://player.vimeo.com/video/123?h=abc123')
    expect(src).toContain('controls=0')
  })
})
