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
