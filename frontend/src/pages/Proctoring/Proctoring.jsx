import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useParams, useNavigate } from 'react-router-dom'
import ProctorOverlay from '../../components/ProctorOverlay/ProctorOverlay'
import ViolationToast from '../../components/ViolationToast/ViolationToast'
import useAuth from '../../hooks/useAuth'
import { getAttempt, getAttemptAnswers, submitAnswer, submitAttempt } from '../../services/attempt.service'
import { getTestQuestions, getTest, getLearnerSections, finishAttemptSection } from '../../services/test.service'
import {
  proctoringPing,
  reportProctoringVideoUploadProgress,
  uploadProctoringVideo,
} from '../../services/proctoring.service'
import { normalizeQuestion, normalizeTest } from '../../utils/assessmentAdapters'
import { getJourneyRequirements, normalizeProctoringConfig } from '../../utils/proctoringRequirements'
import { requestEntireScreenShare, ENTIRE_SCREEN_REQUIRED } from '../../utils/screenCapture'
import { consumeScreenStream } from '../../utils/screenShareState'
import { buildHub, sectionStatus } from './sectionNavigation'
import useLanguage from '../../hooks/useLanguage'
import styles from './Proctoring.module.scss'

const DEFAULT_PROCTORING = {
  tab_switch_detect: false,
  fullscreen_enforce: false,
  face_detection: false,
  multi_face: false,
  eye_tracking: false,
  head_pose_detection: false,
  audio_detection: false,
  object_detection: false,
  mouth_detection: false,
  copy_paste_block: false,
  screen_capture: false,
  object_confidence_threshold: 0.35,
  multi_face_min_area_ratio: 0.008,
  max_face_absence_sec: 1.5,
  frame_interval_ms: 500,
  audio_chunk_ms: 2000,
  audio_consecutive_chunks: 2,
  audio_speech_consecutive_chunks: 2,
  audio_speech_min_rms: 0.03,
  audio_speech_baseline_multiplier: 1.35,
  audio_window: 5,
  camera_cover_hard_luma: 20,
  camera_cover_soft_luma: 40,
  camera_cover_stddev_max: 16,
  camera_cover_hard_consecutive_frames: 1,
  camera_cover_soft_consecutive_frames: 2,
  screenshot_interval_sec: 60,
  max_tab_blurs: 0,
}

const VIDEO_UPLOAD_PROGRESS_STEP = 5
const VIDEO_UPLOAD_PROGRESS_INTERVAL_MS = 1000
const AUTO_SUBMIT_COUNTDOWN_SECONDS = 10

function clampUploadPercent(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.min(100, Math.max(0, Math.round(numeric)))
}

function normalizeProctoringAlert(rawAlert) {
  if (!rawAlert || typeof rawAlert !== 'object') return null
  const eventType = String(rawAlert.event_type || rawAlert.type || 'PROCTORING_ALERT').trim().toUpperCase()
  const severity = String(rawAlert.severity || 'LOW').trim().toUpperCase()
  return {
    ...rawAlert,
    event_type: eventType || 'PROCTORING_ALERT',
    severity: severity || 'LOW',
    detail: String(rawAlert.detail || 'Automatic proctoring alert detected.').trim(),
  }
}

function createRecordingController(source) {
  return {
    source,
    recorder: null,
    sessionId: null,
    mimeType: 'video/webm',
    startedAt: null,
    stoppedAt: null,
    finalizing: false,
    finalized: false,
    chunks: [],
    bytesRecorded: 0,
  }
}

function buildRecordingStream(stream, source) {
  if (!stream) return null
  if (source !== 'camera') return stream
  const videoTracks = stream.getVideoTracks?.() || []
  const audioTracks = stream.getAudioTracks?.() || []
  const tracks = [...videoTracks, ...audioTracks]
  if (!tracks.length) return stream
  return new MediaStream(tracks)
}

function createVideoSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '')
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`
}

function serializeAnswer(answer) {
  if (Array.isArray(answer)) return JSON.stringify(answer)
  if (answer && typeof answer === 'object') return JSON.stringify(answer)
  return answer
}

function parsePersistedAnswer(rawAnswer) {
  if (typeof rawAnswer !== 'string') return rawAnswer
  const trimmed = rawAnswer.trim()
  if (!trimmed) return ''
  if (!['[', '{', '"'].includes(trimmed[0])) return rawAnswer
  try {
    return JSON.parse(trimmed)
  } catch {
    return rawAnswer
  }
}

function hasAnswerValue(value) {
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  if (typeof value === 'string') return value.trim().length > 0
  return value != null
}

function useAutoSave(attemptId, t, delay = 2000) {
  const pending = useRef({})
  const timer = useRef(null)
  const saveGeneration = useRef(0)
  const inflightPromise = useRef(null)
  const [saveState, setSaveState] = useState('idle')
  const [lastSavedAt, setLastSavedAt] = useState(null)
  const [saveError, setSaveError] = useState('')

  const save = useCallback((questionId, answer) => {
    pending.current[questionId] = answer
    setSaveState('pending')
    setSaveError('')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const gen = ++saveGeneration.current
      const entries = { ...pending.current }
      pending.current = {}
      const doSave = async () => {
        const failedEntries = {}
        let hadFailure = false
        setSaveState('saving')
        for (const [qId, ans] of Object.entries(entries)) {
          try {
            await submitAnswer(attemptId, qId, serializeAnswer(ans))
          } catch {
            failedEntries[qId] = ans
            hadFailure = true
          }
        }
        // If flush() ran while we were saving, put unsaved entries back for
        // flush to pick up instead of silently discarding them.
        if (gen !== saveGeneration.current) {
          if (hadFailure) {
            pending.current = { ...failedEntries, ...pending.current }
          }
          return
        }
        if (hadFailure) {
          pending.current = { ...failedEntries, ...pending.current }
          setSaveState('error')
          setSaveError(t('proctor_answers_not_saved'))
          return
        }
        setSaveState('saved')
        setLastSavedAt(new Date())
      }
      inflightPromise.current = doSave().finally(() => { inflightPromise.current = null })
    }, delay)
  }, [attemptId, delay, t])

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    ++saveGeneration.current  // invalidate any in-flight save() callback

    // Wait for any in-flight save to finish (it will re-queue failed entries)
    if (inflightPromise.current) {
      await inflightPromise.current
    }

    // Loop to drain pending answers: new answers may arrive via save() while
    // we are awaiting the API calls, so re-check after each batch.
    while (Object.keys(pending.current).length > 0) {
      const entries = { ...pending.current }
      pending.current = {}
      const failedEntries = {}
      let hadFailure = false
      setSaveState('saving')
      for (const [qId, ans] of Object.entries(entries)) {
        try {
          await submitAnswer(attemptId, qId, serializeAnswer(ans))
        } catch {
          failedEntries[qId] = ans
          hadFailure = true
        }
      }
      if (hadFailure) {
        pending.current = { ...failedEntries, ...pending.current }
        setSaveState('error')
        setSaveError(t('proctor_flush_error'))
        throw new Error('Failed to save pending answers')
      }
    }
    setSaveState('saved')
    setLastSavedAt(new Date())
  }, [attemptId, t])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return { save, flush, saveState, lastSavedAt, saveError }
}

export default function Proctoring() {
  const { attemptId } = useParams()
  const navigate = useNavigate()
  const { tokens } = useAuth()
  const { t } = useLanguage()

  const [exam, setExam] = useState(null)
  const [questions, setQuestions] = useState([])
  const [sections, setSections] = useState([])
  const [finishedSections, setFinishedSections] = useState([])
  const [activeSectionId, setActiveSectionId] = useState(null) // null => show hub
  // Latches true the first time the learner actually enters exam content. Proctoring
  // (camera, screen share, WS, detectors) stays OFF until this flips, so the section
  // picker is never proctored; once on, it stays on for the rest of the attempt.
  const [proctoringStarted, setProctoringStarted] = useState(false)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [answers, setAnswers] = useState({})
  const [timeLeft, setTimeLeft] = useState(null)
  const [violations, setViolations] = useState({ HIGH: 0, MEDIUM: 0 })
  const [toast, setToast] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitPhase, setSubmitPhase] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [restoreWarning, setRestoreWarning] = useState('')
  const [proctorCfg, setProctorCfg] = useState({})
  const [tabBlurs, setTabBlurs] = useState(0)
  const [loading, setLoading] = useState(true)
  const [cameraStream, setCameraStream] = useState(null)
  const [screenStream, setScreenStream] = useState(null)
  const [cameraRecordingStatus, setCameraRecordingStatus] = useState('idle')
  const [screenRecordingStatus, setScreenRecordingStatus] = useState('disabled')
  const [uploadPercent, setUploadPercent] = useState({})
  const [uploadError, setUploadError] = useState('')
  const [screenShareBusy, setScreenShareBusy] = useState(false)
  const [screenShareRequestReady, setScreenShareRequestReady] = useState(false)
  const [proctorStatus, setProctorStatus] = useState('connecting')
  const [cameraDark, setCameraDark] = useState(false)
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false)
  const [autoSubmitState, setAutoSubmitState] = useState(null)
  const wsConnectedRef = useRef(false)
  const screenShareRequestRef = useRef(null)
  const screenShareEstablishedRef = useRef(false)
  const screenShareLossHandledRef = useRef(false)
  const screenSharePickerOpenRef = useRef(false)
  const screenShareGraceRef = useRef(false)
  const [screenShareGranted, setScreenShareGranted] = useState(false)
  const [screenShareGateError, setScreenShareGateError] = useState('')
  const [screenShareGateLoading, setScreenShareGateLoading] = useState(false)
  const screenStreamCleanupRef = useRef(null)
  const isMountedRef = useRef(true)

  const { save, flush, saveState, lastSavedAt, saveError } = useAutoSave(attemptId, t)
  const cameraRecordingRef = useRef(createRecordingController('camera'))
  const screenRecordingRef = useRef(createRecordingController('screen'))
  const wsWarnedRef = useRef(false)
  const lastToastBlursRef = useRef(0)
  const timerExpiredRef = useRef(false)
  const submittedRef = useRef(false)
  const submittingRef = useRef(false)
  const proctorNoticeCooldownRef = useRef(new Map())
  const lastTabSwitchEventRef = useRef(0)
  const preparedRecordingUploadsRef = useRef({})
  const [reloadKey, setReloadKey] = useState(0)
  const sendClientEventRef = useRef(null)
  // Raw WS send (any JSON payload); registered by ProctorOverlay
  const wsRawSendRef = useRef(null)

  // ── Answer timing ─────────────────────────────────────────────────────────
  // Tracks when the current question was first shown so we can report fast answers
  const questionStartTimeRef = useRef(Date.now())

  // ── Keystroke dynamics ────────────────────────────────────────────────────
  // Tracks inter-key intervals inside any text input / textarea
  const lastKeyTimeRef = useRef(0)
  const keyIntervalsRef = useRef([])    // rolling window of inter-key ms values
  const KEY_INTERVAL_WINDOW = 20        // analyse last N key gaps
  const KEY_ANOMALY_THRESHOLD_MS = 50   // avg < 50 ms → suspiciously fast (macro/autofill)
  const lastKeystrokeAlertRef = useRef(0)

  // ── Mouse inactivity ──────────────────────────────────────────────────────
  const lastMouseMoveRef = useRef(Date.now())
  const mouseInactiveAlertedRef = useRef(false)
  const MOUSE_INACTIVE_MS = 120000      // 2 minutes

  // Keep screen stream cleanup ref in sync with state
  useEffect(() => { screenStreamCleanupRef.current = screenStream }, [screenStream])

  useEffect(() => {
    if (!proctorCfg.screen_capture || screenStream || screenShareGranted) return
    const storedStream = consumeScreenStream()
    if (!storedStream) return
    const isLive = storedStream.getVideoTracks?.().some((track) => track.readyState === 'live')
    if (!isLive) {
      storedStream.getTracks?.().forEach((track) => track.stop())
      return
    }
    setScreenStream(storedStream)
    // Don't set screenShareEstablishedRef here — it races with the loss-detection
    // useEffect (which runs in the same render cycle while screenStream is still null).
    // The loss-detection useEffect sets it when screenStream becomes non-null.
    setScreenShareGranted(true)
    setScreenShareGateError('')
  }, [proctorCfg.screen_capture, screenShareGranted, screenStream])

  // If the screen stream dies mid-exam (user clicked "Stop sharing"), re-gate
  useEffect(() => {
    if (screenShareGranted && !screenStream && proctorCfg.screen_capture) {
      // During setup the stream can briefly go null — don't re-gate during grace period
      if (screenShareGraceRef.current || screenSharePickerOpenRef.current) return
      setScreenShareGranted(false)
      setScreenShareGateError(t('proctor_screen_share_stopped'))
    }
  }, [screenStream, screenShareGranted, proctorCfg.screen_capture])

  // Stop screen tracks on component unmount to prevent orphaned MediaStreams
  useEffect(() => {
    return () => { screenStreamCleanupRef.current?.getTracks?.().forEach(t => t.stop()) }
  }, [])

  // Load attempt, exam, and questions
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setLoadError('')
      setRestoreWarning('')
      if (!attemptId) {
        setExam(null)
        setQuestions([])
        setAnswers({})
        setLoadError(t('proctor_invalid_attempt'))
        setLoading(false)
        return
      }
      try {
        const attemptRes = await getAttempt(attemptId)
        const att = attemptRes.data
        // If the attempt was already submitted (e.g. forced_submit from proctoring),
        // redirect to the result page immediately instead of showing the exam UI.
        const attStatus = String(att.status || '').toUpperCase()
        if (attStatus === 'SUBMITTED' || attStatus === 'GRADED') {
          if (!cancelled) {
            submittedRef.current = true
            navigate(`/attempts/${attemptId}`, { replace: true })
          }
          return
        }
        const [examRes, qRes, answersRes, sectionsRes] = await Promise.allSettled([
          getTest(att.exam_id),
          getTestQuestions(att.exam_id),
          getAttemptAnswers(attemptId),
          getLearnerSections(att.exam_id),
        ])
        if (cancelled) return
        if (examRes.status !== 'fulfilled' || qRes.status !== 'fulfilled') {
          throw new Error(t('proctor_load_failed'))
        }
        setSections(sectionsRes.status === 'fulfilled' ? (sectionsRes.value.data || []) : [])
        setFinishedSections(att.sections_finished || [])
        const ex = normalizeTest(examRes.value.data)
        if (cancelled) return
        setExam(ex)
        const merged = { ...DEFAULT_PROCTORING, ...normalizeProctoringConfig(ex.proctoring_config || {}) }
        setProctorCfg(merged)

        setQuestions((qRes.value.data || []).map(normalizeQuestion))
        if (answersRes.status === 'fulfilled') {
          setAnswers(
            (answersRes.value.data || []).reduce((acc, answerRow) => {
              acc[answerRow.question_id] = parsePersistedAnswer(answerRow.answer)
              return acc
            }, {})
          )
        } else {
          setAnswers({})
          setRestoreWarning(t('proctor_restore_warning'))
        }
        if (ex.time_limit_minutes) {
          const started = new Date(att.started_at).getTime()
          const limit = ex.time_limit_minutes * 60
          const elapsed = Math.floor((Date.now() - started) / 1000)
          setTimeLeft(Math.max(0, limit - elapsed))
        }
      } catch (e) {
        if (!cancelled) {
          setExam(null)
          setQuestions([])
          setAnswers({})
          setLoadError(e.response?.data?.detail || e.message || t('proctor_load_failed'))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [attemptId, reloadKey])

  useEffect(() => {
    if (proctorStatus === 'connected') {
      wsWarnedRef.current = false
      wsConnectedRef.current = true
      return
    }
    if (proctorStatus === 'disconnected') {
      // WS is reconnecting — update ref but don't fire an alert.
      // The ProctorOverlay already shows "Reconnecting..." in its status.
      wsConnectedRef.current = false
      return
    }
    if (proctorStatus === 'closed' && wsConnectedRef.current && !wsWarnedRef.current) {
      wsWarnedRef.current = true
      wsConnectedRef.current = false
      setToast({ severity: 'MEDIUM', event_type: 'PROCTORING_CONNECTION', detail: t('proctor_connection_interrupted') })
    }
  }, [proctorStatus])

  // ── Section hub ───────────────────────────────────────────────────────────
  // Groups questions into sections. When the exam has more than one real
  // section, learners navigate a "hub" and take one section at a time. Legacy
  // exams (0 or 1 section) fall through to the flat one-question-at-a-time flow.
  const hub = useMemo(() => buildHub(sections, questions), [sections, questions])
  const sequential = !!exam?.settings?.sequential_sections
  const allowRevisit = exam?.settings?.allow_revisit_sections !== false
  const hubEnabled = hub.length > 1
  const activeSection = hubEnabled ? hub.find((s) => s.id === activeSectionId) : null
  const sectionQuestions = hubEnabled ? (activeSection?.questions || []) : questions
  const finishSection = useCallback(async () => {
    try {
      await flush()
      const { data } = await finishAttemptSection(attemptId, activeSectionId)
      setFinishedSections(data.sections_finished || [])
      setActiveSectionId(null)   // only return to hub on success
    } catch (e) {
      setSubmitError(e.response?.data?.detail || e.message || t('proctor_load_failed'))
    }
  }, [attemptId, activeSectionId, flush, t])

  const journeyRequirements = getJourneyRequirements(proctorCfg)
  // Whether the exam is configured for any proctoring at all.
  const proctoringConfigured = Boolean(
    proctorCfg.tab_switch_detect
    || proctorCfg.fullscreen_enforce
    || proctorCfg.face_detection
    || proctorCfg.multi_face
    || proctorCfg.eye_tracking
    || proctorCfg.head_pose_detection
    || proctorCfg.audio_detection
    || proctorCfg.object_detection
    || proctorCfg.mouth_detection
    || proctorCfg.screen_capture
    || journeyRequirements.systemCheckRequired
    || journeyRequirements.identityRequired
    || (Array.isArray(proctorCfg.alert_rules) && proctorCfg.alert_rules.length > 0)
  )
  // Proctoring only becomes *active* once the learner has entered exam content
  // (see proctoringStarted). This gates the overlay mount, every detection effect,
  // and the screen-share gate, so the section picker stays unproctored.
  const proctoringEnabled = proctoringConfigured && proctoringStarted

  // Latch proctoring ON the first time the learner is in real exam content:
  //  - multi-section exams: when a section is entered (activeSectionId set)
  //  - flat/single-section exams: as soon as loading finishes (no picker to gate on)
  useEffect(() => {
    if (proctoringStarted) return
    if (activeSectionId != null) { setProctoringStarted(true); return }
    if (!loading && !hubEnabled) setProctoringStarted(true)
  }, [proctoringStarted, activeSectionId, loading, hubEnabled])

  const screenShareRequired =
    proctoringStarted && Boolean(proctorCfg.screen_capture) && !screenShareGranted
  const requiredRecordingSources = React.useMemo(() => {
    const sources = []
    if (journeyRequirements.cameraRequired) sources.push('camera')
    if (journeyRequirements.screenRequired) sources.push('screen')
    return sources
  }, [journeyRequirements.cameraRequired, journeyRequirements.screenRequired])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const handleScreenShareGate = useCallback(async () => {
    setScreenShareGateError('')
    setScreenShareGateLoading(true)
    screenSharePickerOpenRef.current = true
    screenShareGraceRef.current = true

    const MAX_SCREEN_SHARE_ATTEMPTS = 2

    for (let attempt = 0; attempt < MAX_SCREEN_SHARE_ATTEMPTS; attempt++) {
      try {
        const stream = await requestEntireScreenShare()
        setScreenStream(stream)
        screenShareEstablishedRef.current = true
        setScreenShareGranted(true)

        // Enter fullscreen after delay — calling requestFullscreen()
        // immediately after getDisplayMedia() can kill the screen share track
        // in some browsers. The delay lets the track stabilize first.
        if (proctorCfg.fullscreen_enforce && !document.fullscreenElement) {
          await new Promise((resolve) => setTimeout(resolve, 800))
          if (stream.getVideoTracks().some((t) => t.readyState === 'live')) {
            try { await document.documentElement.requestFullscreen() } catch { /* non-blocking */ }
          }
          // Verify screen share survived fullscreen transition
          await new Promise((resolve) => setTimeout(resolve, 1000))
          if (!stream.getVideoTracks().some((t) => t.readyState === 'live')) {
            // Screen share died after fullscreen — exit and retry
            if (document.fullscreenElement) {
              try { await document.exitFullscreen() } catch { /* ignore */ }
            }
            stream.getTracks().forEach((t) => t.stop())
            if (attempt < MAX_SCREEN_SHARE_ATTEMPTS - 1) continue
            setScreenShareGateError(t('proctor_screen_share_fullscreen_error'))
            setScreenShareGranted(false)
            screenShareEstablishedRef.current = false
            break
          }
        }
        // Success — exit retry loop
        break
      } catch (err) {
        if (err.code === ENTIRE_SCREEN_REQUIRED) {
          setScreenShareGateError(t('proctor_share_entire_screen'))
        } else if (err.name === 'NotAllowedError') {
          setScreenShareGateError(t('proctor_screen_share_denied'))
        } else {
          setScreenShareGateError(err.message || t('proctor_screen_share_failed'))
        }
        break
      }
    }

    screenSharePickerOpenRef.current = false
    // Only set grace period if screen share was successfully granted
    if (screenShareEstablishedRef.current) {
      screenShareGraceRef.current = true
      window.setTimeout(() => { screenShareGraceRef.current = false }, 5000)
    }
    setScreenShareGateLoading(false)
  }, [proctorCfg.fullscreen_enforce, t])

  const registerSendClientEvent = useCallback((fn) => {
    sendClientEventRef.current = fn || null
  }, [])

  const registerWsRawSend = useCallback((fn) => {
    wsRawSendRef.current = fn || null
  }, [])

  const handleViolation = useCallback((event) => {
    if (event.severity === 'HIGH' || event.severity === 'MEDIUM') {
      setViolations(prev => ({
        ...prev,
        [event.severity]: prev[event.severity] + 1
      }))
    }
    setToast(event)
  }, [])

  const emitProctoringNotice = useCallback((key, detail, severity = 'LOW', eventType = 'PROCTORING_ERROR', cooldownMs = 8000) => {
    const now = Date.now()
    const lastSeen = proctorNoticeCooldownRef.current.get(key) || 0
    if (now - lastSeen < cooldownMs) return
    proctorNoticeCooldownRef.current.set(key, now)
    const event = {
      severity,
      event_type: eventType,
      detail,
    }
    if (severity === 'HIGH' || severity === 'MEDIUM') {
      handleViolation(event)
      return
    }
    setToast(event)
  }, [handleViolation])

  // Send a browser-level violation. If WS is connected the backend creates a
  // ProctoringEvent and echoes back an alert → handleViolation. If not connected
  // we fall back to a local-only toast.
  const sendBrowserViolation = useCallback((eventType, severity, detail) => {
    if (sendClientEventRef.current) {
      try {
        sendClientEventRef.current(eventType, severity, detail)
      } catch (e) {
        console.warn('sendBrowserViolation: sendClientEvent failed, falling back to local:', e?.message)
        handleViolation({ event_type: eventType, severity, detail })
      }
    } else {
      handleViolation({ event_type: eventType, severity, detail })
    }
  }, [handleViolation])

  const handleAnswer = (questionId, answer) => {
    if (submitting || autoSubmitState) return
    setShowSubmitConfirm(false)
    setAnswers(prev => ({ ...prev, [questionId]: answer }))
    save(questionId, answer)
    // Report answer timing if question was answered suspiciously fast
    const elapsed = Date.now() - questionStartTimeRef.current
    if (elapsed > 0 && elapsed < 3000 && wsRawSendRef.current) {
      wsRawSendRef.current({
        type: 'answer_timing',
        question_id: questionId,
        question_index: currentIdx,
        elapsed_ms: elapsed,
      })
    }
  }

  const setRecordingStatusForSource = useCallback((source, value) => {
    if (!isMountedRef.current) return
    if (source === 'screen') {
      setScreenRecordingStatus(value)
      return
    }
    setCameraRecordingStatus(value)
  }, [])

  const registerScreenShareRequest = useCallback((requestFn) => {
    screenShareRequestRef.current = requestFn || null
    setScreenShareRequestReady(Boolean(requestFn))
  }, [])

  const requestRequiredScreenShare = useCallback(async () => {
    const requestFn = screenShareRequestRef.current
    if (!requestFn || screenShareBusy) return
    setScreenShareBusy(true)
    setScreenRecordingStatus('checking')
    screenSharePickerOpenRef.current = true
    try {
      await requestFn()
      // Do NOT call requestFullscreen() after screen share — it kills the
      // screen share track. Fullscreen was entered on RulesPage and the
      // screen recording is more important than re-entering fullscreen.
    } catch (error) {
      setScreenRecordingStatus('failed')
      emitProctoringNotice(
        'screen_share_request',
        error?.message || t('proctor_screen_share_choose'),
        'MEDIUM',
        'SCREEN_SHARE_REQUIRED',
        5000,
      )
    } finally {
      screenSharePickerOpenRef.current = false
      // Grace period: suppress fullscreen/tab-switch violations for 5s after
      // picker closes so the fullscreen re-entry transition and focus shifts
      // from the picker dialog don't trigger false violations.
      screenShareGraceRef.current = true
      window.setTimeout(() => { screenShareGraceRef.current = false }, 5000)
      setScreenShareBusy(false)
    }
  }, [emitProctoringNotice, screenShareBusy])

  const pickRecorderMimeType = (stream) => {
    const hasAudio = Boolean(stream?.getAudioTracks?.().length)
    const candidates = hasAudio
      ? [
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8,opus',
          'video/webm',
        ]
      : [
          'video/webm;codecs=vp9',
          'video/webm;codecs=vp8',
          'video/webm',
        ]
    const supported = candidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m))
    return supported || 'video/webm'
  }

  const startRecordingSession = useCallback(async (stream, source) => {
    if (!attemptId || !stream || !window.MediaRecorder) return
    const recording = source === 'screen' ? screenRecordingRef.current : cameraRecordingRef.current
    if (recording.recorder || recording.sessionId || recording.finalizing) return
    try {
      const recordingStream = buildRecordingStream(stream, source)
      const mimeType = pickRecorderMimeType(recordingStream)
      recording.mimeType = mimeType
      recording.finalized = false
      recording.sessionId = createVideoSessionId()
      recording.startedAt = new Date().toISOString()
      recording.stoppedAt = null
      recording.chunks = []
      recording.bytesRecorded = 0
      const recorder = new MediaRecorder(recordingStream, { mimeType })
      recorder.ondataavailable = (event) => {
        if (!recording.sessionId || !event.data || event.data.size === 0) return
        recording.chunks.push(event.data)
        recording.bytesRecorded += event.data.size
      }
      recorder.onerror = (e) => {
        setRecordingStatusForSource(source, 'failed')
        const msg = t('proctor_recording_interrupted')
        console.error(`MediaRecorder error (${source}):`, e?.error || e)
        setToast({ severity: 'MEDIUM', event_type: 'RECORDING_ERROR', detail: msg })
        emitProctoringNotice(`recorder_error_${source}`, msg, 'LOW', 'RECORDING_ERROR', 60000)
        // Clear stale recorder so startRecordingSession can retry
        recording.recorder = null
        recording.sessionId = null
      }
      recorder.start(2000)
      recording.recorder = recorder
      setRecordingStatusForSource(source, 'recording')
    } catch (error) {
      setRecordingStatusForSource(source, 'failed')
      emitProctoringNotice(`recording_start_${source}`, error?.message || t('proctor_recording_start_error', { source }), 'LOW')
    }
  }, [attemptId, emitProctoringNotice, setRecordingStatusForSource])

  const prepareSingleRecordingUpload = useCallback(async (source, { required = false } = {}) => {
    const existingPayload = preparedRecordingUploadsRef.current[source]
    if (existingPayload) {
      return existingPayload
    }
    const recording = source === 'screen' ? screenRecordingRef.current : cameraRecordingRef.current
    const recorder = recording.recorder
    const sessionId = recording.sessionId
    if (!recorder && !sessionId) {
      if (required) {
        throw new Error(t('proctor_recording_not_ready', { source }))
      }
      return
    }
    if (recording.finalizing || recording.finalized) return
    recording.finalizing = true
    setRecordingStatusForSource(source, 'saving')
    if (recorder && recorder.state !== 'inactive') {
      // Request final data chunk before stopping to avoid losing the tail end
      try { recorder.requestData?.() } catch (error) {
        console.error(`Failed to request final ${source} recorder data before stopping.`, error)
      }
      // Brief wait for the final dataavailable event to fire
      await new Promise((resolve) => setTimeout(resolve, 250))
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000)
        recorder.addEventListener('stop', () => {
          recording.stoppedAt = recording.stoppedAt || new Date().toISOString()
          clearTimeout(timeout)
          resolve()
        }, { once: true })
        recorder.stop()
      })
    }
    recording.stoppedAt = recording.stoppedAt || new Date().toISOString()
    if (!recording.chunks.length || !sessionId) {
      setRecordingStatusForSource(source, 'failed')
      recording.finalizing = false
      if (required) {
        throw new Error(t('proctor_recording_no_data', { source }))
      }
      return
    }

    const extension = recording.mimeType.includes('mp4') ? 'mp4' : 'webm'
    const filename = `${attemptId}_${source}_${sessionId}.${extension}`
    const blob = new Blob(recording.chunks, { type: recording.mimeType || `video/${extension}` })
    try {
      recording.finalized = true
      const payload = {
        attemptId,
        sessionId,
        source,
        filename,
        blob,
        metadata: {
          recording_started_at: recording.startedAt,
          recording_stopped_at: recording.stoppedAt,
        },
      }
      preparedRecordingUploadsRef.current[source] = payload
      recording.sessionId = null
      recording.recorder = null
      recording.startedAt = null
      recording.stoppedAt = null
      recording.chunks = []
      recording.bytesRecorded = 0
      return payload
    } catch (error) {
      setRecordingStatusForSource(source, 'failed')
      emitProctoringNotice(
        `recording_finalize_${source}`,
        error?.response?.data?.detail || error?.message || t('proctor_recording_save_error', { source }),
        'LOW',
      )
      if (required) {
        throw error
      }
    } finally {
      recording.finalizing = false
    }
  }, [attemptId, emitProctoringNotice, setRecordingStatusForSource, t])

  const prepareRecordingUploads = useCallback(async (sources = []) => {
    const normalizedSources = Array.from(new Set((sources || []).filter(Boolean)))
    if (normalizedSources.length === 0) return []
    const payloads = await Promise.all(
      normalizedSources.map((source) => prepareSingleRecordingUpload(source, { required: true })),
    )
    return payloads.filter(Boolean)
  }, [prepareSingleRecordingUpload])

  const uploadPreparedRecording = useCallback(async (payload) => {
    const { attemptId: uploadAttemptId, sessionId, source, filename, blob, metadata } = payload
    const progressState = {
      lastReportedPercent: null,
      lastReportedAt: 0,
      lastStatus: '',
    }
    const totalBytes = Number(blob?.size) > 0 ? Number(blob.size) : 0

    const sendUploadProgress = async ({ uploadedBytes = 0, progressPercent, status = 'uploading' }) => {
      let normalizedPercent = progressPercent == null
        ? (totalBytes > 0 ? clampUploadPercent((Number(uploadedBytes || 0) / totalBytes) * 100) : 0)
        : clampUploadPercent(progressPercent)

      if (status === 'complete') {
        normalizedPercent = 100
      } else if (status !== 'error' && progressState.lastReportedPercent != null) {
        normalizedPercent = Math.max(normalizedPercent, progressState.lastReportedPercent)
      }

      if (status === 'uploading' || status === 'processing') {
        normalizedPercent = Math.min(99, normalizedPercent)
      }

      const now = Date.now()
      const statusChanged = progressState.lastStatus !== status
      const percentAdvanced = progressState.lastReportedPercent == null
        || normalizedPercent >= progressState.lastReportedPercent + VIDEO_UPLOAD_PROGRESS_STEP
      const heartbeatElapsed = (
        progressState.lastReportedPercent != null
        && normalizedPercent !== progressState.lastReportedPercent
        && (now - progressState.lastReportedAt) >= VIDEO_UPLOAD_PROGRESS_INTERVAL_MS
      )

      if (!statusChanged && !percentAdvanced && !heartbeatElapsed) return

      progressState.lastReportedPercent = normalizedPercent
      progressState.lastReportedAt = now
      progressState.lastStatus = status

      // Update local UI progress
      setUploadPercent((prev) => ({ ...prev, [source]: Math.round(normalizedPercent) }))

      try {
        await reportProctoringVideoUploadProgress(uploadAttemptId, {
          session_id: sessionId,
          source,
          filename,
          uploaded_bytes: Math.max(0, Math.round(Number(uploadedBytes || 0))),
          total_bytes: totalBytes,
          progress_percent: normalizedPercent,
          status,
        })
      } catch (error) {
        console.warn(`Failed to report ${source} video upload progress.`, error)
      }
    }

    await sendUploadProgress({ uploadedBytes: 0, progressPercent: 0, status: 'uploading' })

    let lastError = null
    for (let i = 0; i < 5; i += 1) {
      try {
        const uploadResponse = await uploadProctoringVideo(uploadAttemptId, sessionId, source, filename, blob, metadata, {
          onUploadProgress: (event) => {
            const uploadedBytes = Number(event?.loaded || 0)
            const eventTotal = Number(event?.total || 0)
            const effectiveTotal = eventTotal > 0 ? eventTotal : totalBytes
            const progressPercent = effectiveTotal > 0
              ? (uploadedBytes / effectiveTotal) * 100
              : (uploadedBytes > 0 ? 100 : 0)
            void sendUploadProgress({
              uploadedBytes,
              progressPercent,
              status: progressPercent >= 100 ? 'processing' : 'uploading',
            })
          },
        })
        const uploadPayload = uploadResponse?.data ?? uploadResponse?.payload ?? {}
        const jobId = String(uploadPayload?.job_id || '').trim()
        if (jobId) {
          emitProctoringNotice(
            `video_upload_queued_${source}`,
            t('proctor_recording_uploaded'),
            'LOW',
            'VIDEO_UPLOAD_QUEUED',
            12000,
          )
        }
        await sendUploadProgress({
          uploadedBytes: totalBytes || Number(blob?.size || 0),
          progressPercent: 100,
          status: 'complete',
        })
        delete preparedRecordingUploadsRef.current[source]
        lastError = null
        break
      } catch (error) {
        lastError = error
        const backoffMs = 1000 * Math.pow(2, i) + Math.random() * 1000
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
      }
    }
    if (lastError) {
      // Clear stale cache so retry uses fresh recording, not the failed blob
      delete preparedRecordingUploadsRef.current[source]
      await sendUploadProgress({
        uploadedBytes: 0,
        progressPercent: progressState.lastReportedPercent ?? 0,
        status: 'error',
      })
      throw lastError
    }
    setRecordingStatusForSource(source, 'saved')
  }, [emitProctoringNotice, setRecordingStatusForSource])

  const uploadRecordingSources = useCallback(async (sources = []) => {
    const payloads = await prepareRecordingUploads(sources)
    await Promise.all(payloads.map(async (payload) => {
      try {
        await uploadPreparedRecording(payload)
      } catch (error) {
        setRecordingStatusForSource(payload.source, 'failed')
        if (isMountedRef.current) {
          emitProctoringNotice(
            `recording_finalize_${payload.source}`,
            error?.response?.data?.detail || error?.message || t('proctor_recording_save_error', { source: payload.source }),
            'LOW',
          )
        } else {
          console.error(`Recording upload failed for ${payload.source}.`, error)
        }
        throw error
      }
    }))
  }, [emitProctoringNotice, prepareRecordingUploads, setRecordingStatusForSource, uploadPreparedRecording])

  useEffect(() => {
    if (!proctorCfg.screen_capture) {
      setScreenRecordingStatus('disabled')
      screenShareEstablishedRef.current = false
      screenShareLossHandledRef.current = false
      return
    }
    setScreenRecordingStatus((current) => {
      if (current === 'recording' || current === 'saving' || current === 'saved') return current
      return screenStream ? 'ready' : 'waiting'
    })
  }, [proctorCfg.screen_capture, screenStream])

  useEffect(() => {
    if (!attemptId || !cameraStream || !window.MediaRecorder) return
    void startRecordingSession(cameraStream, 'camera')
  }, [attemptId, cameraStream, startRecordingSession])

  useEffect(() => {
    if (!attemptId || !proctorCfg.screen_capture || !screenStream || !window.MediaRecorder) return
    // If the previous screen recorder died (stream was lost and re-established),
    // reset the recording state so a fresh session can start.
    const rec = screenRecordingRef.current
    if (rec.recorder && rec.recorder.state === 'inactive') {
      rec.recorder = null
      rec.sessionId = null
      rec.startedAt = null
      rec.stoppedAt = null
      rec.finalized = false
      rec.finalizing = false
      rec.chunks = []
      rec.bytesRecorded = 0
    }
    void startRecordingSession(screenStream, 'screen')
  }, [attemptId, proctorCfg.screen_capture, screenStream, startRecordingSession])

  const startAutoSubmitCountdown = useCallback((detail) => {
    if (submittedRef.current || submittingRef.current) return
    const normalizedDetail = String(detail || t('proctor_auto_submit_warning')).trim()
    setShowSubmitConfirm(false)
    setSubmitError('')
    setAutoSubmitState((current) => {
      if (current) {
        return {
          detail: normalizedDetail || current.detail,
          secondsLeft: current.secondsLeft,
        }
      }
      return {
        detail: normalizedDetail,
        secondsLeft: AUTO_SUBMIT_COUNTDOWN_SECONDS,
      }
    })
  }, [])

  const handleSubmitRequest = () => {
    if (submitting || autoSubmitState) return
    setShowSubmitConfirm(true)
  }

  const finishRequiredRecordingUploads = useCallback(async () => {
    const pendingSources = requiredRecordingSources.filter((source) => {
      if (source === 'camera') return cameraRecordingStatus !== 'saved'
      if (source === 'screen') return screenRecordingStatus !== 'saved'
      return true
    })
    if (pendingSources.length === 0) {
      return true
    }
    setSubmitPhase('uploading')
    setUploadError('')
    try {
      await uploadRecordingSources(pendingSources)
      return true
    } catch (error) {
      console.warn('Recording upload failed:', error)
      setUploadError(
        error?.response?.data?.detail
          || error?.message
          || t('proctor_upload_retry'),
      )
      return false
    }
  }, [cameraRecordingStatus, requiredRecordingSources, screenRecordingStatus, uploadRecordingSources])

  const finalizeAttemptSubmission = useCallback(async () => {
    setSubmitPhase(t('proctor_submitting'))
    try {
      await submitAttempt(attemptId)
    } catch (submitErr) {
      // If the backend already submitted (e.g. forced_submit from proctoring),
      // treat it as a success and redirect to the result page anyway.
      const detail = submitErr?.response?.data?.detail || ''
      const status = submitErr?.response?.status
      const alreadySubmitted = status === 409 || status === 400
        || /already.submitted/i.test(detail)
        || /already.completed/i.test(detail)
        || /not.*in.progress/i.test(detail)
      if (!alreadySubmitted) {
        throw submitErr
      }
    }
    submittedRef.current = true
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch((error) => {
        emitProctoringNotice('exit_fullscreen', error?.message || t('proctor_fullscreen_exit_error'), 'LOW')
      })
    }
    setSubmitPhase('')
    setSubmitting(false)
    submittingRef.current = false
    navigate(`/attempts/${attemptId}`)
  }, [attemptId, emitProctoringNotice, navigate])

  const runSubmissionFlow = useCallback(async ({ skipFlush = false, forceSubmit = false } = {}) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setAutoSubmitState(null)
    setSubmitting(true)
    setSubmitError('')
    setUploadError('')
    if (!skipFlush) {
      setSubmitPhase(t('proctor_saving_answers'))
    }
    try {
      if (!skipFlush) {
        await Promise.race([
          flush(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Save timed out')), 8000)),
        ]).catch(() => { /* best-effort flush — proceed with upload and submission */ })
      }
      const uploadSucceeded = await finishRequiredRecordingUploads()
      if (!uploadSucceeded) {
        if (!forceSubmit) {
          // Manual submit — let the student retry the upload
          setSubmitting(false)
          submittingRef.current = false
          return
        }
        // Auto-submit (timer expired / forced) — proceed despite upload failure
        // so the student is not stranded with an unsubmittable exam.
        console.warn('Recording upload failed but proceeding with submission (auto-submit)')
      }
      await finalizeAttemptSubmission()
    } catch (e) {
      setSubmitError(e.response?.data?.detail || e.message || t('proctor_submission_failed'))
      setSubmitPhase('')
      setSubmitting(false)
      submittingRef.current = false
    }
  }, [finalizeAttemptSubmission, finishRequiredRecordingUploads, flush])

  const handleSubmit = useCallback(async () => {
    void runSubmissionFlow()
  }, [runSubmissionFlow])

  const handleRetryUpload = useCallback(async () => {
    void runSubmissionFlow({ skipFlush: true, forceSubmit: true })
  }, [runSubmissionFlow])

  const handleForcedSubmit = useCallback((detail) => {
    const event = normalizeProctoringAlert({
      severity: 'HIGH',
      event_type: 'FORCED_SUBMIT',
      detail: detail || t('proctor_auto_submitted'),
    })
    if (event) {
      handleViolation(event)
    }
    startAutoSubmitCountdown(detail)
  }, [handleViolation, startAutoSubmitCountdown])

  const applyPingResponse = useCallback((response) => {
    const payload = response?.data ?? response
    if (!payload || typeof payload !== 'object') return
    const serverAlerts = Array.isArray(payload.alerts) ? payload.alerts : []
    serverAlerts.forEach((alert) => {
      const event = normalizeProctoringAlert(alert)
      if (event) {
        handleViolation(event)
      }
    })
    if (payload.forced_submit) {
      handleForcedSubmit(payload.submit_reason || t('proctor_auto_submitted'))
    }
  }, [handleForcedSubmit, handleViolation])

  // Fullscreen enforcement
  useEffect(() => {
    if (!proctoringEnabled) {
      setProctorStatus('closed')
      setCameraDark(false)
    }
  }, [proctoringEnabled])

  useEffect(() => {
    if (!proctorCfg.fullscreen_enforce || document.fullscreenElement) return undefined
    // When screen capture is active, do NOT request fullscreen here —
    // it was already entered on RulesPage, and calling requestFullscreen()
    // now would kill the screen share track.
    if (proctorCfg.screen_capture) return undefined
    const timeoutId = window.setTimeout(() => {
      document.documentElement.requestFullscreen?.().catch(() => {
        emitProctoringNotice(
          'fullscreen_entry',
          t('proctor_fullscreen_auto_failed'),
          'LOW',
        )
      })
    }, 200)
    return () => window.clearTimeout(timeoutId)
  }, [emitProctoringNotice, proctorCfg.fullscreen_enforce, proctorCfg.screen_capture])

  useEffect(() => {
    if (!proctorCfg.fullscreen_enforce) return undefined
    const handleFullscreenChange = () => {
      // Suppress fullscreen violations while the screen share picker is open,
      // during the grace period after it closes, or when screen capture is
      // enabled (getDisplayMedia and requestFullscreen fight each other in
      // browsers — toggling one always exits the other).
      const screenShareTransition = screenSharePickerOpenRef.current || screenShareGraceRef.current
      const screenCaptureActive = proctorCfg.screen_capture && screenShareEstablishedRef.current
      const screenSharePending = proctorCfg.screen_capture && !screenShareEstablishedRef.current

      if (submittedRef.current) {
        // Exam already submitted — the system itself exits fullscreen, not the student.
        return
      }
      if (screenShareTransition || screenSharePending) {
        // Don't enforce fullscreen while screen share picker is open, during
        // grace period, or before screen share is established — the picker
        // dialog forces the browser out of fullscreen.
        return
      }

      if (attemptId) {
        proctoringPing(attemptId, {
          focus: document.hasFocus(),
          visibility: document.visibilityState,
          blurs: tabBlurs,
          fullscreen: !!document.fullscreenElement,
          camera_dark: cameraDark,
        }).then(applyPingResponse).catch(() => {
          emitProctoringNotice('fullscreen_ping', t('proctor_fullscreen_sync_error'), 'LOW')
        })
      }
      if (!document.fullscreenElement) {
        // When screen capture is active, do NOT call requestFullscreen() —
        // it kills the screen share track. Warn the user but keep recording.
        if (screenCaptureActive) {
          sendBrowserViolation('FULLSCREEN_EXIT', 'MEDIUM', t('proctor_violation_fullscreen_recording'))
          return
        }
        sendBrowserViolation('FULLSCREEN_EXIT', 'HIGH', t('proctor_violation_fullscreen_exam'))
        document.documentElement.requestFullscreen?.().catch(() => {
          emitProctoringNotice('fullscreen_restore', t('proctor_fullscreen_required'), 'MEDIUM', 'FULLSCREEN_REQUIRED', 5000)
        })
      }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [applyPingResponse, attemptId, cameraDark, emitProctoringNotice, proctorCfg.fullscreen_enforce, proctorCfg.screen_capture, sendBrowserViolation, tabBlurs])

  useEffect(() => {
    if (!proctorCfg.screen_capture) {
      screenShareEstablishedRef.current = false
      screenShareLossHandledRef.current = false
      return
    }
    if (screenStream) {
      screenShareEstablishedRef.current = true
      screenShareLossHandledRef.current = false
      return
    }
    if (loading || submitting) return
    if (!screenShareEstablishedRef.current || screenShareLossHandledRef.current) return
    // During the initial screen-share + fullscreen setup the stream can briefly
    // become null before stabilising. Skip loss detection while the grace period is active.
    if (screenShareGraceRef.current) return
    screenShareLossHandledRef.current = true

    // Screen share lost — warn the learner and give them a chance to re-share.
    // Never auto-submit on screen share loss; just log a violation and retry.
    sendBrowserViolation('SCREEN_SHARE_LOST', 'HIGH', t('proctor_screen_share_interrupted'))
    setToast({
      severity: 'HIGH',
      event_type: 'SCREEN_SHARE_LOST',
      detail: t('proctor_screen_share_please_reshare'),
    })
    // Reset the loss flag after a delay so the watcher fires again if still not re-shared
    window.setTimeout(() => { screenShareLossHandledRef.current = false }, 8000)
  }, [loading, proctorCfg.screen_capture, screenStream, sendBrowserViolation, submitting])

  // Countdown timer
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (timeLeft === null || timeLeft <= 0) return
    const id = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(id)
          timerExpiredRef.current = true
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [timeLeft === null || timeLeft <= 0]) // only re-run when starting/stopping

  useEffect(() => {
    if (timeLeft !== 0 || !timerExpiredRef.current) return
    timerExpiredRef.current = false
    startAutoSubmitCountdown(t('proctor_time_up'))
  }, [startAutoSubmitCountdown, timeLeft])

  useEffect(() => {
    if (!autoSubmitState || autoSubmitState.secondsLeft <= 0 || submittingRef.current) return undefined
    const timeoutId = window.setTimeout(() => {
      setAutoSubmitState((current) => {
        if (!current) return null
        if (current.secondsLeft <= 1) {
          return { ...current, secondsLeft: 0 }
        }
        return { ...current, secondsLeft: current.secondsLeft - 1 }
      })
    }, 1000)
    return () => window.clearTimeout(timeoutId)
  }, [autoSubmitState])

  useEffect(() => {
    if (!autoSubmitState || autoSubmitState.secondsLeft !== 0) return
    setAutoSubmitState(null)
    void runSubmissionFlow({ forceSubmit: true })
  }, [autoSubmitState, runSubmissionFlow])

  const formatTime = (secs) => {
    if (secs === null) return '--:--'
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  const autosaveLabel = () => {
    if (saveState === 'saving') return t('proctor_autosave_saving')
    if (saveState === 'pending') return t('proctor_autosave_pending')
    if (saveState === 'saved') {
      return `${t('proctor_autosave_saved')} ${lastSavedAt ? lastSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}`.trim()
    }
    if (saveState === 'error') return t('proctor_autosave_failed')
    return t('proctor_autosave_ready')
  }

  // Tab blur / visibility tracking
  useEffect(() => {
    if (!proctorCfg.tab_switch_detect) return
    const tabBlurCountRef = { current: 0 }
    const recordTabSwitch = () => {
      // Suppress tab switch violations while screen share picker is open or grace period
      if (screenSharePickerOpenRef.current || screenShareGraceRef.current) return
      const now = Date.now()
      if (now - lastTabSwitchEventRef.current < 750) return
      lastTabSwitchEventRef.current = now
      tabBlurCountRef.current += 1
      const next = tabBlurCountRef.current
      setTabBlurs(next)
      const detail = t('proctor_tab_switched', { count: next })
      sendBrowserViolation('TAB_SWITCH', 'MEDIUM', detail)
      if (attemptId) {
        proctoringPing(attemptId, {
          focus: false,
          visibility: 'hidden',
          blurs: next,
          fullscreen: !!document.fullscreenElement,
          camera_dark: cameraDark,
        }).then(applyPingResponse).catch(() => {
          emitProctoringNotice('tab_switch_ping', t('proctor_tab_sync_error'), 'LOW')
        })
      }
    }
    const onVisibility = () => {
      if (document.hidden) recordTabSwitch()
    }
    // Use capture phase to ensure we detect before any other handler can stop propagation
    document.addEventListener('visibilitychange', onVisibility, true)
    // Also listen for window blur as a fallback — catches Alt+Tab and other
    // focus-loss scenarios that some browsers don't report via visibilitychange
    // (e.g. when fullscreen_enforce immediately re-enters fullscreen).
    const onWindowBlur = () => {
      if (!document.hasFocus()) recordTabSwitch()
    }
    window.addEventListener('blur', onWindowBlur, true)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility, true)
      window.removeEventListener('blur', onWindowBlur, true)
    }
  }, [applyPingResponse, attemptId, cameraDark, emitProctoringNotice, proctorCfg.tab_switch_detect, sendBrowserViolation])

  useEffect(() => {
    const max = proctorCfg.max_tab_blurs
    if (max && tabBlurs >= max) {
      setToast({ severity: 'HIGH', event_type: 'TAB_SWITCH', detail: t('proctor_too_many_tabs') })
      lastToastBlursRef.current = tabBlurs
      void runSubmissionFlow({ forceSubmit: true })
    } else if (tabBlurs > 0 && tabBlurs !== lastToastBlursRef.current && proctorCfg.tab_switch_detect) {
      lastToastBlursRef.current = tabBlurs
      setToast({ severity: 'MEDIUM', event_type: 'TAB_SWITCH', detail: t('proctor_tab_count', { count: tabBlurs }) })
    }
  }, [runSubmissionFlow, tabBlurs, proctorCfg.max_tab_blurs, proctorCfg.tab_switch_detect])

  // ── Copy / cut / paste blocking ────────────────────────────────────────────
  useEffect(() => {
    if (!proctorCfg.copy_paste_block) return
    const lastAlert = { t: 0 }
    const clipboardHandler = (e) => {
      e.preventDefault()
      const now = Date.now()
      if (now - lastAlert.t > 6000) {
        lastAlert.t = now
        sendBrowserViolation('COPY_PASTE_ATTEMPT', 'MEDIUM',
          t('proctor_copy_paste_blocked'))
      }
    }
    // Block Ctrl+C / Ctrl+X / Ctrl+V at the keydown level as well, because
    // some browsers suppress the clipboard event when the keydown is not
    // prevented, and bubble-phase document listeners may not fire if a child
    // element stops propagation. Capture phase ensures we intercept first.
    const keyHandler = (e) => {
      const key = e.key?.toLowerCase() || ''
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && (key === 'c' || key === 'x' || key === 'v')) {
        e.preventDefault()
        const now = Date.now()
        if (now - lastAlert.t > 6000) {
          lastAlert.t = now
          sendBrowserViolation('COPY_PASTE_ATTEMPT', 'MEDIUM',
            t('proctor_copy_paste_blocked'))
        }
      }
    }
    // Use capture phase to intercept before any child handler can process or stop propagation
    document.addEventListener('copy', clipboardHandler, true)
    document.addEventListener('cut', clipboardHandler, true)
    document.addEventListener('paste', clipboardHandler, true)
    document.addEventListener('keydown', keyHandler, true)
    return () => {
      document.removeEventListener('copy', clipboardHandler, true)
      document.removeEventListener('cut', clipboardHandler, true)
      document.removeEventListener('paste', clipboardHandler, true)
      document.removeEventListener('keydown', keyHandler, true)
    }
  }, [proctorCfg.copy_paste_block, sendBrowserViolation])

  // ── Keyboard shortcut blocking (DevTools, PrintScreen, view-source…) ───────
  useEffect(() => {
    if (!proctoringEnabled) return
    const lastAlert = {}
    const throttled = (key, ms = 12000) => {
      const now = Date.now()
      if (now - (lastAlert[key] || 0) < ms) return false
      lastAlert[key] = now
      return true
    }
    const handler = (e) => {
      const key = e.key?.toLowerCase() || ''
      const ctrl = e.ctrlKey || e.metaKey
      // F12 – DevTools
      if (e.key === 'F12') {
        e.preventDefault()
        if (throttled('f12')) sendBrowserViolation('SHORTCUT_BLOCKED', 'HIGH', t('proctor_devtools_blocked'))
        return
      }
      // Ctrl+Shift+I/J/K/C – DevTools panels
      if (ctrl && e.shiftKey && ['i', 'j', 'k', 'c'].includes(key)) {
        e.preventDefault()
        if (throttled(`csi_${key}`)) sendBrowserViolation('SHORTCUT_BLOCKED', 'HIGH', t('proctor_shortcut_blocked'))
        return
      }
      // Ctrl+U – View Source
      if (ctrl && key === 'u') {
        e.preventDefault()
        if (throttled('cu')) sendBrowserViolation('SHORTCUT_BLOCKED', 'MEDIUM', t('proctor_view_source_blocked'))
        return
      }
      // Ctrl+S – Save dialog
      if (ctrl && key === 's') { e.preventDefault(); return }
      // Ctrl+P – Print
      if (ctrl && key === 'p') { e.preventDefault(); return }
      // Ctrl+A – Select-all (only when copy/paste block is on)
      if (proctorCfg.copy_paste_block && ctrl && key === 'a') { e.preventDefault(); return }
      // PrintScreen
      if (e.key === 'PrintScreen') {
        e.preventDefault()
        if (throttled('ps')) sendBrowserViolation('SCREENSHOT_ATTEMPT', 'MEDIUM', t('proctor_printscreen_blocked'))
        return
      }
    }
    // Use capture phase so we intercept before any React handler
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [proctoringEnabled, proctorCfg.copy_paste_block, sendBrowserViolation])

  // ── Right-click / context menu blocking ────────────────────────────────────
  useEffect(() => {
    if (!proctoringEnabled) return
    const lastAlert = { t: 0 }
    const handler = (e) => {
      e.preventDefault()
      const now = Date.now()
      if (now - lastAlert.t > 30000) {
        lastAlert.t = now
        sendBrowserViolation('RIGHT_CLICK_ATTEMPT', 'LOW', t('proctor_context_menu_blocked'))
      }
    }
    document.addEventListener('contextmenu', handler)
    return () => document.removeEventListener('contextmenu', handler)
  }, [proctoringEnabled, sendBrowserViolation])

  // ── Multiple monitor / external display detection ───────────────────────────
  useEffect(() => {
    if (!proctoringEnabled) return
    const lastAlert = { current: 0 }
    const COOLDOWN = 60_000 // 1 alert per minute max

    const check = () => {
      const now = Date.now()
      if (now - lastAlert.current < COOLDOWN) return

      const reasons = []

      // Method 1: Screen API isExtended (Chrome 100+)
      if ('isExtended' in window.screen && window.screen.isExtended) {
        reasons.push('screen.isExtended=true')
      }

      // Method 2: screen.width vs availWidth mismatch (taskbar-adjusted)
      if (window.screen.width > window.screen.availWidth + 300) {
        reasons.push(`width ${window.screen.width} >> availWidth ${window.screen.availWidth}`)
      }

      // Method 3: Window position outside primary screen bounds
      if (window.screenX < -50 || window.screenX > window.screen.width + 50 ||
          window.screenY < -50 || window.screenY > window.screen.height + 50) {
        reasons.push(`window at (${window.screenX},${window.screenY}) outside screen`)
      }

      // Method 4: devicePixelRatio mismatch with screen resolution
      // External monitors often have different DPI
      const dpr = window.devicePixelRatio || 1
      const logicalW = window.screen.width
      const physicalW = logicalW * dpr
      if (physicalW > 5000 && dpr > 1) {
        reasons.push(`unusual resolution ${physicalW}px physical at ${dpr}x DPI`)
      }

      // Method 5: Screen Change Events API (Chrome 107+)
      if (window.getScreenDetails) {
        window.getScreenDetails().then(details => {
          if (details.screens && details.screens.length > 1) {
            const now2 = Date.now()
            if (now2 - lastAlert.current < COOLDOWN) return
            lastAlert.current = now2
            sendBrowserViolation('MULTIPLE_MONITORS', 'HIGH',
              t('proctor_multiple_monitors'))
          }
        }).catch(() => {})
      }

      if (reasons.length > 0) {
        lastAlert.current = now
        sendBrowserViolation('MULTIPLE_MONITORS', 'HIGH',
          t('proctor_external_display'))
      }
    }

    check()
    const interval = setInterval(check, 10_000) // check every 10s

    // Also check on resize/move (user plugs in monitor mid-exam)
    const onResize = () => setTimeout(check, 500)
    window.addEventListener('resize', onResize)

    // screen.isExtended change event (Chrome 100+)
    let screenCleanup
    try {
      if ('isExtended' in window.screen) {
        const onChange = () => check()
        window.screen.addEventListener('change', onChange)
        screenCleanup = () => window.screen.removeEventListener('change', onChange)
      }
    } catch (_) {}

    return () => {
      clearInterval(interval)
      window.removeEventListener('resize', onResize)
      if (screenCleanup) screenCleanup()
    }
  }, [proctoringEnabled, sendBrowserViolation])

  // ── Virtual machine / remote desktop detection ─────────────────────────────
  useEffect(() => {
    if (!proctoringEnabled) return
    try {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info')
        if (dbg) {
          const renderer = (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '').toLowerCase()
          const vendor = (gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '').toLowerCase()
          const vmKeywords = ['vmware', 'virtualbox', 'llvm', 'parallels', 'microsoft basic render',
            'swiftshader', 'softpipe', 'llvmpipe', 'citrix', 'rdp display']
          const combined = `${renderer} ${vendor}`
          const hit = vmKeywords.find(kw => combined.includes(kw))
          if (hit) {
            sendBrowserViolation('VIRTUAL_MACHINE', 'HIGH',
              t('proctor_vm_detected'))
          }
        }
      }
    } catch (error) {
      emitProctoringNotice('vm_detection', error?.message || t('proctor_graphics_inspect_error'), 'LOW')
    }
  }, [emitProctoringNotice, proctoringEnabled, sendBrowserViolation])

  // ── Developer tools open detection ─────────────────────────────────────────
  useEffect(() => {
    if (!proctoringEnabled) return
    const lastAlert = { t: 0 }
    const check = () => {
      const widthDiff = window.outerWidth - window.innerWidth
      const heightDiff = window.outerHeight - window.innerHeight
      if ((widthDiff > 160 || heightDiff > 160)) {
        const now = Date.now()
        if (now - lastAlert.t > 30000) {
          lastAlert.t = now
          sendBrowserViolation('DEV_TOOLS_OPEN', 'HIGH', t('proctor_devtools_open'))
        }
      }
    }
    const interval = setInterval(check, 4000)
    return () => clearInterval(interval)
  }, [proctoringEnabled, sendBrowserViolation])

  // ── Answer timing: reset clock when question changes ─────────────────────
  useEffect(() => {
    questionStartTimeRef.current = Date.now()
  }, [currentIdx])

  // ── Keystroke dynamics ────────────────────────────────────────────────────
  useEffect(() => {
    if (!proctoringEnabled) return
    const handler = (e) => {
      // Only track typing in text inputs / textareas (answers)
      const tag = e.target?.tagName
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') return
      const now = Date.now()
      const last = lastKeyTimeRef.current
      if (last > 0) {
        const interval = now - last
        keyIntervalsRef.current.push(interval)
        if (keyIntervalsRef.current.length > KEY_INTERVAL_WINDOW) {
          keyIntervalsRef.current.shift()
        }
        if (keyIntervalsRef.current.length >= KEY_INTERVAL_WINDOW) {
          const avg = keyIntervalsRef.current.reduce((a, b) => a + b, 0) / keyIntervalsRef.current.length
          if (avg < KEY_ANOMALY_THRESHOLD_MS) {
            const alertNow = Date.now()
            if (alertNow - lastKeystrokeAlertRef.current > 60000) {
              lastKeystrokeAlertRef.current = alertNow
              if (wsRawSendRef.current) {
                wsRawSendRef.current({
                  type: 'keystroke_anomaly',
                  avg_interval_ms: Math.round(avg),
                  sample_size: keyIntervalsRef.current.length,
                })
              } else if (sendClientEventRef.current) {
                sendClientEventRef.current('KEYSTROKE_ANOMALY', 'LOW', t('proctor_fast_typing'))
              }
            }
          }
        }
      }
      lastKeyTimeRef.current = now
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [proctoringEnabled])

  // ── Mouse inactivity detection ────────────────────────────────────────────
  useEffect(() => {
    if (!proctoringEnabled) return
    const onMove = () => {
      lastMouseMoveRef.current = Date.now()
      mouseInactiveAlertedRef.current = false
    }
    document.addEventListener('mousemove', onMove, { passive: true })
    const interval = setInterval(() => {
      const idle = Date.now() - lastMouseMoveRef.current
      if (idle >= MOUSE_INACTIVE_MS && !mouseInactiveAlertedRef.current) {
        mouseInactiveAlertedRef.current = true
        sendBrowserViolation(
          'MOUSE_INACTIVE',
          'LOW',
          t('proctor_mouse_inactive'),
        )
      }
    }, 15000)
    return () => {
      document.removeEventListener('mousemove', onMove)
      clearInterval(interval)
    }
  }, [proctoringEnabled, sendBrowserViolation])

  // Heartbeat ping
  useEffect(() => {
    if (!attemptId || !proctoringEnabled) return
    const interval = setInterval(() => {
      proctoringPing(attemptId, {
        focus: document.hasFocus(),
        visibility: document.visibilityState,
        blurs: tabBlurs,
        fullscreen: !!document.fullscreenElement,
        camera_dark: cameraDark,
      }).then(applyPingResponse).catch(() => {
        // Suppress HTTP ping error toasts entirely — the ProctorOverlay
        // already shows "Reconnecting..." when the WS is down, and that
        // is sufficient feedback for the learner.
        console.debug('[Proctoring] HTTP ping failed, WS connected:', wsConnectedRef.current)
      })
    }, 10000)
    return () => clearInterval(interval)
  }, [applyPingResponse, attemptId, cameraDark, emitProctoringNotice, proctoringEnabled, tabBlurs])

  useEffect(() => {
    const onBeforeUnload = (event) => {
      try {
        const recorders = [cameraRecordingRef.current, screenRecordingRef.current]
        for (const recording of recorders) {
          if (recording?.recorder && recording.recorder.state !== 'inactive') {
            recording.recorder.stop()
          }
        }
      } catch (error) {
        console.error('Failed to stop proctoring recorder during page unload.', error)
      }
      // Best-effort flush of unsaved answers
      try {
        flush().catch(() => {})
      } catch {
        // ignore — page is closing
      }
      // Always warn during an active exam (not just when submitting)
      if (!submittedRef.current) {
        event.preventDefault()
        event.returnValue = t('proctor_beforeunload_warning')
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [flush])

  // ── Prevent browser back button during exam ─────────────────────────────────
  useEffect(() => {
    if (submittedRef.current) return
    // Push a dummy state so pressing back pops it instead of leaving the page
    window.history.pushState({ examGuard: true }, '')
    const onPopState = () => {
      if (submittedRef.current) return
      // Re-push to keep the guard in place
      window.history.pushState({ examGuard: true }, '')
      setToast({ severity: 'MEDIUM', event_type: 'NAV_BLOCKED', detail: t('proctor_submit_before_leaving') })
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={`${styles.examPane} ${styles.centerState}`}>
          <p className={styles.stateMessage}>{t('proctor_loading_test')}</p>
        </div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className={styles.page}>
        <div className={`${styles.examPane} ${styles.centerState}`}>
          <div className={styles.errorBanner}>{loadError}</div>
          <button type="button" className={styles.retryBtn} onClick={() => setReloadKey((current) => current + 1)}>
            {t('proctor_retry_loading')}
          </button>
        </div>
      </div>
    )
  }

  // ── Recording upload overlay ────────────────────────────────────────────────
  if (submitPhase === 'uploading') {
    const anyProcessing = cameraRecordingStatus === 'processing' || screenRecordingStatus === 'processing'
    const allDone = Object.values(uploadPercent).length > 0 && Object.values(uploadPercent).every((p) => p >= 100) && !anyProcessing
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          background: 'rgba(30,41,59,0.95)', borderRadius: 16, padding: '2.5rem 3rem',
          minWidth: 400, maxWidth: 500, textAlign: 'center',
          border: '1px solid rgba(6,182,212,0.3)', boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 600, color: '#f1f5f9', marginBottom: '0.5rem' }}>
            {submittedRef.current ? t('proctor_exam_submitted') : t('proctor_finalizing_exam')}
          </div>
          <div style={{ color: '#94a3b8', marginBottom: '1.5rem' }}>
            {anyProcessing
              ? t('proctor_upload_processing')
              : t('proctor_upload_in_progress')}
          </div>
          {uploadError && (
            <div style={{
              marginBottom: '1rem',
              padding: '0.85rem 1rem',
              borderRadius: 10,
              background: 'rgba(127, 29, 29, 0.35)',
              border: '1px solid rgba(248, 113, 113, 0.35)',
              color: '#fecaca',
              textAlign: 'left',
              lineHeight: 1.45,
            }}>
              {uploadError}
            </div>
          )}
          {Object.entries(uploadPercent).map(([src, pct]) => (
            <div key={src} style={{ marginBottom: '1rem', textAlign: 'left' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#cbd5e1', fontSize: '0.9rem', marginBottom: 4 }}>
                <span>{src.charAt(0).toUpperCase() + src.slice(1)} {t('proctor_recording')}</span>
                <span>{pct}%</span>
              </div>
              <div style={{ background: 'rgba(255,255,255,0.1)', borderRadius: 6, height: 10, overflow: 'hidden' }}>
                <div style={{
                  width: `${pct}%`, height: '100%', borderRadius: 6,
                  background: pct >= 100 ? '#22c55e' : '#06b6d4',
                  transition: 'width 0.3s ease',
                }} />
              </div>
            </div>
          ))}
          {allDone && (
            <div style={{ color: '#22c55e', fontWeight: 500, marginTop: '1rem' }}>
              {t('proctor_upload_complete')}
            </div>
          )}
          {uploadError && !allDone && (
            <button
              type="button"
              onClick={handleRetryUpload}
              disabled={submitting}
              style={{
                marginTop: '1rem', padding: '0.5rem 1.5rem',
                background: 'transparent', border: '1px solid rgba(148,163,184,0.4)',
                color: '#94a3b8', borderRadius: 8, cursor: 'pointer', fontSize: '0.85rem',
              }}
            >
              {submitting ? t('proctor_retrying_upload') : t('proctor_retry_upload')}
            </button>
          )}
        </div>
      </div>
    )
  }

  const currentQ = questions[currentIdx]
  const currentQType = currentQ?.question_type || 'TEXT'
  const interactionLocked = submitting || Boolean(autoSubmitState)
  // When the hub is active, navigation is scoped to the active section. We map
  // between the flat `currentIdx` (index into the whole `questions` array, which
  // answer-saving/timing rely on) and the position of that question WITHIN the
  // active section (`inSectionIdx`). `sectionQuestions` is `questions` verbatim
  // for legacy exams, so the flat flow is unchanged.
  const inSectionIdx = hubEnabled ? Math.max(0, sectionQuestions.findIndex((q) => q.id === currentQ?.id)) : currentIdx
  const isLastInSection = hubEnabled
    ? inSectionIdx === sectionQuestions.length - 1
    : currentIdx === questions.length - 1
  const isFirstInSection = hubEnabled ? inSectionIdx <= 0 : currentIdx === 0
  const goToSectionQuestion = (posInSection) => {
    const q = sectionQuestions[posInSection]
    if (!q) return
    const flatIdx = questions.findIndex((item) => item.id === q.id)
    if (flatIdx >= 0) setCurrentIdx(flatIdx)
  }
  const answeredCount = questions.filter((question) => hasAnswerValue(answers[question.id])).length
  const unansweredCount = questions.length - answeredCount
  const progressPct = questions.length > 0 ? (answeredCount / questions.length) * 100 : 0
  const showProgressBar = exam?.settings?.show_progress_bar !== false
  const questionNavLabel = (question, index) => {
    const state = hasAnswerValue(answers[question.id]) ? 'answered' : 'unanswered'
    const current = index === currentIdx ? ', current question' : ''
    return `${t('proctor_go_to_question', { current: index + 1, total: questions.length })}${current}, ${state}`
  }
  const recordingBadgeClass = (status) => {
    if (status === 'saved' || status === 'recording') return styles.badgeConnected
    if (status === 'ready' || status === 'waiting' || status === 'checking' || status === 'saving' || status === 'processing' || status === 'disabled') return styles.badgePending
    return styles.badgeDisconnected
  }
  const proctorPane = (
    proctoringEnabled ? (
      <aside className={`${styles.proctorPane} glass`} aria-label={t('proctor_panel_aria')}>
        <ProctorOverlay
          attemptId={attemptId}
          token={tokens?.access_token}
          config={proctorCfg}
          initialScreenStream={screenStream}
          onViolation={handleViolation}
          onForcedSubmit={handleForcedSubmit}
          onStreamReady={setCameraStream}
          onScreenStreamReady={setScreenStream}
          onRegisterScreenShareRequest={registerScreenShareRequest}
          onRegisterSendClientEvent={registerSendClientEvent}
          onRegisterWsRawSend={registerWsRawSend}
          onStatusChange={setProctorStatus}
          onCameraStateChange={setCameraDark}
        />
      </aside>
    ) : null
  )
  const toastNode = (
    <AnimatePresence>
      {toast && (
        <ViolationToast event={toast} onClose={() => setToast(null)} />
      )}
    </AnimatePresence>
  )

  // ── Screen share gate: block exam until learner grants screen share ──────
  if (screenShareRequired) {
    return (
      <div className={styles.page}>
        <div className={`${styles.examPane} ${styles.centerState}`}>
          <h2 className={styles.examTitle}>{t('proctor_screen_share_required')}</h2>
          <p className={styles.stateMessage}>
            {t('proctor_screen_share_message')}
          </p>
          {screenShareGateError && <div className={styles.errorBanner}>{screenShareGateError}</div>}
          <button
            type="button"
            className={styles.retryBtn}
            disabled={screenShareGateLoading}
            onClick={handleScreenShareGate}
          >
            {screenShareGateLoading ? t('proctor_requesting_screen') : t('proctor_share_to_continue')}
          </button>
        </div>
      </div>
    )
  }

  // ── Section hub ──────────────────────────────────────────────────────────
  // Only shown for multi-section exams while no section is active. Legacy exams
  // (hub.length <= 1) skip this entirely and fall through to the flat flow.
  if (hubEnabled && activeSectionId == null) {
    const sectionBadgeClass = (status) => {
      if (status === 'finished') return styles.badgeConnected
      if (status === 'locked') return styles.badgeDisconnected
      return styles.badgePending
    }
    const allSectionsFinished = hub.every(
      (_, i) => sectionStatus(hub, i, { finished: finishedSections, answers, sequential }) === 'finished'
    )
    return (
      <div className={styles.page}>
        <div
          className={styles.pickerBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label={exam?.title || t('proctor_test')}
        >
          <motion.div
            className={`${styles.pickerModal} glass`}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className={styles.pickerHeader}>
              <h2 className={styles.examTitle}>{exam?.title || t('proctor_test')}</h2>
              <div className={styles.headerMeta}>
                <span className={proctoringEnabled && proctorStatus === 'connected' ? styles.badgeConnected : styles.badgeDisconnected}>
                  {t('proctor_proctoring')}: {proctoringEnabled ? proctorStatus : t('proctor_off')}
                </span>
                <div className={`${styles.timer} glass ${timeLeft !== null && timeLeft <= 300 ? styles.timerDanger : ''}`}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                  </svg>
                  {formatTime(timeLeft)}
                </div>
              </div>
            </div>

            {submitError && <div className={styles.warningBanner}>{submitError}</div>}

            {hub.map((section, i) => {
              const status = sectionStatus(hub, i, { finished: finishedSections, answers, sequential })
              const count = (section.questions || []).length
              const disabled = interactionLocked || status === 'locked' || (status === 'finished' && !allowRevisit)
              return (
                <button
                  key={section.id}
                  type="button"
                  className={`${styles.option} ${status === 'finished' ? styles.optionSelected : ''}`}
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return
                    setShowSubmitConfirm(false)
                    setActiveSectionId(section.id)
                    const first = (section.questions || [])[0]
                    const flatIdx = first ? questions.findIndex((q) => q.id === first.id) : -1
                    setCurrentIdx(flatIdx >= 0 ? flatIdx : 0)
                  }}
                >
                  <span>{section.title || `${t('proctor_section')} ${i + 1}`} · {count} {count === 1 ? t('question') : t('questions')}</span>
                  <span className={sectionBadgeClass(status)}>{t(`proctor_section_status_${status}`)}</span>
                </button>
              )
            })}

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.btnSubmit}
                onClick={handleSubmitRequest}
                disabled={interactionLocked || (sequential && !allSectionsFinished)}
              >
                {submitting ? t('proctor_submitting') : t('proctor_submit_test')}
              </button>
            </div>

            {showSubmitConfirm && (
              <div className={styles.submitConfirm}>
                <div className={styles.submitConfirmTitle}>{t('proctor_ready_to_submit')}</div>
                <div className={styles.submitConfirmBody}>
                  {unansweredCount > 0
                    ? `${t('proctor_still_have')} ${unansweredCount} ${t('proctor_unanswered')} ${unansweredCount === 1 ? t('question') : t('questions')}.`
                    : t('proctor_all_answered')}
                  {' '}
                  {t('proctor_once_submitted')}
                </div>
                {submitting && submitPhase && (
                  <div className={styles.submitStatus}>
                    {submitPhase === 'uploading' ? t('proctor_uploading_recordings') : submitPhase}
                  </div>
                )}
                <div className={styles.submitConfirmActions}>
                  <button type="button" className={styles.btnNav} onClick={() => setShowSubmitConfirm(false)} disabled={submitting}>
                    {t('proctor_keep_reviewing')}
                  </button>
                  <button type="button" className={styles.btnSubmit} onClick={handleSubmit} disabled={submitting}>
                    {submitting ? (submitPhase.includes('Submitting') ? t('proctor_submitting') : t('saving')) : t('proctor_confirm_submit')}
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        </div>
        {proctorPane}
        {toastNode}
      </div>
    )
  }

  if (!currentQ) {
    return (
      <div className={styles.page}>
        <div className={`${styles.examPane} ${styles.centerState}`}>
          <div className={styles.stateMessage}>{t('proctor_no_questions')}</div>
          <button type="button" className={styles.retryBtn} onClick={() => navigate('/attempts')}>
            {t('proctor_back_to_attempts')}
          </button>
        </div>
        {proctorPane}
        {toastNode}
      </div>
    )
  }

  return (
    <div className={styles.page}>
      {/* ---- Test Pane ---- */}
      <div className={styles.examPane}>
        {/* Header */}
        <motion.div
          className={`${styles.examHeader} glass`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
        >
          <h2 className={styles.examTitle}>{exam?.title || t('proctor_test')}</h2>
          <div className={styles.headerMeta}>
            {violations.HIGH > 0 && (
              <span className={styles.badgeHigh}>{violations.HIGH} {t('proctor_severity_high')}</span>
            )}
            {violations.MEDIUM > 0 && (
              <span className={styles.badgeMedium}>{violations.MEDIUM} {t('proctor_severity_medium')}</span>
            )}
            <span className={proctoringEnabled && proctorStatus === 'connected' ? styles.badgeConnected : styles.badgeDisconnected}>
              {t('proctor_proctoring')}: {proctoringEnabled ? proctorStatus : t('proctor_off')}
            </span>
            {proctoringEnabled && (
              <span className={recordingBadgeClass(cameraRecordingStatus)}>
                {t('proctor_camera')}: {cameraRecordingStatus}
              </span>
            )}
            {proctoringEnabled && proctorCfg.screen_capture && (
              <span className={recordingBadgeClass(screenRecordingStatus)}>
                {t('proctor_screen')}: {screenRecordingStatus}
              </span>
            )}
            {proctoringEnabled && (
              <span className={styles.recordingHint}>
                {t('proctor_recording_hint')}
              </span>
            )}
            <span
              className={
                saveState === 'saved'
                  ? styles.badgeSaved
                  : saveState === 'error'
                    ? styles.badgeError
                    : saveState === 'saving'
                      ? styles.badgeSaving
                      : styles.badgePending
              }
            >
              {autosaveLabel()}
            </span>
            <div className={`${styles.timer} glass ${timeLeft !== null && timeLeft <= 300 ? styles.timerDanger : ''}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              {formatTime(timeLeft)}
            </div>
          </div>
        </motion.div>

        {hubEnabled && activeSection && (
          <div className={styles.progressWrap}>
            <div className={styles.progressHeader}>
              <div className={styles.progressTitle}>
                {t('proctor_section_header', {
                  title: activeSection.title || t('proctor_section'),
                  current: inSectionIdx + 1,
                  total: sectionQuestions.length,
                })}
              </div>
              <button
                type="button"
                className={styles.btnNav}
                disabled={interactionLocked}
                onClick={() => { if (!interactionLocked) { setShowSubmitConfirm(false); setActiveSectionId(null) } }}
              >
                {t('proctor_back_to_hub')}
              </button>
            </div>
          </div>
        )}

        {restoreWarning && <div className={styles.warningBanner}>{restoreWarning}</div>}
        {saveError && <div className={styles.warningBanner}>{saveError}</div>}
        {autoSubmitState && (
          <div className={styles.autoSubmitBanner} role="alert" aria-live="assertive">
            <div>
              <div className={styles.autoSubmitTitle}>{t('proctor_auto_submitting_in')} {formatTime(autoSubmitState.secondsLeft)}</div>
              <div className={styles.autoSubmitBody}>{autoSubmitState.detail}</div>
            </div>
            <button type="button" className={styles.btnSubmit} onClick={handleSubmit} disabled={submitting}>
              {t('proctor_submit_now')}
            </button>
          </div>
        )}

        <div className={styles.progressWrap}>
          <div className={styles.progressHeader}>
            <div>
              <div className={styles.progressTitle}>{t('proctor_completion_progress')}</div>
              <div className={styles.progressMeta}>
                {answeredCount} {t('proctor_answered_of')} {questions.length} {t('proctor_total')}
              </div>
            </div>
            <div className={styles.progressStats}>
              <span className={styles.progressChip}>{t('proctor_current')} {currentIdx + 1} / {questions.length}</span>
              <span className={styles.progressChip}>{unansweredCount} {t('proctor_unanswered')}</span>
            </div>
          </div>
          {showProgressBar && (
            <>
              <div
                className={styles.progressBar}
                role="progressbar"
                aria-label={t('proctor_progress_aria')}
                aria-valuemin={0}
                aria-valuemax={questions.length}
                aria-valuenow={answeredCount}
              >
                <div className={styles.progressBarFill} style={{ width: `${progressPct}%` }} />
              </div>
              <div className={styles.progressPercent}>{Math.round(progressPct)}% {t('proctor_complete')}</div>
            </>
          )}
        </div>

        {/* Question Nav — scoped to the active section (whole list for legacy exams) */}
        <div className={styles.questionNav}>
          {sectionQuestions.map((q, i) => {
            const flatIdx = hubEnabled ? questions.findIndex((item) => item.id === q.id) : i
            const isActive = flatIdx === currentIdx
            return (
              <motion.button
                key={q.id}
                type="button"
                className={`${styles.qNum} ${isActive ? styles.qNumActive : ''} ${hasAnswerValue(answers[q.id]) ? styles.qNumAnswered : ''}`}
                onClick={() => {
                  if (interactionLocked) return
                  setShowSubmitConfirm(false)
                  if (flatIdx >= 0) setCurrentIdx(flatIdx)
                }}
                disabled={interactionLocked}
                aria-label={String(i + 1)}
                title={questionNavLabel(q, flatIdx)}
                aria-current={isActive ? 'step' : undefined}
                whileHover={{ y: -1, scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.12 }}
              >
                {i + 1}
              </motion.button>
            )
          })}
        </div>

        {/* Question Card */}
        {currentQ && (
          <motion.div
            className={`${styles.questionCard} glass`}
            key={currentQ.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.22 }}
          >
            <div className={styles.qLabel}>{t('question')} {hubEnabled ? inSectionIdx + 1 : currentIdx + 1} {t('of')} {hubEnabled ? sectionQuestions.length : questions.length}</div>
            {currentQ.image_url && (
              <img className={styles.qImage} src={currentQ.image_url} alt={t('admin_questions_image_alt')} />
            )}
            <div className={styles.qText}>{currentQ.text}</div>

            {(currentQType === 'MCQ' || currentQType === 'TRUEFALSE') && (currentQ.options || []).length > 0 ? (
              <div className={styles.options}>
                {(currentQType === 'TRUEFALSE' ? [t('question_true'), t('question_false')] : currentQ.options).map((opt, oi) => {
                  const letter = currentQType === 'TRUEFALSE' ? opt : String.fromCharCode(65 + oi)
                  const selected = answers[currentQ.id] === letter
                  return (
                    <motion.label
                      key={oi}
                      className={`${styles.option} ${selected ? styles.optionSelected : ''}`}
                      onClick={() => handleAnswer(currentQ.id, letter)}
                      whileHover={{ scale: 1.01 }}
                      whileTap={{ scale: 0.985 }}
                    >
                      <input
                        type="radio"
                        name={`q-${currentQ.id}`}
                        checked={selected}
                        disabled={interactionLocked}
                        readOnly
                      />
                      <span>{currentQType === 'TRUEFALSE' ? letter : `${letter}. ${opt}`}</span>
                    </motion.label>
                  )
                })}
              </div>
            ) : currentQType === 'MULTI' && currentQ.options ? (
              <div className={styles.options}>
                {currentQ.options.map((opt, oi) => {
                  const letter = String.fromCharCode(65 + oi)
                  const current = new Set(answers[currentQ.id] || [])
                  const selected = current.has(letter)
                  return (
                    <motion.label
                      key={oi}
                      className={`${styles.option} ${selected ? styles.optionSelected : ''}`}
                      whileHover={{ scale: 1.01 }}
                      whileTap={{ scale: 0.985 }}
                    >
                      <input
                        type="checkbox"
                        name={`q-${currentQ.id}-${oi}`}
                        checked={selected}
                        disabled={interactionLocked}
                        onChange={(e) => {
                          const next = new Set(current)
                          if (e.target.checked) next.add(letter); else next.delete(letter)
                          handleAnswer(currentQ.id, Array.from(next))
                        }}
                      />
                      <span>{letter}. {opt}</span>
                    </motion.label>
                  )
                })}
              </div>
            ) : (
              <textarea
                className={styles.textAnswer}
                placeholder={t('proctor_type_answer')}
                value={answers[currentQ.id] || ''}
                disabled={interactionLocked}
                onChange={e => handleAnswer(currentQ.id, e.target.value)}
              />
            )}

            {/* Actions */}
            {submitError && (
              <div className={styles.submitError}>
                {submitError}
              </div>
            )}
            {showSubmitConfirm && (
              <div className={styles.submitConfirm}>
                <div className={styles.submitConfirmTitle}>{t('proctor_ready_to_submit')}</div>
                <div className={styles.submitConfirmBody}>
                  {unansweredCount > 0
                    ? `${t('proctor_still_have')} ${unansweredCount} ${t('proctor_unanswered')} ${unansweredCount === 1 ? t('question') : t('questions')}.`
                    : t('proctor_all_answered')}
                  {' '}
                  {t('proctor_once_submitted')}
                </div>
                {submitting && submitPhase && (
                  <div className={styles.submitStatus}>
                    {submitPhase === 'uploading' ? t('proctor_uploading_recordings') : submitPhase}
                  </div>
                )}
                <div className={styles.submitConfirmActions}>
                  <button type="button" className={styles.btnNav} onClick={() => setShowSubmitConfirm(false)} disabled={submitting}>
                    {t('proctor_keep_reviewing')}
                  </button>
                  <button type="button" className={styles.btnSubmit} onClick={handleSubmit} disabled={submitting}>
                    {submitting ? (submitPhase.includes('Submitting') ? t('proctor_submitting') : t('saving')) : t('proctor_confirm_submit')}
                  </button>
                </div>
              </div>
            )}
            <div className={styles.actions}>
              <motion.button
                type="button"
                className={styles.btnNav}
                disabled={isFirstInSection || interactionLocked}
                onClick={() => {
                  if (interactionLocked) return
                  setShowSubmitConfirm(false)
                  if (hubEnabled) goToSectionQuestion(inSectionIdx - 1)
                  else setCurrentIdx(i => i - 1)
                }}
                whileTap={{ scale: 0.97 }}
              >
                {t('proctor_previous_question')}
              </motion.button>
              {hubEnabled ? (
                isLastInSection ? (
                  <motion.button
                    type="button"
                    className={styles.btnSubmit}
                    onClick={() => { if (!interactionLocked) finishSection() }}
                    disabled={interactionLocked}
                    whileTap={{ scale: 0.97 }}
                  >
                    {t('proctor_finish_section')}
                  </motion.button>
                ) : (
                  <motion.button
                    type="button"
                    className={styles.btnNav}
                    onClick={() => {
                      if (interactionLocked) return
                      setShowSubmitConfirm(false)
                      goToSectionQuestion(inSectionIdx + 1)
                    }}
                    disabled={interactionLocked}
                    whileTap={{ scale: 0.97 }}
                  >
                    {t('proctor_next_question')}
                  </motion.button>
                )
              ) : currentIdx < questions.length - 1 ? (
                <motion.button
                  type="button"
                  className={styles.btnNav}
                  onClick={() => {
                    if (interactionLocked) return
                    setShowSubmitConfirm(false)
                    setCurrentIdx(i => i + 1)
                  }}
                  disabled={interactionLocked}
                  whileTap={{ scale: 0.97 }}
                >
                  {t('proctor_next_question')}
                </motion.button>
              ) : (
                <motion.button
                  type="button"
                  className={styles.btnSubmit}
                  onClick={handleSubmitRequest}
                  disabled={interactionLocked}
                  aria-label={showSubmitConfirm ? t('proctor_review_summary_aria') : t('proctor_review_submit_aria')}
                  whileTap={{ scale: submitting ? 1 : 0.97 }}
                >
                  {submitting ? t('proctor_submitting') : autoSubmitState ? t('proctor_auto_submitting') : showSubmitConfirm ? t('proctor_review_submission') : t('proctor_submit_test')}
                </motion.button>
              )}
            </div>
          </motion.div>
        )}
      </div>

      {proctorPane}
      {toastNode}
    </div>
  )
}
