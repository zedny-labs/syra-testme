import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Hls from 'hls.js'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { adminApi } from '../../../services/admin.service'
import { fetchAuthenticatedMediaObjectUrl, revokeObjectUrl } from '../../../utils/authenticatedMedia'
import { translateEventType, translateSeverity } from '../../../utils/proctoringLabels'
import { readPaginatedItems } from '../../../utils/pagination'
import useLanguage from '../../../hooks/useLanguage'
import { buildVimeoEmbedSrc, isVimeoPlayback } from './vimeoPlayback'
import VimeoControlsBar from './VimeoControlsBar'
import styles from './AdminAttemptVideos.module.scss'

const WARN_SEVERITIES = new Set(['HIGH', 'MEDIUM'])
const NOT_READY_VIDEO_STATUSES = new Set(['queued', 'pending', 'uploading', 'processing', 'inprogress', 'error', 'failed'])

function formatSeconds(sec) {
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

function severityClass(severity) {
  if (severity === 'HIGH') return styles.eventHigh
  if (severity === 'MEDIUM') return styles.eventMedium
  return styles.eventLow
}

function formatVideoSource(source, t) {
  if (source === 'screen') return t('admin_videos_source_screen')
  if (source === 'camera') return t('admin_videos_source_camera')
  return t('admin_videos_source_recording')
}

function isAbsoluteHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim())
}

function isHlsPlaybackUrl(url, playbackType) {
  if (playbackType === 'hls') return true
  return /\.m3u8($|\?)/i.test(String(url || ''))
}

function readMediaRangeEnd(ranges) {
  try {
    if (!ranges || ranges.length < 1) return 0
    const end = ranges.end(ranges.length - 1)
    return Number.isFinite(end) && end > 0 ? end : 0
  } catch {
    return 0
  }
}

function readBestVideoDuration(videoEl) {
  if (!videoEl) return 0
  if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
    return videoEl.duration
  }
  return Math.max(
    readMediaRangeEnd(videoEl.seekable),
    readMediaRangeEnd(videoEl.buffered),
  )
}

function readVideoDurationValue(video) {
  const value = Number(video?.duration)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function normalizeVideoStatus(video) {
  return String(video?.status || '').trim().toLowerCase()
}

function isVideoPlayable(video) {
  if (!video?.url) return false
  const status = normalizeVideoStatus(video)
  if (status && NOT_READY_VIDEO_STATUSES.has(status)) return false
  return video.ready_to_stream !== false
}

function describeVideoAvailability(video, t) {
  const status = normalizeVideoStatus(video)
  if (status === 'processing' || status === 'uploading' || status === 'queued' || status === 'pending' || status === 'inprogress') {
    return t('admin_videos_still_processing')
  }
  if (status === 'error' || status === 'failed') {
    return t('admin_videos_failed_to_process')
  }
  if (!video?.url) {
    return t('admin_videos_no_playable_file')
  }
  if (video?.ready_to_stream === false) {
    return t('admin_videos_not_ready_to_stream')
  }
  return t('admin_videos_loading_recording')
}

function summarizeVideoState(video, t) {
  if (!video) return t('admin_videos_not_saved')
  if (isVideoPlayable(video)) {
    const seconds = readVideoDurationValue(video)
    return seconds > 0 ? formatSeconds(seconds) : t('admin_videos_saved')
  }
  const status = normalizeVideoStatus(video)
  if (status === 'processing' || status === 'uploading' || status === 'queued' || status === 'pending' || status === 'inprogress') {
    return t('admin_videos_processing')
  }
  if (status === 'error' || status === 'failed') {
    return t('admin_videos_failed')
  }
  return t('admin_videos_saved')
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'ERR_CANCELED'
}

export default function AdminAttemptVideos() {
  const { t } = useLanguage()
  const { attemptId } = useParams()
  const [searchParams] = useSearchParams()
  const examIdFilter = searchParams.get('exam_id')
  const inSupervisionMode = !attemptId
  const navigate = useNavigate()
  const videoRef = useRef(null)
  const hlsRef = useRef(null)
  const vimeoIframeRef = useRef(null)
  const vimeoPlayerRef = useRef(null)
  const vimeoPlayerWrapRef = useRef(null)
  const durationProbeKeyRef = useRef('')
  const dataAbortRef = useRef(null)

  // Supervision mode: exam-level attempt picker
  const [examAttempts, setExamAttempts] = useState([])
  const [selectedAttemptId, setSelectedAttemptId] = useState(attemptId || '')
  const activeAttemptId = selectedAttemptId || attemptId
  const hasResolvedAttempt = Boolean(activeAttemptId && activeAttemptId !== 'undefined' && activeAttemptId !== 'null')

  const [loading, setLoading] = useState(true)
  const [attemptsLoading, setAttemptsLoading] = useState(inSupervisionMode)
  const [attempt, setAttempt] = useState(null)
  const [videos, setVideos] = useState([])
  const [events, setEvents] = useState([])
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [selectedVideoName, setSelectedVideoName] = useState('')
  const [selectedVideoUrl, setSelectedVideoUrl] = useState('')
  const [deleteVideoConfirm, setDeleteVideoConfirm] = useState(false)
  const [deletingVideo, setDeletingVideo] = useState(false)
  const [selectedEvidenceUrl, setSelectedEvidenceUrl] = useState('')
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [retryToken, setRetryToken] = useState(0)
  const [severityFilter, setSeverityFilter] = useState('ALL')
  const [eventTypeFilter, setEventTypeFilter] = useState('ALL')
  const [selectedEventId, setSelectedEventId] = useState('')

  // When in supervision mode (no attemptId, has exam_id), load all attempts for exam
  useEffect(() => {
    if (!inSupervisionMode) {
      setAttemptsLoading(false)
      setExamAttempts([])
      return
    }

    const controller = new AbortController()
    setAttemptsLoading(true)
    setError('')
    adminApi.attempts({ ...(examIdFilter ? { exam_id: examIdFilter } : {}), skip: 0, limit: 200 }, { signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return
        const filtered = readPaginatedItems(data)
        setExamAttempts(filtered)
        if (filtered.length > 0) {
          setSelectedAttemptId((current) => current || String(filtered[0].id))
        } else {
          setSelectedAttemptId('')
          setAttempt(null)
          setVideos([])
          setEvents([])
          setSelectedVideoName('')
          setLoading(false)
        }
      })
      .catch((e) => {
        if (isAbortError(e)) return
        setExamAttempts([])
        setSelectedAttemptId('')
        setAttempt(null)
        setVideos([])
        setEvents([])
        setSelectedVideoName('')
        setError(e.response?.data?.detail || t('admin_videos_load_attempts_error'))
        setLoading(false)
      })
      .finally(() => {
        if (!controller.signal.aborted) setAttemptsLoading(false)
      })

    return () => { controller.abort() }
  }, [inSupervisionMode, examIdFilter, retryToken])

  useEffect(() => {
    if (attemptId) {
      setSelectedAttemptId(attemptId)
      setDuration(0)
      setCurrentTime(0)
    }
  }, [attemptId])

  useEffect(() => {
    const resolvedId = activeAttemptId
    if (!resolvedId || resolvedId === 'undefined' || resolvedId === 'null') {
      setAttempt(null)
      setVideos([])
      setEvents([])
      setSelectedVideoName('')
      if (!inSupervisionMode) {
        setError(t('admin_videos_invalid_attempt_id'))
      }
      if (!attemptsLoading) setLoading(false)
      return
    }

    if (dataAbortRef.current) dataAbortRef.current.abort()
    const controller = new AbortController()
    dataAbortRef.current = controller
    async function load() {
      setLoading(true)
      setError('')
      setWarning('')
      setSelectedVideoName('')
      try {
        const [attemptResult, videosResult, eventsResult] = await Promise.allSettled([
          adminApi.getAttempt(resolvedId, { signal: controller.signal }),
          adminApi.listAttemptVideos(resolvedId, { signal: controller.signal }),
          adminApi.getAttemptEvents(resolvedId, { signal: controller.signal }),
        ])
        if (controller.signal.aborted) return
        if (attemptResult.status !== 'fulfilled') {
          setAttempt(null)
          setVideos([])
          setEvents([])
          setError(attemptResult.reason?.response?.data?.detail || t('admin_videos_load_recordings_error'))
          return
        }

        const warnings = []
        const attemptData = attemptResult.value.data || null
        const videosData = videosResult.status === 'fulfilled' ? (videosResult.value.data || []) : []
        const eventsData = eventsResult.status === 'fulfilled' ? (eventsResult.value.data || []) : []

        if (videosResult.status !== 'fulfilled') {
          warnings.push(t('admin_videos_recordings_load_failed'))
        }
        if (eventsResult.status !== 'fulfilled') {
          warnings.push(t('admin_videos_events_load_failed'))
        }

        const sortedVideos = [...videosData].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        const defaultVideo = sortedVideos.find((video) => isVideoPlayable(video)) || sortedVideos[0] || null
        setAttempt(attemptData)
        setVideos(sortedVideos)
        setEvents(eventsData)
        setSelectedVideoName((prev) => (
          prev && sortedVideos.some((video) => video.name === prev)
            ? prev
            : (defaultVideo?.name || '')
        ))
        setWarning(warnings.join(' '))
      } catch (e) {
        if (isAbortError(e)) return
        setError(e.response?.data?.detail || t('admin_videos_load_recordings_error'))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    load()
    return () => { controller.abort() }
  }, [activeAttemptId, attemptsLoading, inSupervisionMode, retryToken])

  const selectedVideo = useMemo(
    () => videos.find((v) => v.name === selectedVideoName) || videos[0] || null,
    [videos, selectedVideoName],
  )

  useEffect(() => {
    setDeleteVideoConfirm(false)
  }, [selectedVideoName])
  const selectedVideoIsPlayable = useMemo(
    () => isVideoPlayable(selectedVideo),
    [selectedVideo],
  )
  const effectiveDuration = useMemo(
    () => (duration > 0 ? duration : readVideoDurationValue(selectedVideo)),
    [duration, selectedVideo],
  )
  const selectedVideoUsesHls = useMemo(
    () => isHlsPlaybackUrl(selectedVideoUrl || selectedVideo?.url, selectedVideo?.playback_type),
    [selectedVideo?.playback_type, selectedVideo?.url, selectedVideoUrl],
  )
  const selectedVideoIsVimeo = useMemo(
    () => isVimeoPlayback(selectedVideo, selectedVideoUrl),
    [selectedVideo, selectedVideoUrl],
  )
  const latestVideosBySource = useMemo(() => {
    const bySource = new Map()
    for (const video of videos) {
      if (!video?.source || bySource.has(video.source)) continue
      bySource.set(video.source, video)
    }
    return bySource
  }, [videos])

  const warningEvents = useMemo(
    () => (events || []).filter((e) => e && WARN_SEVERITIES.has(e.severity)),
    [events],
  )

  const attemptStartMs = useMemo(() => {
    if (!attempt?.started_at) return null
    const startedAtMs = new Date(attempt.started_at).getTime()
    return Number.isFinite(startedAtMs) ? startedAtMs : null
  }, [attempt?.started_at])

  const selectedVideoRecordedStartMs = useMemo(() => {
    if (!selectedVideo?.recording_started_at) return null
    const recordedStartMs = new Date(selectedVideo.recording_started_at).getTime()
    return Number.isFinite(recordedStartMs) ? recordedStartMs : null
  }, [selectedVideo?.recording_started_at])

  const selectedVideoRecordedEndMs = useMemo(() => {
    if (!selectedVideo?.recording_stopped_at) return null
    const recordedEndMs = new Date(selectedVideo.recording_stopped_at).getTime()
    return Number.isFinite(recordedEndMs) ? recordedEndMs : null
  }, [selectedVideo?.recording_stopped_at])

  const selectedVideoStartMs = useMemo(() => {
    if (selectedVideoRecordedStartMs !== null) return selectedVideoRecordedStartMs
    if (!selectedVideo?.created_at || !(effectiveDuration > 0)) return null
    const createdAtMs = new Date(selectedVideo.created_at).getTime()
    if (!Number.isFinite(createdAtMs)) return null
    return createdAtMs - (effectiveDuration * 1000)
  }, [effectiveDuration, selectedVideo?.created_at, selectedVideoRecordedStartMs])

  const selectedVideoEndMs = useMemo(() => {
    if (selectedVideoRecordedEndMs !== null) return selectedVideoRecordedEndMs
    if (!(selectedVideoStartMs !== null) || !(effectiveDuration > 0)) return null
    return selectedVideoStartMs + (effectiveDuration * 1000)
  }, [effectiveDuration, selectedVideoRecordedEndMs, selectedVideoStartMs])

  const anchorStartMs = selectedVideoStartMs ?? attemptStartMs

  const warningTimelineEvents = useMemo(() => {
    const clipToleranceMs = 1000
    return warningEvents
      .map((e) => {
        if (!e) return null
        const eventTime = e.occurred_at ? new Date(e.occurred_at).getTime() : null
        let second = 0
        if (anchorStartMs && eventTime) {
          second = Math.max(0, (eventTime - anchorStartMs) / 1000)
        }
        const inSelectedVideo = selectedVideoStartMs !== null
          && selectedVideoEndMs !== null
          && eventTime !== null
          ? eventTime >= selectedVideoStartMs - clipToleranceMs && eventTime <= selectedVideoEndMs + clipToleranceMs
          : true
        return {
          ...e,
          second: selectedVideoStartMs !== null && effectiveDuration > 0
            ? Math.max(0, Math.min(effectiveDuration, second))
            : second,
          inSelectedVideo,
          attemptSecond: attemptStartMs && eventTime ? Math.max(0, (eventTime - attemptStartMs) / 1000) : second,
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.second - b.second)
  }, [warningEvents, anchorStartMs, attemptStartMs, effectiveDuration, selectedVideoEndMs, selectedVideoStartMs])

  const recordingWarningEvents = useMemo(
    () => warningTimelineEvents.filter((event) => event.inSelectedVideo),
    [warningTimelineEvents],
  )

  const warningTypeOptions = useMemo(
    () => Array.from(new Set(recordingWarningEvents.map((event) => event.event_type).filter(Boolean))).sort(),
    [recordingWarningEvents],
  )

  const filteredWarningEvents = useMemo(() => (
    recordingWarningEvents.filter((event) => {
      if (severityFilter !== 'ALL' && event.severity !== severityFilter) return false
      if (eventTypeFilter !== 'ALL' && event.event_type !== eventTypeFilter) return false
      return true
    })
  ), [eventTypeFilter, recordingWarningEvents, severityFilter])

  useEffect(() => {
    if (filteredWarningEvents.length === 0) {
      setSelectedEventId('')
      return
    }
    if (!selectedEventId || !filteredWarningEvents.some((event) => event.id === selectedEventId)) {
      setSelectedEventId(filteredWarningEvents[0].id)
    }
  }, [filteredWarningEvents, selectedEventId])

  const selectedEvent = useMemo(
    () => filteredWarningEvents.find((event) => event.id === selectedEventId) || filteredWarningEvents[0] || null,
    [filteredWarningEvents, selectedEventId],
  )

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    setSelectedVideoUrl('')

    async function loadVideoUrl() {
      if (!selectedVideo) return
      if (!selectedVideoIsPlayable) return
      if (!isAbsoluteHttpUrl(selectedVideo.url)) {
        setWarning((current) => current || t('admin_videos_no_playback_url'))
        return
      }
      if (isVimeoPlayback(selectedVideo, selectedVideo.url)) {
        // Vimeo recordings play through their embed iframe; the URL is a player
        // page, not a media file, so it must not be fetched as authenticated media.
        setSelectedVideoUrl(selectedVideo.url)
        return
      }
      try {
        objectUrl = await fetchAuthenticatedMediaObjectUrl(selectedVideo.url, { signal: controller.signal })
        if (controller.signal.aborted) {
          revokeObjectUrl(objectUrl)
          return
        }
        setSelectedVideoUrl(objectUrl)
      } catch (err) {
        if (!isAbortError(err)) {
          setWarning((current) => current || t('admin_videos_recording_load_failed'))
        }
      }
    }

    void loadVideoUrl()
    return () => {
      controller.abort()
      revokeObjectUrl(objectUrl)
    }
  }, [selectedVideo, selectedVideoIsPlayable])

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    setSelectedEvidenceUrl('')

    async function loadEvidenceUrl() {
      const evidencePath = selectedEvent?.meta?.evidence
      if (!evidencePath) return
      try {
        objectUrl = await fetchAuthenticatedMediaObjectUrl(evidencePath, { signal: controller.signal })
        if (controller.signal.aborted) {
          revokeObjectUrl(objectUrl)
          return
        }
        setSelectedEvidenceUrl(objectUrl)
      } catch (err) {
        if (!isAbortError(err)) {
          setWarning((current) => current || t('admin_videos_evidence_load_failed'))
        }
      }
    }

    void loadEvidenceUrl()
    return () => {
      controller.abort()
      revokeObjectUrl(objectUrl)
    }
  }, [selectedEvent?.id, selectedEvent?.meta?.evidence])

  const warningCounts = useMemo(() => {
    let high = 0
    let medium = 0
    for (const e of filteredWarningEvents) {
      if (e.severity === 'HIGH') high += 1
      else if (e.severity === 'MEDIUM') medium += 1
    }
    return { high, medium, total: high + medium }
  }, [filteredWarningEvents])

  const timelineSegments = useMemo(() => {
    const bucketCount = 120
    const finiteDuration = Number.isFinite(effectiveDuration) ? effectiveDuration : 0
    const maxEventSecond = Math.max(
      0,
      ...filteredWarningEvents.map((e) => (Number.isFinite(e.second) ? e.second : 0)),
    )
    const safeDuration = Math.max(finiteDuration, maxEventSecond + 1, finiteDuration > 0 ? finiteDuration : 1)
    const buckets = Array.from({ length: bucketCount }, () => ({ level: 0, count: 0 }))

    for (const e of filteredWarningEvents) {
      if (!e || !Number.isFinite(e.second)) continue
      const normalized = Math.min(0.9999, Math.max(0, e.second / safeDuration))
      const idx = Math.floor(normalized * bucketCount)
      if (!Number.isInteger(idx) || idx < 0 || idx >= bucketCount) continue
      const level = e.severity === 'HIGH' ? 2 : 1
      buckets[idx].level = Math.max(buckets[idx].level, level)
      buckets[idx].count += 1
    }

    return { buckets, safeDuration }
  }, [effectiveDuration, filteredWarningEvents])

  const videoSummaryCards = [
    {
      label: t('admin_videos_recordings'),
      value: videos.length,
      helper: videos.length > 0 ? t('admin_videos_all_saved_recordings') : t('admin_videos_no_recordings_yet'),
    },
    {
      label: t('admin_videos_warnings'),
      value: warningCounts.total,
      helper: t('admin_videos_filtered_warning_count'),
    },
    {
      label: t('admin_videos_high_risk'),
      value: warningCounts.high,
      helper: t('admin_videos_high_severity_events'),
    },
    {
      label: t('admin_videos_timeline_span'),
      value: formatSeconds(effectiveDuration || timelineSegments.safeDuration),
      helper: t('admin_videos_timeline_duration'),
    },
  ]

  const seekTo = (second) => {
    const target = Math.max(0, Math.min(second, effectiveDuration || second))
    if (selectedVideoIsVimeo) {
      const player = vimeoPlayerRef.current
      if (!player) return
      player.setCurrentTime(target).catch(() => {})
      setCurrentTime(target)
      return
    }
    if (!videoRef.current) return
    videoRef.current.currentTime = target
    setCurrentTime(target)
  }

  // Clicking the video itself toggles play/pause, same as clicking the
  // dedicated button in VimeoControlsBar — that component's own play/pause
  // state stays in sync regardless of who calls play()/pause() on the SDK,
  // since it listens for the SDK's own 'play'/'pause' events.
  const toggleVimeoPlayback = () => {
    const player = vimeoPlayerRef.current
    if (!player) return
    player.getPaused().then((paused) => {
      if (paused) player.play().catch(() => {})
      else player.pause().catch(() => {})
    }).catch(() => {})
  }

  const selectEvent = (event) => {
    if (!event) return
    setSelectedEventId(event.id)
    seekTo(event.second)
  }

  const handleRetry = () => {
    setDuration(0)
    setCurrentTime(0)
    setSelectedEventId('')
    setWarning('')
    setRetryToken((current) => current + 1)
  }

  const handleDeleteVideo = async () => {
    if (!selectedVideo?.event_id || !activeAttemptId) return
    if (!deleteVideoConfirm) {
      setDeleteVideoConfirm(true)
      return
    }
    setDeleteVideoConfirm(false)
    setDeletingVideo(true)
    setError('')
    try {
      await adminApi.deleteAttemptVideo(activeAttemptId, selectedVideo.event_id)
      handleRetry()
    } catch (e) {
      setError(e.response?.data?.detail || t('admin_videos_delete_failed'))
    } finally {
      setDeletingVideo(false)
    }
  }

  const clearFilters = () => {
    setSeverityFilter('ALL')
    setEventTypeFilter('ALL')
  }

  const goToNextWarning = () => {
    const idx = selectedEvent ? filteredWarningEvents.indexOf(selectedEvent) : -1
    const next = filteredWarningEvents[idx + 1]
    if (next) selectEvent(next)
  }

  const goToPrevWarning = () => {
    const idx = selectedEvent ? filteredWarningEvents.indexOf(selectedEvent) : filteredWarningEvents.length
    const prev = filteredWarningEvents[idx - 1]
    if (prev) selectEvent(prev)
  }

  const showEmptyAttemptsState = inSupervisionMode && !attemptsLoading && !hasResolvedAttempt && examAttempts.length === 0 && !error

  const syncDurationFromVideo = useCallback((videoEl) => {
    const nextDuration = readBestVideoDuration(videoEl)
    setDuration(nextDuration > 0 ? nextDuration : 0)
  }, [])

  const probeVideoDuration = useCallback((videoEl) => {
    if (!videoEl) return
    const sourceKey = videoEl.currentSrc || selectedVideoUrl || selectedVideo?.name || ''
    if (!sourceKey || durationProbeKeyRef.current === sourceKey) return
    durationProbeKeyRef.current = sourceKey

    if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
      syncDurationFromVideo(videoEl)
      return
    }

    const originalTime = videoEl.currentTime || 0
    let settled = false
    let timeoutId = null

    const finish = () => {
      if (settled) return
      settled = true
      videoEl.removeEventListener('timeupdate', handleResolvedDuration)
      videoEl.removeEventListener('durationchange', handleResolvedDuration)
      if (timeoutId) window.clearTimeout(timeoutId)
      try {
        videoEl.currentTime = originalTime
      } catch {
        // ignore seek reset failures
      }
      syncDurationFromVideo(videoEl)
    }

    const handleResolvedDuration = () => finish()

    videoEl.addEventListener('timeupdate', handleResolvedDuration, { once: true })
    videoEl.addEventListener('durationchange', handleResolvedDuration, { once: true })

    try {
      videoEl.currentTime = 1e101
      timeoutId = window.setTimeout(finish, 1500)
    } catch {
      finish()
    }
  }, [selectedVideo?.name, selectedVideoUrl, syncDurationFromVideo])

  useEffect(() => {
    durationProbeKeyRef.current = ''
  }, [selectedVideoUrl])

  useEffect(() => {
    const videoEl = videoRef.current
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }
    if (!videoEl || !selectedVideoUrl || !selectedVideoUsesHls) return undefined

    if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = selectedVideoUrl
      return () => {
        if (videoEl.src === selectedVideoUrl) {
          videoEl.removeAttribute('src')
          videoEl.load()
        }
      }
    }

    if (!Hls.isSupported()) {
      setWarning((current) => current || t('admin_videos_browser_cannot_play'))
      return undefined
    }

    const hls = new Hls()
    hlsRef.current = hls
    hls.loadSource(selectedVideoUrl)
    hls.attachMedia(videoEl)
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      syncDurationFromVideo(videoEl)
      probeVideoDuration(videoEl)
    })
    hls.on(Hls.Events.LEVEL_LOADED, () => syncDurationFromVideo(videoEl))
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal) {
        setWarning((current) => current || t('admin_videos_stream_play_failed'))
      }
    })

    return () => {
      if (hlsRef.current === hls) {
        hls.destroy()
        hlsRef.current = null
      }
    }
  }, [probeVideoDuration, selectedVideoUrl, selectedVideoUsesHls, syncDurationFromVideo])

  // Vimeo recordings play in an embed iframe. Drive it with the Vimeo Player SDK
  // so the warning timeline keeps working (seek-to-moment + live currentTime),
  // exactly like the <video> element does for Supabase recordings.
  useEffect(() => {
    if (!selectedVideoIsVimeo || !selectedVideoUrl) return undefined
    const iframe = vimeoIframeRef.current
    if (!iframe) return undefined

    let cancelled = false
    let player = null
    ;(async () => {
      try {
        const { default: Player } = await import('@vimeo/player')
        if (cancelled) return
        player = new Player(iframe)
        vimeoPlayerRef.current = player
        player.on('timeupdate', ({ seconds, duration: dur }) => {
          setCurrentTime(Number.isFinite(seconds) ? seconds : 0)
          if (Number.isFinite(dur) && dur > 0) setDuration(dur)
        })
        player.on('loaded', () => {
          player.getDuration()
            .then((d) => { if (!cancelled && Number.isFinite(d) && d > 0) setDuration(d) })
            .catch(() => {})
        })
        const initialDuration = await player.getDuration().catch(() => 0)
        if (!cancelled && Number.isFinite(initialDuration) && initialDuration > 0) {
          setDuration(initialDuration)
        }
      } catch {
        if (!cancelled) setWarning((current) => current || t('admin_videos_stream_play_failed'))
      }
    })()

    return () => {
      cancelled = true
      if (player) {
        try { player.off('timeupdate') } catch { /* noop */ }
        try { player.off('loaded') } catch { /* noop */ }
        try { player.destroy() } catch { /* noop */ }
      }
      if (vimeoPlayerRef.current === player) vimeoPlayerRef.current = null
    }
  }, [selectedVideoIsVimeo, selectedVideoUrl, t])

  useEffect(() => () => {
    if (dataAbortRef.current) dataAbortRef.current.abort()
    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }
    const videoEl = videoRef.current
    if (videoEl) {
      videoEl.pause()
      videoEl.removeAttribute('src')
      videoEl.load()
    }
  }, [])

  if (attemptsLoading || (loading && hasResolvedAttempt)) return <div className={`${styles.page} ${styles.loadingState}`}>{t('admin_videos_loading_recordings')}</div>

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <button type="button" className={styles.backBtn} onClick={() => {
          if (window.opener) { window.close(); return }
          if (window.history.length > 1) { navigate(-1); return }
          navigate('/admin/attempt-analysis')
        }}>
          {window.opener ? t('admin_videos_close_tab') : t('admin_videos_back')}
        </button>
        <div className={styles.headContent}>
          <h2>{inSupervisionMode ? t('admin_videos_supervision_mode') : t('admin_videos_video_review')}</h2>
          {inSupervisionMode ? (
            <div className={styles.supervisionRow}>
              <label className={styles.supervisionLabel} htmlFor="attempt-videos-candidate-select">{t('admin_videos_candidate')}:</label>
              {examAttempts.length === 0 ? (
                <span className={styles.supervisionHint}>{t('admin_videos_no_attempts_yet')}</span>
              ) : (
                <select
                  id="attempt-videos-candidate-select"
                  className={styles.supervisionSelect}
                  value={selectedAttemptId}
                  onChange={e => { setSelectedAttemptId(e.target.value); setDuration(0); setCurrentTime(0) }}
                >
                  {examAttempts.map(a => (
                    <option key={a.id} value={a.id}>{a.user_name || a.user_id || a.id} - {a.status}</option>
                  ))}
                </select>
              )}
            </div>
          ) : (
            <div className={styles.headMeta}>
              {attempt?.user_name && (
                <span className={styles.metaItem}>
                  <span className={styles.metaLabel}>{t('admin_videos_candidate')}</span> {attempt.user_name}
                </span>
              )}
              {(attempt?.test_title || attempt?.exam_title) && (
                <span className={styles.metaItem}>
                  <span className={styles.metaLabel}>{t('admin_videos_test')}</span> {attempt.test_title || attempt.exam_title}
                </span>
              )}
              <span className={styles.metaItem}>
                <span className={styles.metaLabel}>{t('admin_videos_attempt')}</span> {String(activeAttemptId).slice(0, 8)}
              </span>
              {attempt?.status && (
                <span className={`${styles.statusBadge} ${attempt.status === 'SUBMITTED' || attempt.status === 'GRADED' ? styles.statusDone : attempt.status === 'IN_PROGRESS' ? styles.statusActive : ''}`}>
                  {attempt.status}
                </span>
              )}
              {attempt?.started_at && (
                <span className={styles.metaItem}>
                  <span className={styles.metaLabel}>{t('admin_videos_started')}</span> {new Date(attempt.started_at).toLocaleString()}
                </span>
              )}
            </div>
          )}
        </div>
        <div className={styles.headActions}>
          <button type="button" className={styles.refreshBtn} onClick={handleRetry} disabled={loading || attemptsLoading}>
            {t('admin_videos_refresh')}
          </button>
        </div>
      </div>

      {error ? (
        <div className={styles.error}>
          <span>{error}</span>
          <button type="button" className={styles.errorAction} onClick={handleRetry}>
            {t('admin_videos_retry')}
          </button>
        </div>
      ) : null}

      {!error && warning ? (
        <div className={styles.warning}>
          <span>{warning}</span>
          <button type="button" className={styles.warningAction} onClick={handleRetry}>
            {t('admin_videos_retry')}
          </button>
        </div>
      ) : null}

      {showEmptyAttemptsState ? (
        <div className={styles.empty}>{t('admin_videos_no_attempts_found')}</div>
      ) : videos.length === 0 ? (
        <div className={styles.empty}>{t('admin_videos_no_recordings_saved')}</div>
      ) : (
        <div className={styles.layout}>
          <section className={styles.playerCard}>
            <div className={styles.statsStrip}>
              <div className={styles.statItem}>
                <span className={styles.statValue}>{videos.length}</span>
                <span className={styles.statLabel}>{t('admin_videos_recordings')}</span>
              </div>
              <div className={styles.statItem}>
                <span className={styles.statValue}>{warningCounts.total}</span>
                <span className={styles.statLabel}>{t('admin_videos_warnings')}</span>
              </div>
              <div className={`${styles.statItem} ${warningCounts.high > 0 ? styles.statDanger : ''}`}>
                <span className={styles.statValue}>{warningCounts.high}</span>
                <span className={styles.statLabel}>{t('admin_videos_high_risk')}</span>
              </div>
              <div className={styles.statItem}>
                <span className={styles.statValue}>{warningCounts.medium}</span>
                <span className={styles.statLabel}>{t('admin_videos_medium')}</span>
              </div>
              <div className={styles.statItem}>
                <span className={styles.statValue}>{formatSeconds(effectiveDuration || timelineSegments.safeDuration)}</span>
                <span className={styles.statLabel}>{t('admin_videos_timeline_span')}</span>
              </div>
            </div>

            <div className={styles.playerTop}>
              <div className={styles.recordingControls}>
                <div className={styles.sourceSwitchRow}>
                  {['camera', 'screen'].map((source) => {
                    const sourceVideo = latestVideosBySource.get(source)
                    const sourcePlayable = isVideoPlayable(sourceVideo)
                    const isActive = sourceVideo?.name && sourceVideo.name === selectedVideo?.name
                    return (
                      <button
                        key={source}
                        type="button"
                        className={`${styles.sourceSwitchBtn} ${isActive ? styles.sourceSwitchBtnActive : ''}`}
                        disabled={!sourceVideo}
                        onClick={() => {
                          if (!sourceVideo) return
                          setSelectedVideoName(sourceVideo.name)
                          setCurrentTime(0)
                          setDuration(sourcePlayable ? readVideoDurationValue(sourceVideo) : 0)
                        }}
                      >
                        <span className={styles.sourceSwitchLabel}>{formatVideoSource(source, t)}</span>
                        <span className={styles.sourceSwitchMeta}>
                          {summarizeVideoState(sourceVideo, t)}
                        </span>
                      </button>
                    )
                  })}
                </div>
                <label>
                  {t('admin_videos_source_recording')}
                  <select
                    value={selectedVideo?.name || ''}
                    onChange={(e) => {
                      const nextVideo = videos.find((video) => video.name === e.target.value)
                      setSelectedVideoName(e.target.value)
                      setCurrentTime(0)
                      setDuration(readVideoDurationValue(nextVideo))
                    }}
                  >
                    {videos.map((v) => {
                      const suffix = v.ready_to_stream === false || v.status === 'error'
                        ? ` (${v.status || t('admin_videos_unavailable')})`
                        : ''
                      return (
                        <option key={v.name} value={v.name}>{`${formatVideoSource(v.source, t)} - ${v.name}${suffix}`}</option>
                      )
                    })}
                  </select>
                </label>
              </div>
              {selectedVideoUrl ? (
                <a href={selectedVideoUrl} target="_blank" rel="noreferrer">{t('admin_videos_open_file')}</a>
              ) : (
                <span className={styles.loadingFile}>{describeVideoAvailability(selectedVideo, t)}</span>
              )}
              {selectedVideo?.event_id ? (
                <div className={styles.deleteVideoRow}>
                  {deleteVideoConfirm ? (
                    <span className={styles.deleteVideoWarning}>{t('admin_videos_delete_confirm_warning')}</span>
                  ) : null}
                  <button
                    type="button"
                    className={deleteVideoConfirm ? styles.dangerBtn : styles.refreshBtn}
                    disabled={deletingVideo}
                    onClick={handleDeleteVideo}
                  >
                    {deletingVideo
                      ? t('admin_videos_deleting')
                      : deleteVideoConfirm
                        ? t('admin_videos_confirm_delete')
                        : t('admin_videos_delete_recording')}
                  </button>
                  {deleteVideoConfirm ? (
                    <button
                      type="button"
                      className={styles.refreshBtn}
                      disabled={deletingVideo}
                      onClick={() => setDeleteVideoConfirm(false)}
                    >
                      {t('cancel')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className={styles.playerViewport}>
              {selectedVideoUrl ? (
                selectedVideoIsVimeo ? (
                  <div className={styles.vimeoPlayerWrap} ref={vimeoPlayerWrapRef}>
                    <div className={styles.vimeoVideoStage}>
                      <iframe
                        key={`vimeo-${selectedVideo?.name || 'recording'}`}
                        ref={vimeoIframeRef}
                        className={styles.video}
                        src={buildVimeoEmbedSrc(selectedVideoUrl)}
                        title={selectedVideo?.name || t('admin_videos_source_recording')}
                        allow="autoplay; fullscreen; picture-in-picture"
                        allowFullScreen
                      />
                      {/* The iframe is cross-origin, so we can't attach a click
                          handler inside it — this transparent overlay sits on
                          top and forwards clicks to the same play/pause the
                          control bar's button already uses. */}
                      <div
                        className={styles.vimeoClickOverlay}
                        aria-hidden="true"
                        onClick={toggleVimeoPlayback}
                      />
                    </div>
                    <VimeoControlsBar
                      player={vimeoPlayerRef.current}
                      fullscreenTargetRef={vimeoPlayerWrapRef}
                      currentTime={currentTime}
                      duration={effectiveDuration}
                      onSeek={seekTo}
                    />
                  </div>
                ) : (
                  <video
                    key={`${selectedVideo?.name || 'recording'}-${selectedVideoUsesHls ? 'hls' : 'file'}`}
                    ref={videoRef}
                    controls
                    preload="metadata"
                    className={styles.video}
                    src={selectedVideoUsesHls ? undefined : selectedVideoUrl}
                    onLoadedMetadata={(e) => {
                      syncDurationFromVideo(e.currentTarget)
                      probeVideoDuration(e.currentTarget)
                    }}
                    onDurationChange={(e) => syncDurationFromVideo(e.currentTarget)}
                    onTimeUpdate={(e) => {
                      setCurrentTime(e.currentTarget.currentTime || 0)
                      syncDurationFromVideo(e.currentTarget)
                    }}
                  />
                )
              ) : (
                <div className={styles.videoLoading}>{describeVideoAvailability(selectedVideo, t)}</div>
              )}
            </div>

            <div className={styles.timelineWrap}>
              <div className={styles.timelineHeader}>
                <strong>{t('admin_videos_warning_timeline')}</strong>
                <div className={styles.timelineNav}>
                  <button
                    type="button"
                    className={styles.navBtn}
                    onClick={goToPrevWarning}
                    disabled={!selectedEvent || filteredWarningEvents.indexOf(selectedEvent) <= 0}
                    title={t('admin_videos_previous_warning')}
                  >
                    {t('admin_videos_prev')}
                  </button>
                  <button
                    type="button"
                    className={styles.navBtn}
                    onClick={goToNextWarning}
                    disabled={!selectedEvent || filteredWarningEvents.indexOf(selectedEvent) >= filteredWarningEvents.length - 1}
                    title={t('admin_videos_next_warning')}
                  >
                    {t('admin_videos_next')}
                  </button>
                  <div className={styles.timeDisplay}>
                    <span className={styles.timeNow}>
                      {formatSeconds(currentTime)} / {formatSeconds(effectiveDuration || timelineSegments.safeDuration)}
                    </span>
                  </div>
                </div>
              </div>

              <div
                className={styles.timelineTrack}
                role="slider"
                aria-valuemin={0}
                aria-valuemax={timelineSegments.safeDuration}
                aria-valuenow={currentTime}
                aria-label={t('admin_videos_timeline_aria')}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
                  seekTo(pct * timelineSegments.safeDuration)
                }}
              >
                <div
                  className={styles.timelineFill}
                  style={{
                    width: `${timelineSegments.safeDuration > 0 ? Math.min(100, (currentTime / timelineSegments.safeDuration) * 100) : 0}%`,
                  }}
                />

                {filteredWarningEvents.map((event) => {
                  const pct = timelineSegments.safeDuration > 0
                    ? Math.min(99.5, Math.max(0.5, (event.second / timelineSegments.safeDuration) * 100))
                    : 0
                  return (
                    <button
                      key={event.id}
                      type="button"
                      className={`${styles.warningTick} ${event.severity === 'HIGH' ? styles.warningTickHigh : styles.warningTickMedium}`}
                      style={{ left: `${pct}%` }}
                      title={`${translateSeverity(event.severity, t)} - ${translateEventType(event.event_type, t)} - ${formatSeconds(event.second)}`}
                      onClick={(e) => { e.stopPropagation(); selectEvent(event) }}
                    />
                  )
                })}

                <div
                  className={styles.playhead}
                  style={{
                    left: `${timelineSegments.safeDuration > 0 ? Math.min(100, (currentTime / timelineSegments.safeDuration) * 100) : 0}%`,
                  }}
                />
              </div>

              <div className={styles.timeLabels}>
                {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
                  <span
                    key={pct}
                    className={pct === 0 ? styles.timeLabelStart : pct === 1 ? styles.timeLabelEnd : ''}
                    style={{ left: `${pct * 100}%` }}
                  >
                    {formatSeconds(pct * timelineSegments.safeDuration)}
                  </span>
                ))}
              </div>
            </div>
          </section>

          <aside className={styles.sideCard}>
            <div className={styles.sideHeader}>
              <div className={styles.sideHeadLeft}>
                <h3>{t('admin_videos_exam_events')}</h3>
                <div className={styles.eventCountRow}>
                  <span className={styles.badgeNeutral}>{warningCounts.total} {t('admin_videos_total')}</span>
                </div>
              </div>
            </div>

            <div className={styles.eventsFilters}>
              <label>
                {t('admin_videos_severity')}
                <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
                  <option value="ALL">{t('admin_videos_all_severities')}</option>
                  <option value="HIGH">{t('admin_videos_high')}</option>
                  <option value="MEDIUM">{t('admin_videos_medium')}</option>
                </select>
              </label>
              <label>
                {t('admin_videos_event_type')}
                <select value={eventTypeFilter} onChange={(e) => setEventTypeFilter(e.target.value)}>
                  <option value="ALL">{t('admin_videos_all_types')}</option>
                  {warningTypeOptions.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <button type="button" className={styles.clearBtn} onClick={clearFilters} disabled={severityFilter === 'ALL' && eventTypeFilter === 'ALL'}>
                {t('admin_videos_clear_filters')}
              </button>
            </div>

            {filteredWarningEvents.length === 0 ? (
              <div className={styles.emptySmall}>
                {warningTimelineEvents.length === 0
                  ? t('admin_videos_no_warnings_detected')
                  : recordingWarningEvents.length === 0
                    ? t('admin_videos_no_warnings_in_recording')
                    : t('admin_videos_no_warnings_match_filters')}
              </div>
            ) : (
              <>
                <div className={styles.eventList}>
                  {filteredWarningEvents.map((e) => (
                    <button
                      type="button"
                      key={e.id}
                      className={`${styles.eventBtn} ${selectedEventId === e.id ? styles.eventBtnActive : ''}`}
                      onClick={() => selectEvent(e)}
                    >
                      <div className={styles.eventBtnTop}>
                        <span className={`${styles.eventSeverity} ${severityClass(e.severity)}`}>{translateSeverity(e.severity, t)}</span>
                        {typeof e.ai_confidence === 'number' && (
                          <span className={styles.eventConfidence}>{Math.round(e.ai_confidence * 100)}%</span>
                        )}
                        <span className={styles.eventTimestamp}>{formatSeconds(e.second)}</span>
                      </div>
                      <span className={styles.eventMeta}>{translateEventType(e.event_type, t)}</span>
                      <span className={styles.eventDetail}>{e.detail || t('admin_videos_warning_detected')}</span>
                    </button>
                  ))}
                </div>
                {selectedEvent && (
                  <div className={styles.eventInspector}>
                    <div className={styles.inspectorHeader}>
                      <span className={`${styles.eventSeverity} ${severityClass(selectedEvent.severity)}`}>{translateSeverity(selectedEvent.severity, t)}</span>
                      <span className={styles.inspectorTime}>
                        {t('admin_videos_event')} {filteredWarningEvents.indexOf(selectedEvent) + 1} {t('admin_videos_of')} {filteredWarningEvents.length} - {formatSeconds(selectedEvent.second)}
                      </span>
                    </div>
                    <div className={styles.inspectorTitle}>{translateEventType(selectedEvent.event_type, t)}</div>
                    <div className={styles.inspectorDetail}>{selectedEvent.detail || t('admin_videos_warning_detected_monitoring')}</div>
                    <div className={styles.inspectorMeta}>
                      <span>{selectedEvent.occurred_at ? new Date(selectedEvent.occurred_at).toLocaleString() : '-'}</span>
                    </div>
                    <div className={styles.confidenceWrap}>
                      {typeof selectedEvent.ai_confidence === 'number' ? (
                        <>
                          <div className={styles.confidenceLabel}>
                            {t('admin_videos_ai_confidence')}: {Math.round(selectedEvent.ai_confidence * 100)}%
                          </div>
                          <div className={styles.confidenceTrack}>
                            <div
                              className={styles.confidenceBar}
                              style={{ width: `${Math.round(selectedEvent.ai_confidence * 100)}%` }}
                            />
                          </div>
                        </>
                      ) : (
                        <div className={styles.confidenceLabel}>{t('admin_videos_confidence_unavailable')}</div>
                      )}
                    </div>
                    {selectedEvent.meta?.evidence && (
                      selectedEvidenceUrl ? (
                        <img
                          className={styles.inspectorImage}
                          src={selectedEvidenceUrl}
                          alt={`${translateEventType(selectedEvent.event_type, t)} ${t('admin_videos_evidence')}`}
                        />
                      ) : (
                        <div className={styles.inspectorImage} />
                      )
                    )}
                  </div>
                )}
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}
