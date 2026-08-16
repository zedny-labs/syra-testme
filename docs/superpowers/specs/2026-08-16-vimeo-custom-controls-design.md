# Design: Custom controls for the Vimeo video review player

**Date:** 2026-08-16
**Status:** Approved (pending spec review)

## Problem

Proctoring recordings stored on Vimeo play through an `<iframe src="player.vimeo.com/...">` in the admin Video Review page (`AdminAttemptVideos.jsx`). That iframe renders **Vimeo's own player UI** — its logo, a "like" (heart) button, a "watch later" (clock) button, and its own play/pause/volume/fullscreen controls. This is fundamentally different from the plain `<video controls>` element used for Supabase-hosted recordings, which shows only the browser's native, unbranded controls.

For an internal proctoring-review tool, third-party social-video branding (like/watch-later/logo) looks out of place and unprofessional. `title`, `byline`, `portrait`, `badge`, and the end-of-clip "more videos" screen are already suppressed via existing embed params and a Vimeo API call (`_disable_end_screen` in `vimeo_media.py`), but the native control bar itself — and its branding — remains.

## Goal

Replace Vimeo's native control bar with a small custom one, styled to match the app's own theme, so the review player looks like part of the product rather than an embedded Vimeo widget. Functional parity with what reviewers already have via the native bar: play/pause, seek, time display, volume, fullscreen.

## Scope decisions (confirmed with user)

- **Visual style:** match the app's own existing theme (colors, spacing) — not an attempt to mimic the native `<video controls>` look.
- **Control set:** baseline only — play/pause, scrubber (with buffered indicator), current time / duration, volume/mute, fullscreen. No playback-speed selector (considered, declined for now).
- **Layout:** the control bar is a separate row directly below the video frame, not an overlay floating on top of it.
- **Scope:** this only affects the Vimeo playback path in `AdminAttemptVideos.jsx`. The Supabase `<video controls>` path is unchanged.

## Design

### 1. Hide Vimeo's native bar

`buildVimeoEmbedSrc` (`vimeoPlayback.js`) gains one more query param alongside the existing `dnt=1`, `badge=0`, `byline=0`, `portrait=0`, `title=0`:

- `controls=0` — Vimeo's embed API supports fully suppressing its native control chrome when the page drives playback itself via the Player SDK, which this app already loads (`@vimeo/player`).

### 2. New component: `VimeoControlsBar.jsx`

A small presentational component, colocated with `AdminAttemptVideos.jsx` and `vimeoPlayback.js`.

**Props:**
- `player` — the existing `@vimeo/player` instance (`vimeoPlayerRef.current`), or `null` while still loading.
- `currentTime`, `duration` — numbers, already tracked by the parent (used today for the Warning Timeline).
- `onSeek(seconds)` — the parent's existing `seekTo` function, reused as-is (the same one the Warning Timeline already calls).

**Internal state** (things the parent doesn't already track):
- `isPlaying` (bool)
- `volume` (0–1) and `isMuted` (bool)
- `bufferedPercent` (0–100)
- `isDragging` / `dragTime` — while the user is actively dragging the scrubber, the displayed position follows the drag, not the live `currentTime`, and the actual seek (`onSeek`) fires on release.

**Wiring:** on mount (and whenever `player` changes), subscribe to the SDK's `play`, `pause`, `volumechange`, and `progress` events to keep the above state in sync; unsubscribe on cleanup. This mirrors the existing subscribe/cleanup pattern already used in the parent's player-creation effect (`AdminAttemptVideos.jsx` ~line 683) and adds a second, independent set of listeners on the same player instance — the Vimeo SDK supports multiple listeners per event without conflict.

**Renders:**
- Play/pause icon button — toggles `player.play()` / `player.pause()`.
- Scrubber — a click/drag track showing playback progress and a buffered-range fill behind it. Click/drag position→seconds math reuses the same `getBoundingClientRect()` + `(clientX - rect.left) / rect.width` pattern already used for the Warning Timeline's click-to-seek (`AdminAttemptVideos.jsx` ~line 985), for consistency.
- Time label — `currentTime / duration`, formatted with the existing `formatSeconds` helper already in the file.
- Volume button + slider — toggles mute and adjusts `player.setVolume()`.
- Fullscreen button — calls `player.requestFullscreen()` (SDK method); if unavailable, falls back to calling `.requestFullscreen()` on the iframe DOM element directly.

### 3. Styling

New classnames added to the existing `AdminAttemptVideos.module.scss`, built from the CSS custom properties already used elsewhere in that file (`var(--color-*)`, existing border-radius/spacing conventions) so the bar automatically matches the current theme without introducing new design tokens.

### 4. Integration point

In `AdminAttemptVideos.jsx`, the Vimeo branch of the player render (~line 913) renders the iframe as it does today, plus the new bar directly below it:

```
<div className={styles.playerViewport}>
  <iframe ... src={buildVimeoEmbedSrc(...)} />
  {selectedVideoIsVimeo && (
    <VimeoControlsBar
      player={vimeoPlayerRef.current}
      currentTime={currentTime}
      duration={effectiveDuration}
      onSeek={seekTo}
    />
  )}
</div>
```

No changes to the existing player-creation effect, `seekTo`, or the Warning Timeline — they're reused, not modified.

## Error handling

- `player` is `null` while the iframe/SDK is still loading → the bar renders in a disabled state (buttons inert, scrubber at 0) rather than throwing. Mirrors the existing `if (!player) return` guards already used elsewhere in this file for the Vimeo path.
- Volume/fullscreen SDK calls are wrapped defensively (`.catch(() => {})`), matching the existing pattern already used for `player.setCurrentTime(...)` in `seekTo`.
- Fullscreen falls back to the raw iframe element's `requestFullscreen()` if the SDK method throws or is unavailable.

## Testing

**Frontend unit tests** (extending the existing `vimeoPlayback.test.js` style):
- `buildVimeoEmbedSrc` includes `controls=0` alongside the existing suppressed params.
- Pure helpers used by the controls bar (time formatting, click-position→seconds math) — these don't depend on a live SDK instance or the frontend test harness's broken provider mocks.

**Not planned:** full component-mount tests for `VimeoControlsBar` against a real/mocked `@vimeo/player` instance. The existing frontend test harness (`_workspace_nonruntime/tests/`) has ~168 pre-existing, unrelated failures from a broken provider harness — investing in new mount tests there isn't reliable. Verification is via manual/live check on the deployed admin page instead, consistent with how the rest of the Vimeo integration work was verified.

## Out of scope (future work)

- Playback-speed selector.
- Keyboard shortcuts (space to play/pause, arrow keys to seek) — native `<video controls>` gives this for free today; the custom bar doesn't replicate it in v1.
- Picture-in-picture button (Vimeo's native bar has one; not carried over).
- Any change to the Supabase `<video controls>` playback path.
