// Helpers for playing proctoring recordings that live on Vimeo.
//
// On a standard Vimeo account the API does not expose progressive/HLS file URLs,
// so playback goes through Vimeo's embed player (an <iframe>) rather than the
// <video>/HLS.js path used for Supabase recordings. These helpers keep that
// detection and URL shaping in one testable place.

export function isVimeoEmbedUrl(url) {
  return /player\.vimeo\.com\/video\//i.test(String(url || ''))
}

export function isVimeoPlayback(video, url) {
  if (video?.playback_type === 'vimeo_embed') return true
  return isVimeoEmbedUrl(url || video?.url)
}

// Return an embed src that preserves the private ?h= hash (required to play a
// private recording) while trimming Vimeo's player chrome and disabling tracking.
export function buildVimeoEmbedSrc(url) {
  const raw = String(url || '').trim()
  if (!raw) return ''
  const [base, query = ''] = raw.split('?')
  const params = new URLSearchParams(query)
  params.set('dnt', '1')
  params.set('badge', '0')
  params.set('byline', '0')
  params.set('portrait', '0')
  params.set('title', '0')
  return `${base}?${params.toString()}`
}
