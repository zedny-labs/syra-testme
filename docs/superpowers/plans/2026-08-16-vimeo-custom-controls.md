# Custom Vimeo Controls Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Vimeo's native embedded control bar (logo, like/watch-later buttons, native play/scrub/volume/fullscreen UI) in the admin Video Review page with a small custom control bar styled to match the app's own theme.

**Architecture:** Suppress Vimeo's native chrome via the `controls=0` embed param. Add a new presentational `VimeoControlsBar` component that drives the existing `@vimeo/player` SDK instance (`vimeoPlayerRef`) already created in `AdminAttemptVideos.jsx`, reusing the parent's existing `currentTime`/`duration`/`seekTo` rather than duplicating that state. The bar renders as its own row directly below the video iframe (not an overlay).

**Tech Stack:** React (function components, hooks), `@vimeo/player` SDK (already a dependency), Vitest for unit tests, SCSS modules.

**Design doc:** `docs/superpowers/specs/2026-08-16-vimeo-custom-controls-design.md`

---

## Implementation note (refinement over the design doc)

Two small refinements decided during planning, both staying within the approved design's intent:

1. **No shared `formatSeconds` import.** The design doc said to reuse the existing `formatSeconds` in `AdminAttemptVideos.jsx`. Exporting it and importing it into `VimeoControlsBar.jsx` would create a circular import (`AdminAttemptVideos.jsx` → `VimeoControlsBar.jsx` → `AdminAttemptVideos.jsx`, since the parent also imports the new component). This codebase already tolerates small local duplicates of this exact helper (`AttemptResult.jsx`, `Attempts.jsx`, `AdminAttemptVideos.jsx` each define their own copy) — `VimeoControlsBar.jsx` gets its own local copy too, consistent with that existing pattern.
2. **Fullscreen uses the DOM API directly, not an SDK method.** `@vimeo/player`'s documented method surface does not include a `requestFullscreen()` method. The iframe already has `allow="autoplay; fullscreen; picture-in-picture"` and `allowFullScreen` set, so the button calls the standard `iframeRef.current.requestFullscreen()` directly — no SDK dependency, no fallback branch needed.
3. **Buttons reuse the existing `.navBtn` class** (already used for Prev/Next/Refresh in this same file) instead of introducing new button CSS — same visual style for free, including its existing `:disabled` state.
4. **Scrubber drag uses the Pointer Events API with pointer capture** (`setPointerCapture`), not manual `window`-level `mousemove`/`mouseup` listeners — simpler, and handles mouse and touch uniformly.

---

### Task 1: Suppress Vimeo's native control bar

**Files:**
- Modify: `frontend/src/pages/Admin/AdminAttemptVideos/vimeoPlayback.js:19-30`
- Test: `_workspace_nonruntime/tests/frontend/src/pages/Admin/AdminAttemptVideos/vimeoPlayback.test.js`

- [ ] **Step 1: Write the failing test**

Add this test to the existing `describe('buildVimeoEmbedSrc', ...)` block in `_workspace_nonruntime/tests/frontend/src/pages/Admin/AdminAttemptVideos/vimeoPlayback.test.js` (insert right after the existing `it('preserves the private hash and adds privacy-friendly params', ...)` test, before the closing `})` of that `describe` block):

```javascript
  it('hides the native Vimeo control bar', () => {
    const src = buildVimeoEmbedSrc('https://player.vimeo.com/video/123?h=abc123')
    expect(src).toContain('controls=0')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm run test -- src/pages/Admin/AdminAttemptVideos/vimeoPlayback.test.js`

Expected: FAIL — `expected '...' to contain 'controls=0'`

- [ ] **Step 3: Implement**

In `frontend/src/pages/Admin/AdminAttemptVideos/vimeoPlayback.js`, replace:

```javascript
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
```

with:

```javascript
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
  // Native Vimeo controls are replaced by our own VimeoControlsBar component,
  // driven by the @vimeo/player SDK this page already loads.
  params.set('controls', '0')
  return `${base}?${params.toString()}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/pages/Admin/AdminAttemptVideos/vimeoPlayback.test.js`

Expected: `Test Files 1 passed (1)`, `Tests 8 passed (8)`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Admin/AdminAttemptVideos/vimeoPlayback.js _workspace_nonruntime/tests/frontend/src/pages/Admin/AdminAttemptVideos/vimeoPlayback.test.js
git commit -m "feat(proctoring): hide native Vimeo controls in the embed"
```

---

### Task 2: Add translation keys

**Files:**
- Modify: `frontend/src/locales/en.json`

- [ ] **Step 1: Add the new keys**

In `frontend/src/locales/en.json`, find this existing line:

```json
  "admin_videos_timeline_aria": "Video timeline - click to seek",
```

Add these six new keys directly after it (same file, same indentation — other languages fall back to English automatically via the existing `useLanguage` fallback, so no other locale file needs editing):

```json
  "admin_videos_play": "Play",
  "admin_videos_pause": "Pause",
  "admin_videos_mute": "Mute",
  "admin_videos_unmute": "Unmute",
  "admin_videos_fullscreen": "Fullscreen",
  "admin_videos_seek_aria": "Recording seek bar - click or drag to seek",
  "admin_videos_volume_aria": "Volume",
```

- [ ] **Step 2: Verify the file is still valid JSON**

Run (from `frontend/`): `node -e "JSON.parse(require('fs').readFileSync('src/locales/en.json', 'utf8')); console.log('valid JSON')"`

Expected: `valid JSON`

- [ ] **Step 3: Commit**

```bash
git add frontend/src/locales/en.json
git commit -m "feat(proctoring): add translation keys for the custom Vimeo controls bar"
```

---

### Task 3: Add controls-bar styling

**Files:**
- Modify: `frontend/src/pages/Admin/AdminAttemptVideos/AdminAttemptVideos.module.scss:384-397`

- [ ] **Step 1: Insert the new classes**

In `frontend/src/pages/Admin/AdminAttemptVideos/AdminAttemptVideos.module.scss`, find:

```scss
.videoLoading {
  width: 100%;
  min-height: 260px;
  max-height: 420px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--color-border) 65%, transparent);
  background: #000;
  color: var(--color-muted);
  font-size: 0.88rem;
}

.timelineWrap {
```

Replace it with (inserting the new block between `.videoLoading` and `.timelineWrap`):

```scss
.videoLoading {
  width: 100%;
  min-height: 260px;
  max-height: 420px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--color-border) 65%, transparent);
  background: #000;
  color: var(--color-muted);
  font-size: 0.88rem;
}

.vimeoPlayerWrap {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.vimeoControlsBar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.vimeoScrubTrack {
  position: relative;
  flex: 1;
  min-width: 120px;
  height: 10px;
  border-radius: 999px;
  border: 1px solid var(--review-border);
  background: linear-gradient(90deg, rgba(8, 13, 28, 0.92), rgba(17, 26, 45, 0.96));
  cursor: pointer;
  user-select: none;
  touch-action: none;
  overflow: hidden;
}

.vimeoScrubBuffered {
  position: absolute;
  inset: 0 auto 0 0;
  background: color-mix(in srgb, var(--color-muted) 45%, transparent);
  pointer-events: none;
  max-width: 100%;
}

.vimeoScrubPlayed {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--color-primary, #6366f1);
  pointer-events: none;
  max-width: 100%;
  transition: width 0.1s linear;
}

.vimeoTimeDisplay {
  font-size: 0.84rem;
  font-variant-numeric: tabular-nums;
  color: var(--color-muted);
  white-space: nowrap;
}

.vimeoVolumeSlider {
  width: 80px;
  accent-color: var(--color-primary, #6366f1);
}

.timelineWrap {
```

- [ ] **Step 2: Verify the SCSS compiles**

Run (from `frontend/`): `npx sass --no-source-map src/pages/Admin/AdminAttemptVideos/AdminAttemptVideos.module.scss /tmp/vimeo-controls-check.css`

Expected: exits with no output (exit code 0). Clean up: `rm -f /tmp/vimeo-controls-check.css`

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/Admin/AdminAttemptVideos/AdminAttemptVideos.module.scss
git commit -m "feat(proctoring): add styling for the custom Vimeo controls bar"
```

---

### Task 4: Build the `VimeoControlsBar` component

**Files:**
- Create: `frontend/src/pages/Admin/AdminAttemptVideos/VimeoControlsBar.jsx`
- Test: Create `_workspace_nonruntime/tests/frontend/src/pages/Admin/AdminAttemptVideos/VimeoControlsBar.test.js`

- [ ] **Step 1: Write the failing tests for the pure helpers**

Create `_workspace_nonruntime/tests/frontend/src/pages/Admin/AdminAttemptVideos/VimeoControlsBar.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm run test -- src/pages/Admin/AdminAttemptVideos/VimeoControlsBar.test.js`

Expected: FAIL — cannot find module `./VimeoControlsBar` (the component file doesn't exist yet)

- [ ] **Step 3: Create the component**

Create `frontend/src/pages/Admin/AdminAttemptVideos/VimeoControlsBar.jsx`:

```jsx
import React, { useEffect, useRef, useState } from 'react'
import useLanguage from '../../../hooks/useLanguage'
import styles from './AdminAttemptVideos.module.scss'

export function formatSeconds(sec) {
  if (!Number.isFinite(sec)) return '--:--'
  const s = Math.max(0, Math.floor(sec || 0))
  const m = Math.floor(s / 60)
  const rs = s % 60
  const h = Math.floor(m / 60)
  if (h > 0) {
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(rs).padStart(2, '0')}`
  }
  return `${m}:${String(rs).padStart(2, '0')}`
}

export function pointerPositionToSeconds(clientX, rect, duration) {
  if (!rect || !(rect.width > 0) || !Number.isFinite(duration) || duration <= 0) return 0
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  return pct * duration
}

// Drives the existing @vimeo/player SDK instance to render a control bar
// styled to match this app, replacing Vimeo's native (branded) controls —
// see docs/superpowers/specs/2026-08-16-vimeo-custom-controls-design.md.
export default function VimeoControlsBar({ player, iframeRef, currentTime, duration, onSeek }) {
  const { t } = useLanguage()
  const [isPlaying, setIsPlaying] = useState(false)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [bufferedPercent, setBufferedPercent] = useState(0)
  const [dragSeconds, setDragSeconds] = useState(null)
  const trackRef = useRef(null)

  useEffect(() => {
    if (!player) return undefined
    const handlePlay = () => setIsPlaying(true)
    const handlePause = () => setIsPlaying(false)
    const handleVolumeChange = ({ volume: v }) => {
      const safeVolume = Number.isFinite(v) ? v : 1
      setVolume(safeVolume)
      setIsMuted(safeVolume === 0)
    }
    const handleProgress = ({ percent }) => {
      if (Number.isFinite(percent)) setBufferedPercent(Math.max(0, Math.min(100, percent * 100)))
    }
    player.on('play', handlePlay)
    player.on('pause', handlePause)
    player.on('volumechange', handleVolumeChange)
    player.on('progress', handleProgress)
    player.getVolume().then((v) => {
      const safeVolume = Number.isFinite(v) ? v : 1
      setVolume(safeVolume)
      setIsMuted(safeVolume === 0)
    }).catch(() => {})
    return () => {
      try { player.off('play', handlePlay) } catch { /* noop */ }
      try { player.off('pause', handlePause) } catch { /* noop */ }
      try { player.off('volumechange', handleVolumeChange) } catch { /* noop */ }
      try { player.off('progress', handleProgress) } catch { /* noop */ }
    }
  }, [player])

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
  const displaySeconds = dragSeconds !== null ? dragSeconds : (Number.isFinite(currentTime) ? currentTime : 0)
  const playedPercent = safeDuration > 0 ? Math.min(100, (displaySeconds / safeDuration) * 100) : 0

  const togglePlay = () => {
    if (!player) return
    if (isPlaying) player.pause().catch(() => {})
    else player.play().catch(() => {})
  }

  const toggleMute = () => {
    if (!player) return
    const nextMuted = !isMuted
    player.setVolume(nextMuted ? 0 : (volume || 1)).catch(() => {})
    setIsMuted(nextMuted)
  }

  const changeVolume = (e) => {
    if (!player) return
    const next = Number(e.target.value)
    player.setVolume(next).catch(() => {})
    setVolume(next)
    setIsMuted(next === 0)
  }

  const seekToClientX = (clientX) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return pointerPositionToSeconds(clientX, rect, safeDuration)
  }

  const handleTrackPointerDown = (e) => {
    if (!player) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragSeconds(seekToClientX(e.clientX))
  }

  const handleTrackPointerMove = (e) => {
    if (dragSeconds === null) return
    setDragSeconds(seekToClientX(e.clientX))
  }

  const handleTrackPointerUp = (e) => {
    if (dragSeconds === null) return
    const target = seekToClientX(e.clientX)
    setDragSeconds(null)
    onSeek(target)
  }

  const requestFullscreen = () => {
    iframeRef?.current?.requestFullscreen?.().catch(() => {})
  }

  return (
    <div className={styles.vimeoControlsBar}>
      <button type="button" className={styles.navBtn} onClick={togglePlay} disabled={!player}>
        {isPlaying ? t('admin_videos_pause') : t('admin_videos_play')}
      </button>

      <div
        ref={trackRef}
        className={styles.vimeoScrubTrack}
        role="slider"
        aria-label={t('admin_videos_seek_aria')}
        aria-valuemin={0}
        aria-valuemax={safeDuration}
        aria-valuenow={displaySeconds}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={handleTrackPointerUp}
      >
        <div className={styles.vimeoScrubBuffered} style={{ width: `${bufferedPercent}%` }} />
        <div className={styles.vimeoScrubPlayed} style={{ width: `${playedPercent}%` }} />
      </div>

      <span className={styles.vimeoTimeDisplay}>
        {formatSeconds(displaySeconds)} / {formatSeconds(safeDuration)}
      </span>

      <button type="button" className={styles.navBtn} onClick={toggleMute} disabled={!player}>
        {isMuted ? t('admin_videos_unmute') : t('admin_videos_mute')}
      </button>

      <input
        type="range"
        className={styles.vimeoVolumeSlider}
        min={0}
        max={1}
        step={0.05}
        value={isMuted ? 0 : volume}
        onChange={changeVolume}
        disabled={!player}
        aria-label={t('admin_videos_volume_aria')}
      />

      <button type="button" className={styles.navBtn} onClick={requestFullscreen} disabled={!player}>
        {t('admin_videos_fullscreen')}
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/pages/Admin/AdminAttemptVideos/VimeoControlsBar.test.js`

Expected: `Test Files 1 passed (1)`, `Tests 8 passed (8)`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Admin/AdminAttemptVideos/VimeoControlsBar.jsx _workspace_nonruntime/tests/frontend/src/pages/Admin/AdminAttemptVideos/VimeoControlsBar.test.js
git commit -m "feat(proctoring): add VimeoControlsBar component"
```

---

### Task 5: Wire the new bar into the Video Review page

**Files:**
- Modify: `frontend/src/pages/Admin/AdminAttemptVideos/AdminAttemptVideos.jsx:9-10`, `:911-923`

- [ ] **Step 1: Import the new component**

In `frontend/src/pages/Admin/AdminAttemptVideos/AdminAttemptVideos.jsx`, find:

```javascript
import { buildVimeoEmbedSrc, isVimeoPlayback } from './vimeoPlayback'
import styles from './AdminAttemptVideos.module.scss'
```

Replace with:

```javascript
import { buildVimeoEmbedSrc, isVimeoPlayback } from './vimeoPlayback'
import VimeoControlsBar from './VimeoControlsBar'
import styles from './AdminAttemptVideos.module.scss'
```

- [ ] **Step 2: Wrap the iframe and add the controls bar**

In the same file, find:

```jsx
            <div className={styles.playerViewport}>
              {selectedVideoUrl ? (
                selectedVideoIsVimeo ? (
                  <iframe
                    key={`vimeo-${selectedVideo?.name || 'recording'}`}
                    ref={vimeoIframeRef}
                    className={styles.video}
                    src={buildVimeoEmbedSrc(selectedVideoUrl)}
                    title={selectedVideo?.name || t('admin_videos_source_recording')}
                    allow="autoplay; fullscreen; picture-in-picture"
                    allowFullScreen
                  />
                ) : (
```

Replace with:

```jsx
            <div className={styles.playerViewport}>
              {selectedVideoUrl ? (
                selectedVideoIsVimeo ? (
                  <div className={styles.vimeoPlayerWrap}>
                    <iframe
                      key={`vimeo-${selectedVideo?.name || 'recording'}`}
                      ref={vimeoIframeRef}
                      className={styles.video}
                      src={buildVimeoEmbedSrc(selectedVideoUrl)}
                      title={selectedVideo?.name || t('admin_videos_source_recording')}
                      allow="autoplay; fullscreen; picture-in-picture"
                      allowFullScreen
                    />
                    <VimeoControlsBar
                      player={vimeoPlayerRef.current}
                      iframeRef={vimeoIframeRef}
                      currentTime={currentTime}
                      duration={effectiveDuration}
                      onSeek={seekTo}
                    />
                  </div>
                ) : (
```

Then find the closing of that same ternary a few lines down:

```jsx
                  />
                )
              ) : (
                <div className={styles.videoLoading}>{describeVideoAvailability(selectedVideo, t)}</div>
              )}
            </div>
```

This does **not** change — the `<video>` branch's closing `/>` and the outer ternary structure are unaffected; only the Vimeo branch gained a wrapping `<div>`. Leave it as-is; this step is a verification note, not an edit.

- [ ] **Step 3: Run the full frontend unit test suite for this page's tests**

Run (from `frontend/`): `npm run test -- src/pages/Admin/AdminAttemptVideos`

Expected: both `vimeoPlayback.test.js` and `VimeoControlsBar.test.js` pass (8 tests each, 16 total). This does not mount `AdminAttemptVideos.jsx` itself (no test file targets it), so this run only confirms the two modules above still pass after the import change — it does not catch JSX typos in `AdminAttemptVideos.jsx`. Follow with Step 4.

- [ ] **Step 4: Verify the frontend still builds**

Run (from `frontend/`): `npm run build`

Expected: build completes successfully with no errors (this catches any JSX/import mistakes in `AdminAttemptVideos.jsx` that the unit tests above wouldn't).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Admin/AdminAttemptVideos/AdminAttemptVideos.jsx
git commit -m "feat(proctoring): render VimeoControlsBar in the Video Review page"
```

---

### Task 6: Deploy and verify live

- [ ] **Step 1: Push to main**

```bash
git push origin main
```

This triggers the "Deploy to VM" GitHub Actions workflow automatically.

- [ ] **Step 2: Watch the deploy**

```bash
gh run list --repo zedny-labs/syra-testme --workflow=docker-build.yml --limit 1
gh run watch <run-id> --repo zedny-labs/syra-testme --exit-status
```

Expected: run completes with conclusion `success`.

- [ ] **Step 3: Verify live**

Open the admin Video Review page for an existing Vimeo-backed test attempt (e.g. `https://varexam.zedny.ai/admin/videos/<attempt-id>`) and confirm:
- No native Vimeo logo, like button, or watch-later button visible.
- The new control bar renders below the video: play/pause, scrubber, time, mute, volume slider, fullscreen.
- Play/pause toggles playback and the button label swaps.
- Clicking and dragging the scrubber seeks the video.
- Volume slider changes playback volume; mute button toggles it.
- Fullscreen button enters fullscreen.
