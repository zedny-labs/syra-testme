import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import Proctoring from './Proctoring'

const getAttemptMock = vi.fn()
const getAttemptAnswersMock = vi.fn()
const submitAnswerMock = vi.fn()
const submitAttemptMock = vi.fn()
const getTestQuestionsMock = vi.fn()
const getTestMock = vi.fn()
const getLearnerSectionsMock = vi.fn()
const finishAttemptSectionMock = vi.fn()
const consumeScreenStreamMock = vi.fn()
const proctoringPingMock = vi.fn()
const getProctoringVideoJobStatusMock = vi.fn()
const reportProctoringVideoUploadProgressMock = vi.fn()
const uploadProctoringVideoMock = vi.fn()
const overlayState = {
  cameraStream: null,
  screenStream: null,
}

function MotionDiv({ children, initial, animate, exit, transition, whileHover, whileTap, ...props }) {
  return <div {...props}>{children}</div>
}

function MotionButton({ children, initial, animate, exit, transition, whileHover, whileTap, ...props }) {
  return <button {...props}>{children}</button>
}

function MotionLabel({ children, initial, animate, exit, transition, whileHover, whileTap, ...props }) {
  return <label {...props}>{children}</label>
}

vi.mock('framer-motion', () => ({
  motion: {
    div: MotionDiv,
    button: MotionButton,
    label: MotionLabel,
  },
  AnimatePresence: ({ children }) => <>{children}</>,
}))

vi.mock('../../hooks/useAuth', () => ({
  default: () => ({
    tokens: { access_token: 'test-token' },
  }),
}))

vi.mock('../../components/ProctorOverlay/ProctorOverlay', () => ({
  default: ({ onForcedSubmit, onStreamReady, onScreenStreamReady }) => {
    React.useEffect(() => {
      if (overlayState.cameraStream) onStreamReady?.(overlayState.cameraStream)
      if (overlayState.screenStream) onScreenStreamReady?.(overlayState.screenStream)
    }, [onScreenStreamReady, onStreamReady])

    return (
      <div>
        <div>Proctor Overlay</div>
        <button type="button" onClick={() => onForcedSubmit?.('Attempt was force-submitted by an administrator.')}>
          Trigger forced submit
        </button>
      </div>
    )
  },
}))

vi.mock('../../components/ViolationToast/ViolationToast', () => ({
  default: () => <div>Violation Toast</div>,
}))

vi.mock('../../services/attempt.service', () => ({
  getAttempt: (...args) => getAttemptMock(...args),
  getAttemptAnswers: (...args) => getAttemptAnswersMock(...args),
  submitAnswer: (...args) => submitAnswerMock(...args),
  submitAttempt: (...args) => submitAttemptMock(...args),
}))

vi.mock('../../services/test.service', () => ({
  getTest: (...args) => getTestMock(...args),
  getTestQuestions: (...args) => getTestQuestionsMock(...args),
  getLearnerSections: (...args) => getLearnerSectionsMock(...args),
  finishAttemptSection: (...args) => finishAttemptSectionMock(...args),
}))

vi.mock('../../services/proctoring.service', () => ({
  getProctoringVideoJobStatus: (...args) => getProctoringVideoJobStatusMock(...args),
  reportProctoringVideoUploadProgress: (...args) => reportProctoringVideoUploadProgressMock(...args),
  uploadProctoringVideo: (...args) => uploadProctoringVideoMock(...args),
  proctoringPing: (...args) => proctoringPingMock(...args),
}))

vi.mock('../../utils/screenShareState', () => ({
  consumeScreenStream: () => consumeScreenStreamMock(),
}))

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/attempts/attempt-1/take']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/attempts/:attemptId/take" element={<Proctoring />} />
        <Route path="/attempts/:attemptId" element={<div>Attempt Result</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function advance(ms) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('Proctoring page', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    consumeScreenStreamMock.mockReturnValue(null)
    overlayState.cameraStream = null
    overlayState.screenStream = null
    getProctoringVideoJobStatusMock.mockResolvedValue({})
    reportProctoringVideoUploadProgressMock.mockResolvedValue({})
    uploadProctoringVideoMock.mockResolvedValue({ data: {} })
    proctoringPingMock.mockResolvedValue({
      data: {
        alerts: [],
        forced_submit: false,
        submit_reason: null,
      },
    })
    getAttemptMock.mockResolvedValue({
      data: {
        id: 'attempt-1',
        exam_id: 'exam-1',
        started_at: '2026-03-07T10:00:00Z',
      },
    })
    getTestMock.mockResolvedValue({
      data: {
        id: 'exam-1',
        title: 'Physics Final',
        proctoring_config: {},
      },
    })
    getTestQuestionsMock.mockResolvedValue({
      data: [
        {
          id: 'question-1',
          text: 'What is 2 + 2?',
          question_type: 'TEXT',
        },
      ],
    })
    getLearnerSectionsMock.mockResolvedValue({ data: [] })
    finishAttemptSectionMock.mockResolvedValue({ data: {} })
    getAttemptAnswersMock.mockResolvedValue({ data: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('keeps the attempt usable when saved answers fail to restore', async () => {
    getAttemptAnswersMock.mockRejectedValueOnce(new Error('restore failed'))

    renderPage()

    await waitFor(() => expect(screen.getByText('Physics Final')).toBeTruthy())
    expect(screen.getByText('Previously saved answers could not be restored. New answers will still be saved.')).toBeTruthy()
    expect(screen.getByPlaceholderText('Type your answer here...')).toBeTruthy()
  })

  it('shows a retry state when the test bootstrap fails and recovers on retry', async () => {
    getTestMock
      .mockRejectedValueOnce(new Error('test unavailable'))
      .mockResolvedValueOnce({
        data: {
          id: 'exam-1',
          title: 'Physics Final',
          proctoring_config: {},
        },
      })

    renderPage()

    await waitFor(() => expect(screen.getByText('Failed to load test. Please refresh and try again.')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading test' }))

    await waitFor(() => expect(screen.getByText('What is 2 + 2?')).toBeTruthy())
    expect(getAttemptMock).toHaveBeenCalledTimes(2)
  })

  it('shows an explicit empty state when the attempt has no questions', async () => {
    getTestQuestionsMock.mockResolvedValueOnce({ data: [] })

    renderPage()

    await waitFor(() => expect(screen.getByText('No questions available for this attempt.')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Back to attempts' })).toBeTruthy()
  })

  it('shows progress details and a submit confirmation before final submission', async () => {
    renderPage()

    await waitFor(() => expect(screen.getByText('Physics Final')).toBeTruthy())
    expect(screen.getByText('0 answered of 1 total')).toBeTruthy()
    expect(screen.getByText('1 unanswered')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Review and submit test' }))

    await waitFor(() => expect(screen.getByText('Ready to submit?')).toBeTruthy())
    expect(screen.getByText(/You still have 1 unanswered Question./)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm Submit' })).toBeTruthy()
  })

  it('shows autosave status when the learner changes an answer', async () => {
    renderPage()

    await waitFor(() => expect(screen.getByText('Physics Final')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('Type your answer here...'), { target: { value: 'Momentum is conserved.' } })

    expect(screen.getByText('Autosave: Pending changes')).toBeTruthy()
  })

  it('submits first and uploads recordings in the background', async () => {
    submitAttemptMock.mockResolvedValue({ data: { status: 'SUBMITTED' } })
    getTestMock.mockResolvedValueOnce({
      data: {
        id: 'exam-1',
        title: 'Physics Final',
        proctoring_config: {},
      },
    })
    consumeScreenStreamMock.mockReturnValue({
      getVideoTracks: () => [{ readyState: 'live' }],
      getTracks: () => [],
    })

    renderPage()

    await waitFor(() => expect(screen.getByText('Physics Final')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Review and submit test' }))
    await waitFor(() => expect(screen.getByText('Ready to submit?')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Submit' }))

    await waitFor(() => expect(submitAttemptMock).toHaveBeenCalledWith('attempt-1'))
  })

  it('blocks result navigation while required recordings are still uploading', async () => {
    const originalMediaRecorder = window.MediaRecorder
    const OriginalMediaStream = window.MediaStream

    class FakeMediaStream {
      constructor(tracks = []) {
        this.tracks = tracks
      }

      getAudioTracks() {
        return []
      }

      getVideoTracks() {
        return this.tracks
      }

      getTracks() {
        return this.tracks
      }
    }

    class FakeMediaRecorder {
      static isTypeSupported() {
        return true
      }

      constructor() {
        this.state = 'inactive'
        this.listeners = { stop: [] }
      }

      start() {
        this.state = 'recording'
      }

      requestData() {
        this.ondataavailable?.({ data: new Blob(['recording']) })
      }

      addEventListener(type, callback) {
        this.listeners[type] = this.listeners[type] || []
        this.listeners[type].push(callback)
      }

      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['recording']) })
        for (const listener of this.listeners.stop || []) {
          listener()
        }
      }
    }

    try {
      window.MediaStream = FakeMediaStream
      window.MediaRecorder = FakeMediaRecorder
      const liveTrack = { kind: 'video', readyState: 'live', stop: vi.fn() }
      const liveScreenStream = {
        getVideoTracks: () => [liveTrack],
        getTracks: () => [liveTrack],
      }
      overlayState.cameraStream = {
        getVideoTracks: () => [liveTrack],
        getTracks: () => [liveTrack],
      }
      consumeScreenStreamMock.mockReturnValue(liveScreenStream)
      submitAttemptMock.mockResolvedValue({ data: { status: 'SUBMITTED' } })
      getTestMock.mockResolvedValueOnce({
        data: {
          id: 'exam-1',
          title: 'Physics Final',
          proctoring_config: {
            face_detection: true,
          },
        },
      })
      uploadProctoringVideoMock.mockImplementation(() => new Promise(() => {}))

      renderPage()

      await waitFor(() => expect(screen.getByText('Physics Final')).toBeTruthy())
      fireEvent.click(screen.getByRole('button', { name: 'Review and submit test' }))
      await waitFor(() => expect(screen.getByText('Ready to submit?')).toBeTruthy())
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Submit' }))

      await waitFor(() => expect(screen.getByText('Finalizing your exam...')).toBeTruthy())
      expect(screen.getByText('Uploading proctoring recordings. Please do not close this page.')).toBeTruthy()
      expect(screen.queryByRole('button', { name: /skip upload/i })).toBeNull()
      expect(screen.queryByText('Attempt Result')).toBeNull()
    } finally {
      window.MediaRecorder = originalMediaRecorder
      window.MediaStream = OriginalMediaStream
    }
  })

  it('shows a 10-second countdown before auto-submitting when time runs out', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-07T10:00:00Z'))
    submitAttemptMock.mockResolvedValue({ data: { status: 'SUBMITTED' } })
    getAttemptMock.mockResolvedValueOnce({
      data: {
        id: 'attempt-1',
        exam_id: 'exam-1',
        started_at: '2026-03-07T09:59:01Z',
      },
    })
    getTestMock.mockResolvedValueOnce({
      data: {
        id: 'exam-1',
        title: 'Physics Final',
        time_limit_minutes: 1,
        proctoring_config: {},
      },
    })

    renderPage()

    await flushPromises()
    expect(screen.getByText('Physics Final')).toBeTruthy()
    await advance(1000)
    await flushPromises()

    expect(screen.getByText('Auto-submitting in 00:10')).toBeTruthy()

    for (let tick = 0; tick < 10; tick += 1) {
      await advance(1000)
    }
    await flushPromises()

    expect(submitAttemptMock).toHaveBeenCalledWith('attempt-1')
  })

  it('shows a 10-second countdown before finalizing a forced submit', async () => {
    vi.useFakeTimers()
    submitAttemptMock.mockResolvedValue({ data: { status: 'SUBMITTED' } })
    getTestMock.mockResolvedValueOnce({
      data: {
        id: 'exam-1',
        title: 'Physics Final',
        proctoring_config: {
          tab_switch_detect: true,
        },
      },
    })

    renderPage()

    await flushPromises()
    expect(screen.getByText('Physics Final')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Trigger forced submit' }))
    await flushPromises()

    expect(screen.getByText('Auto-submitting in 00:10')).toBeTruthy()

    for (let tick = 0; tick < 10; tick += 1) {
      await advance(1000)
    }
    await flushPromises()

    expect(submitAttemptMock).toHaveBeenCalledWith('attempt-1')
  })
})
