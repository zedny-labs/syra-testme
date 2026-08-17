import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useNavigate, useSearchParams, useParams } from 'react-router-dom'
import useUnsavedChanges from '../../../hooks/useUnsavedChanges'
import { adminApi } from '../../../services/admin.service'
import { generateQuestionsAI } from '../../../services/ai.service'
import {
  CERTIFICATE_ISSUE_RULE_OPTIONS,
  certificateIssueRuleLabelKey,
  DEFAULT_CERTIFICATE_ISSUE_RULE,
  normalizeCertificateIssueRule,
} from '../../../utils/certificates'
import { normalizeProctoringConfig } from '../../../utils/proctoringRequirements'
import { readPaginatedItems } from '../../../utils/pagination'
import useLanguage from '../../../hooks/useLanguage'
import ExamQuestionPanel from '../ExamQuestionPanel/ExamQuestionPanel'
import SectionsManager from '../SectionsManager/SectionsManager'
import styles from './AdminNewTestWizard.module.scss'

const STEPS = [
  { id: 0, labelKey: 'admin_wizard_step_information' },
  { id: 1, labelKey: 'admin_wizard_step_method' },
  { id: 2, labelKey: 'admin_wizard_step_proctoring' },
  { id: 3, labelKey: 'admin_wizard_step_questions' },
  { id: 4, labelKey: 'admin_wizard_step_grading' },
  { id: 5, labelKey: 'admin_wizard_step_certificates' },
  { id: 6, labelKey: 'admin_wizard_step_review' },
  { id: 7, labelKey: 'admin_wizard_step_sessions' },
  { id: 8, labelKey: 'admin_wizard_step_save_test' },
]

const QUESTION_TYPES = [
  { value: 'MCQ', labelKey: 'admin_wizard_qtype_single_choice' },
  { value: 'MULTI', labelKey: 'admin_wizard_qtype_multiple_choice' },
  { value: 'TEXT', labelKey: 'admin_wizard_qtype_essay' },
  { value: 'TRUEFALSE', labelKey: 'admin_wizard_qtype_true_false' },
  { value: 'ORDERING', labelKey: 'admin_wizard_qtype_ordering' },
  { value: 'FILLINBLANK', labelKey: 'admin_wizard_qtype_fill_blanks' },
  { value: 'MATCHING', labelKey: 'admin_wizard_qtype_matching' },
]

const CERTIFICATE_TEMPLATES = ['Classic', 'Modern', 'Simple']

const DETECTORS = [
  { key: 'face_detection', labelKey: 'admin_wizard_detector_face', descKey: 'admin_wizard_detector_face_desc' },
  { key: 'multi_face', labelKey: 'admin_wizard_detector_multi_face', descKey: 'admin_wizard_detector_multi_face_desc' },
  { key: 'audio_detection', labelKey: 'admin_wizard_detector_audio', descKey: 'admin_wizard_detector_audio_desc' },
  { key: 'object_detection', labelKey: 'admin_wizard_detector_object', descKey: 'admin_wizard_detector_object_desc' },
  { key: 'eye_tracking', labelKey: 'admin_wizard_detector_eye', descKey: 'admin_wizard_detector_eye_desc' },
  { key: 'head_pose_detection', labelKey: 'admin_wizard_detector_head', descKey: 'admin_wizard_detector_head_desc' },
  { key: 'mouth_detection', labelKey: 'admin_wizard_detector_mouth', descKey: 'admin_wizard_detector_mouth_desc' },
]

const DEFAULT_PROCTORING_CONFIG = normalizeProctoringConfig({
  face_detection: true,
  multi_face: true,
  audio_detection: true,
  object_detection: true,
  eye_tracking: true,
  head_pose_detection: true,
  mouth_detection: false,
  face_verify: true,
  fullscreen_enforce: true,
  tab_switch_detect: true,
  screen_capture: true,
  copy_paste_block: true,
  alert_rules: [],
  eye_deviation_deg: 12,
  mouth_open_threshold: 0.35,
  audio_rms_threshold: 0.08,
  max_face_absence_sec: 1.5,
  max_tab_blurs: 3,
  max_alerts_before_autosubmit: 5,
  lighting_min_score: 0.35,
  face_verify_id_threshold: 0.55,
  max_score_before_autosubmit: 15,
  frame_interval_ms: 900,
  audio_chunk_ms: 2000,
  screenshot_interval_sec: 60,
  face_verify_threshold: 0.15,
  cheating_consecutive_frames: 5,
  head_pose_consecutive: 5,
  eye_consecutive: 5,
  head_pose_yaw_deg: 20,
  head_pose_pitch_deg: 20,
  object_confidence_threshold: 0.35,
  audio_consecutive_chunks: 2,
  audio_speech_consecutive_chunks: 2,
  audio_speech_min_rms: 0.03,
  audio_speech_baseline_multiplier: 1.35,
  audio_window: 5,
  multi_face_min_area_ratio: 0.008,
  camera_cover_hard_luma: 20,
  camera_cover_soft_luma: 40,
  camera_cover_stddev_max: 16,
  camera_cover_hard_consecutive_frames: 1,
  camera_cover_soft_consecutive_frames: 2,
})

const PROCTORING_REQUIREMENTS = [
  { key: 'identity_required', labelKey: 'admin_wizard_req_identity', descKey: 'admin_wizard_req_identity_desc' },
  { key: 'camera_required', labelKey: 'admin_wizard_req_camera', descKey: 'admin_wizard_req_camera_desc' },
  { key: 'mic_required', labelKey: 'admin_wizard_req_mic', descKey: 'admin_wizard_req_mic_desc' },
  { key: 'lighting_required', labelKey: 'admin_wizard_req_lighting', descKey: 'admin_wizard_req_lighting_desc' },
  { key: 'fullscreen_enforce', labelKey: 'admin_wizard_req_fullscreen', descKey: 'admin_wizard_req_fullscreen_desc' },
  { key: 'tab_switch_detect', labelKey: 'admin_wizard_req_tab', descKey: 'admin_wizard_req_tab_desc' },
  { key: 'copy_paste_block', labelKey: 'admin_wizard_req_clipboard', descKey: 'admin_wizard_req_clipboard_desc' },
  { key: 'screen_capture', labelKey: 'admin_wizard_req_screen', descKey: 'admin_wizard_req_screen_desc' },
]

const PROCTORING_CONTROL_GROUPS = [
  {
    key: 'identity',
    titleKey: 'admin_wizard_pcg_identity_title',
    descriptionKey: 'admin_wizard_pcg_identity_desc',
    controls: [
      { key: 'max_face_absence_sec', labelKey: 'admin_wizard_ctrl_face_absence_label', descKey: 'admin_wizard_ctrl_face_absence_desc', min: 0.5, max: 15, step: 0.5, unit: 'sec', enabledBy: 'face_detection' },
      { key: 'lighting_min_score', labelKey: 'admin_wizard_ctrl_lighting_min_label', descKey: 'admin_wizard_ctrl_lighting_min_desc', min: 0.1, max: 0.8, step: 0.05, unit: 'score', enabledBy: 'lighting_required' },
      { key: 'face_verify_id_threshold', labelKey: 'admin_wizard_ctrl_face_verify_id_label', descKey: 'admin_wizard_ctrl_face_verify_id_desc', min: 0.3, max: 0.7, step: 0.01, unit: 'distance', enabledBy: 'identity_required' },
      { key: 'face_verify_threshold', labelKey: 'admin_wizard_ctrl_face_verify_label', descKey: 'admin_wizard_ctrl_face_verify_desc', min: 0.05, max: 0.35, step: 0.01, unit: 'distance', enabledBy: 'identity_required' },
      { key: 'object_confidence_threshold', labelKey: 'admin_wizard_ctrl_object_conf_label', descKey: 'admin_wizard_ctrl_object_conf_desc', min: 0.1, max: 0.95, step: 0.05, unit: 'confidence', enabledBy: 'object_detection' },
      { key: 'multi_face_min_area_ratio', labelKey: 'admin_wizard_ctrl_multi_face_area_label', descKey: 'admin_wizard_ctrl_multi_face_area_desc', min: 0.002, max: 0.03, step: 0.001, unit: 'ratio', enabledBy: 'multi_face' },
      { key: 'camera_cover_hard_luma', labelKey: 'admin_wizard_ctrl_cam_cover_hard_label', descKey: 'admin_wizard_ctrl_cam_cover_hard_desc', min: 5, max: 60, step: 1, unit: 'luma', enabledBy: 'camera_required' },
      { key: 'camera_cover_soft_luma', labelKey: 'admin_wizard_ctrl_cam_cover_soft_label', descKey: 'admin_wizard_ctrl_cam_cover_soft_desc', min: 10, max: 90, step: 1, unit: 'luma', enabledBy: 'camera_required' },
      { key: 'camera_cover_stddev_max', labelKey: 'admin_wizard_ctrl_cam_stddev_label', descKey: 'admin_wizard_ctrl_cam_stddev_desc', min: 4, max: 32, step: 1, unit: 'stddev', enabledBy: 'camera_required' },
      { key: 'camera_cover_hard_consecutive_frames', labelKey: 'admin_wizard_ctrl_cam_hard_frames_label', descKey: 'admin_wizard_ctrl_cam_hard_frames_desc', min: 1, max: 4, step: 1, unit: 'frames', enabledBy: 'camera_required' },
      { key: 'camera_cover_soft_consecutive_frames', labelKey: 'admin_wizard_ctrl_cam_soft_frames_label', descKey: 'admin_wizard_ctrl_cam_soft_frames_desc', min: 1, max: 6, step: 1, unit: 'frames', enabledBy: 'camera_required' },
    ],
  },
  {
    key: 'attention',
    titleKey: 'admin_wizard_pcg_attention_title',
    descriptionKey: 'admin_wizard_pcg_attention_desc',
    controls: [
      { key: 'eye_deviation_deg', labelKey: 'admin_wizard_ctrl_eye_angle_label', descKey: 'admin_wizard_ctrl_eye_angle_desc', min: 6, max: 25, step: 1, unit: 'deg', enabledBy: 'eye_tracking' },
      { key: 'eye_consecutive', labelKey: 'admin_wizard_ctrl_eye_frames_label', descKey: 'admin_wizard_ctrl_eye_frames_desc', min: 1, max: 12, step: 1, unit: 'frames', enabledBy: 'eye_tracking' },
      { key: 'head_pose_yaw_deg', labelKey: 'admin_wizard_ctrl_head_yaw_label', descKey: 'admin_wizard_ctrl_head_yaw_desc', min: 8, max: 35, step: 1, unit: 'deg', enabledBy: 'head_pose_detection' },
      { key: 'head_pose_pitch_deg', labelKey: 'admin_wizard_ctrl_head_pitch_label', descKey: 'admin_wizard_ctrl_head_pitch_desc', min: 8, max: 35, step: 1, unit: 'deg', enabledBy: 'head_pose_detection' },
      { key: 'head_pose_consecutive', labelKey: 'admin_wizard_ctrl_head_frames_label', descKey: 'admin_wizard_ctrl_head_frames_desc', min: 1, max: 12, step: 1, unit: 'frames', enabledBy: 'head_pose_detection' },
      { key: 'mouth_open_threshold', labelKey: 'admin_wizard_ctrl_mouth_thresh_label', descKey: 'admin_wizard_ctrl_mouth_thresh_desc', min: 0.1, max: 0.8, step: 0.05, unit: 'ratio', enabledBy: 'mouth_detection' },
      { key: 'audio_rms_threshold', labelKey: 'admin_wizard_ctrl_audio_rms_label', descKey: 'admin_wizard_ctrl_audio_rms_desc', min: 0.02, max: 0.25, step: 0.01, unit: 'rms', enabledBy: 'audio_detection' },
      { key: 'audio_consecutive_chunks', labelKey: 'admin_wizard_ctrl_audio_chunks_label', descKey: 'admin_wizard_ctrl_audio_chunks_desc', min: 1, max: 6, step: 1, unit: 'chunks', enabledBy: 'audio_detection' },
      { key: 'audio_speech_consecutive_chunks', labelKey: 'admin_wizard_ctrl_speech_chunks_label', descKey: 'admin_wizard_ctrl_speech_chunks_desc', min: 1, max: 6, step: 1, unit: 'chunks', enabledBy: 'audio_detection' },
      { key: 'audio_speech_min_rms', labelKey: 'admin_wizard_ctrl_speech_rms_label', descKey: 'admin_wizard_ctrl_speech_rms_desc', min: 0.01, max: 0.12, step: 0.005, unit: 'rms', enabledBy: 'audio_detection' },
      { key: 'audio_speech_baseline_multiplier', labelKey: 'admin_wizard_ctrl_speech_mult_label', descKey: 'admin_wizard_ctrl_speech_mult_desc', min: 1, max: 2.5, step: 0.05, unit: 'x', enabledBy: 'audio_detection' },
      { key: 'audio_window', labelKey: 'admin_wizard_ctrl_audio_window_label', descKey: 'admin_wizard_ctrl_audio_window_desc', min: 3, max: 10, step: 1, unit: 'chunks', enabledBy: 'audio_detection' },
    ],
  },
  {
    key: 'enforcement',
    titleKey: 'admin_wizard_pcg_enforcement_title',
    descriptionKey: 'admin_wizard_pcg_enforcement_desc',
    controls: [
      { key: 'max_tab_blurs', labelKey: 'admin_wizard_ctrl_max_tab_label', descKey: 'admin_wizard_ctrl_max_tab_desc', min: 1, max: 10, step: 1, unit: 'switches', enabledBy: 'tab_switch_detect' },
      { key: 'max_alerts_before_autosubmit', labelKey: 'admin_wizard_ctrl_max_alerts_label', descKey: 'admin_wizard_ctrl_max_alerts_desc', min: 1, max: 20, step: 1, unit: 'alerts' },
      { key: 'max_score_before_autosubmit', labelKey: 'admin_wizard_ctrl_max_score_label', descKey: 'admin_wizard_ctrl_max_score_desc', min: 3, max: 40, step: 1, unit: 'score' },
      { key: 'cheating_consecutive_frames', labelKey: 'admin_wizard_ctrl_consec_frames_label', descKey: 'admin_wizard_ctrl_consec_frames_desc', min: 1, max: 12, step: 1, unit: 'frames' },
    ],
  },
  {
    key: 'capture',
    titleKey: 'admin_wizard_pcg_capture_title',
    descriptionKey: 'admin_wizard_pcg_capture_desc',
    controls: [
      { key: 'frame_interval_ms', labelKey: 'admin_wizard_ctrl_frame_interval_label', descKey: 'admin_wizard_ctrl_frame_interval_desc', min: 750, max: 6000, step: 150, unit: 'ms' },
      { key: 'audio_chunk_ms', labelKey: 'admin_wizard_ctrl_audio_chunk_label', descKey: 'admin_wizard_ctrl_audio_chunk_desc', min: 750, max: 6000, step: 250, unit: 'ms', enabledBy: 'audio_detection' },
      { key: 'screenshot_interval_sec', labelKey: 'admin_wizard_ctrl_screenshot_label', descKey: 'admin_wizard_ctrl_screenshot_desc', min: 15, max: 180, step: 5, unit: 'sec', enabledBy: 'screen_capture' },
    ],
  },
]

const normalizeScheduleComparisonValue = (value) => {
  if (!value) return ''
  try {
    return new Date(value).toISOString()
  } catch {
    return String(value)
  }
}

const PROCTORING_LABEL_KEYS = Object.fromEntries([
  ...DETECTORS.map((detector) => [detector.key, detector.labelKey]),
  ...PROCTORING_REQUIREMENTS.map((control) => [control.key, control.labelKey]),
])

const ALERT_RULE_EVENT_OPTIONS = [
  { value: 'FULLSCREEN_EXIT', labelKey: 'admin_wizard_alert_fullscreen_exit', descKey: 'admin_wizard_alert_fullscreen_exit_desc', requires: ['fullscreen_enforce'] },
  { value: 'ALT_TAB', labelKey: 'admin_wizard_alert_tab_switch', descKey: 'admin_wizard_alert_tab_switch_desc', requires: ['tab_switch_detect'] },
  { value: 'FOCUS_LOSS', labelKey: 'admin_wizard_alert_focus_loss', descKey: 'admin_wizard_alert_focus_loss_desc', requires: ['tab_switch_detect'] },
  { value: 'CAMERA_COVERED', labelKey: 'admin_wizard_alert_camera_covered', descKey: 'admin_wizard_alert_camera_covered_desc', requires: ['camera_required'] },
  { value: 'FACE_DISAPPEARED', labelKey: 'admin_wizard_alert_no_face', descKey: 'admin_wizard_alert_no_face_desc', requires: ['face_detection'] },
  { value: 'MULTIPLE_FACES', labelKey: 'admin_wizard_alert_multiple_faces', descKey: 'admin_wizard_alert_multiple_faces_desc', requires: ['multi_face'] },
  { value: 'FACE_MISMATCH', labelKey: 'admin_wizard_alert_face_mismatch', descKey: 'admin_wizard_alert_face_mismatch_desc', requires: ['face_verify'] },
  { value: 'LOUD_AUDIO', labelKey: 'admin_wizard_alert_loud_audio', descKey: 'admin_wizard_alert_loud_audio_desc', requires: ['audio_detection'] },
  { value: 'AUDIO_ANOMALY', labelKey: 'admin_wizard_alert_audio_anomaly', descKey: 'admin_wizard_alert_audio_anomaly_desc', requires: ['audio_detection'] },
  { value: 'FORBIDDEN_OBJECT', labelKey: 'admin_wizard_alert_forbidden_obj', descKey: 'admin_wizard_alert_forbidden_obj_desc', requires: ['object_detection'] },
  { value: 'EYE_MOVEMENT', labelKey: 'admin_wizard_alert_eye_movement', descKey: 'admin_wizard_alert_eye_movement_desc', requires: ['eye_tracking'] },
  { value: 'HEAD_POSE', labelKey: 'admin_wizard_alert_head_pose', descKey: 'admin_wizard_alert_head_pose_desc', requires: ['head_pose_detection'] },
  { value: 'MOUTH_MOVEMENT', labelKey: 'admin_wizard_alert_mouth_movement', descKey: 'admin_wizard_alert_mouth_movement_desc', requires: ['mouth_detection'] },
]

const ALERT_RULE_ACTIONS = [
  { value: 'FLAG_REVIEW', labelKey: 'admin_wizard_action_flag_review' },
  { value: 'WARN', labelKey: 'admin_wizard_action_warn' },
  { value: 'AUTO_SUBMIT', labelKey: 'admin_wizard_action_auto_submit' },
]

const ALERT_RULE_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH']
const ALERT_RULE_ACTION_HELPER_KEYS = {
  FLAG_REVIEW: 'admin_wizard_action_flag_helper',
  WARN: 'admin_wizard_action_warn_helper',
  AUTO_SUBMIT: 'admin_wizard_action_submit_helper',
}

function humanizeSettingLabel(value) {
  return value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function formatApiErrorMessage(error, fallback) {
  const detail = error?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) {
    return detail
  }
  if (Array.isArray(detail) && detail.length > 0) {
    return detail.map((item) => {
      if (typeof item === 'string' && item.trim()) {
        return item
      }
      if (item && typeof item === 'object') {
        const loc = Array.isArray(item.loc)
          ? item.loc.filter((segment) => !['body', 'query', 'path'].includes(String(segment))).join('.')
          : ''
        const message = item.msg || item.message || 'request validation failed'
        return loc ? `${loc}: ${message}` : message
      }
      return 'Request validation failed'
    }).join(' ')
  }
  if (detail && typeof detail === 'object') {
    return detail.message || detail.msg || fallback
  }
  return error?.validation?.message || fallback
}

function createAlertRule(seed = {}) {
  const id = seed.id || `rule-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  return {
    id,
    event_type: seed.event_type || 'FULLSCREEN_EXIT',
    threshold: Number.isFinite(Number(seed.threshold)) ? Math.max(1, Number(seed.threshold)) : 1,
    severity: seed.severity || 'HIGH',
    action: seed.action || 'WARN',
    message: seed.message || '',
  }
}

function describeAlertRule(rule, t) {
  const option = ALERT_RULE_EVENT_OPTIONS.find((item) => item.value === rule.event_type)
  const action = ALERT_RULE_ACTIONS.find((item) => item.value === rule.action)
  return `${option ? t(option.labelKey) : humanizeSettingLabel(rule.event_type || 'Alert')} x${rule.threshold} -> ${action ? t(action.labelKey) : rule.action} (${rule.severity})`
}

export default function AdminNewTestWizard() {
  const navigate = useNavigate()
  const { t } = useLanguage()
  const [searchParams] = useSearchParams()
  const { id: paramId } = useParams()
  const editId = searchParams.get('edit') || paramId
  const autosaveTimerRef = useRef(null)
  const autosaveGenerationRef = useRef(0)
  const autosavingRef = useRef(false)
  const saveExamRef = useRef(null)
  const saveExamInFlightRef = useRef(null)
  const savingRef = useRef(false)
  const prefersReducedMotion = useReducedMotion()
  const stepTransitionDuration = prefersReducedMotion || import.meta.env.MODE === 'test' ? 0 : 0.25

  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)
  const [examId, setExamId] = useState(editId || null)
  const [editorLocked, setEditorLocked] = useState(false)
  const [editingPublishedTest, setEditingPublishedTest] = useState(false)

  /* ─── Step 0: Information ─── */
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [examCode, setExamCode] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [categories, setCategories] = useState([])
  const [courses, setCourses] = useState([])
  const [courseId, setCourseId] = useState('')
  const [nodes, setNodes] = useState([])
  const [nodeId, setNodeId] = useState('')
  const [creatingCourse, setCreatingCourse] = useState(false)
  const [showCourseCreator, setShowCourseCreator] = useState(false)
  const [newCourseTitle, setNewCourseTitle] = useState('')
  const [newCourseDescription, setNewCourseDescription] = useState('')
  const [newModuleTitle, setNewModuleTitle] = useState('Module 1')
  const [examTemplates, setExamTemplates] = useState([])
  const [selectedTemplate, setSelectedTemplate] = useState('')

  /* ─── Step 1: Method ─── */
  const [method, setMethod] = useState('manual') // 'manual' | 'generator'
  const [generatorBy, setGeneratorBy] = useState('difficulty') // 'difficulty' | 'category'
  const [generatorCount, setGeneratorCount] = useState(20)
  const [generatorDifficultyMix, setGeneratorDifficultyMix] = useState({ easy: 40, medium: 40, hard: 20 })
  const [generatorCategories, setGeneratorCategories] = useState([])
  const [generatorPools, setGeneratorPools] = useState([])
  const [generatorTagsInclude, setGeneratorTagsInclude] = useState('')
  const [generatorTagsExclude, setGeneratorTagsExclude] = useState('')
  const [generatorUniquePerCandidate, setGeneratorUniquePerCandidate] = useState(true)
  const [generatorVersionCount, setGeneratorVersionCount] = useState(3)
  const [generatorRandomSeed, setGeneratorRandomSeed] = useState('')
  const [generatorPreventReuse, setGeneratorPreventReuse] = useState(true)
  const [generatorShuffleAnswers, setGeneratorShuffleAnswers] = useState(true)
  const [generatorAdaptive, setGeneratorAdaptive] = useState(false)

  /* ─── Step 2: Settings ─── */
  const [examType, setExamType] = useState('MCQ')
  const [pageFormat, setPageFormat] = useState('one_per_page')
  const [calculatorType, setCalculatorType] = useState('none')
  const [hideMetadata, setHideMetadata] = useState(false)
  const [randomizeQuestions, setRandomizeQuestions] = useState(false)
  const [randomizeAnswers, setRandomizeAnswers] = useState(false)
  const [showProgressBar, setShowProgressBar] = useState(true)
  const [unlimitedTime, setUnlimitedTime] = useState(false)
  const [timeLimitMinutes, setTimeLimitMinutes] = useState(60)
  const [proctoring, setProctoring] = useState(DEFAULT_PROCTORING_CONFIG)
  const [proctoringView, setProctoringView] = useState('proctoring_settings')
  const [proctoringSessionId, setProctoringSessionId] = useState('')
  const [proctoringLoading, setProctoringLoading] = useState(false)
  const [proctoringRows, setProctoringRows] = useState([])
  const [proctoringSessions, setProctoringSessions] = useState([])
  const [specialAccommodations, setSpecialAccommodations] = useState('')
  const [specialRequests, setSpecialRequests] = useState('')
  const [proctoringSearch, setProctoringSearch] = useState({
    attemptId: '',
    username: '',
    sessionName: '',
    status: '',
    userGroup: '',
    comment: '',
  })

  /* ─── Step 3: Questions ─── */
  const [questions, setQuestions] = useState([])
  const [pools, setPools] = useState([])
  const [selectedPool, setSelectedPool] = useState('')
  const [seedCount, setSeedCount] = useState(5)
  const [questionInitError, setQuestionInitError] = useState('')
  const [panelError, setPanelError] = useState('')

  /* ─── Step 4: Grading ─── */
  const [passingScore, setPassingScore] = useState(60)
  const [maxAttempts, setMaxAttempts] = useState(3)
  const [gradingScaleId, setGradingScaleId] = useState('')
  const [gradingScales, setGradingScales] = useState([])
  const [negativeMarking, setNegativeMarking] = useState(false)
  const [negMarkValue, setNegMarkValue] = useState(0.25)
  const [negMarkType, setNegMarkType] = useState('points')
  const [showFinalScore, setShowFinalScore] = useState(true)
  const [showQuestionScores, setShowQuestionScores] = useState(false)
  const [sequentialSections, setSequentialSections] = useState(false)
  const [allowRevisitSections, setAllowRevisitSections] = useState(true)

  /* ─── Step 5: Certificates ─── */
  const [certEnabled, setCertEnabled] = useState(false)
  const [certTemplate, setCertTemplate] = useState('Classic')
  const [certOrientation, setCertOrientation] = useState('landscape')
  const [certTitle, setCertTitle] = useState('Certificate of Achievement')
  const [certSubtitle, setCertSubtitle] = useState('')
  const [certCompany, setCertCompany] = useState('')
  const [certSigner, setCertSigner] = useState('Examiner')
  const [certDescription, setCertDescription] = useState('This is to certify that the above named candidate has successfully completed the assessment.')
  const [certIssueRule, setCertIssueRule] = useState(DEFAULT_CERTIFICATE_ISSUE_RULE)

  /* ─── Step 7: Sessions ─── */
  const [users, setUsers] = useState([])
  const [selectedUsers, setSelectedUsers] = useState([])
  const [userSearch, setUserSearch] = useState('')
  const [bulkLearnerInput, setBulkLearnerInput] = useState('')
  const [bulkLearnerFeedback, setBulkLearnerFeedback] = useState('')
  const [accessMode, setAccessMode] = useState('OPEN')
  const [scheduledAt, setScheduledAt] = useState('')
  const [assignedSessions, setAssignedSessions] = useState([])
  const [sessionBusy, setSessionBusy] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiTopic, setAiTopic] = useState('')
  const [aiCount, setAiCount] = useState(5)
  const [aiDifficulty, setAiDifficulty] = useState('mixed')

  /* ─── Step 8: Save ─── */
  const [publishStatus, setPublishStatus] = useState('OPEN')
  const publishStatusRef = useRef('OPEN')
  const wizardBaselineRef = useRef('')
  const [wizardReady, setWizardReady] = useState(!editId)
  const [wizardBaselineVersion, setWizardBaselineVersion] = useState(0)
  const [exitingWizard, setExitingWizard] = useState(false)

  const toDateTimeLocalValue = (value) => {
    if (!value) return ''
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    const local = new Date(date.getTime() - (date.getTimezoneOffset() * 60000))
    return local.toISOString().slice(0, 16)
  }

  const updatePublishStatus = useCallback((nextStatus) => {
    publishStatusRef.current = nextStatus
    setPublishStatus(nextStatus)
  }, [])

  useEffect(() => () => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current)
    }
  }, [])

  useEffect(() => {
    savingRef.current = saving
  }, [saving])

  const goToStep = (nextStep) => {
    startTransition(() => {
      setStep(nextStep)
    })
  }

  // `preserveNodeId` keeps whatever node id the caller already knows is correct
  // (e.g. the exam's own `node_id` from a real, existing test) instead of
  // clearing/replacing it. GET /nodes is owner-scoped to courses *this* admin
  // created, so it comes back empty whenever the exam being edited belongs to
  // this admin but its course was created by someone else (legacy data, or an
  // exam whose course ownership otherwise diverges from the exam's own
  // creator) — that's not "no node exists", just "this admin can't list it".
  // Without this guard, an empty list + createIfEmpty would try to create a
  // brand-new node under a course this admin doesn't own, which the backend
  // correctly rejects (403 "not_allowed"); or, with createIfEmpty off, it
  // would still silently null out a perfectly valid node_id.
  const loadNodesForCourse = async (selectedCourseId, { createIfEmpty = false, preserveNodeId = false } = {}) => {
    if (!selectedCourseId) {
      setNodes([])
      if (!preserveNodeId) setNodeId('')
      return []
    }
    try {
      const { data } = await adminApi.nodes(selectedCourseId)
      const nodeList = Array.isArray(data)
        ? data
        : typeof data === 'string'
          ? (() => {
              try {
                const parsed = JSON.parse(data)
                if (Array.isArray(parsed)) return parsed
                return parsed ? [parsed] : []
              } catch {
                return []
              }
            })()
          : data
            ? [data]
            : []
      if (nodeList.length) {
        setNodes(nodeList)
        if (!preserveNodeId) {
          setNodeId((prev) => (
            prev && nodeList.some((node) => String(node.id) === String(prev))
              ? prev
              : nodeList[0].id
          ))
        }
        return nodeList
      }
      if (preserveNodeId) {
        setNodes([])
        return []
      }
      if (createIfEmpty) {
        const { data: node } = await adminApi.createNode({ course_id: selectedCourseId, title: 'Module 1', order: 0 })
        setNodes([node])
        setNodeId(node.id)
        return [node]
      }
      setNodes([])
      setNodeId('')
      return []
    } catch {
      setNodes([])
      if (!preserveNodeId) setNodeId('')
      return []
    }
  }

  const loadAssignedSessions = useCallback(async (targetExamId = examId) => {
    if (!targetExamId) {
      setAssignedSessions([])
      setSelectedUsers([])
      setAccessMode('OPEN')
      setScheduledAt('')
      return
    }
    try {
      const { data } = await adminApi.schedules({ params: { exam_id: targetExamId } })
      const examSchedules = readPaginatedItems(data)
      const nextAssigned = examSchedules.map((schedule) => ({
        id: schedule.id,
        userId: schedule.user_id,
        user: schedule.user_student_id || schedule.user_name || String(schedule.user_id).slice(0, 8),
        mode: schedule.access_mode || 'OPEN',
        at: schedule.scheduled_at || '',
      }))
      setAssignedSessions(nextAssigned)
      setSelectedUsers(examSchedules.map((schedule) => String(schedule.user_id)))
      if (examSchedules.length > 0) {
        const firstSchedule = examSchedules[0]
        setAccessMode(firstSchedule.access_mode || 'OPEN')
        const sameScheduleTime = examSchedules.every((schedule) => String(schedule.scheduled_at || '') === String(firstSchedule.scheduled_at || ''))
        setScheduledAt(sameScheduleTime ? toDateTimeLocalValue(firstSchedule.scheduled_at) : '')
      } else {
        setAccessMode('OPEN')
        setScheduledAt('')
      }
    } catch {
      setAssignedSessions([])
      setSelectedUsers([])
    }
  }, [examId])

  const handleCreateCourseInline = async () => {
    if (!newCourseTitle.trim()) {
      setPanelError(t('admin_wizard_val_course_title_required'))
      return
    }
    setCreatingCourse(true)
    setPanelError('')
    try {
      const { data: course } = await adminApi.createCourse({
        title: newCourseTitle.trim(),
        description: newCourseDescription.trim() || null,
        status: 'DRAFT',
      })
      const { data: node } = await adminApi.createNode({
        course_id: course.id,
        title: newModuleTitle.trim() || 'Module 1',
        order: 0,
      })
      setCourses((current) => [...current, course])
      setCourseId(course.id)
      setNodes([node])
      setNodeId(node.id)
      setShowCourseCreator(false)
      setNewCourseTitle('')
      setNewCourseDescription('')
      setNewModuleTitle('Module 1')
    } catch (e) {
      setPanelError(formatApiErrorMessage(e, t('admin_wizard_val_course_create_failed')))
    } finally {
      setCreatingCourse(false)
    }
  }

  /* ─── Load lookups ─── */
  useEffect(() => {
    let cancelled = false

    const readSettledData = (result, fallback = []) => (
      result.status === 'fulfilled' ? (result.value?.data || fallback) : fallback
    )

    Promise.allSettled([
      adminApi.courses(),
      adminApi.categories(),
      adminApi.gradingScales(),
      adminApi.questionPools(),
      adminApi.learnersForScheduling({ is_active: true }),
      adminApi.examTemplates(),
    ]).then((results) => {
      if (cancelled) return
      const [courseRes, catRes, gsRes, poolRes, userRes, tplRes] = results
      const courseList = readSettledData(courseRes)
      setCourses(courseList)
      setCategories(readSettledData(catRes))
      setGradingScales(readSettledData(gsRes))
      setPools(readSettledData(poolRes))
      setUsers(readSettledData(userRes).filter((user) => user.role === 'LEARNER'))
      setExamTemplates(readSettledData(tplRes))

      if (courseList.length) {
        const first = courseList[0]
        setCourseId((current) => {
          if (current) return current
          void loadNodesForCourse(first.id, { createIfEmpty: true })
          return first.id
        })
      }

      const failedBootstrap = results.some((result) => result.status === 'rejected')
      if (failedBootstrap) {
        setPanelError((current) => current || t('admin_wizard_val_setup_partial'))
      }
    }).catch(() => {
      if (!cancelled) {
        setPanelError((current) => current || t('admin_wizard_val_setup_failed'))
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!nodes.length) return
    setNodeId((current) => (
      current && nodes.some((node) => String(node.id) === String(current))
        ? current
        : nodes[0].id
    ))
  }, [nodes])

  /* ─── Load existing exam for edit ─── */
  useEffect(() => {
    if (!editId) return
    setWizardReady(false)
    const testRequest = adminApi.getTest(editId).then(({ data: test }) => {
      if (!test) return
      setEditorLocked(test.status === 'ARCHIVED')
      setEditingPublishedTest(test.status === 'PUBLISHED')
      const runtimeSettings = test.runtime_settings || {}
      setTitle(test.name || '')
      setDescription(test.description || '')
      setExamCode(test.code || '')
      setExamType(test.type || 'MCQ')
      setCategoryId(test.category_id || '')
      setCourseId(test.course_id || '')
      setNodeId(test.node_id || '')
      if (test.course_id) {
        // preserveNodeId: this test already has a real node_id (fetched above);
        // don't let an owner-scoped, possibly-empty /nodes list overwrite it
        // or trigger creating a duplicate node under a course we may not own.
        loadNodesForCourse(test.course_id, { createIfEmpty: false, preserveNodeId: true })
      }
      setPassingScore(test.passing_score ?? 60)
      setMaxAttempts(test.attempts_allowed ?? 1)
      setGradingScaleId(test.grading_scale_id || '')
      updatePublishStatus(test.status === 'PUBLISHED' ? 'OPEN' : 'CLOSED')
      if (test.proctoring_config) setProctoring({ ...DEFAULT_PROCTORING_CONFIG, ...normalizeProctoringConfig(test.proctoring_config) })
      if (test.time_limit_minutes != null) {
        setUnlimitedTime(false)
        setTimeLimitMinutes(test.time_limit_minutes)
      } else {
        setUnlimitedTime(true)
      }
      setMethod(runtimeSettings.creation_method || 'manual')
      if (runtimeSettings.generator_config) {
        const g = runtimeSettings.generator_config
        if (g.strategy) setGeneratorBy(g.strategy)
        if (g.total_questions) setGeneratorCount(g.total_questions)
        if (g.difficulty_mix) setGeneratorDifficultyMix(g.difficulty_mix)
        if (g.categories) setGeneratorCategories(g.categories)
        if (g.pools) setGeneratorPools(g.pools)
        setGeneratorTagsInclude((g.include_tags || []).join(', '))
        setGeneratorTagsExclude((g.exclude_tags || []).join(', '))
        if (g.unique_per_candidate != null) setGeneratorUniquePerCandidate(!!g.unique_per_candidate)
        if (g.version_count) setGeneratorVersionCount(g.version_count)
        if (g.random_seed) setGeneratorRandomSeed(g.random_seed)
        if (g.prevent_question_reuse != null) setGeneratorPreventReuse(!!g.prevent_question_reuse)
        if (g.shuffle_answers != null) setGeneratorShuffleAnswers(!!g.shuffle_answers)
        if (g.adaptive != null) setGeneratorAdaptive(!!g.adaptive)
      }
      setPageFormat(runtimeSettings.page_format || 'one_per_page')
      setCalculatorType(runtimeSettings.calculator_type || 'none')
      setHideMetadata(!!runtimeSettings.hide_metadata)
      setRandomizeQuestions(!!runtimeSettings.randomize_questions)
      setRandomizeAnswers(!!runtimeSettings.randomize_answers)
      setShowProgressBar(runtimeSettings.show_progress_bar ?? true)
      setNegativeMarking(!!runtimeSettings.negative_marking)
      setNegMarkValue(runtimeSettings.neg_mark_value ?? 0.25)
      setNegMarkType(runtimeSettings.neg_mark_type || 'points')
      setShowFinalScore(runtimeSettings.show_final_score ?? true)
      setShowQuestionScores(!!runtimeSettings.show_question_scores)
      setSequentialSections(!!runtimeSettings.sequential_sections)
      setAllowRevisitSections(runtimeSettings.allow_revisit_sections ?? true)
      setSpecialAccommodations(runtimeSettings.special_accommodations || '')
      setSpecialRequests(runtimeSettings.special_requests || '')
      if (test.certificate) {
        setCertEnabled(true)
        setCertTemplate(test.certificate.template || 'Classic')
        setCertOrientation(test.certificate.orientation || 'landscape')
        setCertTitle(test.certificate.title || 'Certificate of Achievement')
        setCertSubtitle(test.certificate.subtitle || '')
        setCertCompany(test.certificate.issuer || '')
        setCertSigner(test.certificate.signer || 'Examiner')
        setCertDescription(test.certificate.description || 'This is to certify that the above named candidate has successfully completed the assessment.')
        setCertIssueRule(normalizeCertificateIssueRule(test.certificate.issue_rule))
      } else {
        setCertEnabled(false)
        setCertIssueRule(DEFAULT_CERTIFICATE_ISSUE_RULE)
      }
    }).catch(() => {})
    const questionRequest = adminApi.getQuestions(editId).then(({ data }) => setQuestions(data || [])).catch(() => {})
    Promise.allSettled([testRequest, questionRequest]).finally(() => {
      setWizardReady(true)
      setWizardBaselineVersion((current) => current + 1)
    })
  }, [editId, updatePublishStatus])

  useEffect(() => {
    loadAssignedSessions(examId)
  }, [examId, loadAssignedSessions])

  const applyTemplate = (tplId) => {
    const tpl = examTemplates.find(t => t.id === tplId)
    if (!tpl || !tpl.config) return
    const cfg = tpl.config
    setTitle(cfg.title || title)
    setDescription(cfg.description || description)
    if (cfg.exam_type) setExamType(cfg.exam_type)
    if (cfg.category_id) setCategoryId(cfg.category_id)
    if (cfg.time_limit_minutes != null) { setUnlimitedTime(false); setTimeLimitMinutes(cfg.time_limit_minutes) }
    if (cfg.max_attempts != null) setMaxAttempts(cfg.max_attempts)
    if (cfg.passing_score != null) setPassingScore(cfg.passing_score)
    if (cfg.proctoring_config) setProctoring({ ...DEFAULT_PROCTORING_CONFIG, ...normalizeProctoringConfig(cfg.proctoring_config) })
    if (cfg.settings) {
      setRandomizeQuestions(!!cfg.settings.randomize_questions)
      setRandomizeAnswers(!!cfg.settings.randomize_answers)
      setShowProgressBar(cfg.settings.show_progress_bar ?? showProgressBar)
      setSpecialAccommodations(cfg.settings.special_accommodations || '')
      setSpecialRequests(cfg.settings.special_requests || '')
      if (cfg.settings.creation_method) setMethod(cfg.settings.creation_method)
      if (cfg.settings.generator_config) {
        const g = cfg.settings.generator_config
        if (g.strategy) setGeneratorBy(g.strategy)
        if (g.total_questions) setGeneratorCount(g.total_questions)
        if (g.difficulty_mix) setGeneratorDifficultyMix(g.difficulty_mix)
        if (g.categories) setGeneratorCategories(g.categories)
        if (g.pools) setGeneratorPools(g.pools)
        if (g.include_tags) setGeneratorTagsInclude((g.include_tags || []).join(', '))
        if (g.exclude_tags) setGeneratorTagsExclude((g.exclude_tags || []).join(', '))
        if (g.unique_per_candidate != null) setGeneratorUniquePerCandidate(!!g.unique_per_candidate)
        if (g.version_count) setGeneratorVersionCount(g.version_count)
        if (g.random_seed) setGeneratorRandomSeed(g.random_seed)
        if (g.prevent_question_reuse != null) setGeneratorPreventReuse(!!g.prevent_question_reuse)
        if (g.shuffle_answers != null) setGeneratorShuffleAnswers(!!g.shuffle_answers)
        if (g.adaptive != null) setGeneratorAdaptive(!!g.adaptive)
      }
    }
    if (cfg.certificate) {
      setCertEnabled(true)
      setCertTemplate(cfg.certificate.template || certTemplate)
      setCertOrientation(cfg.certificate.orientation || certOrientation)
      setCertTitle(cfg.certificate.title || certTitle)
      setCertSubtitle(cfg.certificate.subtitle || certSubtitle)
      setCertCompany(cfg.certificate.issuer || certCompany)
      setCertSigner(cfg.certificate.signer || certSigner)
      setCertDescription(cfg.certificate.description || certDescription)
      setCertIssueRule(normalizeCertificateIssueRule(cfg.certificate.issue_rule))
    }
  }

  const runtimeSettings = useMemo(() => ({
      creation_method: method,
      generator_config: method === 'generator' ? {
        strategy: generatorBy,
        total_questions: generatorCount,
        difficulty_mix: generatorDifficultyMix,
        categories: generatorCategories,
        pools: generatorPools,
        include_tags: generatorTagsInclude.split(',').map(t => t.trim()).filter(Boolean),
        exclude_tags: generatorTagsExclude.split(',').map(t => t.trim()).filter(Boolean),
        unique_per_candidate: generatorUniquePerCandidate,
        version_count: generatorVersionCount,
        random_seed: generatorRandomSeed || null,
        prevent_question_reuse: generatorPreventReuse,
        shuffle_answers: generatorShuffleAnswers,
        adaptive: generatorAdaptive,
      } : null,
      page_format: pageFormat,
      calculator_type: calculatorType,
      hide_metadata: hideMetadata,
      randomize_questions: randomizeQuestions,
      randomize_answers: randomizeAnswers,
      show_progress_bar: showProgressBar,
      negative_marking: negativeMarking,
      neg_mark_value: negMarkValue,
      neg_mark_type: negMarkType,
      show_final_score: showFinalScore,
      show_question_scores: showQuestionScores,
      sequential_sections: sequentialSections,
      allow_revisit_sections: allowRevisitSections,
      special_accommodations: specialAccommodations,
      special_requests: specialRequests,
    }), [
      method,
      generatorBy,
      generatorCount,
      generatorDifficultyMix,
      generatorCategories,
      generatorPools,
      generatorTagsInclude,
      generatorTagsExclude,
      generatorUniquePerCandidate,
      generatorVersionCount,
      generatorRandomSeed,
      generatorPreventReuse,
      generatorShuffleAnswers,
      generatorAdaptive,
      pageFormat,
      calculatorType,
      hideMetadata,
      randomizeQuestions,
      randomizeAnswers,
      showProgressBar,
      negativeMarking,
      negMarkValue,
      negMarkType,
      showFinalScore,
      showQuestionScores,
      sequentialSections,
      allowRevisitSections,
      specialAccommodations,
      specialRequests,
    ])

  const certificatePayload = useMemo(() => (certEnabled ? {
      template: certTemplate,
      orientation: certOrientation,
      title: certTitle,
      subtitle: certSubtitle,
      issuer: certCompany,
      signer: certSigner,
      description: certDescription,
      issue_rule: certIssueRule,
    } : null), [
      certEnabled,
      certTemplate,
      certOrientation,
      certTitle,
      certSubtitle,
      certCompany,
      certSigner,
      certDescription,
      certIssueRule,
    ])

  const testPayload = useMemo(() => ({
    code: examCode || null,
    name: title,
    description,
    type: examType,
    node_id: nodeId || undefined,
    category_id: categoryId || undefined,
    grading_scale_id: gradingScaleId || undefined,
    time_limit_minutes: unlimitedTime ? null : timeLimitMinutes,
    attempts_allowed: maxAttempts,
    passing_score: passingScore,
    randomize_questions: randomizeQuestions,
    runtime_settings: runtimeSettings,
    proctoring_config: normalizeProctoringConfig(proctoring),
    certificate: certificatePayload,
  }), [
    examCode,
    title,
    description,
    examType,
    nodeId,
    categoryId,
    gradingScaleId,
    unlimitedTime,
    timeLimitMinutes,
    maxAttempts,
    passingScore,
    randomizeQuestions,
    runtimeSettings,
    proctoring,
    certificatePayload,
  ])

  const wizardSnapshot = useMemo(() => JSON.stringify({
    test: testPayload,
    schedule: {
      selectedUsers: [...selectedUsers].map((id) => String(id)).sort(),
      accessMode,
      scheduledAt,
    },
  }), [testPayload, selectedUsers, accessMode, scheduledAt])
  const wizardDirty = wizardReady && wizardBaselineRef.current !== '' && wizardSnapshot !== wizardBaselineRef.current

  useUnsavedChanges(wizardDirty && !saving && !exitingWizard)

  useEffect(() => {
    if (!wizardReady) return
    wizardBaselineRef.current = wizardSnapshot
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardReady, wizardBaselineVersion])

  const saveExam = useCallback(async () => {
    autosaveGenerationRef.current += 1
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
    if (saveExamInFlightRef.current) {
      return saveExamInFlightRef.current
    }

    const nextSave = (async () => {
      const data = testPayload
      let id = examId
      if (examId) {
        await adminApi.updateTest(examId, data)
      } else {
        const res = await adminApi.createTest(data)
        setExamId(res.data.id)
        id = res.data.id
      }
      setWizardBaselineVersion((current) => current + 1)
      return id
    })()

    saveExamInFlightRef.current = nextSave
    try {
      return await nextSave
    } finally {
      if (saveExamInFlightRef.current === nextSave) {
        saveExamInFlightRef.current = null
      }
    }
  }, [examId, testPayload])

  useEffect(() => {
    saveExamRef.current = saveExam
  }, [saveExam])

  const ensureExamCreated = useCallback(async () => {
    if (examId || saving) return examId
    setSaving(true)
    setQuestionInitError('')
    try {
      const newId = await saveExam()
      if (newId) {
        const { data } = await adminApi.getQuestions(newId)
        setQuestions(data || [])
      }
      return newId
    } catch (e) {
      setQuestionInitError(t('admin_wizard_val_create_test_failed'))
      return null
    } finally {
      setSaving(false)
    }
  }, [examId, saveExam, saving])

  useEffect(() => {
    if (step === 3 && !examId) {
      ensureExamCreated()
    }
  }, [step, examId, ensureExamCreated])

  const autoPersist = async () => {
    if (!examId || editorLocked) return
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    const autosaveGeneration = ++autosaveGenerationRef.current
    autosaveTimerRef.current = setTimeout(async () => {
      autosaveTimerRef.current = null
      if (autosaveGeneration !== autosaveGenerationRef.current) return
      if (autosavingRef.current || saveExamInFlightRef.current || savingRef.current) return
      autosavingRef.current = true
      try {
        await saveExamRef.current?.()
      } catch {
        setPanelError(t('admin_wizard_val_autosave_failed'))
      } finally {
        autosavingRef.current = false
      }
    }, 1500)
  }

  const handleNext = async () => {
    setPanelError('')
    if (editorLocked) {
      setPanelError(t('admin_wizard_val_locked'))
      return
    }
    if (step === 0 && courseId && !nodeId) {
      setSaving(true)
      try {
        const { data: node } = await adminApi.createNode({ course_id: courseId, title: 'Module 1', order: 0 })
        setNodes([node])
        setNodeId(node.id)
      } catch (e) {
        setPanelError(formatApiErrorMessage(e, t('admin_wizard_val_module_failed')))
      } finally {
        setSaving(false)
      }
      return
    }
    const validationMessage = validateStep(step)
    if (validationMessage) {
      setPanelError(validationMessage)
      return
    }
    // Save on important steps
    if ([0, 1, 2, 3, 4, 5].includes(step)) {
      let saveSucceeded = true
      setSaving(true)
      try {
        await saveExam()
      } catch (e) {
        saveSucceeded = false
        setPanelError(formatApiErrorMessage(e, t('admin_wizard_val_save_failed')))
      } finally {
        setSaving(false)
      }
      if (!saveSucceeded) return
    }
    startTransition(() => {
      setStep((current) => Math.min(STEPS.length - 1, current + 1))
    })
  }

  const handleSeedPool = async () => {
    if (!selectedPool || !examId) return
    const selectedPoolRecord = pools.find((pool) => String(pool.id) === String(selectedPool))
    if (selectedPoolRecord && Number(selectedPoolRecord.question_count || 0) < 1) {
      setPanelError(t('admin_wizard_val_pool_empty'))
      return
    }
    setPanelError('')
    try {
      await adminApi.seedExamFromPool(selectedPool, examId, seedCount)
      const { data } = await adminApi.getQuestions(examId)
      setQuestions(data || [])
    } catch (e) { setPanelError(formatApiErrorMessage(e, t('admin_wizard_val_pool_seed_failed'))) }
  }

  const handleAIGenerate = async () => {
    if (!aiTopic.trim()) {
      setPanelError(t('admin_wizard_val_ai_topic_required'))
      return
    }
    const ensuredId = await ensureExamCreated()
    if (!ensuredId) return
    setAiLoading(true)
    setPanelError('')
    try {
      const { data } = await generateQuestionsAI({
        topic: aiTopic,
        count: aiCount,
        difficulty: aiDifficulty === 'mixed' ? null : aiDifficulty,
        question_type: 'MCQ',
      })
      // Save generated questions to backend
      for (const [idx, q] of data.entries()) {
        await adminApi.addQuestion({
          exam_id: ensuredId,
          text: q.text,
          question_type: 'MCQ',
          options: q.options && q.options.length ? q.options : null,
          correct_answer: q.correct_answer || (q.options && q.options[0]) || '',
          order: questions.length + idx + 1,
          points: 1,
        })
      }
      const refreshed = await adminApi.getQuestions(ensuredId)
      setQuestions(refreshed.data || [])
    } catch (e) {
      setPanelError(formatApiErrorMessage(e, t('admin_wizard_val_ai_failed')))
    } finally {
      setAiLoading(false)
    }
  }

  const handleAssignSessions = async () => {
    if (!examId || (selectedUsers.length === 0 && assignedSessions.length === 0)) return
    if (accessMode === 'RESTRICTED' && !scheduledAt) {
      setPanelError(t('admin_wizard_val_schedule_required'))
      return
    }
    setPanelError('')
    setSessionBusy(true)
    try {
      // Refresh server state to avoid stale-data 409 conflicts
      let serverSchedules = []
      try {
        const { data: allSchedules } = await adminApi.schedules()
        serverSchedules = readPaginatedItems(allSchedules).filter((schedule) => String(schedule.exam_id) === String(examId))
      } catch {
        // Fall back to local state if the list call fails
        serverSchedules = []
      }
      const existingByUser = serverSchedules.length > 0
        ? new Map(serverSchedules.map((s) => [String(s.user_id), { id: s.id, at: s.scheduled_at, mode: s.access_mode }]))
        : new Map(assignedSessions.map((session) => [String(session.userId), session]))
      const selectedSet = new Set(selectedUsers.map((id) => String(id)))
      const staleEntries = serverSchedules.length > 0
        ? serverSchedules.filter((s) => !selectedSet.has(String(s.user_id)))
        : assignedSessions.filter((session) => !selectedSet.has(String(session.userId)))
      for (const stale of staleEntries) {
        try {
          await adminApi.deleteSchedule(stale.id)
        } catch (deleteErr) {
          if (deleteErr?.response?.status !== 404) {
            throw deleteErr
          }
        }
      }
      for (const uid of selectedUsers) {
        const existing = existingByUser.get(String(uid))
        const payload = {
          scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : (existing?.at || new Date().toISOString()),
          access_mode: accessMode || existing?.mode || 'OPEN',
          notes: null,
        }
        if (existing?.id) {
          try {
            await adminApi.updateSchedule(existing.id, payload)
          } catch (updateErr) {
            if (updateErr?.response?.status === 404) {
              await adminApi.createSchedule({
                user_id: uid,
                exam_id: examId,
                ...payload,
              })
            } else {
              throw updateErr
            }
          }
        } else {
          try {
            await adminApi.createSchedule({
              user_id: uid,
              exam_id: examId,
              ...payload,
            })
          } catch (createErr) {
            // If 409 conflict, the schedule already exists — try to update it
            if (createErr.response?.status === 409) {
              const { data: refreshed } = await adminApi.schedules()
              const match = readPaginatedItems(refreshed).find((schedule) => (
                String(schedule.user_id) === String(uid) && String(schedule.exam_id) === String(examId)
              ))
              if (match) {
                await adminApi.updateSchedule(match.id, payload)
              }
            } else {
              throw createErr
            }
          }
        }
      }
      await loadAssignedSessions(examId)
      setWizardBaselineVersion((current) => current + 1)
    } catch (e) {
      setPanelError(formatApiErrorMessage(e, t('admin_wizard_val_assign_failed')))
    } finally {
      setSessionBusy(false)
    }
  }

  const handleRemoveSession = async (sessionId, userId) => {
    setPanelError('')
    setSessionBusy(true)
    try {
      await adminApi.deleteSchedule(sessionId)
      const nextAssigned = assignedSessions.filter((session) => String(session.id) !== String(sessionId))
      setAssignedSessions(nextAssigned)
      setSelectedUsers((prev) => prev.filter((id) => String(id) !== String(userId)))
      if (nextAssigned.length > 0) {
        const firstSchedule = nextAssigned[0]
        setAccessMode(firstSchedule.mode || 'OPEN')
        const sameScheduleTime = nextAssigned.every((session) => String(session.at || '') === String(firstSchedule.at || ''))
        setScheduledAt(sameScheduleTime ? toDateTimeLocalValue(firstSchedule.at) : '')
      } else {
        setAccessMode('OPEN')
        setScheduledAt('')
      }
      setWizardBaselineVersion((current) => current + 1)
    } catch (e) {
      setPanelError(formatApiErrorMessage(e, t('admin_wizard_val_remove_failed')))
    } finally {
      setSessionBusy(false)
    }
  }

  const handlePublish = async () => {
    const targetPublishStatus = publishStatusRef.current
    if (editorLocked) {
      setPanelError(t('admin_wizard_val_locked'))
      return
    }
    if (targetPublishStatus === 'OPEN') {
      const publishGateSteps = [0, 1, 2, 4, 5, 7]
      for (const gateStep of publishGateSteps) {
        const validationMessage = validateStep(gateStep, { forPublish: true })
        if (validationMessage) {
          goToStep(gateStep)
          setPanelError(validationMessage)
          return
        }
      }
    }
    setSaving(true)
    try {
      const id = await saveExam()
      if (targetPublishStatus === 'OPEN') {
        await adminApi.publishTest(id)
      }
      flushSync(() => {
        setExitingWizard(true)
      })
      navigate('/admin/tests', { replace: true, state: { bypassUnsavedChanges: true } })
    } catch (e) { setPanelError(formatApiErrorMessage(e, t('admin_wizard_val_publish_failed'))) } finally { setSaving(false) }
  }

  const toggleDetector = (key) => {
    setProctoring((prev) => ({ ...prev, [key]: !prev[key] }))
    if (examId) autoPersist()
  }
  const addAlertRule = () => {
    setProctoring((prev) => ({ ...prev, alert_rules: [...(prev.alert_rules || []), createAlertRule()] }))
    if (examId) autoPersist()
  }
  const updateAlertRule = (ruleId, key, rawValue) => {
    setProctoring((prev) => ({
      ...prev,
      alert_rules: (prev.alert_rules || []).map((rule) => (
        rule.id === ruleId
          ? {
              ...rule,
              [key]: key === 'threshold' ? Math.max(1, Number.parseInt(rawValue, 10) || 1) : rawValue,
            }
          : rule
      )),
    }))
    if (examId) autoPersist()
  }
  const removeAlertRule = (ruleId) => {
    setProctoring((prev) => ({
      ...prev,
      alert_rules: (prev.alert_rules || []).filter((rule) => rule.id !== ruleId),
    }))
    if (examId) autoPersist()
  }
  const updateProctoringFlag = (key, checked) => {
    setProctoring((prev) => ({ ...prev, [key]: checked }))
    if (examId) autoPersist()
  }
  const updateProctoringNumber = (key, rawValue, { integer = false } = {}) => {
    const nextValue = integer ? Number.parseInt(rawValue, 10) : Number.parseFloat(rawValue)
    if (!Number.isFinite(nextValue)) return
    setProctoring((prev) => ({ ...prev, [key]: nextValue }))
    if (examId) autoPersist()
  }
  const applyProctoringPreset = (mode) => {
    const presetValues = {
      lenient: {
        eye_deviation_deg: 16,
        eye_consecutive: 7,
        head_pose_yaw_deg: 26,
        head_pose_pitch_deg: 24,
        head_pose_consecutive: 7,
        mouth_open_threshold: 0.45,
        audio_rms_threshold: 0.12,
        audio_consecutive_chunks: 3,
        audio_speech_consecutive_chunks: 3,
        audio_speech_min_rms: 0.04,
        audio_speech_baseline_multiplier: 1.5,
        max_face_absence_sec: 6,
        max_tab_blurs: 5,
        max_alerts_before_autosubmit: 10,
        max_score_before_autosubmit: 20,
        frame_interval_ms: 2400,
        audio_chunk_ms: 4000,
        screenshot_interval_sec: 90,
        lighting_min_score: 0.28,
        face_verify_id_threshold: 0.60,
        face_verify_threshold: 0.2,
        object_confidence_threshold: 0.45,
        multi_face_min_area_ratio: 0.012,
        camera_cover_hard_luma: 16,
        camera_cover_soft_luma: 34,
        camera_cover_stddev_max: 14,
        camera_cover_hard_consecutive_frames: 2,
        camera_cover_soft_consecutive_frames: 3,
      },
      standard: {
        eye_deviation_deg: 12,
        eye_consecutive: 5,
        head_pose_yaw_deg: 20,
        head_pose_pitch_deg: 20,
        head_pose_consecutive: 5,
        mouth_open_threshold: 0.35,
        audio_rms_threshold: 0.08,
        audio_consecutive_chunks: 2,
        audio_speech_consecutive_chunks: 2,
        audio_speech_min_rms: 0.03,
        audio_speech_baseline_multiplier: 1.35,
        max_face_absence_sec: 1.5,
        max_tab_blurs: 3,
        max_alerts_before_autosubmit: 5,
        max_score_before_autosubmit: 15,
        frame_interval_ms: 900,
        audio_chunk_ms: 2000,
        screenshot_interval_sec: 60,
        lighting_min_score: 0.35,
        face_verify_id_threshold: 0.55,
        face_verify_threshold: 0.15,
        object_confidence_threshold: 0.35,
        multi_face_min_area_ratio: 0.008,
        camera_cover_hard_luma: 20,
        camera_cover_soft_luma: 40,
        camera_cover_stddev_max: 16,
        camera_cover_hard_consecutive_frames: 1,
        camera_cover_soft_consecutive_frames: 2,
      },
      strict: {
        eye_deviation_deg: 8,
        eye_consecutive: 3,
        head_pose_yaw_deg: 14,
        head_pose_pitch_deg: 14,
        head_pose_consecutive: 3,
        mouth_open_threshold: 0.22,
        audio_rms_threshold: 0.05,
        audio_consecutive_chunks: 1,
        audio_speech_consecutive_chunks: 1,
        audio_speech_min_rms: 0.025,
        audio_speech_baseline_multiplier: 1.2,
        max_face_absence_sec: 1,
        max_tab_blurs: 1,
        max_alerts_before_autosubmit: 3,
        max_score_before_autosubmit: 9,
        frame_interval_ms: 750,
        audio_chunk_ms: 2000,
        screenshot_interval_sec: 30,
        lighting_min_score: 0.45,
        face_verify_id_threshold: 0.45,
        face_verify_threshold: 0.1,
        object_confidence_threshold: 0.25,
        multi_face_min_area_ratio: 0.006,
        camera_cover_hard_luma: 24,
        camera_cover_soft_luma: 46,
        camera_cover_stddev_max: 18,
        camera_cover_hard_consecutive_frames: 1,
        camera_cover_soft_consecutive_frames: 1,
        screen_capture: true,
      },
    }
    setProctoring((prev) => ({ ...prev, ...(presetValues[mode] || {}) }))
    if (examId) autoPersist()
  }
  const mergeLearnerSelection = (incomingIds) => {
    setSelectedUsers((prev) => {
      const merged = new Map(prev.map((id) => [String(id), id]))
      incomingIds.forEach((id) => {
        merged.set(String(id), String(id))
      })
      return Array.from(merged.values())
    })
  }
  const toggleUser = (uid) => {
    setBulkLearnerFeedback('')
    setSelectedUsers((prev) => (
      prev.some((id) => String(id) === String(uid))
        ? prev.filter((id) => String(id) !== String(uid))
        : [...prev, String(uid)]
    ))
  }

  const filteredUsers = users.filter(u =>
    !userSearch || u.user_id?.toLowerCase().includes(userSearch.toLowerCase()) || u.name?.toLowerCase().includes(userSearch.toLowerCase())
  )
  const selectedLearnerKeys = new Set(selectedUsers.map((id) => String(id)))
  const totalLearners = users.length
  const selectedVisibleLearners = filteredUsers.filter((user) => selectedLearnerKeys.has(String(user.id))).length
  const allLearnersSelected = totalLearners > 0 && users.every((user) => selectedLearnerKeys.has(String(user.id)))
  const allVisibleLearnersSelected = filteredUsers.length > 0 && filteredUsers.every((user) => selectedLearnerKeys.has(String(user.id)))
  const sessionRequiresSchedule = accessMode === 'RESTRICTED'
  const selectedSessionUserIds = useMemo(
    () => [...selectedUsers].map((id) => String(id)).sort(),
    [selectedUsers],
  )
  const assignedSessionUserIds = useMemo(
    () => assignedSessions.map((session) => String(session.userId)).sort(),
    [assignedSessions],
  )
  const normalizedScheduledAt = useMemo(
    () => normalizeScheduleComparisonValue(scheduledAt),
    [scheduledAt],
  )
  const hasPendingSessionChanges = useMemo(() => {
    if (selectedSessionUserIds.length !== assignedSessionUserIds.length) return true
    if (selectedSessionUserIds.some((id, index) => id !== assignedSessionUserIds[index])) return true
    if (selectedSessionUserIds.length === 0) return false
    return assignedSessions.some((session) => {
      if (!selectedLearnerKeys.has(String(session.userId))) return true
      if (String(session.mode || 'OPEN') !== String(accessMode || 'OPEN')) return true
      if (!sessionRequiresSchedule) return false
      return normalizeScheduleComparisonValue(session.at) !== normalizedScheduledAt
    })
  }, [
    accessMode,
    assignedSessionUserIds,
    assignedSessions,
    normalizedScheduledAt,
    selectedLearnerKeys,
    selectedSessionUserIds,
    sessionRequiresSchedule,
  ])
  const canSaveAssignments = !sessionBusy
    && (selectedUsers.length > 0 || assignedSessions.length > 0)
    && (!sessionRequiresSchedule || Boolean(scheduledAt))
  const fmtDateTime = (v) => (v ? new Date(v).toLocaleString() : '-')
  const generatorMixTotal = Object.values(generatorDifficultyMix).reduce((sum, value) => sum + Number(value || 0), 0)
  const activeDetectorCount = DETECTORS.filter(({ key }) => Boolean(proctoring[key])).length
  const alertRuleCount = Array.isArray(proctoring.alert_rules) ? proctoring.alert_rules.length : 0
  const enabledProctoringChecks = Object.entries(proctoring)
    .filter(([, value]) => typeof value === 'boolean' && value)
    .map(([key]) => humanizeSettingLabel(key))

  const validateStep = (targetStep, { forPublish = false } = {}) => {
    if (targetStep === 0) {
      if (!title.trim()) return t('admin_wizard_val_test_name_required')
      if (examCode.trim() && (examCode.trim().length < 6 || examCode.trim().length > 12)) {
        return t('admin_wizard_val_code_length')
      }
      if (courseId && !nodeId) return t('admin_wizard_val_select_module')
    }
    if (targetStep === 1 && method === 'generator') {
      if (!generatorCount || Number(generatorCount) < 1) return t('admin_wizard_val_generator_count')
      if (generatorMixTotal !== 100) return t('admin_wizard_val_generator_mix')
    }
    if (targetStep === 2) {
      if (!unlimitedTime && (!Number.isFinite(Number(timeLimitMinutes)) || Number(timeLimitMinutes) <= 0)) {
        return t('admin_wizard_val_time_limit')
      }
    }
    if (targetStep === 4) {
      if (!Number.isFinite(Number(passingScore)) || Number(passingScore) < 0 || Number(passingScore) > 100) {
        return t('admin_wizard_val_passing_score')
      }
      if (!Number.isFinite(Number(maxAttempts)) || Number(maxAttempts) < 1) {
        return t('admin_wizard_val_max_attempts')
      }
      if (negativeMarking && (!Number.isFinite(Number(negMarkValue)) || Number(negMarkValue) < 0)) {
        return t('admin_wizard_val_neg_marking')
      }
    }
    if (targetStep === 5 && certEnabled) {
      if (!certTitle.trim()) return t('admin_wizard_val_cert_title')
      if (!certSigner.trim()) return t('admin_wizard_val_cert_signer')
    }
    if (targetStep === 7 && accessMode === 'RESTRICTED' && selectedUsers.length > 0 && !scheduledAt) {
      return t('admin_wizard_val_restricted_schedule')
    }
    if (targetStep === 7 && hasPendingSessionChanges) {
      return t('admin_wizard_val_save_assignments')
    }
    if (forPublish && questions.length === 0) {
      return t('admin_wizard_val_add_question')
    }
    return ''
  }

  const selectedPoolRecord = pools.find((pool) => String(pool.id) === String(selectedPool))
  const selectedPoolCount = Number(selectedPoolRecord?.question_count || 0)

  const infoReady = Boolean(title.trim() && (!courseId || nodeId))
  const settingsReady = Boolean(unlimitedTime || (Number.isFinite(Number(timeLimitMinutes)) && Number(timeLimitMinutes) > 0))
  const gradingReady = Boolean(
    Number.isFinite(Number(passingScore))
    && Number(passingScore) >= 0
    && Number(passingScore) <= 100
    && Number.isFinite(Number(maxAttempts))
    && Number(maxAttempts) >= 1
  )
  const certificatesReady = !certEnabled || Boolean(certTitle.trim() && certSigner.trim())
  const currentStepValidation = validateStep(step)
  const nextDisabled = (step === 0 && !title.trim())
    || saving
    || editorLocked
    || (step === 7 && (sessionBusy || Boolean(currentStepValidation)))
  const cycleOverviewCards = [
    {
      label: t('admin_wizard_card_current_step'),
      value: `${step + 1} / ${STEPS.length}`,
      helper: currentStepValidation || t('admin_wizard_card_ready'),
      tone: currentStepValidation ? 'attention' : 'ready',
    },
    {
      label: t('admin_wizard_card_questions'),
      value: String(questions.length),
      helper: questions.length > 0 ? `${method === 'generator' ? t('admin_wizard_card_gen_ready') : t('admin_wizard_card_manual_ready')} ${t('admin_wizard_card_question_bank_ready')}` : t('admin_wizard_card_questions_needed'),
      tone: questions.length > 0 ? 'ready' : 'attention',
    },
    {
      label: t('admin_wizard_card_sessions'),
      value: String(assignedSessions.length),
      helper: assignedSessions.length > 0 ? `${accessMode === 'RESTRICTED' ? t('admin_wizard_card_restricted_saved') : t('admin_wizard_card_open_saved')}` : t('admin_wizard_card_no_learners'),
      tone: assignedSessions.length > 0 ? 'ready' : 'info',
    },
    {
      label: t('admin_wizard_card_proctoring'),
      value: `${activeDetectorCount} ${t('admin_wizard_card_checks')}`,
      helper: `${t('admin_wizard_card_fullscreen')} ${proctoring.fullscreen_enforce ? t('admin_wizard_card_on') : t('admin_wizard_card_off')} | ${t('admin_wizard_card_tabs')} ${proctoring.tab_switch_detect ? t('admin_wizard_card_tracked') : t('admin_wizard_card_not_tracked')} | ${t('admin_wizard_card_rules')} ${alertRuleCount}`,
      tone: activeDetectorCount > 0 ? 'ready' : 'attention',
    },
    {
      label: t('admin_wizard_card_readiness'),
      value: infoReady && settingsReady && gradingReady && certificatesReady ? t('admin_wizard_card_healthy') : t('admin_wizard_card_needs_review'),
      helper: `${infoReady ? t('admin_wizard_card_info_ok') : t('admin_wizard_card_info_missing')} | ${settingsReady ? t('admin_wizard_card_settings_ok') : t('admin_wizard_card_settings_missing')} | ${gradingReady ? t('admin_wizard_card_grading_ok') : t('admin_wizard_card_grading_missing')}`,
      tone: infoReady && settingsReady && gradingReady && certificatesReady ? 'ready' : 'attention',
    },
  ]

  const reviewSections = [
    {
      key: 'information',
      title: t('admin_wizard_review_information'),
      editStep: 0,
      items: [
        [t('admin_wizard_review_test_title'), title || '-'],
        [t('admin_wizard_review_description'), description || t('admin_wizard_review_none')],
        [t('admin_wizard_review_category'), categories.find((category) => category.id === categoryId)?.name || t('admin_wizard_review_none')],
        [t('admin_wizard_review_course'), courses.find((course) => String(course.id) === String(courseId))?.title || t('admin_wizard_review_none')],
        [t('admin_wizard_review_module'), nodes.find((node) => String(node.id) === String(nodeId))?.title || t('admin_wizard_review_none')],
        [t('admin_wizard_review_code'), examCode || t('admin_wizard_review_auto_generated')],
      ],
    },
    {
      key: 'question-design',
      title: t('admin_wizard_review_question_design'),
      editStep: 1,
      items: [
        [t('admin_wizard_review_creation_method'), method === 'manual' ? t('admin_wizard_review_manual_selection') : `${t('admin_wizard_review_generator')} (${generatorBy})`],
        ...(method === 'generator'
          ? [
              [t('admin_wizard_review_total_questions'), generatorCount],
              [t('admin_wizard_review_difficulty_mix'), `${generatorDifficultyMix.easy}% ${t('admin_wizard_review_easy')} | ${generatorDifficultyMix.medium}% ${t('admin_wizard_review_medium')} | ${generatorDifficultyMix.hard}% ${t('admin_wizard_review_hard')}`],
              [t('admin_wizard_review_gen_categories'), generatorCategories.length ? String(generatorCategories.length) : t('admin_wizard_review_all')],
              [t('admin_wizard_review_gen_pools'), generatorPools.length ? String(generatorPools.length) : t('admin_wizard_review_all')],
              [t('admin_wizard_review_tags_include'), generatorTagsInclude || t('admin_wizard_review_none')],
              [t('admin_wizard_review_tags_exclude'), generatorTagsExclude || t('admin_wizard_review_none')],
            ]
          : [
              [t('admin_wizard_review_question_bank'), `${questions.length} ${t('admin_wizard_review_questions_authored')}`],
              [t('admin_wizard_review_seed_pool'), selectedPoolRecord ? `${selectedPoolRecord.name} (${selectedPoolCount} question${selectedPoolCount === 1 ? '' : 's'})` : t('admin_wizard_review_none')],
            ]),
      ],
    },
    {
      key: 'delivery',
      title: t('admin_wizard_review_delivery'),
      editStep: 2,
      items: [
        [t('admin_wizard_review_question_type'), examType],
        [t('admin_wizard_review_page_format'), pageFormat],
        [t('admin_wizard_review_calculator'), calculatorType],
        [t('admin_wizard_review_time_limit'), unlimitedTime ? t('admin_wizard_review_unlimited') : `${timeLimitMinutes} ${t('admin_wizard_review_minutes')}`],
        [t('admin_wizard_review_randomize_q'), randomizeQuestions ? t('admin_wizard_review_yes') : t('admin_wizard_review_no')],
        [t('admin_wizard_review_randomize_a'), randomizeAnswers ? t('admin_wizard_review_yes') : t('admin_wizard_review_no')],
        [t('admin_wizard_review_show_progress'), showProgressBar ? t('admin_wizard_review_yes') : t('admin_wizard_review_no')],
        [t('admin_wizard_review_proctoring_checks'), enabledProctoringChecks.join(', ') || t('admin_wizard_review_none')],
        [t('admin_wizard_review_alert_rules'), alertRuleCount > 0 ? proctoring.alert_rules.map((rule) => describeAlertRule(rule, t)).join(' | ') : t('admin_wizard_review_none')],
        [t('admin_wizard_review_special_acc'), specialAccommodations || t('admin_wizard_review_none')],
        [t('admin_wizard_review_special_req'), specialRequests || t('admin_wizard_review_none')],
      ],
    },
    {
      key: 'grading',
      title: t('admin_wizard_review_scoring'),
      editStep: 4,
      items: [
        [t('admin_wizard_review_passing_score'), `${passingScore}%`],
        [t('admin_wizard_review_max_attempts'), maxAttempts],
        [t('admin_wizard_review_grading_scale'), gradingScales.find((gradingScale) => gradingScale.id === gradingScaleId)?.name || t('admin_wizard_review_none')],
        [t('admin_wizard_review_neg_marking'), negativeMarking ? `${t('admin_wizard_review_yes')} (${negMarkValue} ${negMarkType})` : t('admin_wizard_review_no')],
        [t('admin_wizard_review_show_final'), showFinalScore ? t('admin_wizard_review_yes') : t('admin_wizard_review_no')],
        [t('admin_wizard_review_show_question'), showQuestionScores ? t('admin_wizard_review_yes') : t('admin_wizard_review_no')],
      ],
    },
    {
      key: 'certificates',
      title: t('admin_wizard_review_certificates'),
      editStep: 5,
      items: [
        [t('admin_wizard_review_certificate'), certEnabled ? `${certTemplate} (${certOrientation})` : t('admin_wizard_review_disabled')],
        [t('admin_wizard_review_issue_rule'), certEnabled ? t(certificateIssueRuleLabelKey(certIssueRule)) : t('admin_wizard_review_disabled')],
        [t('admin_wizard_review_cert_title'), certEnabled ? certTitle || t('admin_wizard_review_none') : t('admin_wizard_review_disabled')],
        [t('admin_wizard_review_subtitle'), certEnabled ? certSubtitle || t('admin_wizard_review_none') : t('admin_wizard_review_disabled')],
        [t('admin_wizard_review_issuer'), certEnabled ? certCompany || t('admin_wizard_review_none') : t('admin_wizard_review_disabled')],
        [t('admin_wizard_review_signer'), certEnabled ? certSigner || t('admin_wizard_review_none') : t('admin_wizard_review_disabled')],
      ],
    },
    {
      key: 'readiness',
      title: t('admin_wizard_review_final_readiness'),
      editStep: 3,
      items: [
        [t('admin_wizard_review_questions_authored_count'), `${questions.length} ${t('admin_wizard_review_questions_count')}`],
        [t('admin_wizard_review_ready_publish'), questions.length > 0 ? t('admin_wizard_review_yes') : t('admin_wizard_review_add_first')],
        [t('admin_wizard_review_sessions_assigned'), `${assignedSessions.length} ${t('admin_wizard_review_sessions_count')}`],
        [t('admin_wizard_review_next_phase'), t('admin_wizard_review_next_phase_desc')],
      ],
    },
  ]

  useEffect(() => () => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
  }, [])

  const handleSelectAllLearners = () => {
    if (users.length === 0) {
      setBulkLearnerFeedback(t('admin_wizard_val_no_learners'))
      return
    }
    setPanelError('')
    setBulkLearnerFeedback(`${t('admin_wizard_selected_all')} ${users.length} learner${users.length === 1 ? '' : 's'}.`)
    setSelectedUsers(users.map((user) => String(user.id)))
  }

  const handleSelectVisibleLearners = () => {
    if (filteredUsers.length === 0) {
      setBulkLearnerFeedback(t('admin_wizard_val_no_search_match'))
      return
    }
    setPanelError('')
    mergeLearnerSelection(filteredUsers.map((user) => String(user.id)))
    setBulkLearnerFeedback(`${t('admin_wizard_matched')} ${filteredUsers.length} learner${filteredUsers.length === 1 ? '' : 's'} ${t('admin_wizard_selected_from_filtered')}`)
  }

  const handleClearLearnerSelection = () => {
    setPanelError('')
    setSelectedUsers([])
    setBulkLearnerFeedback(t('admin_wizard_cleared_selection'))
  }

  const handleBulkLearnerMatch = () => {
    const tokens = Array.from(new Set(
      bulkLearnerInput
        .split(/[\n,;]+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ))
    if (tokens.length === 0) {
      setBulkLearnerFeedback(t('admin_wizard_val_paste_first'))
      return
    }

    const matchedLearners = users.filter((user) => {
      const keys = [user.id, user.user_id, user.email]
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
      return tokens.some((token) => keys.includes(token))
    })
    if (matchedLearners.length === 0) {
      setPanelError(t('admin_wizard_val_no_learners_match'))
      setBulkLearnerFeedback(`${t('admin_wizard_matched')} 0 ${t('admin_wizard_matched_of')} ${tokens.length} ${t('admin_wizard_entries')}`)
      return
    }

    setPanelError('')
    mergeLearnerSelection(matchedLearners.map((user) => user.id))
    const matchedKeys = new Set()
    matchedLearners.forEach((user) => {
      ;[user.id, user.user_id, user.email]
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
        .forEach((value) => matchedKeys.add(value))
    })
    const unmatchedCount = tokens.filter((token) => !matchedKeys.has(token)).length
    setBulkLearnerFeedback(
      `${t('admin_wizard_matched')} ${matchedLearners.length} learner${matchedLearners.length === 1 ? '' : 's'}`
      + (unmatchedCount > 0 ? `, ${unmatchedCount} ${unmatchedCount === 1 ? t('admin_wizard_entry_not_found') : t('admin_wizard_entries_not_found')}` : '.'),
    )
  }

  useEffect(() => {
    if (step !== 2 || !examId) return
    let cancelled = false
    setProctoringLoading(true)
    Promise.all([adminApi.attempts({ exam_id: examId, skip: 0, limit: 200 }), adminApi.schedules()])
      .then(([attemptsRes, schedulesRes]) => {
        if (cancelled) return
        const attempts = readPaginatedItems(attemptsRes.data)
        const sessions = (schedulesRes.data || []).filter((s) => String(s.exam_id) === String(examId))
        setProctoringSessions(sessions)

        const schedulesByUser = new Map()
        sessions.forEach((s) => schedulesByUser.set(String(s.user_id), s))

        const rows = attempts.map((a) => {
          const fallbackUser = users.find((u) => String(u.id) === String(a.user_id))
          const session = schedulesByUser.get(String(a.user_id))
          return {
            id: String(a.id),
            attemptId: String(a.id).slice(0, 8),
            username: a.user?.user_id || fallbackUser?.user_id || fallbackUser?.name || String(a.user_id).slice(0, 8),
            sessionName: session ? `Session ${String(session.id).slice(0, 6)}` : '-',
            status: a.status || '-',
            startedAt: a.started_at,
            userGroup: '-',
            comment: a.status === 'GRADED' ? t('admin_wizard_reviewed') : '',
            proctorRate: '-',
            sessionId: session?.id || '',
          }
        })
        setProctoringRows(rows)
      })
      .catch(() => {
        if (!cancelled) {
          setProctoringSessions([])
          setProctoringRows([])
        }
      })
      .finally(() => {
        if (!cancelled) setProctoringLoading(false)
      })
    return () => { cancelled = true }
  }, [step, examId, users])

  const [proctoringRowBusy, setProctoringRowBusy] = useState({})
  const [proctoringBulkBusy, setProctoringBulkBusy] = useState(false)

  const handleProctoringPauseResume = async (row) => {
    setProctoringRowBusy((prev) => ({ ...prev, [row.id]: true }))
    try {
      if (row.paused) await adminApi.resumeAttempt(row.id)
      else await adminApi.pauseAttempt(row.id)
      // Refresh rows
      const { data: attempts } = await adminApi.attempts({ exam_id: examId, skip: 0, limit: 200 })
      const filtered = readPaginatedItems(attempts)
      setProctoringRows((prev) => prev.map((r) => {
        const updated = filtered.find((a) => String(a.id) === r.id)
        return updated ? { ...r, status: updated.status, paused: row.paused ? false : true } : r
      }))
    } catch { /* silent */ }
    finally { setProctoringRowBusy((prev) => ({ ...prev, [row.id]: false })) }
  }

  const handleProctoringBulkPause = async (toPause) => {
    if (!filteredProctoringRows.length) return
    setProctoringBulkBusy(true)
    try {
      for (const r of filteredProctoringRows) {
        if (toPause && !r.paused) await adminApi.pauseAttempt(r.id)
        if (!toPause && r.paused) await adminApi.resumeAttempt(r.id)
      }
      const { data: attempts } = await adminApi.attempts({ exam_id: examId, skip: 0, limit: 200 })
      const filtered = readPaginatedItems(attempts)
      setProctoringRows((prev) => prev.map((r) => {
        const updated = filtered.find((a) => String(a.id) === r.id)
        return updated ? { ...r, status: updated.status } : r
      }))
    } catch { /* silent */ }
    finally { setProctoringBulkBusy(false) }
  }

  const filteredProctoringRows = proctoringRows.filter((row) => {
    if (proctoringSessionId && String(row.sessionId) !== String(proctoringSessionId)) return false
    if (proctoringSearch.attemptId && !row.attemptId.toLowerCase().includes(proctoringSearch.attemptId.toLowerCase())) return false
    if (proctoringSearch.username && !row.username.toLowerCase().includes(proctoringSearch.username.toLowerCase())) return false
    if (proctoringSearch.sessionName && !row.sessionName.toLowerCase().includes(proctoringSearch.sessionName.toLowerCase())) return false
    if (proctoringSearch.status && row.status !== proctoringSearch.status) return false
    if (proctoringSearch.userGroup && !row.userGroup.toLowerCase().includes(proctoringSearch.userGroup.toLowerCase())) return false
    if (proctoringSearch.comment && !row.comment.toLowerCase().includes(proctoringSearch.comment.toLowerCase())) return false
    return true
  })

  const renderStep = () => {
    switch (step) {
      case 0: return (
        <>
          <h3 className={styles.panelTitle}>{t('admin_wizard_test_information')}</h3>
          {examTemplates.length > 0 && (
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="wizard-template">{t('admin_wizard_start_template')}</label>
              <div className={styles.templateRow}>
                <select id="wizard-template" className={styles.select} value={selectedTemplate} onChange={e => setSelectedTemplate(e.target.value)}>
                  <option value="">{t('admin_wizard_select_template')}</option>
                  {examTemplates.map(tpl => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
                </select>
                <button className={styles.btnSecondary} type="button" disabled={!selectedTemplate} onClick={() => applyTemplate(selectedTemplate)}>{t('admin_wizard_apply')}</button>
              </div>
            </div>
          )}
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="wizard-title">{t('admin_wizard_test_name')} <span className={styles.requiredMark}>*</span></label>
            <input id="wizard-title" name="title" className={styles.input} value={title} onChange={e => setTitle(e.target.value)} placeholder={t('admin_wizard_test_name_placeholder')} />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="wizard-description">{t('admin_wizard_description_label')}</label>
            <textarea id="wizard-description" name="description" className={styles.textarea} value={description} onChange={e => setDescription(e.target.value)} rows={4} placeholder={t('admin_wizard_description_placeholder')} />
          </div>
          <div className={styles.inputRow}>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="wizard-course">{t('admin_wizard_course_label')}</label>
              <select
                id="wizard-course"
                name="course"
                className={styles.select}
                value={courseId}
                onChange={e => {
                  const nextCourseId = e.target.value
                  setCourseId(nextCourseId)
                  setNodeId('')
                  loadNodesForCourse(nextCourseId, { createIfEmpty: true })
                }}
              >
                <option value="">{t('admin_wizard_select_course')}</option>
                {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
              <div className={styles.inlineActions}>
                <button className={styles.btnSecondary} type="button" onClick={() => setShowCourseCreator((current) => !current)}>
                  {showCourseCreator ? t('admin_wizard_cancel_new_course') : t('admin_wizard_create_course')}
                </button>
              </div>
              {!courses.length && <p className={styles.helper}>{t('admin_wizard_no_courses_hint')}</p>}
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="wizard-node">{t('admin_wizard_module_label')}</label>
              <select id="wizard-node" name="node" className={styles.select} value={nodeId} onChange={e => setNodeId(e.target.value)} disabled={!courseId}>
                <option value="">{t('admin_wizard_select_module')}</option>
                {nodes.map(n => <option key={n.id} value={n.id}>{n.title}</option>)}
              </select>
              {!nodes.length && courseId && <p className={styles.helper}>{t('admin_wizard_no_modules_hint')}</p>}
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="wizard-exam-code">{t('admin_wizard_external_code')}</label>
              <input id="wizard-exam-code" name="exam_code" className={styles.input} value={examCode} onChange={e => setExamCode(e.target.value)} placeholder={t('admin_wizard_code_placeholder')} />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="wizard-category">{t('admin_wizard_category_label')}</label>
              <select id="wizard-category" name="category" className={styles.select} value={categoryId} onChange={e => setCategoryId(e.target.value)}>
                <option value="">{t('admin_wizard_no_category')}</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
          {showCourseCreator && (
            <div className={styles.inlineCard}>
              <div className={styles.inlineCardHead}>
                <div>
                  <div className={styles.label}>{t('admin_wizard_create_course_inline')}</div>
                  <div className={styles.helper}>{t('admin_wizard_create_course_hint')}</div>
                </div>
              </div>
              <div className={styles.inputRow}>
                <div className={styles.formGroup}>
                  <label className={styles.label} htmlFor="wizard-new-course-title">{t('admin_wizard_course_title')}</label>
                  <input id="wizard-new-course-title" className={styles.input} value={newCourseTitle} onChange={(e) => setNewCourseTitle(e.target.value)} placeholder={t('admin_wizard_course_title_placeholder')} />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.label} htmlFor="wizard-new-module-title">{t('admin_wizard_first_module')}</label>
                  <input id="wizard-new-module-title" className={styles.input} value={newModuleTitle} onChange={(e) => setNewModuleTitle(e.target.value)} placeholder="Module 1" />
                </div>
              </div>
              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="wizard-new-course-description">{t('admin_wizard_course_desc_label')}</label>
                <textarea id="wizard-new-course-description" className={styles.textarea} rows={3} value={newCourseDescription} onChange={(e) => setNewCourseDescription(e.target.value)} placeholder={t('admin_wizard_course_desc_placeholder')} />
              </div>
              <div className={styles.inlineActions}>
                <button className={styles.btnSecondary} type="button" onClick={handleCreateCourseInline} disabled={creatingCourse || !newCourseTitle.trim()}>
                  {creatingCourse ? t('admin_wizard_creating') : t('admin_wizard_create_course_module')}
                </button>
              </div>
            </div>
          )}
        </>
      )

      case 1: return (
        <>
          <h3 className={styles.panelTitle}>{t('admin_wizard_creation_method')}</h3>
          <div className={styles.methodCards}>
            <div className={`${styles.methodCard} ${method === 'manual' ? styles.methodCardActive : ''}`} onClick={() => setMethod('manual')}>
              <div className={styles.methodIcon}>{t('edit')}</div>
              <div className={styles.methodLabel}>{t('admin_wizard_method_manual_label')}</div>
              <div className={styles.methodDesc}>{t('admin_wizard_method_manual_desc')}</div>
              <div className={styles.methodRadio}>
                <input type="radio" checked={method === 'manual'} readOnly />
              </div>
            </div>
            <div className={`${styles.methodCard} ${method === 'generator' ? styles.methodCardActive : ''}`} onClick={() => setMethod('generator')}>
              <div className={styles.methodIcon}>AI</div>
              <div className={styles.methodLabel}>{t('admin_wizard_method_generator_label')}</div>
              <div className={styles.methodDesc}>{t('admin_wizard_method_generator_desc')}</div>
              <div className={styles.methodRadio}>
                <input type="radio" checked={method === 'generator'} readOnly />
              </div>
            </div>
          </div>
          {method === 'generator' && (
            <div className={styles.generatorOptions}>
              <div className={styles.aiBar}>
                <div>
                  <div className={styles.label}>{t('admin_wizard_ai_generation')}</div>
                  <div className={styles.helper}>{t('admin_wizard_ai_hint')}</div>
                </div>
                <div className={styles.aiControls}>
                  <input aria-label="AI topic or chapter" className={`${styles.input} ${styles.aiTopicInput}`} placeholder={t('admin_wizard_ai_topic_placeholder')} value={aiTopic} onChange={e => setAiTopic(e.target.value)} />
                  <input aria-label="AI question count" className={styles.inputMini} type="number" min={1} max={15} value={aiCount} onChange={e => setAiCount(Number(e.target.value))} />
                  <select aria-label="AI difficulty" className={styles.selectMini} value={aiDifficulty} onChange={e => setAiDifficulty(e.target.value)}>
                    <option value="mixed">{t('admin_wizard_ai_mixed')}</option>
                    <option value="easy">{t('admin_wizard_ai_easy')}</option>
                    <option value="medium">{t('admin_wizard_ai_medium')}</option>
                    <option value="hard">{t('admin_wizard_ai_hard')}</option>
                  </select>
                  <button type="button" className={styles.btnSeed} onClick={handleAIGenerate} disabled={aiLoading}>
                    {aiLoading ? t('admin_wizard_ai_generating') : t('admin_wizard_ai_generate')}
                  </button>
                </div>
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label}>{t('admin_wizard_select_based_on')}</label>
                <div className={styles.generatorChoiceRow}>
                  <label className={styles.generatorChoiceLabel}>
                    <input type="radio" checked={generatorBy === 'difficulty'} onChange={() => setGeneratorBy('difficulty')} />
                    {t('admin_wizard_difficulty_mix')}
                  </label>
                  <label className={styles.generatorChoiceLabel}>
                    <input type="radio" checked={generatorBy === 'category'} onChange={() => setGeneratorBy('category')} />
                    {t('admin_wizard_category_quotas')}
                  </label>
                </div>
              </div>
              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="wizard-generator-count">{t('admin_wizard_total_questions')}</label>
                <input id="wizard-generator-count" className={`${styles.input} ${styles.generatorCountInput}`} type="number" min={1} max={200} value={generatorCount} onChange={e => setGeneratorCount(Number(e.target.value))} />
              </div>

              <div className={styles.generatorGrid}>
                <div className={styles.formGroup}>
                  <label className={styles.label}>{t('admin_wizard_difficulty_pct')}</label>
                  {['easy','medium','hard'].map(key => (
                    <div key={key} className={styles.sliderRow}>
                      <span className={styles.sliderLabel}>{key.toUpperCase()}</span>
                      <input
                        className={styles.slider}
                        type="range"
                        min={0}
                        max={100}
                        value={generatorDifficultyMix[key]}
                        onChange={e => setGeneratorDifficultyMix(prev => ({ ...prev, [key]: Number(e.target.value) }))}
                      />
                      <input
                        className={styles.inputMini}
                        type="number"
                        min={0}
                        max={100}
                        value={generatorDifficultyMix[key]}
                        onChange={e => setGeneratorDifficultyMix(prev => ({ ...prev, [key]: Number(e.target.value) }))}
                      />
                    </div>
                  ))}
                  <div className={styles.helper}>{t('admin_wizard_mix_hint')}</div>
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.label}>{t('admin_wizard_restrict_categories')}</label>
                  <div className={styles.chipRow}>
                    {categories.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        className={`${styles.chipToggle} ${generatorCategories.includes(c.id) ? styles.chipToggleOn : ''}`}
                        onClick={() => setGeneratorCategories(prev => prev.includes(c.id) ? prev.filter(x => x !== c.id) : [...prev, c.id])}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                  <div className={styles.helper}>{t('admin_wizard_categories_hint')}</div>
                </div>

                <div className={styles.formGroup}>
                  <label className={styles.label}>{t('admin_wizard_allowed_pools')}</label>
                  <div className={styles.chipRow}>
                    {pools.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        className={`${styles.chipToggle} ${generatorPools.includes(p.id) ? styles.chipToggleOn : ''}`}
                        onClick={() => setGeneratorPools(prev => prev.includes(p.id) ? prev.filter(x => x !== p.id) : [...prev, p.id])}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                  <div className={styles.helper}>{t('admin_wizard_pools_hint')}</div>
                </div>
              </div>

              <div className={styles.generatorGrid}>
                <div className={styles.formGroup}>
                  <label className={styles.label} htmlFor="wizard-generator-tags-include">{t('admin_wizard_include_tags')}</label>
                  <input id="wizard-generator-tags-include" className={styles.input} value={generatorTagsInclude} onChange={e => setGeneratorTagsInclude(e.target.value)} placeholder={t('admin_wizard_include_tags_placeholder')} />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.label} htmlFor="wizard-generator-tags-exclude">{t('admin_wizard_exclude_tags')}</label>
                  <input id="wizard-generator-tags-exclude" className={styles.input} value={generatorTagsExclude} onChange={e => setGeneratorTagsExclude(e.target.value)} placeholder={t('admin_wizard_exclude_tags_placeholder')} />
                </div>
              </div>

              <div className={styles.generatorGrid}>
                <div className={styles.formGroup}>
                  <label className={styles.label}>{t('admin_wizard_versioning')}</label>
                  <div className={styles.toggleRow}>
                    <label className={styles.checkItem}>
                      <input type="checkbox" checked={generatorUniquePerCandidate} onChange={e => setGeneratorUniquePerCandidate(e.target.checked)} />
                      {t('admin_wizard_unique_per_candidate')}
                    </label>
                    <label className={styles.checkItem}>
                      <input type="checkbox" checked={generatorPreventReuse} onChange={e => setGeneratorPreventReuse(e.target.checked)} />
                      {t('admin_wizard_prevent_reuse')}
                    </label>
                    <label className={styles.checkItem}>
                      <input type="checkbox" checked={generatorShuffleAnswers} onChange={e => setGeneratorShuffleAnswers(e.target.checked)} />
                      {t('admin_wizard_shuffle_answers')}
                    </label>
                    <label className={styles.checkItem}>
                      <input type="checkbox" checked={generatorAdaptive} onChange={e => setGeneratorAdaptive(e.target.checked)} />
                      {t('admin_wizard_adaptive')}
                    </label>
                  </div>
                  <div className={styles.inputRow}>
                    <div className={styles.formGroup}>
                      <label className={styles.label} htmlFor="wizard-generator-version-count">{t('admin_wizard_versions_count')}</label>
                      <input id="wizard-generator-version-count" className={styles.input} type="number" min={1} max={20} value={generatorVersionCount} onChange={e => setGeneratorVersionCount(Number(e.target.value))} />
                    </div>
                    <div className={styles.formGroup}>
                      <label className={styles.label} htmlFor="wizard-generator-random-seed">{t('admin_wizard_random_seed')}</label>
                      <input id="wizard-generator-random-seed" className={styles.input} value={generatorRandomSeed} onChange={e => setGeneratorRandomSeed(e.target.value)} placeholder={t('admin_wizard_random_seed_placeholder')} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )

      case 2: return (
        <>
          <h3 className={styles.panelTitle}>{t('admin_wizard_proctoring_settings')}</h3>
          <div className={styles.summaryChips}>
            <span className={styles.chip}>{t('admin_wizard_phase_3')}</span>
            <span className={styles.chip}>{t('admin_wizard_checks_enabled')}: {activeDetectorCount}</span>
            <span className={styles.chip}>{t('admin_wizard_escalation_rules')}: {alertRuleCount}</span>
            <span className={styles.chip}>{t('admin_wizard_fullscreen_label')}: {proctoring.fullscreen_enforce ? t('admin_wizard_on_label') : t('admin_wizard_off_label')}</span>
            <span className={styles.chip}>{t('admin_wizard_tabs_label')}: {proctoring.tab_switch_detect ? t('admin_wizard_tracked_label') : t('admin_wizard_ignored_label')}</span>
          </div>
          <p className={styles.phaseIntro}>
            {t('admin_wizard_proctoring_intro')}
          </p>
          <div className={styles.sectionDivider}>{t('admin_wizard_delivery_settings')}</div>
          <div className={styles.inputRow}>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="wizard-exam-type">{t('admin_wizard_question_type')}</label>
              <select id="wizard-exam-type" className={styles.select} value={examType} onChange={e => setExamType(e.target.value)}>
                <option value="MCQ">{t('admin_wizard_mcq_option')}</option>
                <option value="TEXT">{t('admin_wizard_text_option')}</option>
              </select>
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="wizard-page-format">{t('admin_wizard_page_format')}</label>
              <select id="wizard-page-format" className={styles.select} value={pageFormat} onChange={e => setPageFormat(e.target.value)}>
                <option value="one_per_page">{t('admin_wizard_one_per_page')}</option>
                <option value="all_per_page">{t('admin_wizard_all_per_page')}</option>
                <option value="section_per_page">{t('admin_wizard_section_per_page')}</option>
              </select>
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="wizard-calculator-type">{t('admin_wizard_calculator')}</label>
              <select id="wizard-calculator-type" className={styles.select} value={calculatorType} onChange={e => setCalculatorType(e.target.value)}>
                <option value="none">{t('admin_wizard_no_calculator')}</option>
                <option value="basic">{t('admin_wizard_basic_calc')}</option>
                <option value="scientific">{t('admin_wizard_scientific_calc')}</option>
              </select>
            </div>
          </div>

          <div className={styles.checkboxGroup}>
            {[
              { key: 'hideMetadata', label: t('admin_wizard_hide_metadata'), state: hideMetadata, set: setHideMetadata },
              { key: 'randomize_q', label: t('admin_wizard_randomize_questions'), state: randomizeQuestions, set: setRandomizeQuestions },
              { key: 'randomize_a', label: t('admin_wizard_randomize_answers'), state: randomizeAnswers, set: setRandomizeAnswers },
              { key: 'progress', label: t('admin_wizard_show_progress'), state: showProgressBar, set: setShowProgressBar },
            ].map(item => (
              <label key={item.key} className={styles.checkItem}>
                <input type="checkbox" checked={item.state} onChange={e => item.set(e.target.checked)} />
                <span>{item.label}</span>
              </label>
            ))}
          </div>

          <div className={styles.sectionDivider}>{t('admin_wizard_proctoring_label')}</div>
          <div className={styles.proctoringShell}>
            <div className={styles.proctoringHead}>
              <h4 className={styles.proctoringTitle}>{t('admin_wizard_proctoring_label')}</h4>
              <div className={styles.proctoringViews}>
                <button type="button" className={`${styles.viewTab} ${proctoringView === 'candidate_monitoring' ? styles.viewTabActive : ''}`} onClick={() => setProctoringView('candidate_monitoring')}>{t('admin_wizard_candidate_monitoring')}</button>
                <button type="button" className={`${styles.viewTab} ${proctoringView === 'special_accommodations' ? styles.viewTabActive : ''}`} onClick={() => setProctoringView('special_accommodations')}>{t('admin_wizard_special_accommodations')}</button>
                <button type="button" className={`${styles.viewTab} ${proctoringView === 'special_requests' ? styles.viewTabActive : ''}`} onClick={() => setProctoringView('special_requests')}>{t('admin_wizard_special_requests')}</button>
              </div>
            </div>

            <div className={styles.inputRow}>
              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="wizard-proctoring-test">{t('admin_wizard_test_label')}</label>
                <input id="wizard-proctoring-test" className={styles.input} value={title || t('admin_wizard_untitled_test')} readOnly />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="wizard-proctoring-session">{t('admin_wizard_testing_session')}</label>
                <select id="wizard-proctoring-session" className={styles.select} value={proctoringSessionId} onChange={(e) => setProctoringSessionId(e.target.value)}>
                  <option value="">{t('admin_wizard_all_sessions')}</option>
                  {proctoringSessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {`${t('admin_wizard_session_prefix')} ${String(s.id).slice(0, 6)} - ${fmtDateTime(s.scheduled_at)}`}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {proctoringView === 'candidate_monitoring' && (
              <div className={styles.monitoringTableCard}>
                <div className={styles.monitoringActions}>
                  <button type="button" className={styles.btnSecondary} disabled={proctoringBulkBusy} onClick={() => handleProctoringBulkPause(true)}>{t('admin_wizard_pause_filtered')}</button>
                  <button type="button" className={styles.btnSecondary} disabled={proctoringBulkBusy} onClick={() => handleProctoringBulkPause(false)}>{t('admin_wizard_resume_filtered')}</button>
                  <button type="button" className={styles.btnPrimarySolid} onClick={() => examId && navigate(`/admin/videos?exam_id=${examId}`)}>{t('admin_wizard_open_supervision')}</button>
                  {examId && <button type="button" className={styles.btnSecondary} onClick={() => navigate(`/admin/tests/${examId}/manage?tab=proctoring`)}>{t('admin_wizard_full_proctoring')}</button>}
                </div>

                <div className={styles.monitoringTableWrap}>
                  <table className={styles.monitoringTable}>
                    <thead>
                      <tr>
                        <th>{t('admin_wizard_th_actions')}</th>
                        <th>{t('admin_wizard_th_attempt_id')}</th>
                        <th>{t('admin_wizard_th_username')}</th>
                        <th>{t('admin_wizard_th_session_name')}</th>
                        <th>{t('admin_wizard_th_attempt_status')}</th>
                        <th>{t('admin_wizard_th_test_started')}</th>
                        <th>{t('admin_wizard_th_user_group')}</th>
                        <th>{t('admin_wizard_th_comment')}</th>
                        <th>{t('admin_wizard_th_proctor_rate')}</th>
                      </tr>
                      <tr className={styles.monitoringSearchRow}>
                        <th></th>
                        <th><input className={styles.tableFilter} placeholder={t('admin_wizard_search_placeholder')} value={proctoringSearch.attemptId} onChange={(e) => setProctoringSearch((p) => ({ ...p, attemptId: e.target.value }))} /></th>
                        <th><input className={styles.tableFilter} placeholder={t('admin_wizard_search_placeholder')} value={proctoringSearch.username} onChange={(e) => setProctoringSearch((p) => ({ ...p, username: e.target.value }))} /></th>
                        <th><input className={styles.tableFilter} placeholder={t('admin_wizard_search_placeholder')} value={proctoringSearch.sessionName} onChange={(e) => setProctoringSearch((p) => ({ ...p, sessionName: e.target.value }))} /></th>
                        <th>
                          <select className={styles.tableFilter} value={proctoringSearch.status} onChange={(e) => setProctoringSearch((p) => ({ ...p, status: e.target.value }))}>
                            <option value="">{t('admin_wizard_select_one')}</option>
                            <option value="IN_PROGRESS">IN_PROGRESS</option>
                            <option value="SUBMITTED">SUBMITTED</option>
                            <option value="GRADED">GRADED</option>
                          </select>
                        </th>
                        <th></th>
                        <th><input className={styles.tableFilter} placeholder={t('admin_wizard_search_placeholder')} value={proctoringSearch.userGroup} onChange={(e) => setProctoringSearch((p) => ({ ...p, userGroup: e.target.value }))} /></th>
                        <th><input className={styles.tableFilter} placeholder={t('admin_wizard_search_placeholder')} value={proctoringSearch.comment} onChange={(e) => setProctoringSearch((p) => ({ ...p, comment: e.target.value }))} /></th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {proctoringLoading ? (
                        <tr><td colSpan={9}>{t('admin_wizard_loading_attempts')}</td></tr>
                      ) : filteredProctoringRows.length === 0 ? (
                        <tr><td colSpan={9}>{t('admin_wizard_no_attempts')}</td></tr>
                      ) : (
                        filteredProctoringRows.map((row) => (
                          <tr key={row.id}>
                            <td>
                              <div className={styles.rowActionGroup}>
                                <button type="button" className={styles.rowIconBtn} title={row.paused ? t('admin_wizard_resume_attempt') : t('admin_wizard_pause_attempt')} aria-label={row.paused ? t('admin_wizard_resume_attempt') : t('admin_wizard_pause_attempt')} disabled={proctoringRowBusy[row.id]} onClick={() => handleProctoringPauseResume(row)}>
                                  {row.paused ? (
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                                  ) : (
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 5v14M16 5v14" /></svg>
                                  )}
                                </button>
                                <button type="button" className={styles.rowIconBtn} title={t('admin_wizard_analyze_attempt')} aria-label={t('admin_wizard_analyze_attempt')} onClick={() => navigate(`/admin/attempt-analysis?id=${row.id}`)}>
                                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                    <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
                                  </svg>
                                </button>
                                <button type="button" className={styles.rowIconBtn} title={t('admin_wizard_open_recordings')} aria-label={t('admin_wizard_open_recordings')} onClick={() => navigate(`/admin/videos/${row.id}`)}>
                                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M23 7l-7 5 7 5V7z" />
                                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                                  </svg>
                                </button>
                              </div>
                            </td>
                            <td>{row.attemptId}</td>
                            <td>{row.username}</td>
                            <td>{row.sessionName}</td>
                            <td>{row.status}</td>
                            <td>{fmtDateTime(row.startedAt)}</td>
                            <td>{row.userGroup}</td>
                            <td>{row.comment || '-'}</td>
                            <td>{row.proctorRate}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <div className={styles.monitoringFooter}>
                  <span>{t('admin_wizard_save_columns')}</span>
                  <span>{t('admin_wizard_rows_label')}: {filteredProctoringRows.length}</span>
                </div>
              </div>
            )}

            {proctoringView === 'special_accommodations' && (
              <div className={styles.proctoringNotes}>
                <label className={styles.label} htmlFor="wizard-special-accommodations">{t('admin_wizard_special_accommodations')}</label>
                <textarea
                  id="wizard-special-accommodations"
                  className={styles.textarea}
                  value={specialAccommodations}
                  onChange={(e) => {
                    setSpecialAccommodations(e.target.value)
                    if (examId) autoPersist()
                  }}
                  rows={4}
                />
              </div>
            )}

            {proctoringView === 'special_requests' && (
              <div className={styles.proctoringNotes}>
                <label className={styles.label} htmlFor="wizard-special-requests">{t('admin_wizard_special_requests')}</label>
                <textarea
                  id="wizard-special-requests"
                  className={styles.textarea}
                  value={specialRequests}
                  onChange={(e) => {
                    setSpecialRequests(e.target.value)
                    if (examId) autoPersist()
                  }}
                  rows={4}
                />
              </div>
            )}

            <div className={styles.sectionDivider}>{t('admin_wizard_journey_requirements')}</div>
            <div className={styles.requirementGrid}>
              {PROCTORING_REQUIREMENTS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`${styles.requirementCard} ${proctoring[item.key] ? styles.requirementCardActive : ''}`}
                  onClick={() => updateProctoringFlag(item.key, !proctoring[item.key])}
                >
                  <div className={styles.requirementCardHead}>
                    <div className={styles.requirementCardTitle}>{t(item.labelKey)}</div>
                    <div className={`${styles.toggleTrack} ${proctoring[item.key] ? styles.toggleTrackOn : ''}`}>
                      <div className={styles.toggleThumb} />
                    </div>
                  </div>
                  <div className={styles.requirementCardDesc}>{t(item.descKey)}</div>
                </button>
              ))}
            </div>

            <div className={styles.sectionDivider}>{t('admin_wizard_alert_rules_title')}</div>
            <div className={styles.alertRuleShell}>
              <div className={styles.alertRuleHead}>
                <div>
                  <div className={styles.alertRuleTitle}>{t('admin_wizard_escalate_desc')}</div>
                  <div className={styles.alertRuleDesc}>
                    {t('admin_wizard_escalate_hint')}
                  </div>
                </div>
                <button type="button" className={styles.btnSecondary} onClick={addAlertRule}>{t('admin_wizard_add_rule')}</button>
              </div>

              {alertRuleCount === 0 ? (
                <div className={styles.alertRuleEmpty}>
                  {t('admin_wizard_no_rules')}
                </div>
              ) : (
                <div className={styles.alertRuleList}>
                  {proctoring.alert_rules.map((rule, index) => {
                    const option = ALERT_RULE_EVENT_OPTIONS.find((item) => item.value === rule.event_type) || ALERT_RULE_EVENT_OPTIONS[0]
                    const dependencies = Array.isArray(option.requires) ? option.requires : []
                    const missingDependencies = dependencies.filter((dep) => !proctoring[dep])
                    const dependencyLabel = missingDependencies.map((dep) => PROCTORING_LABEL_KEYS[dep] ? t(PROCTORING_LABEL_KEYS[dep]) : humanizeSettingLabel(dep)).join(', ')
                    return (
                      <div key={rule.id} className={styles.alertRuleCard}>
                        <div className={styles.alertRuleCardHead}>
                          <div>
                            <div className={styles.alertRuleCardTitle}>{t('admin_wizard_rule_label')} {index + 1}</div>
                            <div className={styles.alertRuleCardMeta}>{describeAlertRule(rule, t)}</div>
                          </div>
                          <button type="button" className={styles.reviewEditBtn} onClick={() => removeAlertRule(rule.id)}>{t('admin_wizard_remove')}</button>
                        </div>
                        <div className={styles.alertRuleGrid}>
                          <div className={styles.formGroup}>
                            <label className={styles.label}>{t('admin_wizard_alert_type')}</label>
                            <select
                              aria-label={`Alert type ${index + 1}`}
                              className={styles.select}
                              value={rule.event_type}
                              onChange={(e) => updateAlertRule(rule.id, 'event_type', e.target.value)}
                            >
                              {ALERT_RULE_EVENT_OPTIONS.map((item) => (
                                <option key={item.value} value={item.value}>{t(item.labelKey)}</option>
                              ))}
                            </select>
                            <div className={styles.helper}>{t(option.descKey)}</div>
                          </div>
                          <div className={styles.formGroup}>
                            <label className={styles.label}>{t('admin_wizard_trigger_after')}</label>
                            <input
                              aria-label={`Trigger after ${index + 1}`}
                              className={styles.input}
                              type="number"
                              min={1}
                              max={20}
                              value={rule.threshold}
                              onChange={(e) => updateAlertRule(rule.id, 'threshold', e.target.value)}
                            />
                            <div className={styles.helper}>{t('admin_wizard_trigger_hint')}</div>
                          </div>
                          <div className={styles.formGroup}>
                            <label className={styles.label}>{t('admin_wizard_escalation_severity')}</label>
                            <select
                              aria-label={`Escalation severity ${index + 1}`}
                              className={styles.select}
                              value={rule.severity}
                              onChange={(e) => updateAlertRule(rule.id, 'severity', e.target.value)}
                            >
                              {ALERT_RULE_SEVERITIES.map((value) => (
                                <option key={value} value={value}>{value}</option>
                              ))}
                            </select>
                            <div className={styles.helper}>{t('admin_wizard_severity_hint')}</div>
                          </div>
                          <div className={styles.formGroup}>
                            <label className={styles.label}>{t('admin_wizard_what_happens')}</label>
                            <select
                              aria-label={`What happens ${index + 1}`}
                              className={styles.select}
                              value={rule.action}
                              onChange={(e) => updateAlertRule(rule.id, 'action', e.target.value)}
                            >
                              {ALERT_RULE_ACTIONS.map((item) => (
                                <option key={item.value} value={item.value}>{item.label}</option>
                              ))}
                            </select>
                            <div className={styles.helper}>{t(ALERT_RULE_ACTION_HELPER_KEYS[rule.action] || ALERT_RULE_ACTION_HELPER_KEYS.WARN)}</div>
                          </div>
                        </div>
                        <div className={styles.formGroup}>
                          <label className={styles.label}>{t('admin_wizard_optional_message')}</label>
                          <input
                            aria-label={`Escalation message ${index + 1}`}
                            className={styles.input}
                            value={rule.message || ''}
                            onChange={(e) => updateAlertRule(rule.id, 'message', e.target.value)}
                            placeholder={t('admin_wizard_message_placeholder')}
                          />
                        </div>
                        {missingDependencies.length > 0 && (
                          <div className={styles.alertRuleDependencyWarning}>
                            {t('admin_wizard_rule_depends')} {dependencyLabel}. {t('admin_wizard_enable_above')}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className={styles.sectionDivider}>{t('admin_wizard_detector_switches')}</div>
            <div className={styles.presetRow}>
              <button className={styles.btnSecondary} type="button" onClick={() => applyProctoringPreset('lenient')}>{t('admin_wizard_lenient')}</button>
              <button className={styles.btnSecondary} type="button" onClick={() => applyProctoringPreset('standard')}>{t('admin_wizard_standard')}</button>
              <button className={styles.btnSecondary} type="button" onClick={() => applyProctoringPreset('strict')}>{t('admin_wizard_strict')}</button>
            </div>
            <div className={styles.detectorsGrid}>
              {DETECTORS.map(d => (
                <div key={d.key} className={`${styles.detectorCard} ${proctoring[d.key] ? styles.detectorOn : ''}`} onClick={() => toggleDetector(d.key)}>
                  <div className={styles.detectorToggle}>
                    <div className={`${styles.toggleTrack} ${proctoring[d.key] ? styles.toggleTrackOn : ''}`}>
                      <div className={styles.toggleThumb} />
                    </div>
                  </div>
                  <div>
                    <div className={styles.detectorName}>{t(d.labelKey)}</div>
                    <div className={styles.detectorDesc}>{t(d.descKey)}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className={styles.sectionDivider}>{t('admin_wizard_advanced_tuning')}</div>
            <div className={styles.advancedSectionStack}>
              {PROCTORING_CONTROL_GROUPS.map((group) => (
                <div key={group.key} className={styles.advancedSectionCard}>
                  <div className={styles.advancedSectionHead}>
                    <div className={styles.advancedSectionTitle}>{t(group.titleKey)}</div>
                    <div className={styles.advancedSectionDesc}>{t(group.descriptionKey)}</div>
                  </div>
                  <div className={styles.advancedControlGrid}>
                    {group.controls.map((control) => {
                      const dependencies = Array.isArray(control.enabledBy)
                        ? control.enabledBy
                        : control.enabledBy
                          ? [control.enabledBy]
                          : []
                      const controlEnabled = dependencies.length === 0 || dependencies.every((dep) => Boolean(proctoring[dep]))
                      const dependencyLabel = dependencies.map((dep) => PROCTORING_LABEL_KEYS[dep] ? t(PROCTORING_LABEL_KEYS[dep]) : humanizeSettingLabel(dep)).join(' and ')
                      const numericValue = proctoring[control.key] ?? control.min
                      return (
                        <div
                          key={control.key}
                          className={`${styles.advancedControlCard} ${!controlEnabled ? styles.advancedControlCardDisabled : ''}`}
                        >
                          <div className={styles.advancedControlHead}>
                            <div>
                              <div className={styles.advancedControlLabel}>{t(control.labelKey)}</div>
                              <div className={styles.advancedControlDesc}>{t(control.descKey)}</div>
                            </div>
                            <div className={styles.advancedControlMeta}>
                              {numericValue}
                              <span className={styles.advancedControlUnit}>{control.unit}</span>
                            </div>
                          </div>
                          <input
                            className={styles.advancedControlRange}
                            type="range"
                            min={control.min}
                            max={control.max}
                            step={control.step}
                            value={numericValue}
                            disabled={!controlEnabled}
                            onChange={(e) => updateProctoringNumber(control.key, e.target.value, { integer: Number.isInteger(control.step) })}
                          />
                          <div className={styles.advancedControlInputs}>
                            <input
                              className={`${styles.input} ${styles.advancedNumberInput}`}
                              type="number"
                              min={control.min}
                              max={control.max}
                              step={control.step}
                              value={numericValue}
                              disabled={!controlEnabled}
                              onChange={(e) => updateProctoringNumber(control.key, e.target.value, { integer: Number.isInteger(control.step) })}
                            />
                            <span className={styles.advancedInputHint}>
                              {controlEnabled ? `${t('admin_wizard_recommended_range')} ${control.min} ${t('admin_wizard_to')} ${control.max} ${control.unit}` : `${t('admin_wizard_enable_first')} ${dependencyLabel} ${t('admin_wizard_enable_first_suffix')}`}
                            </span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.sectionDivider}>{t('admin_wizard_time_limit_section')}</div>
          <label className={styles.checkItem}>
            <input type="checkbox" checked={unlimitedTime} onChange={e => setUnlimitedTime(e.target.checked)} />
            <span>{t('admin_wizard_unlimited_time')}</span>
          </label>
          {!unlimitedTime && (
            <div className={`${styles.formGroup} ${styles.timeLimitWrap}`}>
              <label className={styles.label} htmlFor="wizard-time-limit">{t('admin_wizard_duration_label')}</label>
              <input id="wizard-time-limit" name="time_limit" className={`${styles.input} ${styles.timeLimitInput}`} type="number" min={1} max={600} value={timeLimitMinutes} onFocus={e => e.target.select()} onChange={e => setTimeLimitMinutes(Number(e.target.value))} />
            </div>
          )}
        </>
      )

      case 3: return (
        <>
          <h3 className={styles.panelTitle}>{t('admin_wizard_questions_title')}</h3>
          <p className={styles.questionsIntro}>
            {t('admin_wizard_questions_intro')}
          </p>

          {examId && (
            <div className={styles.questionsStack}>
              <SectionsManager
                examId={examId}
                onChange={() => adminApi.getQuestions(examId).then(({ data }) => setQuestions(data || [])).catch(() => {})}
              />
              <ExamQuestionPanel examId={examId} questions={questions} onUpdate={setQuestions} questionTypes={QUESTION_TYPES} />
            </div>
          )}
          {!examId && (
            <div className={styles.questionInitCard}>
              <div className={styles.questionInitLead}>
                {saving ? t('admin_wizard_creating_test') : t('admin_wizard_hang_tight')}
              </div>
              {questionInitError && <div className={styles.questionInitError}>{questionInitError}</div>}
              {!saving && (
                <button className={styles.btnSeed} onClick={ensureExamCreated}>
                  {t('admin_wizard_retry_create')}
                </button>
              )}
            </div>
          )}
        </>
      )

      case 4: return (
        <>
          <h3 className={styles.panelTitle}>{t('admin_wizard_grading_config')}</h3>
          <div className={styles.inputRow}>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="wizard-passing-score">{t('admin_wizard_passing_mark')}</label>
              <input id="wizard-passing-score" className={styles.input} type="number" min={0} max={100} value={passingScore} onChange={e => { setPassingScore(Number(e.target.value)); if (examId) autoPersist() }} />
              <span className={styles.metricHelper}>
                {t('admin_wizard_passing_hint')} {passingScore}{t('admin_wizard_passing_hint_suffix')}
              </span>
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="wizard-max-attempts">{t('admin_wizard_max_attempts_label')}</label>
              <input id="wizard-max-attempts" className={styles.input} type="number" min={1} max={20} value={maxAttempts} onChange={e => { setMaxAttempts(Number(e.target.value)); if (examId) autoPersist() }} />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="wizard-grading-scale">{t('admin_wizard_grading_scale_label')}</label>
              <select id="wizard-grading-scale" className={styles.select} value={gradingScaleId} onChange={e => { setGradingScaleId(e.target.value); if (examId) autoPersist() }}>
                <option value="">{t('admin_wizard_no_scale')}</option>
                {gradingScales.map(gs => <option key={gs.id} value={gs.id}>{gs.name}</option>)}
              </select>
            </div>
          </div>

          <div className={styles.sectionDivider}>{t('admin_wizard_neg_marking_section')}</div>
          <label className={styles.checkItem}>
            <input type="checkbox" checked={negativeMarking} onChange={e => { setNegativeMarking(e.target.checked); if (examId) autoPersist() }} />
            <span>{t('admin_wizard_enable_neg_marking')}</span>
          </label>
          {negativeMarking && (
            <div className={`${styles.inputRow} ${styles.negativeMarkRow}`}>
              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="wizard-negative-mark-value">{t('admin_wizard_deduction_value')}</label>
                <input id="wizard-negative-mark-value" className={styles.input} type="number" min={0} step={0.25} value={negMarkValue} onChange={e => { setNegMarkValue(Number(e.target.value)); if (examId) autoPersist() }} />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="wizard-negative-mark-type">{t('admin_wizard_deduction_type')}</label>
                <select id="wizard-negative-mark-type" className={styles.select} value={negMarkType} onChange={e => { setNegMarkType(e.target.value); if (examId) autoPersist() }}>
                  <option value="points">{t('admin_wizard_fixed_points')}</option>
                  <option value="percentage">{t('admin_wizard_pct_question')}</option>
                </select>
              </div>
            </div>
          )}

          <div className={styles.sectionDivider}>{t('admin_wizard_score_display')}</div>
          <div className={styles.checkboxGroup}>
            <label className={styles.checkItem}>
              <input type="checkbox" checked={showFinalScore} onChange={e => { setShowFinalScore(e.target.checked); if (examId) autoPersist() }} />
              <span>{t('admin_wizard_show_final_score')}</span>
            </label>
            <label className={styles.checkItem}>
              <input type="checkbox" checked={showQuestionScores} onChange={e => { setShowQuestionScores(e.target.checked); if (examId) autoPersist() }} />
              <span>{t('admin_wizard_show_per_question')}</span>
            </label>
            <label className={styles.checkItem}>
              <input type="checkbox" checked={sequentialSections} onChange={e => { setSequentialSections(e.target.checked); if (examId) autoPersist() }} />
              <span>{t('admin_wizard_sequential_sections')}</span>
            </label>
            <label className={styles.checkItem}>
              <input type="checkbox" checked={allowRevisitSections} onChange={e => { setAllowRevisitSections(e.target.checked); if (examId) autoPersist() }} />
              <span>{t('admin_wizard_allow_revisit_sections')}</span>
            </label>
            </div>

          <div className={styles.conductGrid}>
            <div className={styles.formGroup}>
              <label className={styles.label}>{t('admin_wizard_conduct_controls')}</label>
              <div className={styles.toggleRow}>
                <label className={styles.checkItem}>
                  <input type="checkbox" checked={proctoring.fullscreen_enforce} onChange={e => { setProctoring(p => ({ ...p, fullscreen_enforce: e.target.checked })); if (examId) autoPersist() }} />
                  {t('admin_wizard_enforce_fullscreen')}
                </label>
                <label className={styles.checkItem}>
                  <input type="checkbox" checked={proctoring.tab_switch_detect} onChange={e => { setProctoring(p => ({ ...p, tab_switch_detect: e.target.checked })); if (examId) autoPersist() }} />
                  {t('admin_wizard_detect_tab_switches')}
                </label>
                <label className={styles.checkItem}>
                  <input type="checkbox" checked={proctoring.screen_capture} onChange={e => { setProctoring(p => ({ ...p, screen_capture: e.target.checked })); if (examId) autoPersist() }} />
                  {t('admin_wizard_capture_screen')}
                </label>
                <label className={styles.checkItem}>
                  <input type="checkbox" checked={proctoring.copy_paste_block} onChange={e => { setProctoring(p => ({ ...p, copy_paste_block: e.target.checked })); if (examId) autoPersist() }} />
                  {t('admin_wizard_block_copy_paste')}
                </label>
              </div>
              <div className={styles.helper}>{t('admin_wizard_conduct_hint')}</div>
            </div>
          </div>
        </>
      )

      case 5: return (
        <>
          <h3 className={styles.panelTitle}>{t('admin_wizard_certificates_title')}</h3>
          <label className={`${styles.checkItem} ${styles.certToggleRow}`}>
            <div
              className={`${styles.toggleTrack} ${certEnabled ? styles.toggleTrackOn : ''}`}
              onClick={() => { setCertEnabled(v => !v); if (examId) autoPersist() }}
            >
              <div className={styles.toggleThumb} />
            </div>
            <span className={styles.toggleLabelStrong}>{t('admin_wizard_enable_cert_builder')}</span>
          </label>
          {certEnabled && (
            <>
              <div className={styles.formGroup}>
                <label className={styles.label}>{t('admin_wizard_cert_release_rule')}</label>
                <div className={styles.certRuleList}>
                  {CERTIFICATE_ISSUE_RULE_OPTIONS.map((option) => (
                    <label key={option.value} className={`${styles.certRuleCard} ${certIssueRule === option.value ? styles.certRuleCardActive : ''}`}>
                      <input
                        type="radio"
                        name="wizard-certificate-issue-rule"
                        checked={certIssueRule === option.value}
                        onChange={() => { setCertIssueRule(option.value); if (examId) autoPersist() }}
                      />
                      <span className={styles.certRuleBody}>
                        <span className={styles.certRuleTitle}>{t(option.labelKey)}</span>
                        <span className={styles.certRuleDescription}>{t(option.descriptionKey)}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className={styles.helper}>
                  {certIssueRule === 'AFTER_PROCTORING_REVIEW'
                    ? t('admin_wizard_cert_after_review')
                    : certIssueRule === 'POSITIVE_PROCTORING'
                      ? t('admin_wizard_cert_positive_proctoring')
                      : t('admin_wizard_cert_after_pass')}
                </div>
              </div>
              <div className={styles.inputRow}>
                <div className={styles.formGroup}>
                  <label className={styles.label} htmlFor="wizard-certificate-template">{t('admin_wizard_template_label')}</label>
                  <select id="wizard-certificate-template" className={styles.select} value={certTemplate} onChange={e => { setCertTemplate(e.target.value); if (examId) autoPersist() }}>
                    {CERTIFICATE_TEMPLATES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.label}>{t('admin_wizard_orientation_label')}</label>
                  <div className={styles.orientationRow}>
                    {['landscape', 'portrait'].map(o => (
                      <label key={o} className={styles.orientationOption}>
                        <input type="radio" checked={certOrientation === o} onChange={() => { setCertOrientation(o); if (examId) autoPersist() }} />
                        {o.charAt(0).toUpperCase() + o.slice(1)}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div className={styles.inputRow}>
                <div className={styles.formGroup}>
                  <label className={styles.label} htmlFor="wizard-certificate-title">{t('admin_wizard_cert_title_label')}</label>
                  <input id="wizard-certificate-title" className={styles.input} value={certTitle} onChange={e => { setCertTitle(e.target.value); if (examId) autoPersist() }} />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.label} htmlFor="wizard-certificate-subtitle">{t('admin_wizard_subtitle_label')}</label>
                  <input id="wizard-certificate-subtitle" className={styles.input} value={certSubtitle} onChange={e => { setCertSubtitle(e.target.value); if (examId) autoPersist() }} placeholder={t('admin_wizard_subtitle_placeholder')} />
                </div>
              </div>
              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="wizard-certificate-company">{t('admin_wizard_company_label')}</label>
                <input id="wizard-certificate-company" className={styles.input} value={certCompany} onChange={e => { setCertCompany(e.target.value); if (examId) autoPersist() }} placeholder={t('admin_wizard_company_placeholder')} />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="wizard-certificate-signer">{t('admin_wizard_signer_label')}</label>
                <input id="wizard-certificate-signer" className={styles.input} value={certSigner} onChange={e => { setCertSigner(e.target.value); if (examId) autoPersist() }} placeholder={t('admin_wizard_signer_placeholder')} />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="wizard-certificate-description">{t('admin_wizard_cert_body')}</label>
                <textarea id="wizard-certificate-description" className={styles.textarea} rows={3} value={certDescription} onChange={e => { setCertDescription(e.target.value); if (examId) autoPersist() }} />
              </div>
              <div className={styles.certPreview}>
                <div className={styles.certPreviewLabel}>{certTemplate} - {certOrientation}</div>
                <div className={`${styles.certPreviewBox} ${certOrientation === 'landscape' ? styles.certPreviewLandscape : styles.certPreviewPortrait}`}>
                  <div className={styles.certPreviewBadge}>{t(certificateIssueRuleLabelKey(certIssueRule))}</div>
                  <div className={styles.certPreviewTitle}>{certTitle || t('admin_wizard_cert_preview_title')}</div>
                  {certSubtitle && <div className={styles.certPreviewSub}>{certSubtitle}</div>}
                  {certCompany && <div className={styles.certPreviewCompany}>{certCompany}</div>}
                  {certSigner && <div className={styles.certPreviewCompany}>{t('admin_wizard_signed_by')} {certSigner}</div>}
                </div>
              </div>
            </>
          )}
        </>
      )

      case 6: return (
        <>
          <h3 className={styles.panelTitle}>{t('admin_wizard_review_title')}</h3>
          <div className={styles.reviewGrid}>
            {reviewSections.map((section) => (
              <div key={section.key} className={styles.reviewCard}>
                <div className={styles.reviewCardHeader}>
                  <div className={styles.reviewCardTitle}>{section.title}</div>
                  <button type="button" className={styles.reviewEditBtn} onClick={() => goToStep(section.editStep)}>
                    {t('admin_wizard_review_edit_step')} {section.editStep + 1}
                  </button>
                </div>
                <div className={styles.reviewCardList}>
                  {section.items.map(([label, value]) => (
                    <div key={`${section.key}-${label}`} className={styles.reviewRow}>
                      <span className={styles.reviewLabel}>{label}</span>
                      <span className={styles.reviewValue}>{String(value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )

      case 7: return (
        <>
          <h3 className={styles.panelTitle}>{t('admin_wizard_sessions_title')}</h3>
          <p className={styles.sessionIntro}>
            {t('admin_wizard_sessions_intro')}
          </p>
          {!examId ? (
            <p className={styles.sessionEmpty}>{t('admin_wizard_save_first')}</p>
          ) : (
            <>
              <div className={styles.inputRow}>
                <div className={styles.formGroup}>
                  <label className={styles.label} htmlFor="wizard-access-mode">{t('admin_wizard_access_mode')}</label>
                  <select id="wizard-access-mode" className={styles.select} value={accessMode} onChange={e => setAccessMode(e.target.value)}>
                    <option value="OPEN">{t('admin_wizard_open_anytime')}</option>
                    <option value="RESTRICTED">{t('admin_wizard_restricted_schedule')}</option>
                  </select>
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.label} htmlFor="wizard-scheduled-at">{t('admin_wizard_scheduled_datetime')}</label>
                  <input id="wizard-scheduled-at" className={styles.input} type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} />
                </div>
              </div>
              {sessionRequiresSchedule && !scheduledAt && (
                <div className={styles.sessionWarning}>{t('admin_wizard_restricted_warning')}</div>
              )}
              {hasPendingSessionChanges && (
                <div className={styles.sessionWarning}>{t('admin_wizard_save_warning')}</div>
              )}

              <label className={`${styles.label} ${styles.sectionLabel}`}>{t('admin_wizard_select_learners')}</label>
              <div className={styles.helper}>{t('admin_wizard_assigned_preselected')}</div>
              <div className={styles.summaryChips}>
                <span className={styles.chip}>{t('admin_wizard_learners_label')}: {totalLearners}</span>
                <span className={styles.chip}>{t('admin_wizard_visible_label')}: {filteredUsers.length}</span>
                <span className={styles.chip}>{t('admin_wizard_selected_label')}: {selectedUsers.length}</span>
                <span className={styles.chip}>{t('admin_wizard_visible_selected')}: {selectedVisibleLearners}</span>
              </div>
              <div className={styles.sessionBulkBar}>
                <button type="button" className={styles.btnSecondary} onClick={handleSelectAllLearners} disabled={sessionBusy || totalLearners === 0 || allLearnersSelected}>
                  {allLearnersSelected ? t('admin_wizard_all_selected') : `${t('admin_wizard_select_all')} (${totalLearners})`}
                </button>
                <button type="button" className={styles.btnSecondary} onClick={handleSelectVisibleLearners} disabled={sessionBusy || filteredUsers.length === 0 || allVisibleLearnersSelected}>
                  {allVisibleLearnersSelected ? t('admin_wizard_visible_selected_btn') : `${t('admin_wizard_select_visible')} (${filteredUsers.length})`}
                </button>
                <button type="button" className={styles.btnSecondary} onClick={handleClearLearnerSelection} disabled={sessionBusy || selectedUsers.length === 0}>
                  {t('admin_wizard_clear_selection')}
                </button>
              </div>
              <div className={styles.inlineCard}>
                <div className={styles.inlineCardHead}>
                  <div className={styles.label}>{t('admin_wizard_bulk_add')}</div>
                  <div className={styles.helper}>{t('admin_wizard_bulk_hint')}</div>
                </div>
                <textarea
                  className={styles.textarea}
                  aria-label="Bulk learners"
                  rows={3}
                  placeholder={'learner001@example.com\nLIV1772920670269\n1b2c3d4e-...'}
                  value={bulkLearnerInput}
                  onChange={(e) => setBulkLearnerInput(e.target.value)}
                />
                <div className={styles.inlineActions}>
                  <button type="button" className={styles.btnSecondary} onClick={handleBulkLearnerMatch} disabled={sessionBusy || !bulkLearnerInput.trim()}>
                    {t('admin_wizard_add_pasted')}
                  </button>
                </div>
                {bulkLearnerFeedback && <div className={styles.bulkSelectionMessage}>{bulkLearnerFeedback}</div>}
              </div>
              <label className={styles.label} htmlFor="wizard-learner-search">{t('admin_wizard_search_learners')}</label>
              <input id="wizard-learner-search" className={styles.userSearch} placeholder={t('admin_wizard_search_learners_placeholder')} value={userSearch} onChange={e => setUserSearch(e.target.value)} />
              <div className={styles.userList}>
                {filteredUsers.map(u => (
                  <label key={u.id} className={styles.userItem}>
                    <input type="checkbox" checked={selectedLearnerKeys.has(String(u.id))} onChange={() => toggleUser(u.id)} />
                    <span>{u.user_id} - {u.name || u.email || t('admin_wizard_learner_fallback')}</span>
                  </label>
                ))}
                {filteredUsers.length === 0 && <div className={`${styles.userItem} ${styles.emptyUserItem}`}>{t('admin_wizard_no_learners_found')}</div>}
              </div>
              <button
                className={styles.btnSeed}
                onClick={handleAssignSessions}
                disabled={!canSaveAssignments}
              >
                {sessionBusy ? t('saving') : `${t('admin_wizard_save_assignments')}${selectedUsers.length > 0 ? ` (${selectedUsers.length})` : assignedSessions.length > 0 ? ` (${t('admin_wizard_clear_update')})` : ''}`}
              </button>
              {assignedSessions.length > 0 && (
                <div className={styles.sessionActions}>
                  <div className={`${styles.label} ${styles.sessionActionsTitle}`}>{t('admin_wizard_assigned_sessions')} ({assignedSessions.length})</div>
                  {assignedSessions.map((s, i) => (
                    <div key={`action-${i}`} className={styles.sessionRow}>
                      <span>{s.user} - {s.mode}{s.at ? ` @ ${new Date(s.at).toLocaleString()}` : ''}</span>
                      <button type="button" className={styles.sessionRemove} onClick={() => handleRemoveSession(s.id, s.userId)} disabled={sessionBusy}>
                        {t('admin_wizard_remove')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )

      case 8: return (
        <>
          <h3 className={styles.panelTitle}>{t('admin_wizard_save_test_title')}</h3>
          <p className={styles.sessionIntro}>
            {t('admin_wizard_save_intro')}
          </p>
          <div className={styles.summaryChips}>
            <span className={styles.chip}>{t('admin_wizard_card_questions')}: {questions.length}</span>
            <span className={styles.chip}>{t('admin_wizard_seed_pools')}: {selectedPool ? 1 : 0}</span>
            <span className={styles.chip}>{t('admin_wizard_scheduled_label')}: {assignedSessions.length}</span>
            <span className={styles.chip}>{t('admin_wizard_status_label')}: {publishStatus === 'OPEN' ? t('admin_wizard_published') : t('admin_wizard_draft')}</span>
          </div>
          {questions.length === 0 && (
            <div className={styles.publishWarning}>
              {t('admin_wizard_publish_warning')}
            </div>
          )}
          <div className={styles.formGroup}>
            <label className={styles.label}>{t('admin_wizard_pub_status')}</label>
            <div className={styles.publishOptions}>
              <label className={`${styles.publishOption} ${publishStatus === 'CLOSED' ? styles.publishOptionActive : ''}`}>
                <input type="radio" checked={publishStatus === 'CLOSED'} onChange={() => updatePublishStatus('CLOSED')} />
                <div className={styles.publishOptionCopy}>
                  <div className={styles.publishOptionTitle}>{t('admin_wizard_draft')}</div>
                  <div className={styles.publishOptionSubtitle}>{t('admin_wizard_not_visible')}</div>
                </div>
              </label>
              <label className={`${styles.publishOption} ${publishStatus === 'OPEN' ? styles.publishOptionActive : ''}`}>
                <input type="radio" checked={publishStatus === 'OPEN'} onChange={() => updatePublishStatus('OPEN')} />
                <div className={styles.publishOptionCopy}>
                  <div className={styles.publishOptionTitle}>{t('admin_wizard_published')}</div>
                  <div className={styles.publishOptionSubtitle}>{t('admin_wizard_visible_active')}</div>
                </div>
              </label>
            </div>
          </div>
          <div className={styles.publishSummary}>
            <strong className={styles.publishSummaryStrong}>{t('admin_wizard_summary')}</strong> &quot;{title || t('admin_wizard_unnamed_test')}&quot; {t('admin_wizard_with')} {questions.length} {t('admin_wizard_questions_comma')} {assignedSessions.length} {t('admin_wizard_sessions_assigned_suffix')}
          </div>
        </>
      )

      default: return null
    }
  }

  return (
    <div className={styles.page}>
      <h2 className={styles.title}>{editId ? t('admin_wizard_edit_test') : t('admin_wizard_new_test')}</h2>

      {editingPublishedTest && !editorLocked && (
        <div className={styles.warningBanner}>{t('admin_wizard_editing_published_warning')}</div>
      )}

      {/* Steps bar */}
      <div className={styles.stepsBar}>
        {STEPS.map(s => (
          <div
            key={s.id}
            className={`${styles.step} ${s.id === step ? styles.stepActive : ''} ${s.id < step ? styles.stepCompleted : ''}`}
            onClick={() => s.id <= step && goToStep(s.id)}
          >
            <span className={`${styles.stepNum} ${s.id === step ? styles.stepNumActive : ''} ${s.id < step ? styles.stepNumCompleted : ''}`}>
              {s.id < step ? 'OK' : s.id + 1}
            </span>
            {t(s.labelKey)}
          </div>
        ))}
      </div>

      {/* Panel */}
      <div className={`${styles.panel} glass`}>
        {panelError && <div className={styles.errorBanner}>{panelError}</div>}
        <div className={styles.stepOverviewGrid}>
          {cycleOverviewCards.map((card) => (
            <div
              key={card.label}
              className={`${styles.stepOverviewCard} ${
                card.tone === 'ready'
                  ? styles.stepOverviewCardReady
                  : card.tone === 'attention'
                    ? styles.stepOverviewCardAttention
                    : styles.stepOverviewCardInfo
              }`}
            >
              <div className={styles.stepOverviewLabel}>{card.label}</div>
              <div className={styles.stepOverviewValue}>{card.value}</div>
              <div className={styles.stepOverviewHelper}>{card.helper}</div>
            </div>
          ))}
        </div>
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: stepTransitionDuration, ease: 'easeOut' }}
          >
            {renderStep()}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Actions */}
      <div className={styles.actions}>
        <button
          className={styles.btnBack}
          onClick={() => startTransition(() => setStep((current) => current - 1))}
          disabled={step === 0}
        >
          {t('back')}
        </button>
        {step < STEPS.length - 1 ? (
          <button className={styles.btnNext} onClick={handleNext} disabled={nextDisabled}>
            {saving ? t('saving') : t('next')}
          </button>
        ) : (
          <button className={styles.btnPublish} onClick={handlePublish} disabled={saving || editorLocked || (publishStatus === 'OPEN' && questions.length === 0)}>
            {saving ? t('saving') : publishStatus === 'OPEN' ? t('admin_wizard_publish_test') : t('admin_wizard_save_draft')}
          </button>
        )}
      </div>
    </div>
  )
}
