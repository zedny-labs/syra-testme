import { useEffect, useState } from 'react'

// Canonical breakpoints (px). Keep in sync with src/styles/_breakpoints.scss.
export const BREAKPOINTS = { xs: 480, sm: 640, md: 768, lg: 1024, xl: 1280 }

const getMatch = (query) =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false

// Subscribe to a CSS media query and re-render when it changes.
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => getMatch(query))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const mql = window.matchMedia(query)
    const handler = (event) => setMatches(event.matches)
    setMatches(mql.matches)
    // Safari <14 uses addListener/removeListener
    if (mql.addEventListener) mql.addEventListener('change', handler)
    else mql.addListener(handler)
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', handler)
      else mql.removeListener(handler)
    }
  }, [query])

  return matches
}

// true when the viewport is at or below the given breakpoint (default md / 768px).
export function useIsMobile(breakpoint = 'md') {
  const px = BREAKPOINTS[breakpoint] ?? BREAKPOINTS.md
  return useMediaQuery(`(max-width: ${px - 0.02}px)`)
}
