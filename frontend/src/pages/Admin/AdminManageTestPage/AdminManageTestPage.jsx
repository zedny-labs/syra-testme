import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import useUnsavedChanges from '../../../hooks/useUnsavedChanges'
import { adminApi } from '../../../services/admin.service'
import {
  CERTIFICATE_ISSUE_RULE_OPTIONS,
  certificateIssueRuleLabelKey,
  DEFAULT_CERTIFICATE_ISSUE_RULE,
  normalizeCertificateIssueRule,
} from '../../../utils/certificates'
import { readBlobErrorMessage } from '../../../utils/httpErrors'
import { normalizeProctoringConfig } from '../../../utils/proctoringRequirements'
import { readPaginatedItems } from '../../../utils/pagination'
import useLanguage from '../../../hooks/useLanguage'
import {
  emptyAnswerState,
  questionToAnswerState,
  answerStateToPayload,
  validateAnswerState,
} from '../../../utils/questionPayload'
import AdministrationTab from './tabs/AdministrationTab'
import CandidatesTab from './tabs/CandidatesTab'
import ProctoringTab from './tabs/ProctoringTab'
import QuestionsTab from './tabs/QuestionsTab'
import SectionsManager from '../SectionsManager/SectionsManager'
import ReportsTab from './tabs/ReportsTab'
import SessionsTab from './tabs/SessionsTab'
import SettingsTab from './tabs/SettingsTab'
import styles from './AdminManageTestPage.module.scss'

const TAB_IDS = ['settings', 'sections', 'sessions', 'candidates', 'proctoring', 'administration', 'reports']
const TAB_LABEL_KEYS = {
  settings: 'admin_manage_tab_settings',
  sections: 'admin_manage_tab_sections',
  sessions: 'admin_manage_tab_sessions',
  candidates: 'admin_manage_tab_candidates',
  proctoring: 'admin_manage_tab_proctoring',
  administration: 'admin_manage_tab_administration',
  reports: 'admin_manage_tab_reports',
}
const TABS = TAB_IDS.map((id) => ({ id, label: id }))

const VIDEO_UPLOAD_STATUS_POLL_INTERVAL_MS = 15000
const ACTIVE_VIDEO_UPLOAD_STATUSES = new Set(['queued', 'uploading', 'processing', 'waiting'])
const VIDEO_UPLOAD_POLL_GRACE_WINDOW_MS = 20 * 60 * 1000


const SETTINGS_MENU_GROUP_KEYS = {
  'General': 'admin_manage_group_general',
  'Policies': 'admin_manage_group_policies',
  'Results': 'admin_manage_group_results',
  'Extras': 'admin_manage_group_extras',
}

const SETTINGS_MENU_ITEM_KEYS = {
  'Basic information': 'admin_manage_menu_basic_info',
  'Test instructions dialog settings': 'admin_manage_menu_instructions',
  'Duration and layout': 'admin_manage_menu_duration',
  'Security settings': 'admin_manage_menu_security',
  'Pause, retake and reschedule settings': 'admin_manage_menu_retake',
  'Language settings': 'admin_manage_menu_language',
  'Result validity settings': 'admin_manage_menu_result_validity',
  'Grading configuration': 'admin_manage_menu_grading',
  'Personal report settings': 'admin_manage_menu_personal_report',
  'Score report settings': 'admin_manage_menu_score_report',
  'Certificates': 'admin_manage_menu_certificates',
  'Coupons': 'admin_manage_menu_coupons',
  'Attachments': 'admin_manage_menu_attachments',
  'External attributes': 'admin_manage_menu_external_attrs',
  'Test categories': 'admin_manage_menu_categories',
}

const SETTINGS_MENU_GROUPS = [
  {
    group: 'General',
    items: ['Basic information', 'Test instructions dialog settings', 'Duration and layout'],
  },
  {
    group: 'Policies',
    items: ['Security settings', 'Pause, retake and reschedule settings', 'Language settings'],
  },
  {
    group: 'Results',
    items: ['Result validity settings', 'Grading configuration', 'Personal report settings', 'Score report settings'],
  },
  {
    group: 'Extras',
    items: ['Certificates', 'Coupons', 'Attachments', 'External attributes', 'Test categories'],
  },
]

const SETTINGS_MENU_ITEMS = SETTINGS_MENU_GROUPS.flatMap((group) => group.items)

const MENU_TO_SECTION = {
  'Basic information': 'basic',
  'Test instructions dialog settings': 'instructions',
  'Duration and layout': 'duration',
  'Security settings': 'security',
  'Pause, retake and reschedule settings': 'retake',
  'Language settings': 'language',
  'Result validity settings': 'result-validity',
  'Grading configuration': 'grading',
  'Personal report settings': 'personal-report',
  'Score report settings': 'score-report',
  Certificates: 'certificate',
  Coupons: 'coupons',
  Attachments: 'attachments',
  'External attributes': 'externalattrs',
  'Test categories': 'categories',
}

const SECTION_TO_MENU = Object.fromEntries(
  Object.entries(MENU_TO_SECTION).map(([label, section]) => [section, label]),
)

const DEFAULT_SETTINGS_SECTION = MENU_TO_SECTION['Basic information']
const SETTINGS_SECTION_IDS = Object.values(MENU_TO_SECTION)

const QA_ICONS = {
  preview:  'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
  sessions: 'M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z',
  shield:   'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z',
  reports:  'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z',
  review:   'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
}

const SETTINGS_PAGE_ICONS = {
  instructions: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8M8 9h2',
  duration: 'M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 4h10M9 11h6M9 15h6',
  retake: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M21 12a9 9 0 0 1-3 6.7M21 20v-5h-5',
  security: 'M12 2 5 5v6c0 5 3.4 9.7 7 11 3.6-1.3 7-6 7-11V5l-7-3zm0 6v5m0 3h.01',
  validity: 'M8 2v3M16 2v3M3 7h18M5 5h14a2 2 0 0 1 2 2v11a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a2 2 0 0 1 2-2zm7 6v4l3 2',
  grading: 'M4 5h16M4 12h16M4 19h10M18 17l2 2 4-4',
  certificate: 'M6 3h12l3 4v14H3V7l3-4zm2 0v4h8V3M8 13l2.2 2.2L16 9.4',
  personalReport: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-4.4 0-8 2-8 4.5V21h16v-2.5c0-2.5-3.6-4.5-8-4.5z',
  scoreReport: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
  coupons: 'M20 12a2 2 0 0 1-2 2h-1v3a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-3H6a2 2 0 0 1 0-4h1V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3h1a2 2 0 0 1 2 2zM9 7v10h6V7',
  language: 'M4 5h7M7.5 5A13 13 0 0 1 4 15m7.5-10A13 13 0 0 0 15 15m0 0-3-3m3 3 3-3M12 19l4 0M14 15l2 4',
  attachments: 'M8 12.5 6.6 13.9a3 3 0 0 0 4.2 4.2l6.4-6.4a4.5 4.5 0 0 0-6.4-6.4l-7 7a6 6 0 0 0 8.5 8.5l5.2-5.2',
  external: 'M10 13a5 5 0 0 1 0-7l1.5-1.5a5 5 0 0 1 7 7L17 13M14 11a5 5 0 0 1 0 7L12.5 19.5a5 5 0 0 1-7-7L7 11',
  categories: 'M5 4h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm1 5h12M8 13h6M8 17h6',
}

const PROCTORING_MONITOR_KEYS = [
  'face_detection',
  'multi_face',
  'eye_tracking',
  'head_pose_detection',
  'audio_detection',
  'object_detection',
]

const LOCKDOWN_KEYS = ['fullscreen_enforce', 'tab_switch_detect', 'copy_paste_block']

const LANGUAGE_OPTION_KEYS = [
  { value: '', key: 'settings_select_language' },
  { value: 'en', key: 'english' },
  { value: 'ar', key: 'arabic' },
  { value: 'fr', key: 'french' },
  { value: 'es', key: 'spanish' },
  { value: 'de', key: 'german' },
  { value: 'pt', key: 'portuguese' },
  { value: 'zh', key: 'chinese' },
]

const REPORT_DISPLAY_OPTION_KEYS = [
  { value: 'IMMEDIATELY_AFTER_GRADING', key: 'report_display_after_grading' },
  { value: 'IMMEDIATELY_AFTER_FINISHING', key: 'report_display_after_finishing' },
  { value: 'ON_MANAGER_APPROVAL', key: 'report_display_on_approval' },
]

const REPORT_CONTENT_OPTION_KEYS = [
  { value: 'SCORE_AND_DETAILS', key: 'report_content_score_details' },
  { value: 'SCORE_ONLY', key: 'report_content_score_only' },
]

const PERSONAL_REPORT_LEFT_FLAG_KEYS = [
  ['show_score_report', 'report_flag_display_score'],
  ['display_subscores_by_pool', 'report_flag_display_subscores_pool'],
  ['display_section_scores', 'report_flag_display_section_scores'],
  ['display_percentage_required_to_pass', 'report_flag_display_pct_to_pass'],
  ['display_employee_id', 'report_flag_display_employee_id'],
  ['display_achieved_score_summary', 'report_flag_display_achieved_summary'],
  ['display_score_description', 'report_flag_display_score_desc'],
]

const PERSONAL_REPORT_RIGHT_FLAG_KEYS = [
  ['show_pass_fail_info', 'report_flag_show_pass_fail'],
  ['display_score_each_question', 'report_flag_display_score_each_q'],
  ['display_instructor_notes', 'report_flag_display_instructor_notes'],
  ['display_candidate_groups', 'report_flag_display_candidate_groups'],
  ['show_full_timestamps', 'report_flag_show_timestamps'],
  ['show_rounded_scores', 'report_flag_show_rounded_scores'],
]

const PERSONAL_REPORT_EXPORT_FLAG_KEYS = [
  ['export_personal_report_excel', 'report_export_excel'],
  ['export_personal_report_pdf', 'report_export_pdf'],
  ['enable_score_report_download', 'report_export_score_download'],
  ['enable_knowledge_deficiency_report_download', 'report_export_deficiency'],
]

const ATTACHMENT_TYPE_OPTION_KEYS = [
  { value: 'LINK', key: 'attachment_type_link' },
  { value: 'PDF', key: 'attachment_type_pdf' },
  { value: 'DOC', key: 'attachment_type_doc' },
  { value: 'IMAGE', key: 'attachment_type_image' },
  { value: 'VIDEO', key: 'attachment_type_video' },
]

const DEFAULT_SCORE_REPORT_SETTINGS = {
  heading: 'Score report',
  intro: '',
  include_candidate_summary: true,
  include_section_breakdown: true,
  include_proctoring_summary: false,
  include_certificate_status: false,
  include_pass_fail_badge: true,
}

const EMPTY_TRANSLATION_DRAFT = {
  language: 'ar',
  title: '',
  description: '',
  instructions_body: '',
  completion_message: '',
}

const EMPTY_ATTACHMENT_DRAFT = {
  title: '',
  url: '',
  type: 'LINK',
}

const EMPTY_COUPON_GENERATOR = {
  prefix: 'SAVE',
  count: '5',
  discount_type: 'percentage',
  amount: '10',
  expiration_time: '',
}

const EMPTY_COUPON_FILTERS = {
  code: '',
  discount_type: '',
  amount: '',
  status: '',
  expiration_time: '',
  used_by: '',
  date_of_use: '',
  created_by: '',
}

const EMPTY_CATEGORY_DRAFT = {
  name: '',
  description: '',
}

const QUESTION_TYPES = ['MCQ', 'MULTI', 'TRUEFALSE', 'ORDERING', 'FILLINBLANK', 'MATCHING', 'TEXT']

const PROCTOR_BOOLEAN_KEYS = [
  'fullscreen_enforce',
  'tab_switch_detect',
  'lighting_required',
  'copy_paste_block',
  'face_detection',
  'multi_face',
  'eye_tracking',
  'head_pose_detection',
  'audio_detection',
  'object_detection',
  'screen_capture',
]

const PROCTOR_LABEL_KEYS = {
  fullscreen_enforce: 'proctor_label_fullscreen_enforce',
  tab_switch_detect: 'proctor_label_tab_switch_detect',
  lighting_required: 'proctor_label_lighting_required',
  copy_paste_block: 'proctor_label_copy_paste_block',
  face_detection: 'proctor_label_face_detection',
  multi_face: 'proctor_label_multi_face',
  eye_tracking: 'proctor_label_eye_tracking',
  head_pose_detection: 'proctor_label_head_pose_detection',
  audio_detection: 'proctor_label_audio_detection',
  object_detection: 'proctor_label_object_detection',
  screen_capture: 'proctor_label_screen_capture',
}

const TAB_ALIASES = {
  'test-sections': 'sections',
  'testing-sessions': 'sessions',
  'test-administration': 'administration',
}

function normalizeTabParam(search) {
  const raw = new URLSearchParams(search).get('tab')
  const normalized = TAB_ALIASES[raw] || raw
  return TABS.some((item) => item.id === normalized) ? normalized : 'settings'
}

function normalizeSettingsSectionParam(search) {
  const raw = new URLSearchParams(search).get('section')
  return SETTINGS_SECTION_IDS.includes(raw) ? raw : DEFAULT_SETTINGS_SECTION
}

function readRefreshAttemptParam(search) {
  return new URLSearchParams(search).get('refreshAttempt') || ''
}

function isManageRoutePath(pathname) {
  return /^\/admin\/tests\/[^/]+\/manage$/.test(pathname || '')
}

function isCanceledRequest(error) {
  return error?.name === 'AbortError' || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED'
}

function readRequestError(error, fallback) {
  const detail = error?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return detail.trim()
  if (Array.isArray(detail) && detail.length > 0) {
    return detail.map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') return item.msg || item.message || 'Validation error'
      return 'Validation error'
    }).join('; ')
  }
  if (detail && typeof detail === 'object') return detail.msg || detail.message || fallback
  return error?.message || fallback
}

const emptyQuestionForm = () => ({
  text: '',
  question_type: 'MCQ',
  answer: emptyAnswerState('MCQ'),
  points: '1',
  order: '0',
  image_url: null,
})

const EMPTY_SESSION_FORM = {
  user_id: '',
  scheduled_at: '',
  access_mode: 'OPEN',
  notes: '',
}

function formatAttemptStatus(row) {
  if (row.paused) return 'PAUSED'
  if (row.status === 'NOT_STARTED') return 'NOT STARTED'
  return row.status || '-'
}

function formatScore(score) {
  if (score == null || Number.isNaN(Number(score))) return '-'
  const numeric = Number(score)
  return Number.isInteger(numeric) ? `${numeric}%` : `${numeric.toFixed(2)}%`
}

function clampVideoUploadPercent(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.min(100, Math.round(numeric)))
}

function normalizeVideoUploadSourceSummary(item) {
  if (!item || typeof item !== 'object') return null
  const source = String(item.source || 'camera').trim().toLowerCase() || 'camera'
  const progressPercent = clampVideoUploadPercent(item.progress_percent)
  return {
    source,
    label: String(item.label || `${source.charAt(0).toUpperCase()}${source.slice(1)}`),
    progressPercent,
    remainingPercent: Math.max(0, 100 - progressPercent),
    status: String(item.status || 'not_started').trim().toLowerCase() || 'not_started',
    hasSavedVideo: Boolean(item.has_saved_video),
  }
}

function normalizeVideoUploadStatus(item) {
  const sources = Array.isArray(item?.sources)
    ? item.sources.map((entry) => normalizeVideoUploadSourceSummary(entry)).filter(Boolean)
    : []
  const fallbackPercent = sources.length > 0
    ? Math.round(sources.reduce((sum, source) => sum + source.progressPercent, 0) / sources.length)
    : 0
  const uploadPercent = clampVideoUploadPercent(item?.upload_percent ?? fallbackPercent)
  const requiredSources = Array.isArray(item?.required_sources)
    ? item.required_sources.map((source) => String(source || '').trim().toLowerCase()).filter(Boolean)
    : []

  return {
    hasVideo: Boolean(item?.has_video),
    savedVideoCount: Number(item?.saved_video_count || 0),
    uploadPercent,
    remainingPercent: Math.max(0, 100 - uploadPercent),
    uploading: Boolean(item?.uploading),
    uploadStatus: String(item?.status || 'not_started').trim().toLowerCase() || 'not_started',
    uploadStatusLabel: String(item?.status_label || (uploadPercent > 0 ? 'Uploading in background' : 'Not started')),
    uploadSources: sources,
    requiredVideoSources: requiredSources,
    allRequiredVideosUploaded: Boolean(item?.all_required_uploaded),
  }
}

function defaultVideoUploadStatus() {
  return {
    hasVideo: false,
    savedVideoCount: 0,
    uploadPercent: 0,
    remainingPercent: 100,
    uploading: false,
    uploadStatus: 'not_started',
    uploadStatusLabel: 'Not started',
    uploadSources: [],
    requiredVideoSources: [],
    allRequiredVideosUploaded: false,
  }
}

function applyVideoUploadStatus(row, rawStatus) {
  const status = rawStatus || defaultVideoUploadStatus()
  return {
    ...row,
    hasVideo: status.hasVideo,
    savedVideoCount: status.savedVideoCount,
    uploadPercent: status.uploadPercent,
    remainingPercent: status.remainingPercent,
    uploading: status.uploading,
    uploadStatus: status.uploadStatus,
    uploadStatusLabel: status.uploadStatusLabel,
    uploadSources: status.uploadSources,
    requiredVideoSources: status.requiredVideoSources,
    allRequiredVideosUploaded: status.allRequiredVideosUploaded,
  }
}

function shouldPollRowVideoUploadStatus(row) {
  const status = String(row?.uploadStatus || '').trim().toLowerCase()
  if (status === 'not_started' || status === 'complete' || status === 'error') return false
  if (!ACTIVE_VIDEO_UPLOAD_STATUSES.has(status)) return false
  if (status !== 'waiting') return true

  const submittedAtMs = new Date(row?.submittedAt || row?.startedAt || 0).getTime()
  if (!Number.isFinite(submittedAtMs) || submittedAtMs <= 0) return false
  return (Date.now() - submittedAtMs) <= VIDEO_UPLOAD_POLL_GRACE_WINDOW_MS
}

function shouldBootstrapRowVideoUploadStatus(row) {
  if (shouldPollRowVideoUploadStatus(row)) return true

  const attemptStatus = String(row?.status || '').trim().toUpperCase()
  if (!['IN_PROGRESS', 'SUBMITTED', 'GRADED'].includes(attemptStatus)) return false

  // Always bootstrap for attempts that haven't fetched upload status yet.
  // The initial render creates rows with uploadStatus='not_started' which
  // may be wrong — the only way to know the real status is to ask the API.
  const currentUploadStatus = String(row?.uploadStatus || '').trim().toLowerCase()
  if (currentUploadStatus === 'not_started' || !currentUploadStatus) return true

  const referenceMs = new Date(row?.submittedAt || row?.startedAt || 0).getTime()
  if (!Number.isFinite(referenceMs) || referenceMs <= 0) return true
  return (Date.now() - referenceMs) <= VIDEO_UPLOAD_POLL_GRACE_WINDOW_MS
}

function safeJsonParse(value, fallback = null) {
  if (value == null || value === '') return fallback
  try { return JSON.parse(value) } catch { return '__INVALID__' }
}

function questionTypeOf(q) {
  return q?.question_type || q?.type || 'TEXT'
}

function sanitizeFilename(v) {
  return String(v || 'report').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'report'
}

function formatMetadataDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getBrandInitials(value) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'SY'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase()
}

function buildLocalId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function languageLabelOf(value, languageOptions) {
  return languageOptions.find((option) => option.value === value)?.label || String(value || '').trim() || 'Custom'
}

function attachmentTitleFromUrl(url, fallbackIndex = 1) {
  const raw = String(url || '').trim()
  if (!raw) return `Attachment ${fallbackIndex}`
  try {
    const parsed = new URL(raw)
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop()
    return decodeURIComponent(lastSegment || parsed.hostname || `Attachment ${fallbackIndex}`)
  } catch {
    const lastSegment = raw.split('/').filter(Boolean).pop()
    return decodeURIComponent(lastSegment || `Attachment ${fallbackIndex}`)
  }
}

function normalizeCertificatePayload(value) {
  const payload = {
    title: String(value?.title || '').trim(),
    subtitle: String(value?.subtitle || '').trim(),
    issuer: String(value?.issuer || '').trim(),
    signer: String(value?.signer || '').trim(),
    issue_rule: normalizeCertificateIssueRule(value?.issue_rule),
  }
  const hasContent = Object.entries(payload).some(([key, item]) => key !== 'issue_rule' && Boolean(item))
  return hasContent ? payload : null
}

function normalizeTranslationEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const normalized = {
    id: String(entry.id || buildLocalId('translation')),
    language: String(entry.language || '').trim(),
    title: String(entry.title || '').trim(),
    description: String(entry.description || '').trim(),
    instructions_body: String(entry.instructions_body || '').trim(),
    completion_message: String(entry.completion_message || '').trim(),
  }
  if (!normalized.language) return null
  if (!normalized.title && !normalized.description && !normalized.instructions_body && !normalized.completion_message) {
    return null
  }
  return normalized
}

function normalizeAttachmentEntry(entry, fallbackIndex = 1) {
  if (!entry || typeof entry !== 'object') return null
  const url = String(entry.url || '').trim()
  if (!url) return null
  const type = ATTACHMENT_TYPE_OPTION_KEYS.some((option) => option.value === entry.type) ? entry.type : 'LINK'
  return {
    id: String(entry.id || buildLocalId('attachment')),
    title: String(entry.title || '').trim() || attachmentTitleFromUrl(url, fallbackIndex),
    url,
    type,
  }
}

function normalizeAttachmentEntries(rawItems, legacyUrls) {
  if (Array.isArray(rawItems) && rawItems.length) {
    return rawItems
      .map((entry, index) => normalizeAttachmentEntry(entry, index + 1))
      .filter(Boolean)
  }
  const urls = Array.isArray(legacyUrls)
    ? legacyUrls
    : String(legacyUrls || '')
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
  return urls
    .map((url, index) => normalizeAttachmentEntry({ url }, index + 1))
    .filter(Boolean)
}

function normalizeCouponEntry(entry, fallbackIndex = 1) {
  if (!entry || typeof entry !== 'object') return null
  const code = String(entry.code || '').trim().toUpperCase()
  if (!code) return null
  const amount = Number(entry.amount)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const discountType = entry.discount_type === 'fixed' ? 'fixed' : 'percentage'
  return {
    id: String(entry.id || buildLocalId('coupon')),
    code,
    discount_type: discountType,
    amount,
    status: String(entry.status || 'Draft').trim() || 'Draft',
    expiration_time: String(entry.expiration_time || '').trim(),
    used_by: String(entry.used_by || '').trim(),
    date_of_use: String(entry.date_of_use || '').trim(),
    created_by: String(entry.created_by || `Admin ${fallbackIndex}`).trim(),
  }
}

function normalizeCouponEntries(rawEntries, legacyCode, legacyType, legacyValue, createdBy) {
  if (Array.isArray(rawEntries) && rawEntries.length) {
    return rawEntries
      .map((entry, index) => normalizeCouponEntry(entry, index + 1))
      .filter(Boolean)
  }
  const code = String(legacyCode || '').trim()
  const amount = Number(legacyValue)
  if (!code || !Number.isFinite(amount) || amount <= 0) return []
  return [
    normalizeCouponEntry({
      code,
      discount_type: legacyType === 'fixed' ? 'fixed' : 'percentage',
      amount,
      status: 'Draft',
      created_by: createdBy || 'Admin',
    }, 1),
  ].filter(Boolean)
}

function normalizeScoreReportSettings(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    heading: String(raw.heading || DEFAULT_SCORE_REPORT_SETTINGS.heading),
    intro: String(raw.intro || DEFAULT_SCORE_REPORT_SETTINGS.intro),
    include_candidate_summary: raw.include_candidate_summary == null
      ? DEFAULT_SCORE_REPORT_SETTINGS.include_candidate_summary
      : Boolean(raw.include_candidate_summary),
    include_section_breakdown: raw.include_section_breakdown == null
      ? DEFAULT_SCORE_REPORT_SETTINGS.include_section_breakdown
      : Boolean(raw.include_section_breakdown),
    include_proctoring_summary: Boolean(raw.include_proctoring_summary),
    include_certificate_status: Boolean(raw.include_certificate_status),
    include_pass_fail_badge: raw.include_pass_fail_badge == null
      ? DEFAULT_SCORE_REPORT_SETTINGS.include_pass_fail_badge
      : Boolean(raw.include_pass_fail_badge),
  }
}

function sanitizeCouponPrefix(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 10) || 'SAVE'
}

function stripAdminMeta(settings) {
  if (!settings || typeof settings !== 'object') return {}
  const next = { ...settings }
  delete next._admin_test
  return next
}

function mergeExamAndTest(examData, testData) {
  if (!examData && !testData) return null
  const settings = testData?.runtime_settings ?? stripAdminMeta(examData?.settings)
  return {
    ...(examData || {}),
    ...(testData || {}),
    id: examData?.id || testData?.id,
    title: testData?.name || examData?.title || '',
    name: testData?.name || examData?.title || '',
    description: testData?.description ?? examData?.description ?? '',
    exam_type: testData?.type || examData?.exam_type || examData?.type || 'MCQ',
    type: testData?.type || examData?.exam_type || examData?.type || 'MCQ',
    status: testData?.status || (examData?.status === 'OPEN' ? 'PUBLISHED' : examData?.status === 'CLOSED' ? 'ARCHIVED' : 'DRAFT'),
    runtime_status: testData?.runtime_status || examData?.status || 'CLOSED',
    code: testData?.code || '',
    course_id: testData?.course_id || examData?.course_id || '',
    course_title: testData?.course_title || examData?.course_title || '',
    time_limit_minutes: testData?.time_limit_minutes ?? examData?.time_limit_minutes ?? examData?.time_limit ?? '',
    max_attempts: testData?.attempts_allowed ?? testData?.max_attempts ?? examData?.max_attempts ?? 1,
    attempts_allowed: testData?.attempts_allowed ?? testData?.max_attempts ?? examData?.max_attempts ?? 1,
    passing_score: testData?.passing_score ?? examData?.passing_score ?? null,
    grading_scale_id: testData?.grading_scale_id ?? examData?.grading_scale_id ?? '',
    report_content: testData?.report_content || examData?.report_content || 'SCORE_AND_DETAILS',
    report_displayed: testData?.report_displayed || examData?.report_displayed || 'IMMEDIATELY_AFTER_GRADING',
    settings,
    proctoring_config: normalizeProctoringConfig(testData?.proctoring_config || examData?.proctoring_config || {}),
    certificate: testData?.certificate || examData?.certificate || null,
  }
}

export default function AdminManageTestPage() {
  const { id } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { t } = useLanguage()

  const languageOptions = useMemo(() => LANGUAGE_OPTION_KEYS.map((opt) => ({ value: opt.value, label: t(opt.key) })), [t])
  const reportDisplayOptions = useMemo(() => REPORT_DISPLAY_OPTION_KEYS.map((opt) => ({ value: opt.value, label: t(opt.key) })), [t])
  const reportContentOptions = useMemo(() => REPORT_CONTENT_OPTION_KEYS.map((opt) => ({ value: opt.value, label: t(opt.key) })), [t])
  const personalReportLeftFlags = useMemo(() => PERSONAL_REPORT_LEFT_FLAG_KEYS.map(([field, key]) => [field, t(key)]), [t])
  const personalReportRightFlags = useMemo(() => PERSONAL_REPORT_RIGHT_FLAG_KEYS.map(([field, key]) => [field, t(key)]), [t])
  const personalReportExportFlags = useMemo(() => PERSONAL_REPORT_EXPORT_FLAG_KEYS.map(([field, key]) => [field, t(key)]), [t])
  const attachmentTypeOptions = useMemo(() => ATTACHMENT_TYPE_OPTION_KEYS.map((opt) => ({ value: opt.value, label: t(opt.key) })), [t])

  const [tab, setTab] = useState(() => normalizeTabParam(location.search))
  const [settingsSection, setSettingsSection] = useState(() => normalizeSettingsSectionParam(location.search))
  const refreshAttemptId = readRefreshAttemptParam(location.search)
  const [view, setView] = useState('candidate_monitoring')
  const [showFilters, setShowFilters] = useState(true)

  const [exam, setExam] = useState(null)
  const [users, setUsers] = useState([])
  const [questions, setQuestions] = useState([])
  const [sessions, setSessions] = useState([])
  const [attemptRows, setAttemptRows] = useState([])

  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')

  const [savingSettings, setSavingSettings] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkAction, setBulkAction] = useState('')
  const [rowBusy, setRowBusy] = useState({})
  const [gradeDrafts, setGradeDrafts] = useState({})
  const [deleteQuestionId, setDeleteQuestionId] = useState(null)
  const [deleteSessionId, setDeleteSessionId] = useState(null)
  const [deleteExamConfirm, setDeleteExamConfirm] = useState(false)
  const [deletingQuestionBusyId, setDeletingQuestionBusyId] = useState(null)
  const [deletingSessionBusyId, setDeletingSessionBusyId] = useState(null)
  const [deletingExamBusy, setDeletingExamBusy] = useState(false)

  const [selectedSession, setSelectedSession] = useState('')
  const [search, setSearch] = useState({ attempt: '', user: '', session: '', status: '', group: '', comment: '' })
  const [reportsBusy, setReportsBusy] = useState(false)
  const [categories, setCategories] = useState([])

  const [settingsForm, setSettingsFormState] = useState({
    title: '',
    description: '',
    time_limit_minutes: '',
    max_attempts: '1',
    passing_score: '',
    code: '',
    proctoring_config: {},
    instructions: '',
    instructions_heading: '',
    instructions_body: '',
    completion_message: '',
    instructions_require_acknowledgement: false,
    show_test_instructions: true,
    show_test_duration: true,
    show_passing_mark: true,
    show_question_count: true,
    show_remaining_retakes: false,
    show_score_report: false,
    show_answer_review: false,
    show_correct_answers: false,
    email_result_on_submit: false,
    report_displayed: 'IMMEDIATELY_AFTER_GRADING',
    report_content: 'SCORE_AND_DETAILS',
    duration_type: 'Time defined in each section',
    hide_assignment_metadata: false,
    hide_finish_until_last_question: false,
    enforce_section_order: false,
    calculator_type: 'No calculator',
    settings_json: '',
    certificate_json: '',
    certificate_title: '',
    certificate_subtitle: '',
    certificate_issuer: '',
    certificate_signer: '',
    certificate_issue_rule: DEFAULT_CERTIFICATE_ISSUE_RULE,
    allow_pause: false,
    pause_duration_minutes: '',
    allow_retake: false,
    retake_cooldown_hours: '',
    reschedule_policy: 'NOT_ALLOWED',
    limited_free_reschedules: false,
    network_access: 'ALL_NETWORKS',
    auto_logout_after_finish_or_pause: false,
    require_profile_update: false,
    result_validity_period_enabled: false,
    result_validity_days: '',
    passing_mark_inclusive: true,
    require_positive_proctoring_report: false,
    show_advanced_grading: false,
    custom_score_report_enabled: false,
    score_report_heading: DEFAULT_SCORE_REPORT_SETTINGS.heading,
    score_report_intro: DEFAULT_SCORE_REPORT_SETTINGS.intro,
    score_report_include_candidate_summary: DEFAULT_SCORE_REPORT_SETTINGS.include_candidate_summary,
    score_report_include_section_breakdown: DEFAULT_SCORE_REPORT_SETTINGS.include_section_breakdown,
    score_report_include_proctoring_summary: DEFAULT_SCORE_REPORT_SETTINGS.include_proctoring_summary,
    score_report_include_certificate_status: DEFAULT_SCORE_REPORT_SETTINGS.include_certificate_status,
    score_report_include_pass_fail_badge: DEFAULT_SCORE_REPORT_SETTINGS.include_pass_fail_badge,
    report_lifespan_enabled: false,
    report_access_duration_enabled: false,
    display_subscores_by_pool: false,
    display_section_scores: false,
    display_percentage_required_to_pass: false,
    display_employee_id: false,
    display_achieved_score_summary: false,
    display_score_description: false,
    show_pass_fail_info: false,
    display_score_each_question: false,
    display_instructor_notes: false,
    display_candidate_groups: false,
    show_full_timestamps: false,
    show_rounded_scores: false,
    export_personal_report_excel: false,
    export_personal_report_pdf: false,
    enable_score_report_download: false,
    enable_knowledge_deficiency_report_download: false,
    coupons_enabled: false,
    coupon_code: '',
    coupon_discount_type: 'percentage',
    coupon_discount_value: '',
    coupon_entries: [],
    language: 'en',
    allow_language_override: false,
    attachment_urls: '',
    attachment_items: [],
    test_translations: [],
    external_attributes_json: '',
    external_id: '',
    category_id: '',
    descriptive_label: '',
    creation_type: 'Test with sections',
    section_count: '0',
    allow_section_selection: false,
  })
  const settingsFormRef = useRef(settingsForm)
  const settingsBaselineRef = useRef(JSON.stringify(settingsForm))
  const examRef = useRef(exam)
  const usersRef = useRef(users)
  const sessionsRef = useRef(sessions)
  const attemptRowsRef = useRef(attemptRows)
  const categoriesRef = useRef(categories)
  const loadAbortRef = useRef(null)
  const uploadStatusPollAbortRef = useRef(null)
  const uploadStatusPollBusyRef = useRef(false)
  const setSettingsForm = useCallback((updater) => {
    setSettingsFormState((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      settingsFormRef.current = next
      return next
    })
  }, [])
  const serializeSettingsForm = useCallback((form) => JSON.stringify(form), [])

  const [editingAccomId, setEditingAccomId] = useState(null)
  const [editingAccomForm, setEditingAccomForm] = useState({ access_mode: 'OPEN', notes: '', scheduled_at: '' })
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)
  const [categoryDraft, setCategoryDraft] = useState(EMPTY_CATEGORY_DRAFT)
  const [categoryBusy, setCategoryBusy] = useState(false)
  const [categoryError, setCategoryError] = useState('')
  const [translationDraft, setTranslationDraft] = useState(EMPTY_TRANSLATION_DRAFT)
  const [editingTranslationId, setEditingTranslationId] = useState(null)
  const [translationError, setTranslationError] = useState('')
  const [showTranslationEditor, setShowTranslationEditor] = useState(false)
  const [attachmentDraft, setAttachmentDraft] = useState(EMPTY_ATTACHMENT_DRAFT)
  const [editingAttachmentId, setEditingAttachmentId] = useState(null)
  const [attachmentError, setAttachmentError] = useState('')
  const [showAttachmentEditor, setShowAttachmentEditor] = useState(false)
  const [attachmentImportText, setAttachmentImportText] = useState('')
  const [attachmentImportError, setAttachmentImportError] = useState('')
  const [showAttachmentImporter, setShowAttachmentImporter] = useState(false)
  const [couponGenerator, setCouponGenerator] = useState(EMPTY_COUPON_GENERATOR)
  const [couponFilters, setCouponFilters] = useState(EMPTY_COUPON_FILTERS)
  const [couponError, setCouponError] = useState('')
  const [showCouponGenerator, setShowCouponGenerator] = useState(false)
  const [certificateView, setCertificateView] = useState('detail')
  const [showCertificateEditor, setShowCertificateEditor] = useState(false)
  const [showCertificateSync, setShowCertificateSync] = useState(false)
  const [certificateSyncSourceId, setCertificateSyncSourceId] = useState('')
  const [certificateSyncOptions, setCertificateSyncOptions] = useState([])
  const [certificateSyncLoading, setCertificateSyncLoading] = useState(false)
  const [certificateSyncError, setCertificateSyncError] = useState('')

  const [questionForm, setQuestionForm] = useState(emptyQuestionForm())
  const [editingQuestionId, setEditingQuestionId] = useState('')
  const [questionSearch, setQuestionSearch] = useState('')
  const [questionBusy, setQuestionBusy] = useState(false)

  const [sessionForm, setSessionForm] = useState(EMPTY_SESSION_FORM)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [savingAccomId, setSavingAccomId] = useState(null)

  useEffect(() => {
    const normalized = normalizeTabParam(location.search)
    if (normalized !== tab) {
      setTab(normalized)
    }
  }, [location.search, tab])

  useEffect(() => {
    const normalized = normalizeSettingsSectionParam(location.search)
    if (normalized !== settingsSection) {
      setSettingsSection(normalized)
    }
  }, [location.search, settingsSection])

  useEffect(() => {
    settingsFormRef.current = settingsForm
  }, [settingsForm])

  useEffect(() => {
    examRef.current = exam
  }, [exam])

  useEffect(() => {
    usersRef.current = users
  }, [users])

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    attemptRowsRef.current = attemptRows
  }, [attemptRows])

  useEffect(() => {
    categoriesRef.current = categories
  }, [categories])

  const handleTabChange = useCallback((nextTab, nextSection = settingsSection) => {
    if (!TABS.some((item) => item.id === nextTab)) return
    const resolvedSection = SETTINGS_SECTION_IDS.includes(nextSection) ? nextSection : DEFAULT_SETTINGS_SECTION
    setTab(nextTab)
    const params = new URLSearchParams(location.search)
    if (nextTab === 'settings') params.delete('tab')
    else params.set('tab', nextTab)
    if (resolvedSection === DEFAULT_SETTINGS_SECTION) params.delete('section')
    else params.set('section', resolvedSection)
    const search = params.toString()
    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : '',
      },
      { replace: true },
    )
  }, [location.pathname, location.search, navigate, settingsSection])

  const hydrateSettingsForm = useCallback((ex) => {
    const cfg = normalizeProctoringConfig(ex?.proctoring_config || {})
    const s = ex?.runtime_settings ?? stripAdminMeta(ex?.settings)
    const certificate = normalizeCertificatePayload(ex?.certificate)
    const scoreReportSettings = normalizeScoreReportSettings(s?.score_report_settings)
    const attachmentItems = normalizeAttachmentEntries(s?.attachment_items, s?.attachment_urls)
    const couponEntries = normalizeCouponEntries(s?.coupon_entries, s?.coupon_code, s?.coupon_discount_type, s?.coupon_discount_value, 'Admin')
    const translationItems = Array.isArray(s?.test_translations)
      ? s.test_translations.map((entry) => normalizeTranslationEntry(entry)).filter(Boolean)
      : []
    const externalAttributes = s?.external_attributes && typeof s.external_attributes === 'object' && !Array.isArray(s.external_attributes)
      ? s.external_attributes
      : null
    const nextForm = {
      title: ex?.title || '',
      description: ex?.description || '',
      code: ex?.code || '',
      time_limit_minutes: String(ex?.time_limit_minutes ?? ex?.time_limit ?? ''),
      max_attempts: String(ex?.max_attempts ?? 1),
      passing_score: ex?.passing_score == null ? '' : String(ex.passing_score),
      proctoring_config: cfg,
      instructions: s.instructions || '',
      instructions_heading: s.instructions_heading || '',
      instructions_body: s.instructions_body || s.instructions || '',
      completion_message: s.completion_message || '',
      instructions_require_acknowledgement: Boolean(s.instructions_require_acknowledgement),
      show_test_instructions: s?.show_test_instructions == null ? true : Boolean(s.show_test_instructions),
      show_test_duration: s?.show_test_duration == null ? true : Boolean(s.show_test_duration),
      show_passing_mark: s?.show_passing_mark == null ? true : Boolean(s.show_passing_mark),
      show_question_count: s?.show_question_count == null ? true : Boolean(s.show_question_count),
      show_remaining_retakes: Boolean(s.show_remaining_retakes),
      show_score_report: Boolean(s.show_score_report),
      show_answer_review: Boolean(s.show_answer_review),
      show_correct_answers: Boolean(s.show_correct_answers),
      email_result_on_submit: Boolean(s.email_result_on_submit),
      report_displayed: ex?.report_displayed || 'IMMEDIATELY_AFTER_GRADING',
      report_content: ex?.report_content || 'SCORE_AND_DETAILS',
      duration_type: s?.duration_type || 'Time defined in each section',
      hide_assignment_metadata: Boolean(s.hide_assignment_metadata),
      hide_finish_until_last_question: Boolean(s.hide_finish_until_last_question),
      enforce_section_order: Boolean(s.enforce_section_order),
      calculator_type: s?.calculator_type || 'No calculator',
      settings_json: Object.keys(s || {}).length ? JSON.stringify(s, null, 2) : '',
      certificate_json: certificate ? JSON.stringify(certificate, null, 2) : '',
      certificate_title: certificate?.title || '',
      certificate_subtitle: certificate?.subtitle || '',
      certificate_issuer: certificate?.issuer || '',
      certificate_signer: certificate?.signer || '',
      certificate_issue_rule: normalizeCertificateIssueRule(certificate?.issue_rule),
      allow_pause: Boolean(s?.allow_pause),
      pause_duration_minutes: s?.pause_duration_minutes != null ? String(s.pause_duration_minutes) : '',
      allow_retake: Boolean(s?.allow_retake),
      retake_cooldown_hours: s?.retake_cooldown_hours != null ? String(s.retake_cooldown_hours) : '',
      reschedule_policy: s?.reschedule_policy || 'NOT_ALLOWED',
      limited_free_reschedules: Boolean(s?.limited_free_reschedules),
      network_access: s?.network_access || 'ALL_NETWORKS',
      auto_logout_after_finish_or_pause: Boolean(s?.auto_logout_after_finish_or_pause),
      require_profile_update: Boolean(s?.require_profile_update),
      result_validity_period_enabled: Boolean(s?.result_validity_period_enabled),
      result_validity_days: s?.result_validity_days != null ? String(s.result_validity_days) : '',
      passing_mark_inclusive: s?.passing_mark_inclusive == null ? true : Boolean(s.passing_mark_inclusive),
      require_positive_proctoring_report: Boolean(s?.require_positive_proctoring_report),
      show_advanced_grading: Boolean(s?.show_advanced_grading),
      custom_score_report_enabled: Boolean(s?.custom_score_report_enabled),
      score_report_heading: scoreReportSettings.heading,
      score_report_intro: scoreReportSettings.intro,
      score_report_include_candidate_summary: scoreReportSettings.include_candidate_summary,
      score_report_include_section_breakdown: scoreReportSettings.include_section_breakdown,
      score_report_include_proctoring_summary: scoreReportSettings.include_proctoring_summary,
      score_report_include_certificate_status: scoreReportSettings.include_certificate_status,
      score_report_include_pass_fail_badge: scoreReportSettings.include_pass_fail_badge,
      report_lifespan_enabled: Boolean(s?.report_lifespan_enabled),
      report_access_duration_enabled: Boolean(s?.report_access_duration_enabled),
      display_subscores_by_pool: Boolean(s?.display_subscores_by_pool),
      display_section_scores: Boolean(s?.display_section_scores),
      display_percentage_required_to_pass: Boolean(s?.display_percentage_required_to_pass),
      display_employee_id: Boolean(s?.display_employee_id),
      display_achieved_score_summary: Boolean(s?.display_achieved_score_summary),
      display_score_description: Boolean(s?.display_score_description),
      show_pass_fail_info: Boolean(s?.show_pass_fail_info),
      display_score_each_question: Boolean(s?.display_score_each_question),
      display_instructor_notes: Boolean(s?.display_instructor_notes),
      display_candidate_groups: Boolean(s?.display_candidate_groups),
      show_full_timestamps: Boolean(s?.show_full_timestamps),
      show_rounded_scores: Boolean(s?.show_rounded_scores),
      export_personal_report_excel: Boolean(s?.export_personal_report_excel),
      export_personal_report_pdf: Boolean(s?.export_personal_report_pdf),
      enable_score_report_download: Boolean(s?.enable_score_report_download),
      enable_knowledge_deficiency_report_download: Boolean(s?.enable_knowledge_deficiency_report_download),
      coupons_enabled: Boolean(s?.coupons_enabled),
      coupon_code: couponEntries[0]?.code || s?.coupon_code || '',
      coupon_discount_type: couponEntries[0]?.discount_type || s?.coupon_discount_type || 'percentage',
      coupon_discount_value: couponEntries[0]?.amount != null ? String(couponEntries[0].amount) : (s?.coupon_discount_value != null ? String(s.coupon_discount_value) : ''),
      coupon_entries: couponEntries,
      language: s?.language || 'en',
      allow_language_override: Boolean(s?.allow_language_override),
      attachment_urls: attachmentItems.map((item) => item.url).join('\n'),
      attachment_items: attachmentItems,
      test_translations: translationItems,
      external_attributes_json: externalAttributes ? JSON.stringify(externalAttributes, null, 2) : '',
      external_id: externalAttributes?.external_id || s?.external_id || '',
      category_id: String(ex?.category_id || ''),
      descriptive_label: s?.descriptive_label || '',
      creation_type: s?.creation_type || 'Test with sections',
      section_count: s?.section_count != null ? String(s.section_count) : String(ex?.question_count ?? 0),
      allow_section_selection: Boolean(s?.allow_section_selection),
    }
    setSettingsForm(nextForm)
    settingsBaselineRef.current = serializeSettingsForm(nextForm)
    setShowCategoryPicker(false)
    setCategoryDraft(EMPTY_CATEGORY_DRAFT)
    setCategoryError('')
    setShowTranslationEditor(false)
    setTranslationDraft(EMPTY_TRANSLATION_DRAFT)
    setEditingTranslationId(null)
    setTranslationError('')
    setShowAttachmentEditor(false)
    setAttachmentDraft(EMPTY_ATTACHMENT_DRAFT)
    setEditingAttachmentId(null)
    setAttachmentError('')
    setShowAttachmentImporter(false)
    setAttachmentImportText('')
    setAttachmentImportError('')
    setShowCouponGenerator(false)
    setCouponGenerator(EMPTY_COUPON_GENERATOR)
    setCouponError('')
    setShowCertificateEditor(Boolean(certificate))
    setShowCertificateSync(false)
    setCertificateSyncSourceId('')
    setCertificateSyncOptions([])
    setCertificateSyncError('')
  }, [])

  useEffect(() => () => {
    if (loadAbortRef.current) loadAbortRef.current.abort()
    if (uploadStatusPollAbortRef.current) uploadStatusPollAbortRef.current.abort()
  }, [])

  const buildAttemptRows = useCallback((attemptItems, userItems, examSessions, uploadStatusMap = new Map()) => {
    const userMap = new Map((userItems || []).map((user) => [String(user.id), user]))
    const sessionByUserId = new Map((examSessions || []).map((session) => [String(session.user_id), session]))

    return (attemptItems || []).map((attempt) => {
      const user = userMap.get(String(attempt.user_id))
      const session = sessionByUserId.get(String(attempt.user_id))
      const uploadStatus = uploadStatusMap.get(String(attempt.id)) || defaultVideoUploadStatus()
      const highAlerts = Number(attempt.high_violations || 0)
      const mediumAlerts = Number(attempt.med_violations || 0)
      const score = highAlerts * 3 + mediumAlerts
      const needsManualReview = attempt.status === 'SUBMITTED' && (attempt.score == null)

      return applyVideoUploadStatus({
        id: String(attempt.id),
        attemptIdFull: String(attempt.id),
        attemptId: String(attempt.id).slice(0, 8),
        username: attempt.user_student_id || user?.user_id || attempt.user_name || user?.name || String(attempt.user_id).slice(0, 8),
        sessionName: session ? `${t('admin_manage_session_prefix')} ${String(session.id).slice(0, 6)}` : '-',
        status: attempt.status || '-',
        score: typeof attempt.score === 'number' ? attempt.score : null,
        needsManualReview,
        reviewState: needsManualReview
          ? t('admin_manage_review_awaiting')
          : attempt.status === 'GRADED'
            ? t('admin_manage_review_finalized')
            : attempt.status === 'SUBMITTED'
              ? t('admin_manage_review_auto_scored')
              : t('admin_manage_review_in_progress'),
        paused: Boolean(attempt.paused),
        startedAt: attempt.started_at,
        submittedAt: attempt.submitted_at,
        userGroup: session?.access_mode || '-',
        comment: attempt.paused
          ? t('admin_manage_comment_paused')
          : (needsManualReview ? t('admin_manage_comment_manual_grading') : (attempt.status === 'GRADED' ? t('admin_manage_comment_reviewed') : attempt.status === 'SUBMITTED' ? t('admin_manage_comment_submitted') : '')),
        proctorRate: score,
        sessionId: session?.id || '',
        highAlerts,
        mediumAlerts,
        identityVerified: Boolean(attempt.identity_verified),
        selfiePath: attempt.selfie_path || null,
        idDocPath: attempt.id_doc_path || null,
      }, uploadStatus)
    })
  }, [t])

  const loadVideoUploadStatusMap = useCallback(async (signal, attemptIds = []) => {
    if (!id || id === 'undefined' || id === 'null') return new Map()
    const normalizedAttemptIds = Array.from(new Set(
      (Array.isArray(attemptIds) ? attemptIds : [])
        .map((attemptId) => String(attemptId || '').trim())
        .filter(Boolean),
    ))
    if (normalizedAttemptIds.length === 0) return new Map()
    const { data } = await adminApi.listExamVideoUploadStatus(
      id,
      normalizedAttemptIds,
      signal ? { signal } : {},
    )
    const items = Array.isArray(data) ? data : []
    return new Map(
      items.map((item) => [String(item.attempt_id), normalizeVideoUploadStatus(item)]),
    )
  }, [id])

  const loadAll = useCallback(async (showSpinner = true) => {
    if (!id || id === 'undefined' || id === 'null') {
      if (isManageRoutePath(location.pathname)) {
        navigate('/admin/tests', { replace: true })
      }
      return
    }
    if (loadAbortRef.current) loadAbortRef.current.abort()
    if (uploadStatusPollAbortRef.current) {
      uploadStatusPollAbortRef.current.abort()
      uploadStatusPollAbortRef.current = null
    }
    const controller = new AbortController()
    loadAbortRef.current = controller
    if (showSpinner || !examRef.current) setLoading(true)
    setLoadError('')
    setError('')
    try {
      const requestOptions = { signal: controller.signal }
      const { data: testData } = await adminApi.getTest(id, requestOptions)
      if (controller.signal.aborted) return

      const mergedExam = mergeExamAndTest(null, testData)
      setExam(mergedExam)
      hydrateSettingsForm(mergedExam)

      const needsCategories = tab === 'settings' && settingsSection === 'categories'
      const needsQuestions = tab === 'sections'
      const needsSessions = tab === 'sessions' || tab === 'proctoring' || tab === 'candidates' || tab === 'reports'
      const needsUsers = tab === 'sessions' || tab === 'candidates' || tab === 'proctoring'
      const needsAttempts = tab === 'candidates' || tab === 'proctoring' || tab === 'administration' || tab === 'reports'
      const tasks = []
      if (needsCategories) tasks.push(['categories', adminApi.categories(requestOptions)])
      if (needsQuestions) tasks.push(['questions', adminApi.getQuestions(id, requestOptions)])
      if (needsSessions) tasks.push(['sessions', adminApi.schedules({ ...requestOptions, params: { exam_id: id } })])
      if (needsUsers) tasks.push(['users', adminApi.learnersForScheduling({ is_active: true }, requestOptions)])
      if (needsAttempts) tasks.push(['attempts', adminApi.attempts({ exam_id: id, skip: 0, limit: 200 }, requestOptions)])

      if (tasks.length === 0) return

      const results = await Promise.allSettled(tasks.map(([, promise]) => promise))
      if (controller.signal.aborted) return

      const payloads = {}
      const failures = []
      tasks.forEach(([key], index) => {
        const result = results[index]
        if (result.status === 'fulfilled') {
          payloads[key] = result.value?.data ?? result.value
        } else if (!isCanceledRequest(result.reason)) {
          failures.push(readRequestError(result.reason, t('admin_manage_failed_load_resource')))
        }
      })

      if (needsCategories) {
        const nextCategories = Array.isArray(payloads.categories) ? payloads.categories : []
        setCategories((current) => (nextCategories.length === 0 && current.length > 0 ? current : nextCategories))
      }
      if (needsQuestions) setQuestions(payloads.questions || [])

      // learnersForScheduling returns a plain UserRead[]; fall back to the
      // paginated envelope reader for any other shape.
      const resolvedUsers = payloads.users != null
        ? (Array.isArray(payloads.users) ? payloads.users : readPaginatedItems(payloads.users))
        : usersRef.current
      if (needsUsers) setUsers(resolvedUsers)

      const resolvedSessions = payloads.sessions != null
        ? readPaginatedItems(payloads.sessions)
        : sessionsRef.current
      if (needsSessions) setSessions(resolvedSessions)

      if (needsAttempts) {
        const resolvedAttempts = payloads.attempts != null ? readPaginatedItems(payloads.attempts) : []
        setAttemptRows(buildAttemptRows(resolvedAttempts, resolvedUsers, resolvedSessions))
      }

      if (failures.length > 0) {
        setLoadError(failures[0])
      }
    } catch (e) {
      if (!isCanceledRequest(e)) {
        setLoadError(readRequestError(e, t('admin_manage_failed_load_test_data')))
      }
    } finally {
      if (!controller.signal.aborted && loadAbortRef.current === controller) {
        loadAbortRef.current = null
        setLoading(false)
      }
    }
  }, [id, location.pathname, navigate, hydrateSettingsForm, tab, settingsSection, buildAttemptRows])

  const loadAllRef = useRef(loadAll)
  useEffect(() => {
    loadAllRef.current = loadAll
  }, [loadAll])

  useEffect(() => {
    const shouldShowSpinner = !examRef.current || String(examRef.current.id) !== String(id)
    void loadAllRef.current(shouldShowSpinner)
  }, [id, tab])

  useEffect(() => {
    if (tab !== 'settings' || settingsSection !== 'categories') return
    if (categoriesRef.current.length > 0) return
    void loadAllRef.current(false)
  }, [tab, settingsSection])

  useEffect(() => {
    if (tab !== 'candidates' || !refreshAttemptId) return undefined

    let cancelled = false
    const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))

    const clearRefreshParam = () => {
      const params = new URLSearchParams(location.search)
      if (!params.has('refreshAttempt')) return
      params.delete('refreshAttempt')
      const search = params.toString()
      navigate(
        {
          pathname: location.pathname,
          search: search ? `?${search}` : '',
        },
        { replace: true },
      )
    }

    const refreshReviewedAttempt = async () => {
      for (let index = 0; index < 5; index += 1) {
        if (cancelled) return
        await loadAllRef.current(false)
        if (cancelled) return
        const refreshedAttempt = attemptRowsRef.current.find((row) => String(row.id) === String(refreshAttemptId))
        if (refreshedAttempt && (refreshedAttempt.status === 'GRADED' || refreshedAttempt.reviewState === 'Finalized')) {
          clearRefreshParam()
          return
        }
        if (index < 4) {
          await sleep(2500)
        }
      }
      if (!cancelled) {
        clearRefreshParam()
      }
    }

    void refreshReviewedAttempt()
    return () => {
      cancelled = true
    }
  }, [location.pathname, location.search, navigate, refreshAttemptId, tab])

  const videoUploadStatusTargetAttemptIds = useMemo(() => (
    attemptRows
      .filter((row) => shouldBootstrapRowVideoUploadStatus(row))
      .map((row) => String(row.id))
  ), [attemptRows])

  const refreshAttemptVideoUploadStatus = useCallback(async ({ signal, attemptIds = [] } = {}) => {
    if (!id || id === 'undefined' || id === 'null') return
    if (uploadStatusPollBusyRef.current) return
    const normalizedAttemptIds = Array.from(new Set(
      (Array.isArray(attemptIds) ? attemptIds : videoUploadStatusTargetAttemptIds)
        .map((attemptId) => String(attemptId || '').trim())
        .filter(Boolean),
    ))
    if (normalizedAttemptIds.length === 0) return
    uploadStatusPollBusyRef.current = true
    try {
      const uploadStatusMap = await loadVideoUploadStatusMap(signal, normalizedAttemptIds)
      if (signal?.aborted) return
      setAttemptRows((prev) => prev.map((row) => applyVideoUploadStatus(row, uploadStatusMap.get(String(row.id)))))
    } catch (refreshError) {
      if (!isCanceledRequest(refreshError)) {
        console.warn('Failed to refresh admin video upload status.', refreshError)
      }
    } finally {
      uploadStatusPollBusyRef.current = false
    }
  }, [id, loadVideoUploadStatusMap, videoUploadStatusTargetAttemptIds])

  const shouldBootstrapVideoUploadStatus = useMemo(() => (
    tab === 'proctoring'
    && view === 'candidate_monitoring'
    && videoUploadStatusTargetAttemptIds.length > 0
  ), [tab, videoUploadStatusTargetAttemptIds.length, view])

  const shouldPollVideoUploadStatus = useMemo(() => (
    tab === 'proctoring'
    && view === 'candidate_monitoring'
    && attemptRows.some((row) => shouldPollRowVideoUploadStatus(row))
  ), [attemptRows, tab, view])

  useEffect(() => {
    if (!shouldPollVideoUploadStatus && !shouldBootstrapVideoUploadStatus) {
      if (uploadStatusPollAbortRef.current) {
        uploadStatusPollAbortRef.current.abort()
        uploadStatusPollAbortRef.current = null
      }
      uploadStatusPollBusyRef.current = false
      return undefined
    }

    let disposed = false
    let timeoutId = null

    const abortActivePoll = () => {
      if (uploadStatusPollAbortRef.current) {
        uploadStatusPollAbortRef.current.abort()
        uploadStatusPollAbortRef.current = null
      }
    }

    const scheduleNext = () => {
      if (disposed) return
      timeoutId = window.setTimeout(() => {
        void runPoll()
      }, VIDEO_UPLOAD_STATUS_POLL_INTERVAL_MS)
    }

    const runPoll = async () => {
      if (disposed) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        scheduleNext()
        return
      }

      abortActivePoll()
      const controller = new AbortController()
      uploadStatusPollAbortRef.current = controller
      await refreshAttemptVideoUploadStatus({
        signal: controller.signal,
        attemptIds: videoUploadStatusTargetAttemptIds,
      })
      if (uploadStatusPollAbortRef.current === controller) {
        uploadStatusPollAbortRef.current = null
      }
      scheduleNext()
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId)
          timeoutId = null
        }
        abortActivePoll()
        return
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
        timeoutId = null
      }
      void runPoll()
    }

    if (shouldBootstrapVideoUploadStatus) {
      void runPoll()
    } else {
      scheduleNext()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      disposed = true
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      abortActivePoll()
    }
  }, [refreshAttemptVideoUploadStatus, shouldBootstrapVideoUploadStatus, shouldPollVideoUploadStatus, videoUploadStatusTargetAttemptIds])

  useEffect(() => {
    setGradeDrafts(
      attemptRows.reduce((acc, row) => {
        acc[row.id] = row.score != null ? String(row.score) : ''
        return acc
      }, {}),
    )
  }, [attemptRows])

  const filteredRows = useMemo(() => attemptRows.filter((r) => {
    if (selectedSession && String(r.sessionId) !== String(selectedSession)) return false
    if (search.attempt && !r.attemptId.toLowerCase().includes(search.attempt.toLowerCase())) return false
    if (search.user && !r.username.toLowerCase().includes(search.user.toLowerCase())) return false
    if (search.session && !r.sessionName.toLowerCase().includes(search.session.toLowerCase())) return false
    if (search.status && (search.status === 'PAUSED' ? !r.paused : r.status !== search.status)) return false
    if (search.group && !String(r.userGroup || '').toLowerCase().includes(search.group.toLowerCase())) return false
    if (search.comment && !String(r.comment || '').toLowerCase().includes(search.comment.toLowerCase())) return false
    return true
  }), [attemptRows, selectedSession, search])

  const flaggedRows = useMemo(
    () => attemptRows.filter((row) => row.highAlerts > 0 || row.mediumAlerts > 0),
    [attemptRows],
  )

  const monitoringHasFilters = Boolean(
    selectedSession
    || search.attempt
    || search.user
    || search.session
    || search.status
    || search.group
    || search.comment,
  )

  const monitoringSummaryCards = useMemo(() => [
    {
      label: t('admin_manage_card_loaded_attempts'),
      value: attemptRows.length,
      helper: t('admin_manage_card_loaded_attempts_helper'),
    },
    {
      label: t('admin_manage_card_visible_now'),
      value: filteredRows.length,
      helper: monitoringHasFilters ? t('admin_manage_card_matching_filters') : t('admin_manage_card_all_loaded'),
    },
    {
      label: t('admin_manage_card_paused'),
      value: attemptRows.filter((row) => row.paused).length,
      helper: t('admin_manage_card_paused_helper'),
    },
    {
      label: t('admin_manage_card_flagged_requests'),
      value: flaggedRows.length,
      helper: t('admin_manage_card_flagged_helper'),
    },
  ], [attemptRows, filteredRows.length, flaggedRows.length, monitoringHasFilters, t])

  const clearMonitoringFilters = () => {
    setSelectedSession('')
    setSearch({ attempt: '', user: '', session: '', status: '', group: '', comment: '' })
  }

  const filteredQuestions = useMemo(() => {
    if (!questionSearch) return questions
    const q = questionSearch.toLowerCase()
    return questions.filter((x) => String(x.text || '').toLowerCase().includes(q) || String(questionTypeOf(x)).toLowerCase().includes(q))
  }, [questions, questionSearch])

  const learners = useMemo(() => (users || []).filter((u) => u.role === 'LEARNER'), [users])
  const couponRows = Array.isArray(settingsForm.coupon_entries) ? settingsForm.coupon_entries : []
  const couponStatusOptions = useMemo(
    () => Array.from(new Set(couponRows.map((row) => String(row.status || 'Draft').trim()).filter(Boolean))),
    [couponRows],
  )
  const filteredCouponRows = useMemo(() => {
    const normalizedFilters = Object.fromEntries(
      Object.entries(couponFilters).map(([key, value]) => [key, String(value || '').trim().toLowerCase()]),
    )
    return couponRows.filter((row) => {
      const discountTypeMatches = !normalizedFilters.discount_type || row.discount_type === normalizedFilters.discount_type
      const statusMatches = !normalizedFilters.status || String(row.status || 'Draft').trim().toLowerCase() === normalizedFilters.status
      if (!discountTypeMatches || !statusMatches) return false
      return [
        ['code', row.code],
        ['amount', row.amount],
        ['expiration_time', row.expiration_time],
        ['used_by', row.used_by],
        ['date_of_use', row.date_of_use],
        ['created_by', row.created_by],
      ].every(([field, value]) => {
        const filterValue = normalizedFilters[field]
        if (!filterValue) return true
        return String(value || '').toLowerCase().includes(filterValue)
      })
    })
  }, [couponFilters, couponRows])
  const couponHasActiveFilters = Object.values(couponFilters).some((value) => String(value || '').trim())
  const candidateRows = useMemo(() => {
    const sessionOnlyRows = sessions
      .filter((session) => !attemptRows.some((attempt) => String(attempt.sessionId) === String(session.id)))
      .map((session) => {
        const learner = users.find((user) => String(user.id) === String(session.user_id))
        return applyVideoUploadStatus({
          id: `scheduled-${session.id}`,
          attemptIdFull: null,
          attemptId: '-',
          username: learner?.user_id || learner?.name || String(session.user_id).slice(0, 8),
          status: 'NOT_STARTED',
          score: null,
          needsManualReview: false,
          reviewState: t('admin_manage_review_scheduled'),
          paused: false,
          startedAt: null,
          submittedAt: null,
          userGroup: session.access_mode || '-',
          comment: session.notes || t('admin_manage_comment_waiting'),
          proctorRate: 0,
          sessionId: session.id,
          sessionName: `${t('admin_manage_session_prefix')} ${String(session.id).slice(0, 6)}`,
          highAlerts: 0,
          mediumAlerts: 0,
        }, defaultVideoUploadStatus())
      })
    return [...attemptRows, ...sessionOnlyRows]
  }, [attemptRows, sessions, users])

  const withNotice = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 2600) }
  const withError = (msg) => { const safe = typeof msg === 'string' ? msg : (msg && typeof msg === 'object' ? JSON.stringify(msg) : String(msg || 'An error occurred')); setError(safe); setTimeout(() => setError(''), 4200) }

  const withRowBusy = async (rowId, fn) => {
    setRowBusy((prev) => ({ ...prev, [rowId]: true }))
    try { await fn() } finally { setRowBusy((prev) => ({ ...prev, [rowId]: false })) }
  }

  const handlePauseResume = async (row) => {
    if (!row.attemptIdFull) {
      withError(t('admin_manage_err_not_started'))
      return
    }
    try {
      await withRowBusy(row.id, async () => {
        if (row.paused) await adminApi.resumeAttempt(row.attemptIdFull)
        else await adminApi.pauseAttempt(row.attemptIdFull)
      })
      await loadAll(false)
    } catch (e) {
      withError(readRequestError(e, t('admin_manage_err_pause_resume')))
    }
  }

  const handleOpenReport = async (row) => {
    if (!row.attemptIdFull) {
      withError(t('admin_manage_err_no_report'))
      return
    }
    try {
      await withRowBusy(row.id, async () => {
        const { data } = await adminApi.generateReport(row.attemptIdFull)
        const blob = new Blob([data], { type: 'text/html' })
        const url = URL.createObjectURL(blob)
        window.open(url, '_blank', 'noopener,noreferrer')
        setTimeout(() => URL.revokeObjectURL(url), 30000)
      })
    } catch (e) {
      withError(readRequestError(e, t('admin_manage_err_open_report')))
    }
  }

  const handleOpenVideo = (row) => {
    if (rowBusy[row.id] || !row.attemptIdFull) return
    const url = `/admin/attempts/${row.attemptIdFull}/videos`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const handleOpenResult = (row) => {
    if (rowBusy[row.id] || !row.attemptIdFull) return
    navigate({
      pathname: `/attempts/${row.attemptIdFull}`,
      search: `?from=manage-test&testId=${encodeURIComponent(id || '')}&tab=${encodeURIComponent(tab)}`,
    })
  }

  const handleSaveGrade = async (row) => {
    if (!row.attemptIdFull) {
      withError(t('admin_manage_err_not_started'))
      return
    }
    if (row.status === 'IN_PROGRESS') {
      withError(t('admin_manage_err_submit_first'))
      return
    }
    const rawValue = `${gradeDrafts[row.id] ?? ''}`.trim()
    if (!rawValue) {
      withError(t('admin_manage_err_score_range'))
      return
    }
    const nextScore = Number(rawValue)
    if (!Number.isFinite(nextScore) || nextScore < 0 || nextScore > 100) {
      withError(t('admin_manage_err_grade_range'))
      return
    }
    try {
      await withRowBusy(row.id, async () => {
        await adminApi.gradeAttempt(row.attemptIdFull, nextScore)
      })
      await loadAll(false)
      withNotice(row.status === 'GRADED' ? t('admin_manage_grade_updated') : t('admin_manage_attempt_graded'))
    } catch (e) {
      withError(readRequestError(e, t('admin_manage_err_save_grade')))
    }
  }

  const handleBulkPauseResume = async (toPause) => {
    if (!filteredRows.length) return
    setBulkBusy(true)
    setBulkAction(toPause ? 'pause' : 'resume')
    try {
      for (const r of filteredRows) {
        if (!r.attemptIdFull) continue
        if (toPause && !r.paused) await adminApi.pauseAttempt(r.attemptIdFull)
        if (!toPause && r.paused) await adminApi.resumeAttempt(r.attemptIdFull)
      }
      await loadAll(false)
      withNotice(toPause ? t('admin_manage_filtered_paused') : t('admin_manage_filtered_resumed'))
    } catch (e) {
      withError(readRequestError(e, t('admin_manage_err_bulk_action')))
    } finally {
      setBulkBusy(false)
      setBulkAction('')
    }
  }

  const handleSettingsSave = async () => {
    if (!exam) return
    if (isArchived) return withError(t('admin_manage_archived_readonly'))
    await Promise.resolve()
    const form = settingsFormRef.current
    const trimmedTitle = form.title.trim()
    const trimmedCode = form.code.trim()
    const parsedSettings = safeJsonParse(form.settings_json, null)
    if (parsedSettings === '__INVALID__') return withError(t('admin_manage_err_invalid_json'))

    const timeLimit = form.time_limit_minutes === '' ? null : Number(form.time_limit_minutes)
    const maxAttempts = form.max_attempts === '' ? 1 : Number(form.max_attempts)
    const passingScore = form.passing_score === '' ? null : Number(form.passing_score)
    const pauseDurationMinutes = form.pause_duration_minutes === '' ? null : Number(form.pause_duration_minutes)
    const retakeCooldownHours = form.retake_cooldown_hours === '' ? null : Number(form.retake_cooldown_hours)
    const sectionCount = form.section_count === '' ? 0 : Number(form.section_count)
    const resultValidityDays = form.result_validity_days === '' ? null : Number(form.result_validity_days)
    const certificatePayload = normalizeCertificatePayload({
      title: form.certificate_title,
      subtitle: form.certificate_subtitle,
      issuer: form.certificate_issuer,
      signer: form.certificate_signer,
      issue_rule: form.certificate_issue_rule,
    })
    const attachmentItems = normalizeAttachmentEntries(form.attachment_items, form.attachment_urls)
    const attachmentUrls = attachmentItems.map((item) => item.url)
    const couponEntries = normalizeCouponEntries(
      form.coupon_entries,
      form.coupon_code,
      form.coupon_discount_type,
      form.coupon_discount_value,
      couponCreatedBy,
    )
    const translationEntries = (Array.isArray(form.test_translations) ? form.test_translations : [])
      .map((entry) => normalizeTranslationEntry(entry))
      .filter(Boolean)
    const scoreReportSettings = normalizeScoreReportSettings({
      heading: form.score_report_heading,
      intro: form.score_report_intro,
      include_candidate_summary: form.score_report_include_candidate_summary,
      include_section_breakdown: form.score_report_include_section_breakdown,
      include_proctoring_summary: form.score_report_include_proctoring_summary,
      include_certificate_status: form.score_report_include_certificate_status,
      include_pass_fail_badge: form.score_report_include_pass_fail_badge,
    })

    if (!trimmedTitle) return withError(t('admin_manage_err_title_required'))
    if (timeLimit != null && (!Number.isFinite(timeLimit) || timeLimit <= 0)) return withError(t('admin_manage_err_time_limit'))
    if (!Number.isFinite(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) return withError(t('admin_manage_err_max_attempts'))
    if (maxAttempts > 1 && !form.allow_retake) return withError(t('admin_manage_err_enable_retakes'))
    if (passingScore != null && (!Number.isFinite(passingScore) || passingScore < 0 || passingScore > 100)) return withError(t('admin_manage_err_passing_score'))
    if (!Number.isFinite(sectionCount) || sectionCount < 0 || sectionCount > 99) return withError(t('admin_manage_err_section_range'))
    if (form.allow_pause && pauseDurationMinutes != null && (!Number.isFinite(pauseDurationMinutes) || pauseDurationMinutes <= 0)) {
      return withError(t('admin_manage_err_pause_duration'))
    }
    if (form.allow_retake && retakeCooldownHours != null && (!Number.isFinite(retakeCooldownHours) || retakeCooldownHours < 0)) {
      return withError(t('admin_manage_err_retake_cooldown'))
    }
    if (form.result_validity_period_enabled && resultValidityDays != null && (!Number.isFinite(resultValidityDays) || resultValidityDays <= 0)) {
      return withError(t('admin_manage_err_validity_days'))
    }

    let parsedExternalAttrs = null
    if (form.external_attributes_json) {
      try { parsedExternalAttrs = JSON.parse(form.external_attributes_json) }
      catch { return withError(t('admin_manage_err_external_json')) }
    }
    if (parsedExternalAttrs != null && (typeof parsedExternalAttrs !== 'object' || Array.isArray(parsedExternalAttrs))) {
      return withError(t('admin_manage_err_external_object'))
    }
    if (form.external_id.trim()) {
      parsedExternalAttrs = { ...(parsedExternalAttrs || {}), external_id: form.external_id.trim() }
    }

    const runtimeSettings = {
      ...(parsedSettings || {}),
      instructions: form.instructions || '',
      instructions_heading: form.instructions_heading || '',
      instructions_body: form.instructions_body || '',
      completion_message: form.completion_message || '',
      instructions_require_acknowledgement: form.instructions_require_acknowledgement,
      show_test_instructions: form.show_test_instructions,
      show_test_duration: form.show_test_duration,
      show_passing_mark: form.show_passing_mark,
      show_question_count: form.show_question_count,
      show_remaining_retakes: form.show_remaining_retakes,
      show_score_report: form.show_score_report,
      show_answer_review: form.show_answer_review,
      show_correct_answers: form.show_correct_answers,
      email_result_on_submit: form.email_result_on_submit,
      duration_type: form.duration_type,
      hide_assignment_metadata: form.hide_assignment_metadata,
      hide_finish_until_last_question: form.hide_finish_until_last_question,
      enforce_section_order: form.enforce_section_order,
      calculator_type: form.calculator_type,
      allow_pause: form.allow_pause,
      pause_duration_minutes: form.allow_pause ? pauseDurationMinutes : null,
      allow_retake: form.allow_retake,
      retake_cooldown_hours: form.allow_retake ? retakeCooldownHours : null,
      reschedule_policy: form.reschedule_policy,
      limited_free_reschedules: form.limited_free_reschedules,
      network_access: form.network_access,
      auto_logout_after_finish_or_pause: form.auto_logout_after_finish_or_pause,
      require_profile_update: form.require_profile_update,
      result_validity_period_enabled: form.result_validity_period_enabled,
      result_validity_days: form.result_validity_period_enabled ? resultValidityDays : null,
      passing_mark_inclusive: form.passing_mark_inclusive,
      require_positive_proctoring_report: form.require_positive_proctoring_report,
      show_advanced_grading: form.show_advanced_grading,
      custom_score_report_enabled: form.custom_score_report_enabled,
      report_lifespan_enabled: form.report_lifespan_enabled,
      report_access_duration_enabled: form.report_access_duration_enabled,
      display_subscores_by_pool: form.display_subscores_by_pool,
      display_section_scores: form.display_section_scores,
      display_percentage_required_to_pass: form.display_percentage_required_to_pass,
      display_employee_id: form.display_employee_id,
      display_achieved_score_summary: form.display_achieved_score_summary,
      display_score_description: form.display_score_description,
      show_pass_fail_info: form.show_pass_fail_info,
      display_score_each_question: form.display_score_each_question,
      display_instructor_notes: form.display_instructor_notes,
      display_candidate_groups: form.display_candidate_groups,
      show_full_timestamps: form.show_full_timestamps,
      show_rounded_scores: form.show_rounded_scores,
      export_personal_report_excel: form.export_personal_report_excel,
      export_personal_report_pdf: form.export_personal_report_pdf,
      enable_score_report_download: form.enable_score_report_download,
      enable_knowledge_deficiency_report_download: form.enable_knowledge_deficiency_report_download,
      coupons_enabled: couponEntries.length > 0,
      coupon_entries: couponEntries,
      coupon_code: couponEntries[0]?.code || null,
      coupon_discount_type: couponEntries[0]?.discount_type || form.coupon_discount_type,
      coupon_discount_value: couponEntries[0]?.amount ?? null,
      language: form.language,
      allow_language_override: form.allow_language_override,
      attachment_items: attachmentItems,
      attachment_urls: attachmentUrls,
      test_translations: translationEntries,
      score_report_settings: scoreReportSettings,
      external_attributes: parsedExternalAttrs,
      descriptive_label: form.descriptive_label.trim(),
      creation_type: form.creation_type || 'Test with sections',
      section_count: Math.floor(sectionCount),
      allow_section_selection: form.allow_section_selection,
    }
    const adminPayload = isPublished
      ? {
          name: trimmedTitle,
          description: form.description || null,
        }
      : {
          code: trimmedCode || null,
          name: trimmedTitle,
          description: form.description || null,
          type: exam.type,
          node_id: exam.node_id || undefined,
          category_id: form.category_id || exam.category_id || undefined,
          grading_scale_id: exam.grading_scale_id || undefined,
          report_displayed: form.report_displayed,
          report_content: form.report_content,
          time_limit_minutes: timeLimit,
          attempts_allowed: Math.floor(maxAttempts),
          passing_score: passingScore,
          runtime_settings: runtimeSettings,
          proctoring_config: normalizeProctoringConfig(form.proctoring_config || {}),
          certificate: certificatePayload,
        }

    setSavingSettings(true)
    let saved = false
    try {
      await adminApi.updateTest(exam.id, adminPayload)
      saved = true
      withNotice(t('admin_manage_settings_saved'))
    } catch (e) {
      withError(readRequestError(e, t('admin_manage_err_save_settings')))
    } finally {
      setSavingSettings(false)
    }
    if (saved) {
      void loadAll(false)
    }
  }

  const handlePublish = async () => {
    if (!exam) return
    try {
      await adminApi.publishTest(exam.id)
      await loadAll(false)
      withNotice(t('admin_manage_test_published'))
    } catch (e) {
      withError(readRequestError(e, t('admin_manage_err_publish')))
    }
  }

  const handleClose = async () => {
    if (!exam) return
    try {
      if (isArchived) {
        await adminApi.unarchiveTest(exam.id)
        withNotice(t('admin_manage_test_unarchived'))
      } else {
        await adminApi.archiveTest(exam.id)
        withNotice(t('admin_manage_test_archived'))
      }
      await loadAll(false)
    } catch (e) {
      withError(readRequestError(e, t('admin_manage_err_status_change')))
    }
  }

  const handlePreview = () => {
    if (!exam) return
    if (!isPublished) return withError(t('admin_manage_err_publish_first'))
    navigate(`/tests/${exam.id}`)
  }

  const handleDuplicate = async () => {
    if (!exam) return
    try {
      const { data: newExam } = await adminApi.duplicateTest(exam.id)
      withNotice(t('admin_manage_test_duplicated'))
      navigate(`/admin/tests/${newExam.id}/manage`)
    } catch (e) {
      withError(readRequestError(e, t('admin_manage_err_duplicate')))
    }
  }

  const handleDeleteExam = async () => {
    if (!exam) return
    if (!deleteExamConfirm) { setDeleteExamConfirm(true); return }
    setDeleteExamConfirm(false)
    setDeletingExamBusy(true)
    try {
      await adminApi.deleteTest(exam.id)
      navigate('/admin/tests')
    } catch (e) {
      withError(readRequestError(e, t('admin_manage_err_delete_test')))
    } finally {
      setDeletingExamBusy(false)
    }
  }

  const handleSettingsMenuClick = (item) => {
    const section = MENU_TO_SECTION[item] || DEFAULT_SETTINGS_SECTION
    handleTabChange('settings', section)
  }

  const startEditAccom = (s) => {
    setEditingAccomId(s.id)
    setEditingAccomForm({
      access_mode: s.access_mode || 'OPEN',
      notes: s.notes || '',
      scheduled_at: s.scheduled_at ? new Date(s.scheduled_at).toISOString().slice(0, 16) : '',
    })
  }

  const handleSaveAccom = async (sessionId) => {
    if (!editingAccomForm.scheduled_at) return withError(t('admin_manage_err_schedule_required'))
    setSavingAccomId(sessionId)
    try {
      await adminApi.updateSchedule(sessionId, {
        access_mode: editingAccomForm.access_mode,
        notes: editingAccomForm.notes || null,
        scheduled_at: new Date(editingAccomForm.scheduled_at).toISOString(),
      })
      setEditingAccomId(null)
      await loadAll(false)
      withNotice(t('admin_manage_accommodation_updated'))
    } catch (e) {
      withError(readRequestError(e, t('admin_manage_err_update_accommodation')))
    } finally {
      setSavingAccomId(null)
    }
  }

  const resetQuestionForm = () => { setQuestionForm(emptyQuestionForm()); setEditingQuestionId('') }

  const startEditQuestion = (q) => {
    setEditingQuestionId(String(q.id))
    setQuestionForm({
      text: q.text || '',
      question_type: questionTypeOf(q),
      answer: questionToAnswerState(q),
      points: String(q.points ?? 1),
      order: String(q.order ?? 0),
      image_url: q.image_url ?? null,
    })
    handleTabChange('sections')
  }

  const handleQuestionTypeChange = (value) => {
    setQuestionForm((prev) => ({ ...prev, question_type: value, answer: emptyAnswerState(value) }))
  }

  const handleQuestionSubmit = async (e) => {
    e.preventDefault()
    setQuestionBusy(true)
    try {
      const qType = questionForm.question_type
      const { options, correct_answer } = answerStateToPayload(qType, questionForm.answer)
      const payload = {
        text: questionForm.text.trim(),
        question_type: qType,
        options,
        correct_answer,
        points: Number(questionForm.points || 1),
        order: Number(questionForm.order || 0),
        image_url: questionForm.image_url || null,
      }
      if (!payload.text) throw new Error(t('admin_manage_err_question_text_required'))
      if (!Number.isFinite(payload.points) || payload.points <= 0) throw new Error(t('admin_manage_err_points_positive'))
      const answerErrorKey = validateAnswerState(qType, questionForm.answer)
      if (answerErrorKey) throw new Error(t(answerErrorKey))

      if (editingQuestionId) {
        await adminApi.updateQuestion(editingQuestionId, payload)
        withNotice(t('admin_manage_question_updated'))
      } else {
        await adminApi.addQuestion({ ...payload, exam_id: id })
        withNotice(t('admin_manage_question_added'))
      }
      const { data } = await adminApi.getQuestions(id)
      setQuestions(data || [])
      resetQuestionForm()
    } catch (e2) {
      withError(readRequestError(e2, t('admin_manage_err_save_question')))
    } finally {
      setQuestionBusy(false)
    }
  }

  const handleDeleteQuestion = async (qid) => {
    if (deleteQuestionId !== qid) { setDeleteQuestionId(qid); return }
    setDeletingQuestionBusyId(qid)
    try {
      await adminApi.deleteQuestion(qid)
      const { data } = await adminApi.getQuestions(id)
      setQuestions(data || [])
      if (editingQuestionId === String(qid)) resetQuestionForm()
      setDeleteQuestionId(null)
      withNotice(t('admin_manage_question_deleted'))
    } catch (e) {
      withError(readRequestError(e, t('admin_manage_err_delete_question')))
    } finally {
      setDeletingQuestionBusyId(null)
    }
  }

  const handleCreateSession = async (e) => {
    e.preventDefault()
    if (!sessionForm.user_id) return withError(t('admin_manage_err_select_learner'))
    if (!sessionForm.scheduled_at) return withError(t('admin_manage_err_pick_schedule'))
    setSessionBusy(true)
    try {
      const existing = sessions.find((session) => String(session.user_id) === String(sessionForm.user_id))
      const payload = {
        scheduled_at: new Date(sessionForm.scheduled_at).toISOString(),
        access_mode: sessionForm.access_mode,
        notes: sessionForm.notes || null,
      }
      if (existing?.id) {
        await adminApi.updateSchedule(existing.id, payload)
      } else {
        await adminApi.createSchedule({
          exam_id: id,
          user_id: sessionForm.user_id,
          ...payload,
        })
      }
      setSessionForm(EMPTY_SESSION_FORM)
      await loadAll(false)
      withNotice(existing?.id ? t('admin_manage_session_updated') : t('admin_manage_session_created'))
    } catch (e2) {
      withError(readRequestError(e2, t('admin_manage_err_save_session')))
    } finally {
      setSessionBusy(false)
    }
  }

  const handleDeleteSession = async (sessionId) => {
    if (deleteSessionId !== sessionId) { setDeleteSessionId(sessionId); return }
    setDeletingSessionBusyId(sessionId)
    try {
      await adminApi.deleteSchedule(sessionId)
      setDeleteSessionId(null)
      await loadAll(false)
      withNotice(t('admin_manage_session_deleted'))
    } catch (e) {
      withError(readRequestError(e, t('admin_manage_err_delete_session')))
    } finally {
      setDeletingSessionBusyId(null)
    }
  }

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const downloadExamCsv = async () => {
    if (!exam) return
    setReportsBusy(true)
    try {
      const { data } = await adminApi.testReportCsv(exam.id)
      downloadBlob(new Blob([data], { type: 'text/csv' }), `${sanitizeFilename(exam.title)}_report.csv`)
      withNotice(t('admin_manage_csv_downloaded'))
    } catch (e) {
      withError(await readBlobErrorMessage(e, t('admin_manage_err_csv')))
    } finally {
      setReportsBusy(false)
    }
  }

  const downloadExamPdf = async () => {
    if (!exam) return
    setReportsBusy(true)
    try {
      const { data } = await adminApi.generateTestReportPdf(exam.id)
      downloadBlob(new Blob([data], { type: 'application/pdf' }), `${sanitizeFilename(exam.title)}_report.pdf`)
      withNotice(t('admin_manage_pdf_downloaded'))
    } catch (e) {
      withError(await readBlobErrorMessage(e, t('admin_manage_err_pdf')))
    } finally {
      setReportsBusy(false)
    }
  }

  const settingsDirty = !loading && Boolean(exam) && serializeSettingsForm(settingsForm) !== settingsBaselineRef.current

  useUnsavedChanges(tab === 'settings' && settingsDirty && !savingSettings)

  if (loading && !exam) return <div className={styles.page}>{t('admin_manage_loading')}</div>
  if (!exam) {
    return (
      <div className={styles.page}>
        <div className={styles.error}>{loadError || t('admin_manage_test_not_found')}</div>
        <div className={styles.inlineActions}>
          <button type="button" className={styles.blueBtn} onClick={() => loadAll(true)}>{t('retry')}</button>
          <button type="button" className={styles.ghostBtn} onClick={() => navigate('/admin/tests')}>{t('admin_manage_back_to_tests')}</button>
        </div>
      </div>
    )
  }

  const isPublished = exam.status === 'PUBLISHED'
  const isArchived = exam.status === 'ARCHIVED'
  const lockedExamFields = isPublished || isArchived
  const reportSettingsLocked = isPublished || isArchived
  const sessionFormReady = Boolean(sessionForm.user_id && sessionForm.scheduled_at)
  const activeProctoringChecks = PROCTOR_BOOLEAN_KEYS.filter((key) => Boolean(settingsForm.proctoring_config?.[key]))
  const openSessions = sessions.filter((session) => session.access_mode === 'OPEN').length
  const restrictedSessions = sessions.filter((session) => session.access_mode === 'RESTRICTED').length
  const manageOverviewCards = [
    {
      label: t('status'),
      value: isPublished ? t('published') : isArchived ? t('archived') : t('draft'),
      helper: isPublished ? t('admin_manage_overview_status_published_helper') : t('admin_manage_overview_status_draft_helper'),
    },
    {
      label: t('questions'),
      value: questions.length,
      helper: questions.length > 0 ? t('admin_manage_overview_questions_linked') : t('admin_manage_overview_questions_empty'),
    },
    {
      label: t('admin_manage_overview_sessions'),
      value: sessions.length,
      helper: sessions.length > 0 ? t('admin_manage_overview_sessions_persisted') : t('admin_manage_overview_sessions_empty'),
    },
    {
      label: t('admin_manage_overview_attempts'),
      value: attemptRows.length,
      helper: attemptRows.length > 0 ? `${flaggedRows.length} ${t('admin_manage_overview_flagged')}` : t('admin_manage_overview_no_attempts'),
    },
    {
      label: t('admin_manage_overview_reports'),
      value: settingsForm.show_score_report ? t('admin_manage_overview_candidate_visible') : t('admin_manage_overview_admin_only'),
      helper: settingsForm.show_answer_review ? t('admin_manage_overview_review_enabled') : t('admin_manage_overview_review_hidden'),
    },
  ]
  const lifecycleCards = [
    {
      label: t('admin_manage_lifecycle_learner_access'),
      value: sessions.length === 0 ? t('admin_manage_lifecycle_not_assigned') : `${openSessions} ${t('admin_manage_lifecycle_open')} / ${restrictedSessions} ${t('admin_manage_lifecycle_restricted')}`,
      helper: sessions.length === 0 ? t('admin_manage_lifecycle_assign_hint') : t('admin_manage_lifecycle_based_on_records'),
    },
    {
      label: t('admin_manage_lifecycle_proctoring_profile'),
      value: activeProctoringChecks.length > 0 ? `${activeProctoringChecks.length} ${t('admin_manage_lifecycle_checks')}` : t('admin_manage_lifecycle_monitoring_off'),
      helper: activeProctoringChecks.length > 0 ? activeProctoringChecks.map((key) => t(PROCTOR_LABEL_KEYS[key])).join(', ') : t('admin_manage_lifecycle_no_proctoring'),
    },
    {
      label: t('admin_manage_lifecycle_certificates'),
      value: exam.certificate ? t('admin_manage_lifecycle_enabled') : t('admin_manage_lifecycle_disabled'),
      helper: exam.certificate ? `${t('admin_manage_lifecycle_issued_by')} ${exam.certificate.signer || t('admin_manage_lifecycle_configured_signer')}` : t('admin_manage_lifecycle_no_certificate'),
    },
    {
      label: t('admin_manage_lifecycle_retake_policy'),
      value: settingsForm.allow_retake ? t('admin_manage_lifecycle_allowed') : t('admin_manage_lifecycle_locked'),
      helper: settingsForm.allow_retake
        ? `${t('admin_manage_lifecycle_cooldown')} ${settingsForm.retake_cooldown_hours || '0'} ${t('admin_manage_lifecycle_hours')}, ${t('admin_manage_lifecycle_max')} ${settingsForm.max_attempts} ${t('admin_manage_lifecycle_attempts')}`
        : t('admin_manage_lifecycle_no_retake'),
    },
    {
      label: t('admin_manage_lifecycle_review_queue'),
      value: flaggedRows.length,
      helper: flaggedRows.length > 0 ? t('admin_manage_lifecycle_flagged_need_review') : t('admin_manage_lifecycle_no_flagged'),
    },
  ]
  const createdByLabel = exam.created_by_name || 'Unavailable'
  const couponCreatedBy = createdByLabel !== 'Unavailable' ? createdByLabel : 'Admin'
  const updatedByLabel = createdByLabel
  const basicPageInitials = getBrandInitials(settingsForm.title || exam.title)
  const basicPageStatus = isPublished ? t('published') : isArchived ? t('archived') : t('draft')
  const openCycleTab = (nextTab, nextSection = null) => {
    handleTabChange(nextTab, nextSection || settingsSection)
  }
  const handleSettingsCancel = () => {
    if (!exam) return
    hydrateSettingsForm(exam)
    setError('')
    setNotice('')
  }

  const isBrowserLockdownEnabled = LOCKDOWN_KEYS.some((key) => Boolean(settingsForm.proctoring_config?.[key]))
  const isProctoringEnabled = [...PROCTORING_MONITOR_KEYS, 'lighting_required', 'screen_capture']
    .some((key) => Boolean(settingsForm.proctoring_config?.[key]))
  const translationRows = Array.isArray(settingsForm.test_translations) ? settingsForm.test_translations : []
  const attachmentRows = Array.isArray(settingsForm.attachment_items) ? settingsForm.attachment_items : []
  const selectedCategory = categories.find((category) => String(category.id) === String(settingsForm.category_id || ''))
  const certificatePreview = normalizeCertificatePayload({
    title: settingsForm.certificate_title,
    subtitle: settingsForm.certificate_subtitle,
    issuer: settingsForm.certificate_issuer,
    signer: settingsForm.certificate_signer,
    issue_rule: settingsForm.certificate_issue_rule,
  })

  const setCheckboxField = (field) => (e) => setSettingsForm((prev) => ({ ...prev, [field]: e.target.checked }))
  const setTextField = (field) => (e) => setSettingsForm((prev) => ({ ...prev, [field]: e.target.value }))
  const setCouponFilterField = (field) => (event) => {
    const value = event.target.value
    setCouponFilters((prev) => ({ ...prev, [field]: value }))
  }
  const setCertificateField = (field) => (e) => {
    const value = e.target.value
    setSettingsForm((prev) => {
      const next = { ...prev, [field]: value }
      next.certificate_json = JSON.stringify(normalizeCertificatePayload({
        title: field === 'certificate_title' ? value : next.certificate_title,
        subtitle: field === 'certificate_subtitle' ? value : next.certificate_subtitle,
        issuer: field === 'certificate_issuer' ? value : next.certificate_issuer,
        signer: field === 'certificate_signer' ? value : next.certificate_signer,
        issue_rule: field === 'certificate_issue_rule' ? value : next.certificate_issue_rule,
      }) || {}, null, 2)
      return next
    })
  }
  const setBrowserLockdownEnabled = (checked) => {
    setSettingsForm((prev) => ({
      ...prev,
      proctoring_config: {
        ...(prev.proctoring_config || {}),
        ...Object.fromEntries(LOCKDOWN_KEYS.map((key) => [key, checked])),
      },
    }))
  }
  const setProctoringEnabled = (checked) => {
    setSettingsForm((prev) => ({
      ...prev,
      proctoring_config: {
        ...(prev.proctoring_config || {}),
        ...Object.fromEntries([...PROCTORING_MONITOR_KEYS, 'lighting_required', 'screen_capture'].map((key) => [key, checked])),
      },
    }))
  }
  const setProctoringConfigField = (field) => (event) => {
    const checked = event.target.checked
    setSettingsForm((prev) => ({
      ...prev,
      proctoring_config: {
        ...(prev.proctoring_config || {}),
        [field]: checked,
      },
    }))
  }
  const startCreateTranslation = () => {
    setTranslationDraft({
      ...EMPTY_TRANSLATION_DRAFT,
      language: settingsForm.language || 'ar',
    })
    setEditingTranslationId(null)
    setTranslationError('')
    setShowTranslationEditor(true)
  }
  const startEditTranslation = (translation) => {
    setTranslationDraft({
      language: translation.language || settingsForm.language || 'ar',
      title: translation.title || '',
      description: translation.description || '',
      instructions_body: translation.instructions_body || '',
      completion_message: translation.completion_message || '',
    })
    setEditingTranslationId(translation.id)
    setTranslationError('')
    setShowTranslationEditor(true)
  }
  const cancelTranslationEditor = () => {
    setShowTranslationEditor(false)
    setEditingTranslationId(null)
    setTranslationDraft({
      ...EMPTY_TRANSLATION_DRAFT,
      language: settingsForm.language || 'ar',
    })
    setTranslationError('')
  }
  const saveTranslationDraft = () => {
    const normalized = normalizeTranslationEntry({
      ...translationDraft,
      id: editingTranslationId || buildLocalId('translation'),
    })
    if (!normalized) {
      setTranslationError(t('admin_manage_err_translation_lang'))
      return
    }
    const duplicateLanguage = translationRows.some((entry) => (
      entry.id !== normalized.id
      && String(entry.language).toLowerCase() === String(normalized.language).toLowerCase()
    ))
    if (duplicateLanguage) {
      setTranslationError(t('admin_manage_err_translation_duplicate'))
      return
    }
    setSettingsForm((prev) => {
      const current = Array.isArray(prev.test_translations) ? prev.test_translations : []
      const nextTranslations = editingTranslationId
        ? current.map((entry) => (entry.id === editingTranslationId ? normalized : entry))
        : [...current, normalized]
      return { ...prev, test_translations: nextTranslations }
    })
    cancelTranslationEditor()
    withNotice(t('admin_manage_translation_updated'))
  }
  const removeTranslationEntry = (translationId) => {
    setSettingsForm((prev) => ({
      ...prev,
      test_translations: (Array.isArray(prev.test_translations) ? prev.test_translations : [])
        .filter((entry) => entry.id !== translationId),
    }))
    if (editingTranslationId === translationId) {
      cancelTranslationEditor()
    }
    withNotice(t('admin_manage_translation_removed'))
  }
  const startCreateAttachment = () => {
    setAttachmentDraft(EMPTY_ATTACHMENT_DRAFT)
    setEditingAttachmentId(null)
    setAttachmentError('')
    setShowAttachmentEditor(true)
  }
  const startEditAttachment = (attachment) => {
    setAttachmentDraft({
      title: attachment.title || '',
      url: attachment.url || '',
      type: attachment.type || 'LINK',
    })
    setEditingAttachmentId(attachment.id)
    setAttachmentError('')
    setShowAttachmentEditor(true)
  }
  const cancelAttachmentEditor = () => {
    setAttachmentDraft(EMPTY_ATTACHMENT_DRAFT)
    setEditingAttachmentId(null)
    setAttachmentError('')
    setShowAttachmentEditor(false)
  }
  const saveAttachmentDraft = () => {
    const normalized = normalizeAttachmentEntry({
      ...attachmentDraft,
      id: editingAttachmentId || buildLocalId('attachment'),
    }, attachmentRows.length + 1)
    if (!normalized) {
      setAttachmentError(t('admin_manage_err_attachment_url'))
      return
    }
    setSettingsForm((prev) => {
      const current = Array.isArray(prev.attachment_items) ? prev.attachment_items : []
      const nextItems = editingAttachmentId
        ? current.map((entry) => (entry.id === editingAttachmentId ? normalized : entry))
        : [...current, normalized]
      return {
        ...prev,
        attachment_items: nextItems,
        attachment_urls: nextItems.map((entry) => entry.url).join('\n'),
      }
    })
    cancelAttachmentEditor()
    withNotice(t('admin_manage_attachment_updated'))
  }
  const removeAttachmentItem = (attachmentId) => {
    setSettingsForm((prev) => {
      const nextItems = (Array.isArray(prev.attachment_items) ? prev.attachment_items : [])
        .filter((entry) => entry.id !== attachmentId)
      return {
        ...prev,
        attachment_items: nextItems,
        attachment_urls: nextItems.map((entry) => entry.url).join('\n'),
      }
    })
    if (editingAttachmentId === attachmentId) {
      cancelAttachmentEditor()
    }
    withNotice(t('admin_manage_attachment_removed'))
  }
  const importAttachmentRows = () => {
    const lines = attachmentImportText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (!lines.length) {
      setAttachmentImportError(t('admin_manage_err_attachment_import_empty'))
      return
    }
    const imported = lines
      .map((line, index) => {
        const [left, right] = line.includes('|')
          ? line.split('|').map((value) => value.trim())
          : ['', line]
        return normalizeAttachmentEntry({
          id: buildLocalId('attachment'),
          title: left,
          url: right || left,
          type: 'LINK',
        }, attachmentRows.length + index + 1)
      })
      .filter(Boolean)
    if (!imported.length) {
      setAttachmentImportError(t('admin_manage_err_attachment_import_invalid'))
      return
    }
    setSettingsForm((prev) => {
      const nextItems = [...(Array.isArray(prev.attachment_items) ? prev.attachment_items : []), ...imported]
      return {
        ...prev,
        attachment_items: nextItems,
        attachment_urls: nextItems.map((entry) => entry.url).join('\n'),
      }
    })
    setAttachmentImportText('')
    setAttachmentImportError('')
    setShowAttachmentImporter(false)
    withNotice(t('admin_manage_attachments_imported'))
  }
  const handleGenerateCoupons = () => {
    const prefix = sanitizeCouponPrefix(couponGenerator.prefix)
    const count = Number(couponGenerator.count)
    const amount = Number(couponGenerator.amount)
    if (!Number.isFinite(count) || count < 1 || count > 100) {
      setCouponError(t('admin_manage_err_coupon_count'))
      return
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setCouponError(t('admin_manage_err_coupon_amount'))
      return
    }
    if (couponGenerator.discount_type === 'percentage' && amount > 100) {
      setCouponError(t('admin_manage_err_coupon_percentage'))
      return
    }
    const nextRows = Array.from({ length: count }).map((_, index) => normalizeCouponEntry({
      id: buildLocalId('coupon'),
      code: `${prefix}-${String(couponRows.length + index + 1).padStart(3, '0')}`,
      discount_type: couponGenerator.discount_type,
      amount,
      status: 'Draft',
      expiration_time: couponGenerator.expiration_time,
      used_by: '',
      date_of_use: '',
      created_by: couponCreatedBy,
    }, couponRows.length + index + 1)).filter(Boolean)
    setSettingsForm((prev) => {
      const current = Array.isArray(prev.coupon_entries) ? prev.coupon_entries : []
      const merged = [...current, ...nextRows]
      return {
        ...prev,
        coupons_enabled: merged.length > 0,
        coupon_entries: merged,
        coupon_code: merged[0]?.code || '',
        coupon_discount_type: merged[0]?.discount_type || 'percentage',
        coupon_discount_value: merged[0]?.amount != null ? String(merged[0].amount) : '',
      }
    })
    setCouponError('')
    setShowCouponGenerator(false)
    setCouponGenerator(EMPTY_COUPON_GENERATOR)
    withNotice(t('admin_manage_coupons_generated'))
  }
  const removeCouponEntry = (couponId) => {
    setSettingsForm((prev) => {
      const merged = (Array.isArray(prev.coupon_entries) ? prev.coupon_entries : [])
        .filter((entry) => entry.id !== couponId)
      return {
        ...prev,
        coupons_enabled: merged.length > 0,
        coupon_entries: merged,
        coupon_code: merged[0]?.code || '',
        coupon_discount_type: merged[0]?.discount_type || 'percentage',
        coupon_discount_value: merged[0]?.amount != null ? String(merged[0].amount) : '',
      }
    })
    withNotice(t('admin_manage_coupon_removed'))
  }
  const clearCertificateDraft = () => {
    setSettingsForm((prev) => ({
      ...prev,
      certificate_title: '',
      certificate_subtitle: '',
      certificate_issuer: '',
      certificate_signer: '',
      certificate_issue_rule: DEFAULT_CERTIFICATE_ISSUE_RULE,
      certificate_json: '',
    }))
    setShowCertificateEditor(false)
    withNotice(t('admin_manage_cert_cleared'))
  }
  const toggleCertificateSync = async () => {
    if (showCertificateSync) {
      setShowCertificateSync(false)
      return
    }
    setShowCertificateSync(true)
    setCertificateSyncError('')
    if (certificateSyncOptions.length) return
    setCertificateSyncLoading(true)
    try {
      const { data } = await adminApi.allTests()
      const options = (data?.items || [])
        .filter((item) => String(item.id) !== String(exam?.id) && normalizeCertificatePayload(item.certificate))
      setCertificateSyncOptions(options)
      if (options[0]) {
        setCertificateSyncSourceId(String(options[0].id))
      }
      if (!options.length) {
        setCertificateSyncError(t('admin_manage_err_no_cert_sources'))
      }
    } catch (e) {
      setCertificateSyncError(readRequestError(e, t('admin_manage_err_cert_sources')))
    } finally {
      setCertificateSyncLoading(false)
    }
  }
  const applySyncedCertificate = () => {
    const source = certificateSyncOptions.find((item) => String(item.id) === String(certificateSyncSourceId))
    const normalized = normalizeCertificatePayload(source?.certificate)
    if (!normalized) {
      setCertificateSyncError(t('admin_manage_err_choose_cert'))
      return
    }
    setSettingsForm((prev) => ({
      ...prev,
      certificate_title: normalized.title || '',
      certificate_subtitle: normalized.subtitle || '',
      certificate_issuer: normalized.issuer || '',
      certificate_signer: normalized.signer || '',
      certificate_issue_rule: normalizeCertificateIssueRule(normalized.issue_rule),
      certificate_json: JSON.stringify(normalized, null, 2),
    }))
    setShowCertificateEditor(true)
    setShowCertificateSync(false)
    setCertificateSyncError('')
    withNotice(t('admin_manage_cert_synced'))
  }
  const handleCreateCategory = async () => {
    const payload = {
      name: categoryDraft.name.trim(),
      type: 'TEST',
      description: categoryDraft.description.trim(),
    }
    if (!payload.name) {
      setCategoryError(t('admin_manage_err_category_name'))
      return
    }
    setCategoryBusy(true)
    setCategoryError('')
    try {
      const { data: created } = await adminApi.createCategory(payload)
      const { data: categoryRows } = await adminApi.categories()
      const nextCategories = Array.isArray(categoryRows) ? [...categoryRows] : []
      const resolvedCategory = created?.id
        ? created
        : nextCategories.find((category) => String(category.name || '').toLowerCase() === payload.name.toLowerCase())
      if (resolvedCategory?.id && !nextCategories.some((category) => String(category.id) === String(resolvedCategory.id))) {
        nextCategories.unshift(resolvedCategory)
      }
      setCategories(nextCategories)
      setSettingsForm((prev) => ({ ...prev, category_id: String(resolvedCategory?.id || '') }))
      setShowCategoryPicker(true)
      setCategoryDraft(EMPTY_CATEGORY_DRAFT)
      withNotice(t('admin_manage_category_created'))
    } catch (e) {
      setCategoryError(readRequestError(e, t('admin_manage_err_create_category')))
    } finally {
      setCategoryBusy(false)
    }
  }
  const renderSettingsPageIcon = (iconPath) => (
    <span className={styles.settingsPageIcon} aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
        <path d={iconPath} />
      </svg>
    </span>
  )
  const renderSettingsPageHeader = (title, description, iconPath, actions = null) => (
    <div className={styles.settingsPageIntro}>
      <div>
        <div className={styles.settingsPageTitle}>
          {renderSettingsPageIcon(iconPath)}
          <h3>{title}</h3>
        </div>
        {description ? <p className={styles.settingsPageDescription}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.settingsPageActions}>{actions}</div> : null}
    </div>
  )
  const renderSettingsFooter = (saveLabel) => (
    <div className={styles.settingsPageFooter}>
      <button type="button" className={styles.blueBtn} disabled={savingSettings || isArchived} onClick={handleSettingsSave}>
        {savingSettings ? t('admin_manage_saving') : (saveLabel || t('save'))}
      </button>
      <button type="button" className={styles.ghostBtn} onClick={handleSettingsCancel}>{t('cancel')}</button>
    </div>
  )

  const renderSettingsPanel = () => {
    switch (settingsSection) {
      case 'instructions':
        return (
          <>
            {renderSettingsPageHeader(
              t('settings_instructions_page_title'),
              t('settings_instructions_page_desc'),
              SETTINGS_PAGE_ICONS.instructions,
            )}
            <div id="settings-instructions" className={styles.settingsPageStack}>
              <div className={styles.sectionCard}>
                <div className={styles.settingsCardHeader}>
                  {renderSettingsPageIcon(SETTINGS_PAGE_ICONS.instructions)}
                  <h4>{t('settings_test_overview_options')}</h4>
                </div>
                <div className={styles.settingsCheckboxList}>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.instructions_require_acknowledgement)} onChange={setCheckboxField('instructions_require_acknowledgement')} />
                    <span>{t('settings_require_acknowledgment')}</span>
                  </label>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.show_test_instructions)} onChange={setCheckboxField('show_test_instructions')} />
                    <span>{t('settings_show_test_instructions')}</span>
                  </label>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.show_test_duration)} onChange={setCheckboxField('show_test_duration')} />
                    <span>{t('settings_show_test_duration')}</span>
                  </label>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.show_passing_mark)} onChange={setCheckboxField('show_passing_mark')} />
                    <span>{t('settings_show_passing_mark')}</span>
                  </label>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.show_question_count)} onChange={setCheckboxField('show_question_count')} />
                    <span>{t('settings_show_question_count')}</span>
                  </label>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.show_remaining_retakes)} onChange={setCheckboxField('show_remaining_retakes')} />
                    <span>{t('settings_show_remaining_retakes')}</span>
                  </label>
                </div>
              </div>

              <div className={styles.sectionCard}>
                <label className={styles.settingsFieldGroup}>
                  <span>{t('settings_instructions_heading')}</span>
                  <input value={settingsForm.instructions_heading || ''} disabled={lockedExamFields} onChange={setTextField('instructions_heading')} />
                </label>
              </div>

              <div className={styles.sectionCard}>
                <label className={styles.settingsFieldGroup}>
                  <span>{t('settings_instructions_body')}</span>
                  <textarea className={styles.settingsEditor} value={settingsForm.instructions_body || ''} disabled={lockedExamFields} onChange={setTextField('instructions_body')} rows={8} />
                </label>
              </div>

              <div className={styles.sectionCard}>
                <label className={styles.settingsFieldGroup}>
                  <span>{t('settings_test_completion_message')}</span>
                  <textarea className={styles.settingsEditor} value={settingsForm.completion_message || ''} disabled={lockedExamFields} onChange={setTextField('completion_message')} rows={5} />
                </label>
              </div>
            </div>
            {renderSettingsFooter()}
          </>
        )
      case 'duration':
        return (
          <>
            {renderSettingsPageHeader(
              t('settings_duration_page_title'),
              t('settings_duration_page_desc'),
              SETTINGS_PAGE_ICONS.duration,
            )}
            <div id="settings-duration" className={styles.settingsPageStack}>
              <div className={styles.sectionCard}>
                <div className={styles.settingsFormStack}>
                  <label className={styles.settingsFieldGroup}>
                    <span>{t('settings_duration_type')}</span>
                    <select disabled={lockedExamFields} value={settingsForm.duration_type} onChange={setTextField('duration_type')}>
                      <option value="Time defined in each section">{t('settings_duration_type_section')}</option>
                      <option value="Single timer for full test">{t('settings_duration_type_single')}</option>
                    </select>
                  </label>
                  <label className={styles.settingsFieldGroup}>
                    <span>{t('settings_page_format')}</span>
                    <div className={styles.inlineReadOnlyField}>
                      <span>{t('settings_page_format_note')}</span>
                      <button type="button" className={styles.inlineLinkButton} onClick={() => openCycleTab('sections')}>{t('settings_go_to_sections')}</button>
                    </div>
                  </label>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.hide_assignment_metadata)} onChange={setCheckboxField('hide_assignment_metadata')} />
                    <span>{t('settings_hide_assignment_metadata')}</span>
                  </label>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.hide_finish_until_last_question)} onChange={setCheckboxField('hide_finish_until_last_question')} />
                    <span>{t('settings_hide_finish_until_last')}</span>
                  </label>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.enforce_section_order)} onChange={setCheckboxField('enforce_section_order')} />
                    <span>{t('settings_enforce_section_order')}</span>
                  </label>
                  <label className={styles.settingsFieldGroup}>
                    <span>{t('settings_calculator_type')}</span>
                    <select disabled={lockedExamFields} value={settingsForm.calculator_type} onChange={setTextField('calculator_type')}>
                      <option value="No calculator">{t('settings_calculator_none')}</option>
                      <option value="Simple calculator">{t('settings_calculator_simple')}</option>
                      <option value="Advanced calculator">{t('settings_calculator_advanced')}</option>
                    </select>
                  </label>
                </div>
              </div>
            </div>
            {renderSettingsFooter()}
          </>
        )
      case 'security':
        return (
          <>
            {renderSettingsPageHeader(
              t('settings_security_page_title'),
              t('settings_security_page_desc'),
              SETTINGS_PAGE_ICONS.security,
            )}
            <div id="settings-security" className={styles.settingsPageStack}>
              <div className={styles.sectionCard}>
                <label className={styles.settingsInlineCheck}>
                  <input type="checkbox" disabled={lockedExamFields} checked={isBrowserLockdownEnabled} onChange={(e) => setBrowserLockdownEnabled(e.target.checked)} />
                  <span>{t('settings_enable_lockdown')}</span>
                </label>
              </div>
              <div className={styles.sectionCard}>
                <label className={styles.settingsInlineCheck}>
                  <input type="checkbox" disabled={lockedExamFields} checked={isProctoringEnabled} onChange={(e) => setProctoringEnabled(e.target.checked)} />
                  <span>{t('settings_enable_proctoring')}</span>
                </label>
              </div>
              <div className={styles.sectionCard}>
                <div className={styles.settingsCardHeader}>
                  {renderSettingsPageIcon(SETTINGS_PAGE_ICONS.review)}
                  <h4>{t('settings_proctoring_checks')}</h4>
                </div>
                <p className={styles.sectionDescription}>{t('settings_proctoring_checks_desc')}</p>
                <div className={styles.settingsTwoColumnChecks}>
                  <div className={styles.settingsCheckboxList}>
                    {['lighting_required', 'face_detection', 'multi_face', 'eye_tracking'].map((field) => (
                      <label key={field} className={styles.settingsInlineCheck}>
                        <input
                          type="checkbox"
                          disabled={lockedExamFields}
                          checked={Boolean(settingsForm.proctoring_config?.[field])}
                          onChange={setProctoringConfigField(field)}
                        />
                        <span>{t(PROCTOR_LABEL_KEYS[field])}</span>
                      </label>
                    ))}
                  </div>
                  <div className={styles.settingsCheckboxList}>
                    {['head_pose_detection', 'audio_detection', 'object_detection', 'screen_capture'].map((field) => (
                      <label key={field} className={styles.settingsInlineCheck}>
                        <input
                          type="checkbox"
                          disabled={lockedExamFields}
                          checked={Boolean(settingsForm.proctoring_config?.[field])}
                          onChange={setProctoringConfigField(field)}
                        />
                        <span>{t(PROCTOR_LABEL_KEYS[field])}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div className={styles.sectionCard}>
                <label className={styles.settingsFieldGroup}>
                  <span>{t('settings_network_access')}</span>
                  <select disabled={lockedExamFields} value={settingsForm.network_access} onChange={setTextField('network_access')}>
                    <option value="ALL_NETWORKS">{t('settings_network_all')}</option>
                    <option value="INTERNAL_ONLY">{t('settings_network_internal')}</option>
                    <option value="ALLOWLIST_ONLY">{t('settings_network_allowlist')}</option>
                  </select>
                </label>
              </div>
              <div className={styles.sectionCard}>
                <div className={styles.settingsCheckboxList}>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.auto_logout_after_finish_or_pause)} onChange={setCheckboxField('auto_logout_after_finish_or_pause')} />
                    <span>{t('settings_auto_logout')}</span>
                  </label>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.require_profile_update)} onChange={setCheckboxField('require_profile_update')} />
                    <span>{t('settings_require_profile_update')}</span>
                  </label>
                </div>
              </div>
            </div>
            {renderSettingsFooter()}
          </>
        )
      case 'retake':
        return (
          <>
            {renderSettingsPageHeader(
              t('settings_retake_page_title'),
              t('settings_retake_page_desc'),
              SETTINGS_PAGE_ICONS.retake,
            )}
            <div id="settings-retake" className={styles.settingsPageStack}>
              <div className={styles.sectionCard}>
                <div className={styles.settingsCheckboxList}>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.allow_pause)} onChange={setCheckboxField('allow_pause')} />
                    <span>{t('settings_allow_pause')}</span>
                  </label>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.allow_retake)} onChange={setCheckboxField('allow_retake')} />
                    <span>{t('settings_allow_retake')}</span>
                  </label>
                </div>
              </div>
              {settingsForm.allow_pause ? (
                <div className={styles.sectionCard}>
                  <label className={styles.settingsFieldGroup}>
                    <span>{t('settings_pause_duration')}</span>
                    <input type="number" min="1" value={settingsForm.pause_duration_minutes} disabled={lockedExamFields} onChange={setTextField('pause_duration_minutes')} />
                  </label>
                </div>
              ) : null}
              {settingsForm.allow_retake ? (
                <div className={styles.sectionCard}>
                  <label className={styles.settingsFieldGroup}>
                    <span>{t('settings_retake_cooldown')}</span>
                    <input type="number" min="0" step="1" value={settingsForm.retake_cooldown_hours} disabled={lockedExamFields} onChange={setTextField('retake_cooldown_hours')} />
                  </label>
                </div>
              ) : null}
              <div className={styles.sectionCard}>
                <label className={styles.settingsInlineCheck}>
                  <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.limited_free_reschedules)} onChange={setCheckboxField('limited_free_reschedules')} />
                  <span>{t('settings_limited_reschedules')}</span>
                </label>
              </div>
            </div>
            {renderSettingsFooter()}
          </>
        )
      case 'language':
        return (
          <>
            {renderSettingsPageHeader(
              t('settings_language_page_title'),
              t('settings_language_page_desc'),
              SETTINGS_PAGE_ICONS.language,
            )}
            <div id="settings-language" className={styles.settingsPageStack}>
              <div className={styles.sectionCard}>
                <div className={styles.settingsCardHeader}>
                  {renderSettingsPageIcon(SETTINGS_PAGE_ICONS.language)}
                  <h4>{t('settings_language_preference')}</h4>
                </div>
                <p className={styles.sectionDescription}>{t('settings_language_preference_desc')}</p>
                <label className={styles.settingsFieldGroup}>
                  <span>{t('settings_language_preference')}</span>
                  <select disabled={lockedExamFields} value={settingsForm.language} onChange={setTextField('language')}>
                    {languageOptions.map((option) => (
                      <option key={option.value || 'empty'} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className={styles.sectionCard}>
                <div className={styles.settingsCardHeader}>
                  {renderSettingsPageIcon(SETTINGS_PAGE_ICONS.categories)}
                  <h4>{t('settings_translation_settings')}</h4>
                </div>
                <p className={styles.sectionDescription}>
                  {t('settings_translation_settings_desc')}
                </p>
                <div className={styles.tableCard}>
                  <div className={styles.tableToolbar}>
                    <div className={styles.settingsSubtableTitle}>{t('settings_translations')}</div>
                    <div className={styles.tableActions}>
                      <button type="button" className={styles.blueBtn} disabled={lockedExamFields} onClick={startCreateTranslation}>
                        {t('settings_add_translation')}
                      </button>
                    </div>
                  </div>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>{t('settings_language_label')}</th>
                        <th style={{ width: '180px' }}>{t('settings_action')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {translationRows.length === 0 ? (
                        <tr>
                          <td colSpan={2} className={styles.tableEmptyCell}>{t('admin_manage_no_translations')}</td>
                        </tr>
                      ) : translationRows.map((translation) => (
                        <tr key={translation.id}>
                          <td>
                            <div className={styles.inlineDetailTitle}>{languageLabelOf(translation.language, languageOptions)}</div>
                            <div className={styles.inlineDetailCopy}>
                              {translation.title || translation.description || translation.instructions_body || translation.completion_message || t('admin_manage_translation_drafted')}
                            </div>
                          </td>
                          <td>
                            <div className={styles.inlineActions}>
                              <button type="button" className={styles.blueBtn} disabled={lockedExamFields} onClick={() => startEditTranslation(translation)}>
                                {t('edit')}
                              </button>
                              <button type="button" className={styles.ghostBtn} disabled={lockedExamFields} onClick={() => removeTranslationEntry(translation.id)}>
                                {t('remove')}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {showTranslationEditor ? (
                  <div className={styles.editorCard}>
                    <div className={styles.editorHeader}>
                      <h5>{editingTranslationId ? t('settings_edit_translation') : t('settings_add_translation')}</h5>
                      <p>{t('settings_translation_editor_desc')}</p>
                    </div>
                    {translationError ? <div className={styles.error}>{translationError}</div> : null}
                    <div className={styles.inlineFormGrid}>
                      <label className={styles.settingsFieldGroup}>
                        <span>{t('settings_language_label')}</span>
                        <select value={translationDraft.language} onChange={(event) => setTranslationDraft((prev) => ({ ...prev, language: event.target.value }))}>
                          {languageOptions.filter((option) => option.value).map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.settingsFieldGroup}>
                        <span>{t('settings_translated_title')}</span>
                        <input value={translationDraft.title} onChange={(event) => setTranslationDraft((prev) => ({ ...prev, title: event.target.value }))} />
                      </label>
                      <label className={`${styles.settingsFieldGroup} ${styles.editorWideField}`}>
                        <span>{t('settings_translated_description')}</span>
                        <textarea rows={4} value={translationDraft.description} onChange={(event) => setTranslationDraft((prev) => ({ ...prev, description: event.target.value }))} />
                      </label>
                      <label className={`${styles.settingsFieldGroup} ${styles.editorWideField}`}>
                        <span>{t('settings_translated_instructions')}</span>
                        <textarea rows={4} value={translationDraft.instructions_body} onChange={(event) => setTranslationDraft((prev) => ({ ...prev, instructions_body: event.target.value }))} />
                      </label>
                      <label className={`${styles.settingsFieldGroup} ${styles.editorWideField}`}>
                        <span>{t('settings_translated_completion')}</span>
                        <textarea rows={3} value={translationDraft.completion_message} onChange={(event) => setTranslationDraft((prev) => ({ ...prev, completion_message: event.target.value }))} />
                      </label>
                    </div>
                    <div className={styles.inlineActions}>
                      <button type="button" className={styles.blueBtn} onClick={saveTranslationDraft}>
                        {t('settings_save_translation')}
                      </button>
                      <button type="button" className={styles.ghostBtn} onClick={cancelTranslationEditor}>
                        {t('cancel')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            {renderSettingsFooter()}
          </>
        )
      case 'result-validity':
        return (
          <>
            {renderSettingsPageHeader(
              t('settings_validity_page_title'),
              t('settings_validity_page_desc'),
              SETTINGS_PAGE_ICONS.validity,
            )}
            <div id="settings-result-validity" className={styles.settingsPageStack}>
              <div className={styles.sectionCard}>
                <label className={styles.settingsInlineCheck}>
                  <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.result_validity_period_enabled)} onChange={setCheckboxField('result_validity_period_enabled')} />
                  <span>{t('settings_result_validity')}</span>
                </label>
                {settingsForm.result_validity_period_enabled ? (
                  <label className={styles.settingsFieldGroup}>
                    <span>{t('settings_validity_days')}</span>
                    <input type="number" min="1" disabled={lockedExamFields} value={settingsForm.result_validity_days} onChange={setTextField('result_validity_days')} />
                  </label>
                ) : null}
              </div>
            </div>
            {renderSettingsFooter()}
          </>
        )
      case 'grading':
        return (() => {
          const sectionCount = Math.max(0, Number(settingsForm.section_count || 0))
          return (
            <>
              {renderSettingsPageHeader(
                t('settings_grading_page_title'),
                t('settings_grading_page_desc'),
                SETTINGS_PAGE_ICONS.grading,
              )}
              <div id="settings-grading" className={styles.settingsPageStack}>
                <div className={styles.sectionCard}>
                  <div className={styles.settingsCardHeader}>
                    {renderSettingsPageIcon(SETTINGS_PAGE_ICONS.validity)}
                    <h4>{t('settings_grading_pass_rule')}</h4>
                  </div>
                  <div className={styles.gradingRuleList}>
                    <p>{t('admin_manage_grading_overall', { score: settingsForm.passing_score || '0.00' })}</p>
                    <p>{t('admin_manage_grading_sections')}</p>
                    {sectionCount > 0 ? (
                      <ol>
                        {Array.from({ length: sectionCount }).map((_, index) => (
                          <li key={`grading-section-${index}`}>
                            {t('admin_manage_grading_section_n', { score: settingsForm.passing_score || '0.00', n: index + 1 })}
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </div>
                </div>

                <div className={styles.sectionCard}>
                  <div className={styles.settingsCardHeader}>
                    {renderSettingsPageIcon(SETTINGS_PAGE_ICONS.grading)}
                    <h4>{t('settings_define_passing_mark')}</h4>
                  </div>
                  <p className={styles.sectionDescription}>{t('settings_define_passing_mark_desc')}</p>
                  <div className={styles.settingsCompactFieldRow}>
                    <label className={styles.settingsFieldGroup}>
                      <span>{t('settings_passing_mark')}</span>
                      <input type="number" min="0" max="100" disabled={lockedExamFields} value={settingsForm.passing_score} onChange={setTextField('passing_score')} />
                    </label>
                  </div>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.passing_mark_inclusive)} onChange={setCheckboxField('passing_mark_inclusive')} />
                    <span>{t('settings_passing_mark_inclusive')}</span>
                  </label>
                </div>

                <div className={styles.sectionCard}>
                  <div className={styles.settingsCardHeader}>
                    {renderSettingsPageIcon(SETTINGS_PAGE_ICONS.security)}
                    <h4>{t('settings_proctoring_report')}</h4>
                  </div>
                  <p className={styles.sectionDescription}>
                    {t('settings_proctoring_report_desc')}
                  </p>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.require_positive_proctoring_report)} onChange={setCheckboxField('require_positive_proctoring_report')} />
                    <span>{t('settings_require_positive_proctoring')}</span>
                  </label>
                </div>

                <div className={styles.sectionCard}>
                  <label className={styles.settingsSwitchRow}>
                    <span>{t('settings_show_advanced')}</span>
                    <span className={styles.settingsSwitch}>
                      <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.show_advanced_grading)} onChange={setCheckboxField('show_advanced_grading')} />
                      <span />
                    </span>
                  </label>
                </div>
              </div>
              {renderSettingsFooter()}
            </>
          )
        })()
      case 'personal-report':
        return (
          <>
            {renderSettingsPageHeader(
              t('settings_personal_report_page_title'),
              t('settings_personal_report_page_desc'),
              SETTINGS_PAGE_ICONS.personalReport,
            )}
            <div id="settings-personal-report" className={styles.settingsPageStack}>
              <div className={styles.sectionCard}>
                <div className={styles.settingsCardHeader}>
                  {renderSettingsPageIcon(SETTINGS_PAGE_ICONS.duration)}
                  <h4>{t('settings_timing_access')}</h4>
                </div>
                <label className={styles.settingsFieldGroup}>
                  <span>{t('settings_show_report')}</span>
                  <select value={settingsForm.report_displayed} disabled={reportSettingsLocked} onChange={setTextField('report_displayed')}>
                    {reportDisplayOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <div className={styles.settingsCheckboxList}>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={reportSettingsLocked} checked={Boolean(settingsForm.report_lifespan_enabled)} onChange={setCheckboxField('report_lifespan_enabled')} />
                    <span>{t('settings_report_lifespan')}</span>
                  </label>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={reportSettingsLocked} checked={Boolean(settingsForm.report_access_duration_enabled)} onChange={setCheckboxField('report_access_duration_enabled')} />
                    <span>{t('settings_report_access_duration')}</span>
                  </label>
                </div>
              </div>

              <div className={styles.sectionCard}>
                <div className={styles.settingsCardHeader}>
                  {renderSettingsPageIcon(SETTINGS_PAGE_ICONS.scoreReport)}
                  <h4>{t('settings_report_content_heading')}</h4>
                </div>
                <label className={styles.settingsFieldGroup}>
                  <span>{t('settings_report_content')}</span>
                  <select value={settingsForm.report_content} disabled={reportSettingsLocked} onChange={setTextField('report_content')}>
                    {reportContentOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <div className={styles.settingsTwoColumnChecks}>
                  <div className={styles.settingsCheckboxList}>
                    {personalReportLeftFlags.map(([field, label]) => (
                      <label key={field} className={styles.settingsInlineCheck}>
                        <input type="checkbox" disabled={reportSettingsLocked} checked={Boolean(settingsForm[field])} onChange={setCheckboxField(field)} />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                  <div className={styles.settingsCheckboxList}>
                    {personalReportRightFlags.map(([field, label]) => (
                      <label key={field} className={styles.settingsInlineCheck}>
                        <input type="checkbox" disabled={reportSettingsLocked} checked={Boolean(settingsForm[field])} onChange={setCheckboxField(field)} />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className={styles.sectionCard}>
                <div className={styles.settingsCardHeader}>
                  {renderSettingsPageIcon(SETTINGS_PAGE_ICONS.review)}
                  <h4>{t('settings_review_options')}</h4>
                </div>
                <div className={styles.settingsCheckboxList}>
                  <label className={styles.settingsInlineCheck}>
                    <input type="checkbox" disabled={reportSettingsLocked} checked={Boolean(settingsForm.show_answer_review)} onChange={setCheckboxField('show_answer_review')} />
                    <span>{t('settings_allow_answer_review')}</span>
                  </label>
                  <label className={styles.settingsInlineCheck}>
                    <input
                      type="checkbox"
                      disabled={reportSettingsLocked || !settingsForm.show_answer_review}
                      checked={Boolean(settingsForm.show_correct_answers)}
                      onChange={setCheckboxField('show_correct_answers')}
                    />
                    <span>{t('settings_show_correct_answers')}</span>
                  </label>
                </div>
              </div>

              <div className={styles.sectionCard}>
                <div className={styles.settingsCardHeader}>
                  {renderSettingsPageIcon(SETTINGS_PAGE_ICONS.attachments)}
                  <h4>{t('settings_export_options')}</h4>
                </div>
                <div className={styles.settingsCheckboxList}>
                  {personalReportExportFlags.map(([field, label]) => (
                    <label key={field} className={styles.settingsInlineCheck}>
                      <input type="checkbox" disabled={reportSettingsLocked} checked={Boolean(settingsForm[field])} onChange={setCheckboxField(field)} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            {renderSettingsFooter()}
          </>
        )
      case 'score-report':
        return (
          <>
            {renderSettingsPageHeader(
              t('settings_score_report_page_title'),
              t('settings_score_report_page_desc'),
              SETTINGS_PAGE_ICONS.scoreReport,
            )}
            <div id="settings-score-report" className={styles.settingsPageStack}>
              <div className={styles.sectionCard}>
                <p className={styles.sectionDescription}>
                  {t('settings_score_report_global_note')}
                </p>
                <div className={styles.inlineActions}>
                  <button
                    type="button"
                    className={styles.blueBtn}
                    disabled={lockedExamFields}
                    onClick={() => {
                      setSettingsForm((prev) => ({ ...prev, custom_score_report_enabled: true }))
                      withNotice(t('admin_manage_custom_score_report_enabled'))
                    }}
                  >
                    {t('settings_create_custom')}
                  </button>
                  {settingsForm.custom_score_report_enabled ? (
                    <button
                      type="button"
                      className={styles.ghostBtn}
                      disabled={lockedExamFields}
                      onClick={() => {
                        setSettingsForm((prev) => ({
                          ...prev,
                          custom_score_report_enabled: false,
                          score_report_heading: DEFAULT_SCORE_REPORT_SETTINGS.heading,
                          score_report_intro: DEFAULT_SCORE_REPORT_SETTINGS.intro,
                          score_report_include_candidate_summary: DEFAULT_SCORE_REPORT_SETTINGS.include_candidate_summary,
                          score_report_include_section_breakdown: DEFAULT_SCORE_REPORT_SETTINGS.include_section_breakdown,
                          score_report_include_proctoring_summary: DEFAULT_SCORE_REPORT_SETTINGS.include_proctoring_summary,
                          score_report_include_certificate_status: DEFAULT_SCORE_REPORT_SETTINGS.include_certificate_status,
                          score_report_include_pass_fail_badge: DEFAULT_SCORE_REPORT_SETTINGS.include_pass_fail_badge,
                        }))
                        withNotice(t('admin_manage_custom_score_report_reset'))
                      }}
                    >
                      {t('settings_reset_custom')}
                    </button>
                  ) : null}
                </div>
                {settingsForm.custom_score_report_enabled ? (
                  <div className={styles.editorCard}>
                    <div className={styles.editorHeader}>
                      <h5>{t('settings_custom_layout')}</h5>
                      <p>{t('settings_custom_layout_desc')}</p>
                    </div>
                    <div className={styles.inlineFormGrid}>
                      <label className={styles.settingsFieldGroup}>
                        <span>{t('settings_report_heading')}</span>
                        <input value={settingsForm.score_report_heading} disabled={lockedExamFields} onChange={setTextField('score_report_heading')} />
                      </label>
                      <label className={`${styles.settingsFieldGroup} ${styles.editorWideField}`}>
                        <span>{t('settings_report_introduction')}</span>
                        <textarea rows={4} value={settingsForm.score_report_intro} disabled={lockedExamFields} onChange={setTextField('score_report_intro')} />
                      </label>
                    </div>
                    <div className={styles.settingsCheckboxList}>
                      <label className={styles.settingsInlineCheck}>
                        <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.score_report_include_candidate_summary)} onChange={setCheckboxField('score_report_include_candidate_summary')} />
                        <span>{t('settings_include_candidate_summary')}</span>
                      </label>
                      <label className={styles.settingsInlineCheck}>
                        <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.score_report_include_section_breakdown)} onChange={setCheckboxField('score_report_include_section_breakdown')} />
                        <span>{t('settings_include_section_breakdown')}</span>
                      </label>
                      <label className={styles.settingsInlineCheck}>
                        <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.score_report_include_proctoring_summary)} onChange={setCheckboxField('score_report_include_proctoring_summary')} />
                        <span>{t('settings_include_proctoring_summary')}</span>
                      </label>
                      <label className={styles.settingsInlineCheck}>
                        <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.score_report_include_certificate_status)} onChange={setCheckboxField('score_report_include_certificate_status')} />
                        <span>{t('settings_include_certificate_status')}</span>
                      </label>
                      <label className={styles.settingsInlineCheck}>
                        <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.score_report_include_pass_fail_badge)} onChange={setCheckboxField('score_report_include_pass_fail_badge')} />
                        <span>{t('settings_include_pass_fail_badge')}</span>
                      </label>
                    </div>
                    <div className={styles.previewList}>
                      <div className={styles.previewListTitle}>{settingsForm.score_report_heading || DEFAULT_SCORE_REPORT_SETTINGS.heading}</div>
                      <ul>
                        {settingsForm.score_report_intro ? <li>{settingsForm.score_report_intro}</li> : null}
                        {settingsForm.score_report_include_candidate_summary ? <li>{t('settings_preview_candidate_summary')}</li> : null}
                        {settingsForm.score_report_include_section_breakdown ? <li>{t('settings_preview_section_breakdown')}</li> : null}
                        {settingsForm.score_report_include_proctoring_summary ? <li>{t('settings_preview_proctoring_summary')}</li> : null}
                        {settingsForm.score_report_include_certificate_status ? <li>{t('settings_preview_certificate_status')}</li> : null}
                        {settingsForm.score_report_include_pass_fail_badge ? <li>{t('settings_preview_pass_fail_badge')}</li> : null}
                      </ul>
                    </div>
                  </div>
                ) : null}
                {!settingsForm.custom_score_report_enabled ? (
                  <div className={styles.settingsStatusNote}>{t('admin_manage_no_custom_score_report')}</div>
                ) : null}
              </div>
            </div>
            {renderSettingsFooter()}
          </>
        )
      case 'certificate':
        return (
          <>
            {renderSettingsPageHeader(
              t('settings_cert_page_title'),
              t('settings_cert_page_desc'),
              SETTINGS_PAGE_ICONS.certificate,
              <>
                <button type="button" className={styles.blueBtn} disabled={lockedExamFields} onClick={() => setShowCertificateEditor(true)}>{t('settings_add_cert')}</button>
                <button type="button" className={styles.ghostBtn} disabled={lockedExamFields} onClick={() => void toggleCertificateSync()}>{t('settings_sync_cert')}</button>
                <button type="button" className={`${styles.iconGhostBtn} ${certificateView === 'detail' ? styles.iconGhostBtnActive : ''}`} aria-label="Certificate board view" onClick={() => setCertificateView('detail')}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 5h16v14H4zM9 5v14M15 5v14M4 12h16" /></svg>
                </button>
                <button type="button" className={`${styles.iconGhostBtn} ${certificateView === 'compact' ? styles.iconGhostBtnActive : ''}`} aria-label="Certificate grid view" onClick={() => setCertificateView('compact')}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" /></svg>
                </button>
              </>,
            )}
            <div id="settings-certificate" className={styles.settingsPageStack}>
              {showCertificateSync ? (
                <div className={styles.editorCard}>
                  <div className={styles.editorHeader}>
                    <h5>{t('settings_sync_cert_heading')}</h5>
                    <p>{t('settings_sync_cert_desc')}</p>
                  </div>
                  {certificateSyncError ? <div className={styles.error}>{certificateSyncError}</div> : null}
                  <label className={styles.settingsFieldGroup}>
                    <span>{t('settings_source_test')}</span>
                    <select value={certificateSyncSourceId} disabled={certificateSyncLoading || lockedExamFields} onChange={(event) => setCertificateSyncSourceId(event.target.value)}>
                      <option value="">{certificateSyncLoading ? t('admin_manage_loading_cert_sources') : t('admin_manage_select_a_test')}</option>
                      {certificateSyncOptions.map((item) => (
                        <option key={item.id} value={item.id}>{item.name}</option>
                      ))}
                    </select>
                  </label>
                  <div className={styles.inlineActions}>
                    <button type="button" className={styles.blueBtn} disabled={lockedExamFields || !certificateSyncSourceId || certificateSyncLoading} onClick={applySyncedCertificate}>
                      {t('settings_apply_synced')}
                    </button>
                    <button type="button" className={styles.ghostBtn} onClick={() => setShowCertificateSync(false)}>
                      {t('cancel')}
                    </button>
                  </div>
                </div>
              ) : null}
              {(showCertificateEditor || certificatePreview) ? (
                <div className={styles.settingsSplitLayout}>
                  <div className={styles.sectionCard}>
                    <div className={styles.settingsCardHeader}>
                      {renderSettingsPageIcon(SETTINGS_PAGE_ICONS.certificate)}
                      <h4>{t('settings_cert_content')}</h4>
                    </div>
                    <div className={styles.inlineFormGrid}>
                      <label className={styles.settingsFieldGroup}>
                        <span>{t('settings_issue_rule')}</span>
                        <select value={settingsForm.certificate_issue_rule} disabled={lockedExamFields} onChange={setCertificateField('certificate_issue_rule')}>
                          {CERTIFICATE_ISSUE_RULE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.settingsFieldGroup}>
                        <span>{t('settings_certificate_title')}</span>
                        <input value={settingsForm.certificate_title} disabled={lockedExamFields} onChange={setCertificateField('certificate_title')} placeholder={t('admin_certs_title_placeholder')} />
                      </label>
                      <label className={styles.settingsFieldGroup}>
                        <span>{t('settings_subtitle')}</span>
                        <input value={settingsForm.certificate_subtitle} disabled={lockedExamFields} onChange={setCertificateField('certificate_subtitle')} placeholder={t('admin_certs_subtitle_placeholder')} />
                      </label>
                      <label className={styles.settingsFieldGroup}>
                        <span>{t('settings_issuer')}</span>
                        <input value={settingsForm.certificate_issuer} disabled={lockedExamFields} onChange={setCertificateField('certificate_issuer')} placeholder={t('admin_certs_issuer_placeholder')} />
                      </label>
                      <label className={styles.settingsFieldGroup}>
                        <span>{t('settings_signer')}</span>
                        <input value={settingsForm.certificate_signer} disabled={lockedExamFields} onChange={setCertificateField('certificate_signer')} placeholder={t('admin_certs_signer_placeholder')} />
                      </label>
                    </div>
                    <div className={styles.inlineActions}>
                      <button type="button" className={styles.ghostBtn} disabled={lockedExamFields} onClick={clearCertificateDraft}>
                        {t('settings_remove_cert')}
                      </button>
                    </div>
                  </div>
                  <div className={`${styles.certificatePreviewCard} ${certificateView === 'compact' ? styles.certificatePreviewCompact : ''}`}>
                    <div className={styles.certificatePreviewInner}>
                      <div className={styles.certificateBadge}>{t(certificateIssueRuleLabelKey(certificatePreview?.issue_rule))}</div>
                      <div className={styles.certificateHeading}>{certificatePreview?.title || t('admin_certs_title_placeholder')}</div>
                      <div className={styles.certificateSubtitle}>
                        {certificatePreview?.subtitle || `Awarded for successfully completing ${settingsForm.title || exam.title}.`}
                      </div>
                      <div className={styles.certificateMetaRow}>
                        <div>
                          <span>{t('settings_cert_preview_test')}</span>
                          <strong>{settingsForm.title || exam.title}</strong>
                        </div>
                        <div>
                          <span>{t('settings_issuer')}</span>
                          <strong>{certificatePreview?.issuer || t('settings_cert_not_set')}</strong>
                        </div>
                      </div>
                      <div className={styles.certificateSignerRow}>
                        <span>{t('settings_cert_signed_by')}</span>
                        <strong>{certificatePreview?.signer || t('settings_cert_awaiting_signer')}</strong>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className={styles.settingsEmptyState}>
                  {t('admin_manage_no_certificates')}
                </div>
              )}
            </div>
            {renderSettingsFooter()}
          </>
        )
      case 'coupons':
        return (
          <>
            {renderSettingsPageHeader(
              t('settings_coupons_page_title'),
              t('settings_coupons_page_desc'),
              SETTINGS_PAGE_ICONS.coupons,
            )}
            <div id="settings-coupons" className={styles.settingsPageStack}>
              <div className={styles.tableCard}>
                <div className={styles.tableToolbar}>
                  <div className={styles.settingsSubtableTitle}>{t('settings_list_of_coupons')}</div>
                  <div className={styles.tableActions}>
                    <button
                      type="button"
                      className={styles.blueBtn}
                      disabled={lockedExamFields}
                      onClick={() => {
                        setShowCouponGenerator((prev) => !prev)
                        setCouponError('')
                      }}
                    >
                      {t('settings_generate_coupons')}
                    </button>
                  </div>
                </div>
                {showCouponGenerator ? (
                  <div className={styles.editorCard}>
                    <div className={styles.editorHeader}>
                      <h5>{t('settings_coupon_generator')}</h5>
                      <p>{t('settings_coupon_generator_desc')}</p>
                    </div>
                    {couponError ? <div className={styles.error}>{couponError}</div> : null}
                    <div className={styles.inlineFormGrid}>
                      <label className={styles.settingsFieldGroup}>
                        <span>{t('settings_code_prefix')}</span>
                        <input value={couponGenerator.prefix} onChange={(event) => setCouponGenerator((prev) => ({ ...prev, prefix: event.target.value }))} />
                      </label>
                      <label className={styles.settingsFieldGroup}>
                        <span>{t('settings_count')}</span>
                        <input type="number" min="1" max="100" value={couponGenerator.count} onChange={(event) => setCouponGenerator((prev) => ({ ...prev, count: event.target.value }))} />
                      </label>
                      <label className={styles.settingsFieldGroup}>
                        <span>{t('settings_discount_type')}</span>
                        <select value={couponGenerator.discount_type} onChange={(event) => setCouponGenerator((prev) => ({ ...prev, discount_type: event.target.value }))}>
                          <option value="percentage">{t('settings_percentage')}</option>
                          <option value="fixed">{t('settings_fixed_amount')}</option>
                        </select>
                      </label>
                      <label className={styles.settingsFieldGroup}>
                        <span>{t('settings_amount')}</span>
                        <input type="number" min="1" value={couponGenerator.amount} onChange={(event) => setCouponGenerator((prev) => ({ ...prev, amount: event.target.value }))} />
                      </label>
                      <label className={styles.settingsFieldGroup}>
                        <span>{t('settings_expiration_time')}</span>
                        <input type="datetime-local" value={couponGenerator.expiration_time} onChange={(event) => setCouponGenerator((prev) => ({ ...prev, expiration_time: event.target.value }))} />
                      </label>
                    </div>
                    <div className={styles.inlineActions}>
                      <button type="button" className={styles.blueBtn} onClick={handleGenerateCoupons}>
                        {t('settings_create_coupon_rows')}
                      </button>
                      <button type="button" className={styles.ghostBtn} onClick={() => setShowCouponGenerator(false)}>
                        {t('cancel')}
                      </button>
                    </div>
                  </div>
                ) : null}
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>{t('settings_coupon_code')}</th>
                      <th>{t('settings_discount_type')}</th>
                      <th>{t('settings_amount')}</th>
                      <th>{t('status')}</th>
                      <th>{t('settings_expiration_time')}</th>
                      <th>{t('settings_used_by')}</th>
                      <th>{t('settings_date_of_use')}</th>
                      <th>{t('settings_created_by')}</th>
                      <th>{t('settings_actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className={styles.tableFilterRow}>
                      <td><input aria-label="Coupon code filter" placeholder={t('search')} value={couponFilters.code} onChange={setCouponFilterField('code')} /></td>
                      <td>
                        <select aria-label="Discount type filter" value={couponFilters.discount_type} onChange={setCouponFilterField('discount_type')}>
                          <option value="">{t('settings_all')}</option>
                          <option value="percentage">{t('settings_percentage')}</option>
                          <option value="fixed">{t('settings_fixed')}</option>
                        </select>
                      </td>
                      <td><input aria-label="Amount filter" placeholder={t('search')} value={couponFilters.amount} onChange={setCouponFilterField('amount')} /></td>
                      <td>
                        <select aria-label="Status filter" value={couponFilters.status} onChange={setCouponFilterField('status')}>
                          <option value="">{t('settings_all')}</option>
                          {couponStatusOptions.map((status) => (
                            <option key={status} value={String(status).toLowerCase()}>{status}</option>
                          ))}
                        </select>
                      </td>
                      <td><input aria-label="Expiration time filter" placeholder={t('search')} value={couponFilters.expiration_time} onChange={setCouponFilterField('expiration_time')} /></td>
                      <td><input aria-label="Used by filter" placeholder={t('search')} value={couponFilters.used_by} onChange={setCouponFilterField('used_by')} /></td>
                      <td><input aria-label="Date of use filter" placeholder={t('search')} value={couponFilters.date_of_use} onChange={setCouponFilterField('date_of_use')} /></td>
                      <td><input aria-label="Created by filter" placeholder={t('search')} value={couponFilters.created_by} onChange={setCouponFilterField('created_by')} /></td>
                      <td />
                    </tr>
                    {couponRows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className={styles.tableEmptyCell}>{t('admin_manage_no_coupons')}</td>
                      </tr>
                    ) : filteredCouponRows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className={styles.tableEmptyCell}>{t('admin_manage_no_coupons_match_filters')}</td>
                      </tr>
                    ) : (
                      filteredCouponRows.map((row) => (
                        <tr key={row.id}>
                          <td>{row.code}</td>
                          <td>{row.discount_type === 'percentage' ? t('settings_percentage') : t('settings_fixed')}</td>
                          <td>{row.discount_type === 'percentage' ? `${row.amount}%` : row.amount}</td>
                          <td>{row.status || t('draft')}</td>
                          <td>{row.expiration_time || '-'}</td>
                          <td>{row.used_by || '-'}</td>
                          <td>{row.date_of_use || '-'}</td>
                          <td>{row.created_by || t('admin')}</td>
                          <td className={styles.actionsCell}>
                            <button type="button" disabled={lockedExamFields} onClick={() => removeCouponEntry(row.id)}>{t('delete')}</button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
                <div className={styles.settingsTableFooter}>
                  <span>{couponHasActiveFilters ? `${t('settings_rows')}: ${filteredCouponRows.length} / ${couponRows.length}` : `${t('settings_rows')}: ${couponRows.length}`}</span>
                </div>
              </div>
            </div>
            {renderSettingsFooter()}
          </>
        )
      case 'attachments':
        return (
          <>
            {renderSettingsPageHeader(
              t('settings_attachments_page_title'),
              t('settings_attachments_page_desc'),
              SETTINGS_PAGE_ICONS.attachments,
            )}
            <div id="settings-attachments" className={styles.settingsPageStack}>
              <div className={styles.inlineActions}>
                <button type="button" className={styles.ghostBtn} disabled={lockedExamFields} onClick={startCreateAttachment}>{t('settings_create_new_attachment')}</button>
                <button
                  type="button"
                  className={styles.ghostBtn}
                  disabled={lockedExamFields}
                  onClick={() => {
                    setShowAttachmentImporter((prev) => !prev)
                    setAttachmentImportError('')
                  }}
                >
                  {t('settings_import_from_library')}
                </button>
              </div>
              {showAttachmentEditor ? (
                <div className={styles.editorCard}>
                  <div className={styles.editorHeader}>
                    <h5>{editingAttachmentId ? t('settings_edit_attachment') : t('settings_create_attachment')}</h5>
                    <p>{t('settings_attachment_editor_desc')}</p>
                  </div>
                  {attachmentError ? <div className={styles.error}>{attachmentError}</div> : null}
                  <div className={styles.inlineFormGrid}>
                    <label className={styles.settingsFieldGroup}>
                      <span>{t('settings_attachment_title')}</span>
                      <input value={attachmentDraft.title} onChange={(event) => setAttachmentDraft((prev) => ({ ...prev, title: event.target.value }))} />
                    </label>
                    <label className={styles.settingsFieldGroup}>
                      <span>{t('settings_attachment_url')}</span>
                      <input value={attachmentDraft.url} onChange={(event) => setAttachmentDraft((prev) => ({ ...prev, url: event.target.value }))} />
                    </label>
                    <label className={styles.settingsFieldGroup}>
                      <span>{t('settings_attachment_type')}</span>
                      <select value={attachmentDraft.type} onChange={(event) => setAttachmentDraft((prev) => ({ ...prev, type: event.target.value }))}>
                        {attachmentTypeOptions.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className={styles.inlineActions}>
                    <button type="button" className={styles.blueBtn} onClick={saveAttachmentDraft}>
                      {t('settings_save_attachment')}
                    </button>
                    <button type="button" className={styles.ghostBtn} onClick={cancelAttachmentEditor}>
                      {t('cancel')}
                    </button>
                  </div>
                </div>
              ) : null}
              {showAttachmentImporter ? (
                <div className={styles.editorCard}>
                  <div className={styles.editorHeader}>
                    <h5>{t('settings_import_attachment_rows')}</h5>
                    <p>{t('settings_import_attachment_rows_desc')}</p>
                  </div>
                  {attachmentImportError ? <div className={styles.error}>{attachmentImportError}</div> : null}
                  <label className={`${styles.settingsFieldGroup} ${styles.editorWideField}`}>
                    <span>{t('settings_attachment_rows')}</span>
                    <textarea rows={5} value={attachmentImportText} onChange={(event) => setAttachmentImportText(event.target.value)} />
                  </label>
                  <div className={styles.inlineActions}>
                    <button type="button" className={styles.blueBtn} onClick={importAttachmentRows}>
                      {t('settings_import_rows')}
                    </button>
                    <button type="button" className={styles.ghostBtn} onClick={() => setShowAttachmentImporter(false)}>
                      {t('cancel')}
                    </button>
                  </div>
                </div>
              ) : null}
              {attachmentRows.length === 0 ? (
                <div className={styles.settingsEmptyState}>{t('admin_manage_no_attachments')}</div>
              ) : (
                <div className={styles.tableCard}>
                  <div className={styles.tableToolbar}>
                    <div className={styles.settingsSubtableTitle}>{t('settings_linked_attachments')}</div>
                    <div className={styles.tableMeta}>{attachmentRows.length} {t('settings_attachments_count')}</div>
                  </div>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>{t('settings_attachment_title')}</th>
                        <th>{t('settings_type')}</th>
                        <th>{t('settings_url')}</th>
                        <th>{t('settings_actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attachmentRows.map((attachment) => (
                        <tr key={attachment.id}>
                          <td>{attachment.title}</td>
                          <td>{attachmentTypeOptions.find((option) => option.value === attachment.type)?.label || attachment.type}</td>
                          <td className={styles.urlCell}><a href={attachment.url} target="_blank" rel="noreferrer">{attachment.url}</a></td>
                          <td className={styles.actionsCell}>
                            <button type="button" disabled={lockedExamFields} onClick={() => startEditAttachment(attachment)}>{t('edit')}</button>
                            <button type="button" disabled={lockedExamFields} onClick={() => removeAttachmentItem(attachment.id)}>{t('delete')}</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {renderSettingsFooter()}
          </>
        )
      case 'externalattrs':
        return (
          <>
            {renderSettingsPageHeader(
              t('settings_external_page_title'),
              t('settings_external_page_desc'),
              SETTINGS_PAGE_ICONS.external,
            )}
            <div id="settings-externalattrs" className={styles.settingsPageStack}>
              <div className={styles.sectionCard}>
                <label className={styles.settingsFieldGroup}>
                  <span>{t('settings_external_id')}</span>
                  <input disabled={lockedExamFields} value={settingsForm.external_id} onChange={setTextField('external_id')} />
                </label>
              </div>
            </div>
            {renderSettingsFooter()}
          </>
        )
      case 'categories':
        return (
          <>
            {renderSettingsPageHeader(
              t('settings_categories_page_title'),
              t('settings_categories_page_desc'),
              SETTINGS_PAGE_ICONS.categories,
            )}
            <div id="settings-categories" className={styles.settingsPageStack}>
              <div className={styles.inlineActions}>
                <button
                  type="button"
                  className={styles.ghostBtn}
                  disabled={lockedExamFields}
                  onClick={() => {
                    setShowCategoryPicker(true)
                    setCategoryError('')
                  }}
                >
                  {t('settings_add_category')}
                </button>
                {selectedCategory ? (
                  <button type="button" className={styles.ghostBtn} disabled={lockedExamFields} onClick={() => setSettingsForm((prev) => ({ ...prev, category_id: '' }))}>
                    {t('settings_remove_category')}
                  </button>
                ) : null}
              </div>
              {(showCategoryPicker || selectedCategory) ? (
                <div className={styles.sectionCard}>
                  <label className={styles.settingsFieldGroup}>
                    <span>{t('settings_assigned_category')}</span>
                    <select disabled={lockedExamFields} value={settingsForm.category_id} onChange={setTextField('category_id')}>
                      <option value="">{t('settings_uncategorized')}</option>
                      {categories.map((cat) => (
                        <option key={cat.id} value={cat.id}>{cat.name}</option>
                      ))}
                    </select>
                  </label>
                  {selectedCategory ? <div className={styles.inlineDetailCopy}>{t('settings_current_category')}: {selectedCategory.name}</div> : null}
                </div>
              ) : null}
              <div className={styles.editorCard}>
                <div className={styles.editorHeader}>
                  <h5>{t('settings_create_new_category')}</h5>
                  <p>{t('settings_create_new_category_desc')}</p>
                </div>
                {categoryError ? <div className={styles.error}>{categoryError}</div> : null}
                <div className={styles.inlineFormGrid}>
                  <label className={styles.settingsFieldGroup}>
                    <span>{t('settings_category_name')}</span>
                    <input value={categoryDraft.name} disabled={lockedExamFields || categoryBusy} onChange={(event) => setCategoryDraft((prev) => ({ ...prev, name: event.target.value }))} />
                  </label>
                  <label className={`${styles.settingsFieldGroup} ${styles.editorWideField}`}>
                    <span>{t('settings_description')}</span>
                    <textarea rows={3} value={categoryDraft.description} disabled={lockedExamFields || categoryBusy} onChange={(event) => setCategoryDraft((prev) => ({ ...prev, description: event.target.value }))} />
                  </label>
                </div>
                <div className={styles.inlineActions}>
                  <button type="button" className={styles.blueBtn} disabled={lockedExamFields || categoryBusy} onClick={() => void handleCreateCategory()}>
                    {categoryBusy ? t('settings_creating') : t('settings_create_category')}
                  </button>
                </div>
              </div>
              <p className={styles.sectionDescription}>
                {t('settings_uncategorized_note')}
              </p>
            </div>
            {renderSettingsFooter()}
          </>
        )
      case 'basic':
      default:
        return (
          <div id="settings-basic" className={`${styles.sectionCard} ${styles.basicInfoCard}`}>
            <div className={styles.basicInfoHero}>
              <div className={styles.basicInfoHeroCopy}>
                <div className={styles.basicInfoHeading}>
                  <span className={styles.basicInfoIcon} aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 10v6" />
                      <path d="M12 7h.01" />
                    </svg>
                  </span>
                  <div>
                    <h3>{t('settings_basic_info')}</h3>
                    <p>{t('settings_basic_info_desc')}</p>
                  </div>
                </div>
              </div>
              <div className={styles.basicInfoActions}>
                <button type="button" className={styles.greenBtn} onClick={handlePreview}>{t('settings_preview')}</button>
                {!isPublished && !isArchived ? <button type="button" className={styles.blueBtn} onClick={handlePublish}>{t('settings_publish_test')}</button> : null}
                <button type="button" className={styles.ghostBtn} disabled={lockedExamFields} onClick={() => navigate(`/admin/tests/${exam.id}/edit`)}>
                  {t('settings_options')}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              </div>
            </div>

            <div className={styles.basicInfoLayout}>
              <div className={styles.basicInfoMain}>
                <div className={styles.basicInfoTopRow}>
                  <label className={styles.basicInfoWideField}>{t('settings_test_name')}<input value={settingsForm.title} disabled={isArchived} onChange={(e) => setSettingsForm((p) => ({ ...p, title: e.target.value }))} /></label>
                  <label>{t('settings_test_status')}
                    <span className={`${styles.statusBadge} ${isPublished ? styles.statusPublished : isArchived ? styles.statusArchived : styles.statusDraft}`} style={{ marginTop: '0.45rem', display: 'inline-block' }}>
                      {basicPageStatus}
                    </span>
                  </label>
                  <label>{t('settings_test_id')}
                    <span className={styles.testIdField} title={String(exam.id)} onClick={() => { navigator.clipboard.writeText(String(exam.id)) }} style={{ cursor: 'pointer', marginTop: '0.45rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <input value={settingsForm.code || String(exam.id)} readOnly style={{ cursor: 'pointer' }} title="Click to copy full ID" />
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </span>
                  </label>
                </div>

                <label>{t('settings_test_desc')}<textarea className={styles.basicDescriptionField} value={settingsForm.description} disabled={isArchived} onChange={(e) => setSettingsForm((p) => ({ ...p, description: e.target.value }))} rows={8} /></label>

                <label>{t('settings_descriptive_label')}<input value={settingsForm.descriptive_label} disabled={lockedExamFields} onChange={(e) => setSettingsForm((p) => ({ ...p, descriptive_label: e.target.value }))} placeholder="Optional short label shown in listings" /></label>

                <div className={styles.row}>
                  <label>{t('settings_creation_type')}
                    <select value={settingsForm.creation_type} disabled={lockedExamFields} onChange={(e) => setSettingsForm((p) => ({ ...p, creation_type: e.target.value }))}>
                      <option value="Test with sections">{t('settings_creation_type_sections')}</option>
                      <option value="Single flow test">{t('settings_creation_type_single')}</option>
                      <option value="Adaptive test">{t('settings_creation_type_adaptive')}</option>
                    </select>
                  </label>
                  <label>{t('settings_test_sections')}<input type="number" min="0" max="99" value={settingsForm.section_count} disabled={lockedExamFields} onChange={(e) => setSettingsForm((p) => ({ ...p, section_count: e.target.value }))} /></label>
                </div>

                <div className={styles.basicToggleRow}>
                  <label className={styles.toggleItem}>
                    <input type="checkbox" disabled={lockedExamFields} checked={Boolean(settingsForm.allow_section_selection)} onChange={(e) => setSettingsForm((p) => ({ ...p, allow_section_selection: e.target.checked }))} />
                    <span>{t('settings_enable_section_selection')}</span>
                  </label>
                </div>

                <div className={styles.row}>
                  <label>{t('settings_created_by')}<input value={createdByLabel} readOnly /></label>
                  <label>{t('settings_creation_time')}<input value={formatMetadataDate(exam.created_at)} readOnly /></label>
                </div>
                <div className={styles.row}>
                  <label>{t('settings_updated_by')}<input value={updatedByLabel} readOnly /></label>
                  <label>{t('settings_update_time')}<input value={formatMetadataDate(exam.updated_at)} readOnly /></label>
                </div>
              </div>

              <aside className={styles.basicInfoBrandPanel}>
                <div className={styles.basicInfoBrandBadge} aria-hidden="true">
                  <span>{basicPageInitials}</span>
                </div>
                <button
                  type="button"
                  className={styles.basicInfoBrandEdit}
                  disabled={lockedExamFields}
                  aria-label="Edit test branding"
                  onClick={() => navigate(`/admin/tests/${exam.id}/edit`)}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
                <div className={styles.basicInfoBrandMeta}>
                  <div className={styles.basicInfoBrandTitle}>{settingsForm.title || exam.title}</div>
                  <div className={styles.basicInfoBrandCopy}>
                    {settingsForm.creation_type || 'Test with sections'} with {settingsForm.section_count || 0} configured section{String(settingsForm.section_count || '0') === '1' ? '' : 's'}.
                  </div>
                </div>
              </aside>
            </div>
            {renderSettingsFooter()}
          </div>
        )
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.breadcrumb}>
        <button type="button" className={styles.backBtn} onClick={() => navigate('/admin/tests')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          {t('admin_manage_all_tests')}
        </button>
        <span className={styles.breadcrumbSep}>›</span>
        <span className={styles.breadcrumbCurrent}>{exam.title}</span>
        <span className={`${styles.statusBadge} ${isPublished ? styles.statusPublished : isArchived ? styles.statusArchived : styles.statusDraft}`}>
          {isPublished ? t('published') : isArchived ? t('archived') : t('draft')}
        </span>
      </div>

      {notice ? <div className={styles.notice}>{notice}</div> : null}
      {loadError ? (
        <div className={styles.error}>
          <div className={styles.bannerActions}>
            <span>{loadError}</span>
            <button type="button" className={styles.retryBtn} onClick={() => loadAll(false)}>{t('retry')}</button>
          </div>
        </div>
      ) : null}
      {error ? <div className={styles.error}>{error}</div> : null}

      {tab !== 'settings' && (
        <>
          <div className={styles.summaryGrid}>
            {manageOverviewCards.map((card) => (
              <div key={card.label} className={styles.summaryCard}>
                <div className={styles.summaryLabel}>{card.label}</div>
                <div className={styles.summaryValue}>{card.value}</div>
                <div className={styles.summarySub}>{card.helper}</div>
              </div>
            ))}
          </div>

          <div className={styles.lifecycleGrid}>
            {lifecycleCards.map((card) => (
              <div key={card.label} className={styles.lifecycleCard}>
                <div className={styles.lifecycleLabel}>{card.label}</div>
                <div className={styles.lifecycleValue}>{card.value}</div>
                <div className={styles.lifecycleHelper}>{card.helper}</div>
              </div>
            ))}
          </div>

          <div className={styles.quickActionRow}>
            {[
              { label: t('admin_manage_qa_preview'),     iconKey: 'preview',  onClick: handlePreview,                             primary: true },
              { label: t('admin_manage_qa_sessions'),    iconKey: 'sessions', onClick: () => openCycleTab('sessions') },
              { label: t('admin_manage_qa_proctoring'),  iconKey: 'shield',   onClick: () => openCycleTab('proctoring') },
              { label: t('admin_manage_qa_reports'),     iconKey: 'reports',  onClick: () => openCycleTab('reports') },
              { label: t('admin_manage_qa_learner_review'), iconKey: 'review',   onClick: () => openCycleTab('settings', 'reports') },
            ].map((action) => (
              <button
                key={action.label}
                type="button"
                className={`${styles.quickAction} ${action.primary ? styles.quickActionPrimary : ''}`}
                onClick={action.onClick}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d={QA_ICONS[action.iconKey]} />
                </svg>
                {action.label}
              </button>
            ))}
          </div>
        </>
      )}

      <div className={styles.tabs}>
        {TABS.map((tabItem) => (
          <button
            key={tabItem.id}
            type="button"
            className={tab === tabItem.id ? styles.tabActive : ''}
            onClick={() => handleTabChange(tabItem.id)}
          >
            {t(TAB_LABEL_KEYS[tabItem.id])}
          </button>
        ))}
      </div>

      <div className={styles.content}>
        {tab === 'settings' && (
          <SettingsTab
            settingsMenuItems={SETTINGS_MENU_ITEMS}
            menuToSection={MENU_TO_SECTION}
            settingsSection={settingsSection}
            handleSettingsMenuClick={handleSettingsMenuClick}
            renderSettingsPanel={renderSettingsPanel}
          />
        )}

        {tab === 'sections' && (
          <>
            <SectionsManager
              examId={id}
              onChange={() => adminApi.getQuestions(id).then(({ data }) => setQuestions(data || [])).catch(() => {})}
            />
            <QuestionsTab
              questions={questions}
              questionSearch={questionSearch}
              setQuestionSearch={setQuestionSearch}
              questionForm={questionForm}
              lockedExamFields={lockedExamFields}
              handleQuestionTypeChange={handleQuestionTypeChange}
              setQuestionForm={setQuestionForm}
              questionTypes={QUESTION_TYPES}
              questionBusy={questionBusy}
              editingQuestionId={editingQuestionId}
              resetQuestionForm={resetQuestionForm}
              handleQuestionSubmit={handleQuestionSubmit}
              filteredQuestions={filteredQuestions}
              questionTypeOf={questionTypeOf}
              deletingQuestionBusyId={deletingQuestionBusyId}
              deleteQuestionId={deleteQuestionId}
              setDeleteQuestionId={setDeleteQuestionId}
              startEditQuestion={startEditQuestion}
              handleDeleteQuestion={handleDeleteQuestion}
            />
          </>
        )}

        {tab === 'sessions' && (
          <SessionsTab
            sessions={sessions}
            sessionForm={sessionForm}
            setSessionForm={setSessionForm}
            learners={learners}
            isArchived={isArchived}
            sessionFormReady={sessionFormReady}
            sessionBusy={sessionBusy}
            handleCreateSession={handleCreateSession}
            users={users}
            deleteSessionId={deleteSessionId}
            deletingSessionBusyId={deletingSessionBusyId}
            setDeleteSessionId={setDeleteSessionId}
            handleDeleteSession={handleDeleteSession}
          />
        )}

        {false && tab === 'sessions' && (
          <section className={styles.full}>
            <h3 className={styles.tabPanelHeader}>{t('admin_manage_fallback_sessions_heading')} <span className={styles.countPill}>{sessions.length}</span></h3>
            <form className={styles.sectionCard} onSubmit={handleCreateSession}>
              <div className={styles.row}>
                <label>{t('admin_manage_learner_label')}
                  <select value={sessionForm.user_id} disabled={isArchived} onChange={(e) => setSessionForm((p) => ({ ...p, user_id: e.target.value }))}>
                    <option value="">{t('admin_manage_select_learner')}</option>
                    {learners.map((u) => <option key={u.id} value={u.id}>{u.user_id} - {u.name}</option>)}
                  </select>
                </label>
                <label>{t('admin_manage_schedule_datetime')}<input type="datetime-local" disabled={isArchived} value={sessionForm.scheduled_at} onChange={(e) => setSessionForm((p) => ({ ...p, scheduled_at: e.target.value }))} /></label>
              </div>
              <div className={styles.row}>
                <label>{t('admin_manage_th_access_mode')}
                  <select value={sessionForm.access_mode} disabled={isArchived} onChange={(e) => setSessionForm((p) => ({ ...p, access_mode: e.target.value }))}>
                    <option value="OPEN">{t('admin_manage_access_open')}</option><option value="RESTRICTED">{t('admin_manage_access_restricted')}</option>
                  </select>
                </label>
                <label>{t('admin_manage_notes_label')}<input value={sessionForm.notes} disabled={isArchived} onChange={(e) => setSessionForm((p) => ({ ...p, notes: e.target.value }))} /></label>
              </div>
              <p className={styles.muted}>Every testing session requires both a learner and a scheduled date/time.</p>
              <div className={styles.inlineActions}>
                <button type="submit" className={styles.blueBtn} disabled={sessionBusy || isArchived || !sessionFormReady}>
                  {sessionBusy ? t('saving') : t('admin_manage_btn_assign_session')}
                </button>
              </div>
            </form>
            <div className={styles.tableCard}>
              <table className={styles.table}>
                <thead><tr><th>{t('admin_manage_th_session_id')}</th><th>{t('admin_manage_th_user')}</th><th>{t('admin_manage_th_scheduled_at')}</th><th>{t('admin_manage_th_access_mode')}</th><th>{t('admin_manage_th_notes')}</th><th>{t('admin_manage_th_actions')}</th></tr></thead>
                <tbody>
                  {sessions.length === 0 ? (
                    <tr><td colSpan={6}>{t('admin_manage_no_sessions')}</td></tr>
                  ) : sessions.map((s) => (
                    <tr key={s.id}>
                      <td>{String(s.id).slice(0, 8)}</td>
                      <td>{users.find((u) => String(u.id) === String(s.user_id))?.user_id || String(s.user_id).slice(0, 8)}</td>
                      <td>{new Date(s.scheduled_at).toLocaleString()}</td>
                      <td>{s.access_mode}</td>
                      <td>{s.notes || '-'}</td>
                      <td className={styles.actionsCell}>
                        {deleteSessionId === s.id ? (
                          <>
                            <button
                              type="button"
                              className={styles.dangerInlineBtn}
                              disabled={isArchived || deletingSessionBusyId === s.id}
                              onClick={() => handleDeleteSession(s.id)}
                            >
                              {deletingSessionBusyId === s.id ? t('admin_manage_deleting') : t('confirm_delete')}
                            </button>
                            <button type="button" disabled={deletingSessionBusyId === s.id} onClick={() => setDeleteSessionId(null)}>{t('cancel')}</button>
                          </>
                        ) : (
                          <button type="button" disabled={isArchived || deletingSessionBusyId === s.id} onClick={() => handleDeleteSession(s.id)}>{t('delete')}</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'candidates' && (
          <CandidatesTab
            candidateRows={candidateRows}
            formatAttemptStatus={formatAttemptStatus}
            formatScore={formatScore}
            gradeDrafts={gradeDrafts}
            setGradeDrafts={setGradeDrafts}
            rowBusy={rowBusy}
            handleSaveGrade={handleSaveGrade}
            handleOpenResult={handleOpenResult}
            navigate={navigate}
            handlePauseResume={handlePauseResume}
            handleOpenVideo={handleOpenVideo}
            handleOpenReport={handleOpenReport}
          />
        )}

        {false && tab === 'candidates' && (
          <section className={styles.full}>
            <h3 className={styles.tabPanelHeader}>{t('admin_manage_fallback_candidates_heading')} <span className={styles.countPill}>{candidateRows.length}</span></h3>
            <p className={styles.sectionDescription}>
              Assigned learners stay visible here even before they start the test, so the roster and attempt activity are tracked in one place.
            </p>
            <div className={styles.tableCard}>
              <table className={styles.table}>
                <thead><tr><th>{t('admin_manage_th_attempt')}</th><th>{t('admin_manage_th_user')}</th><th>{t('admin_manage_th_status')}</th><th>{t('admin_manage_th_started')}</th><th>{t('admin_manage_th_score')}</th><th>{t('admin_manage_th_review')}</th><th>{t('admin_manage_th_high')}</th><th>{t('admin_manage_th_medium')}</th><th>{t('admin_manage_th_actions')}</th></tr></thead>
                <tbody>
                  {candidateRows.length === 0 ? (
                    <tr><td colSpan={9}>{t('admin_manage_no_candidates')}</td></tr>
                  ) : candidateRows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.attemptId}</td>
                      <td>{r.username}</td>
                      <td>
                        <span className={`${styles.statusBadge} ${r.status === 'NOT_STARTED' ? styles.statusNeutral : r.needsManualReview ? styles.statusPending : r.status === 'GRADED' ? styles.statusGraded : styles.statusNeutral}`}>
                          {formatAttemptStatus(r)}
                        </span>
                      </td>
                      <td>{r.startedAt ? new Date(r.startedAt).toLocaleString() : '-'}</td>
                      <td>{formatScore(r.score)}</td>
                      <td>
                        <div className={styles.reviewCell}>
                          <div className={styles.reviewState}>{r.reviewState}</div>
                          {r.submittedAt && <div className={styles.reviewMeta}>{t('status_submitted')} {new Date(r.submittedAt).toLocaleString()}</div>}
                          {r.attemptIdFull && r.status !== 'IN_PROGRESS' ? (
                            <div className={styles.scoreEditor}>
                              <input
                                type="number"
                                min="0"
                                max="100"
                                step="0.01"
                                value={gradeDrafts[r.id] ?? ''}
                                disabled={rowBusy[r.id]}
                                aria-label={`Grade for ${r.username}`}
                                onChange={(e) => setGradeDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))}
                              />
                              <button type="button" className={styles.blueBtn} disabled={rowBusy[r.id]} onClick={() => handleSaveGrade(r)}>
                                {rowBusy[r.id] ? t('saving') : r.status === 'GRADED' ? t('admin_manage_btn_update_grade') : t('admin_manage_btn_save_grade')}
                              </button>
                            </div>
                          ) : (
                            <div className={styles.reviewMeta}>
                              {r.attemptIdFull ? 'Submit required before grading' : 'Learner has not started this test yet'}
                            </div>
                          )}
                        </div>
                      </td>
                      <td>{r.highAlerts}</td>
                      <td>{r.mediumAlerts}</td>
                      <td className={styles.actionsCell}>
                        <button type="button" disabled={rowBusy[r.id] || !r.attemptIdFull} onClick={() => handleOpenResult(r)}>{t('admin_manage_btn_result')}</button>
                        <button type="button" disabled={rowBusy[r.id] || !r.attemptIdFull} onClick={() => navigate(`/admin/attempt-analysis?id=${r.attemptIdFull}`)}>{t('admin_manage_btn_analyze')}</button>
                        <button type="button" onClick={() => handlePauseResume(r)} disabled={rowBusy[r.id] || !r.attemptIdFull}>{r.paused ? t('admin_manage_btn_resume') : t('admin_manage_btn_pause')}</button>
                        <button type="button" onClick={() => handleOpenVideo(r)} disabled={rowBusy[r.id] || !r.attemptIdFull}>{t('admin_manage_btn_video')}</button>
                        <button type="button" onClick={() => handleOpenReport(r)} disabled={rowBusy[r.id] || !r.attemptIdFull}>{rowBusy[r.id] ? t('admin_manage_btn_opening') : t('admin_manage_btn_report')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'proctoring' && (
          <ProctoringTab
            exam={exam}
            sessions={sessions}
            selectedSession={selectedSession}
            setSelectedSession={setSelectedSession}
            monitoringSummaryCards={monitoringSummaryCards}
            view={view}
            setView={setView}
            filteredRows={filteredRows}
            attemptRows={attemptRows}
            bulkBusy={bulkBusy}
            bulkAction={bulkAction}
            handleBulkPauseResume={handleBulkPauseResume}
            loadAll={loadAll}
            loading={loading}
            clearMonitoringFilters={clearMonitoringFilters}
            monitoringHasFilters={monitoringHasFilters}
            navigate={navigate}
            examId={id}
            showFilters={showFilters}
            setShowFilters={setShowFilters}
            search={search}
            setSearch={setSearch}
            rowBusy={rowBusy}
            handlePauseResume={handlePauseResume}
            handleOpenReport={handleOpenReport}
            handleOpenVideo={handleOpenVideo}
            users={users}
            editingAccomId={editingAccomId}
            editingAccomForm={editingAccomForm}
            setEditingAccomForm={setEditingAccomForm}
            savingAccomId={savingAccomId}
            handleSaveAccom={handleSaveAccom}
            setEditingAccomId={setEditingAccomId}
            isArchived={isArchived}
            startEditAccom={startEditAccom}
          />
        )}

        {false && tab === 'proctoring' && (
          <section className={styles.full}>
            <h3 className={styles.tabPanelHeader}>{t('admin_manage_fallback_proctoring_heading')}</h3>
            <p className={styles.sectionDescription}>Review monitored attempts, special accommodations, and flagged activity for this test.</p>
            <div className={styles.row}>
              <label>{t('admin_manage_test_label')}<input value={exam.title || ''} readOnly /></label>
              <label>{t('admin_manage_testing_session_label')}
                <select value={selectedSession} onChange={(e) => setSelectedSession(e.target.value)}>
                  <option value="">{t('admin_manage_all_testing_sessions')}</option>
                  {sessions.map((s) => <option key={s.id} value={s.id}>{`Session ${String(s.id).slice(0, 6)}`}</option>)}
                </select>
              </label>
            </div>
            <div className={styles.summaryGrid}>
              {monitoringSummaryCards.map((card) => (
                <div key={card.label} className={styles.summaryCard}>
                  <div className={styles.summaryLabel}>{card.label}</div>
                  <div className={styles.summaryValue}>{card.value}</div>
                  <div className={styles.summarySub}>{card.helper}</div>
                </div>
              ))}
            </div>
            <div className={styles.viewTabs}>
              <button type="button" className={view === 'candidate_monitoring' ? styles.viewActive : ''} onClick={() => setView('candidate_monitoring')}>Candidate monitoring</button>
              <button type="button" className={view === 'special_accommodations' ? styles.viewActive : ''} onClick={() => setView('special_accommodations')}>Special accommodations</button>
              <button type="button" className={view === 'special_requests' ? styles.viewActive : ''} onClick={() => setView('special_requests')}>Special requests</button>
            </div>

            {view === 'candidate_monitoring' && (
              <div className={styles.tableCard}>
                <div className={styles.tableToolbar}>
                  <div className={styles.tableMeta}>
                    Showing {filteredRows.length} attempt{filteredRows.length !== 1 ? 's' : ''} across {attemptRows.length} loaded.
                  </div>
                  <div className={styles.tableActions}>
                    <button type="button" onClick={() => handleBulkPauseResume(true)} disabled={bulkBusy || filteredRows.length === 0}>
                      {bulkBusy && bulkAction === 'pause' ? 'Pausing...' : 'Pause session'}
                    </button>
                    <button type="button" onClick={() => handleBulkPauseResume(false)} disabled={bulkBusy || filteredRows.length === 0}>
                      {bulkBusy && bulkAction === 'resume' ? 'Resuming...' : 'Resume session'}
                    </button>
                    <button type="button" onClick={() => void loadAll(false)} disabled={loading}>
                      {loading ? t('admin_manage_btn_refreshing') : t('admin_manage_btn_refresh')}
                    </button>
                    <button type="button" onClick={clearMonitoringFilters} disabled={!monitoringHasFilters}>
                      {t('admin_manage_btn_clear_filters')}
                    </button>
                    <button type="button" className={styles.blueBtn} onClick={() => navigate(`/admin/videos?exam_id=${id}`)}>{t('admin_manage_btn_open_supervision')}</button>
                    <button type="button" onClick={() => setShowFilters((s) => !s)}>{showFilters ? t('admin_manage_btn_hide_filters') : t('admin_manage_btn_filter')}</button>
                  </div>
                </div>
                {filteredRows.length === 0 ? (
                  <div className={styles.emptyPanel}>
                    <div className={styles.emptyTitle}>
                      {monitoringHasFilters ? t('admin_manage_no_attempts_match_filters') : t('admin_manage_no_attempts_yet')}
                    </div>
                    <div className={styles.emptyText}>
                      {monitoringHasFilters
                        ? t('admin_manage_clear_filters_hint')
                        : t('admin_manage_attempts_will_appear')}
                    </div>
                    {monitoringHasFilters && (
                      <button type="button" className={styles.ghostBtn} onClick={clearMonitoringFilters}>
                        {t('admin_manage_btn_clear_filters')}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className={styles.tableCard}>
                  <table className={styles.table}>
                    <thead>
                      <tr><th>{t('admin_manage_th_actions')}</th><th>{t('admin_manage_th_attempt_id')}</th><th>{t('admin_manage_th_username')}</th><th>{t('admin_manage_th_testing_session')}</th><th>{t('admin_manage_th_status')}</th><th>{t('admin_manage_th_started')}</th><th>{t('admin_manage_th_access')}</th><th>{t('admin_manage_th_comment')}</th><th>{t('admin_manage_th_proctor_rate')}</th></tr>
                      {showFilters && (
                        <tr>
                          <th></th>
                          <th><input placeholder={t('search')} value={search.attempt} onChange={(e) => setSearch((p) => ({ ...p, attempt: e.target.value }))} /></th>
                          <th><input placeholder={t('search')} value={search.user} onChange={(e) => setSearch((p) => ({ ...p, user: e.target.value }))} /></th>
                          <th><input placeholder={t('search')} value={search.session} onChange={(e) => setSearch((p) => ({ ...p, session: e.target.value }))} /></th>
                          <th><select value={search.status} onChange={(e) => setSearch((p) => ({ ...p, status: e.target.value }))}><option value="">{t('admin_manage_select_one')}</option><option value="IN_PROGRESS">{t('status_in_progress')}</option><option value="PAUSED">{t('status_paused')}</option><option value="SUBMITTED">{t('status_submitted')}</option><option value="GRADED">{t('status_graded')}</option></select></th>
                          <th></th>
                          <th><input placeholder={t('search')} value={search.group} onChange={(e) => setSearch((p) => ({ ...p, group: e.target.value }))} /></th>
                          <th><input placeholder={t('search')} value={search.comment} onChange={(e) => setSearch((p) => ({ ...p, comment: e.target.value }))} /></th>
                          <th></th>
                        </tr>
                      )}
                    </thead>
                    <tbody>
                      {filteredRows.map((r) => (
                        <tr key={r.id}>
                          <td className={styles.actionsCell}>
                            <button type="button" onClick={() => handlePauseResume(r)} disabled={rowBusy[r.id]}>{r.paused ? t('admin_manage_btn_resume') : t('admin_manage_btn_pause')}</button>
                            <button type="button" onClick={() => handleOpenReport(r)} disabled={rowBusy[r.id]}>{rowBusy[r.id] ? t('admin_manage_btn_opening') : t('admin_manage_btn_report')}</button>
                            <button type="button" onClick={() => handleOpenVideo(r)} disabled={rowBusy[r.id]} className={r.hasVideo ? styles.videoBtnGreen : styles.videoBtnRed}>{t('admin_manage_btn_video')}</button>
                          </td>
                          <td>{r.attemptId}</td><td>{r.username}</td><td>{r.sessionName}</td><td>{r.paused ? t('status_paused') : r.status}</td>
                          <td>{r.startedAt ? new Date(r.startedAt).toLocaleString() : '-'}</td><td>{r.userGroup}</td><td>{r.comment || '-'}</td><td>{r.proctorRate}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>
            )}

            {view === 'special_accommodations' && (
              <div className={styles.tableCard}>
                <table className={styles.table}>
                  <thead><tr><th>{t('admin_manage_th_session')}</th><th>{t('admin_manage_th_user')}</th><th>{t('admin_manage_th_access_mode')}</th><th>{t('admin_manage_th_notes')}</th><th>{t('admin_manage_th_scheduled_at')}</th><th>{t('admin_manage_th_actions')}</th></tr></thead>
                  <tbody>
                    {sessions.length === 0 ? <tr><td colSpan={6}>{t('admin_manage_no_accommodations')}</td></tr> : sessions.map((s) => (
                      <tr key={s.id}>
                        <td>{String(s.id).slice(0, 8)}</td>
                        <td>{users.find((u) => String(u.id) === String(s.user_id))?.user_id || String(s.user_id).slice(0, 8)}</td>
                        {editingAccomId === s.id ? (
                          <>
                            <td>
                              <select value={editingAccomForm.access_mode} onChange={(e) => setEditingAccomForm((p) => ({ ...p, access_mode: e.target.value }))}>
                                <option value="OPEN">{t('admin_manage_access_open')}</option>
                                <option value="RESTRICTED">{t('admin_manage_access_restricted')}</option>
                              </select>
                            </td>
                            <td><input value={editingAccomForm.notes} onChange={(e) => setEditingAccomForm((p) => ({ ...p, notes: e.target.value }))} placeholder={t('admin_manage_notes_placeholder')} /></td>
                            <td><input type="datetime-local" value={editingAccomForm.scheduled_at} onChange={(e) => setEditingAccomForm((p) => ({ ...p, scheduled_at: e.target.value }))} /></td>
                            <td className={styles.actionsCell}>
                              <button
                                type="button"
                                className={styles.blueBtn}
                                disabled={savingAccomId === s.id || !editingAccomForm.scheduled_at}
                                onClick={() => handleSaveAccom(s.id)}
                              >
                                {savingAccomId === s.id ? t('saving') : t('save')}
                              </button>
                              <button type="button" disabled={savingAccomId === s.id} onClick={() => setEditingAccomId(null)}>{t('cancel')}</button>
                            </td>
                          </>
                        ) : (
                          <>
                            <td>{s.access_mode}</td>
                            <td>{s.notes || '-'}</td>
                            <td>{new Date(s.scheduled_at).toLocaleString()}</td>
                            <td className={styles.actionsCell}>
                              <button type="button" disabled={isArchived} onClick={() => startEditAccom(s)}>{t('edit')}</button>
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {view === 'special_requests' && (
              <div className={styles.tableCard}>
                <table className={styles.table}>
                  <thead><tr><th>{t('admin_manage_th_attempt')}</th><th>{t('admin_manage_th_user')}</th><th>{t('admin_manage_th_high_alerts')}</th><th>{t('admin_manage_th_medium_alerts')}</th><th>{t('admin_manage_th_actions')}</th></tr></thead>
                  <tbody>
                    {attemptRows.filter((r) => r.highAlerts > 0 || r.mediumAlerts > 0).length === 0 ? <tr><td colSpan={5}>{t('admin_manage_no_flagged')}</td></tr> : attemptRows.filter((r) => r.highAlerts > 0 || r.mediumAlerts > 0).map((r) => (
                      <tr key={r.id}>
                        <td>{r.attemptId}</td><td>{r.username}</td><td>{r.highAlerts}</td><td>{r.mediumAlerts}</td>
                        <td className={styles.actionsCell}>
                          <button type="button" disabled={rowBusy[r.id]} onClick={() => navigate(`/admin/attempt-analysis?id=${r.id}`)}>{t('admin_manage_btn_analyze')}</button>
                          <button type="button" disabled={rowBusy[r.id]} onClick={() => handleOpenVideo(r)}>{t('admin_manage_btn_inspect_video')}</button>
                          <button type="button" disabled={rowBusy[r.id]} onClick={() => handleOpenReport(r)}>
                            {rowBusy[r.id] ? t('admin_manage_btn_opening') : t('admin_manage_btn_report')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {tab === 'administration' && (
          <AdministrationTab
            exam={exam}
            attemptRows={attemptRows}
            isArchived={isArchived}
            deletingExamBusy={deletingExamBusy}
            handleSettingsSave={handleSettingsSave}
            isPublished={isPublished}
            handlePublish={handlePublish}
            handleClose={handleClose}
            lockedExamFields={lockedExamFields}
            navigate={navigate}
            deleteExamConfirm={deleteExamConfirm}
            setDeleteExamConfirm={setDeleteExamConfirm}
            handleDeleteExam={handleDeleteExam}
          />
        )}

        {false && tab === 'administration' && (
          <section className={styles.full}>
            <h3 className={styles.tabPanelHeader}>{t('admin_manage_fallback_admin_heading')}</h3>
            <div className={styles.sectionCard}>
              <div className={styles.row}>
                <label>{t('admin_manage_current_status')}<input value={exam.status || ''} readOnly /></label>
                <label>{t('admin_manage_total_attempts')}<input value={String(attemptRows.length)} readOnly /></label>
              </div>
              <div className={styles.inlineActions}>
                <button type="button" className={styles.blueBtn} disabled={isArchived || deletingExamBusy} onClick={handleSettingsSave}>{t('admin_manage_btn_save_settings')}</button>
                {!isPublished && !isArchived ? <button type="button" className={styles.greenBtn} disabled={deletingExamBusy} onClick={handlePublish}>{t('admin_manage_btn_publish')}</button> : null}
                <button type="button" className={styles.ghostBtn} disabled={deletingExamBusy} onClick={handleClose}>{isArchived ? t('admin_manage_btn_unarchive') : t('admin_manage_btn_archive')}</button>
                <button type="button" className={styles.ghostBtn} disabled={lockedExamFields || deletingExamBusy} onClick={() => navigate(`/admin/tests/${exam.id}/edit`)}>{t('admin_manage_btn_open_editor')}</button>
                {deleteExamConfirm ? (
                  <>
                    <button type="button" className={styles.dangerBtn} disabled={deletingExamBusy} onClick={handleDeleteExam}>
                      {deletingExamBusy ? t('admin_manage_deleting') : t('confirm_delete')}
                    </button>
                    <button type="button" className={styles.ghostBtn} disabled={deletingExamBusy} onClick={() => setDeleteExamConfirm(false)}>{t('cancel')}</button>
                  </>
                ) : (
                  <button type="button" className={styles.dangerBtn} disabled={deletingExamBusy} onClick={handleDeleteExam}>{t('admin_manage_btn_delete_test')}</button>
                )}
              </div>
            </div>
          </section>
        )}

        {tab === 'reports' && (
          <ReportsTab
            reportsBusy={reportsBusy}
            downloadExamCsv={downloadExamCsv}
            downloadExamPdf={downloadExamPdf}
            attemptRows={attemptRows}
            rowBusy={rowBusy}
            handleOpenReport={handleOpenReport}
            handleOpenVideo={handleOpenVideo}
          />
        )}

        {false && tab === 'reports' && (
          <section className={styles.full}>
            <h3 className={styles.tabPanelHeader}>{t('admin_manage_fallback_reports_heading')}</h3>
            <div className={styles.sectionCard}>
              <div className={styles.inlineActions}>
                <button type="button" className={styles.blueBtn} disabled={reportsBusy} onClick={downloadExamCsv}>Download Test CSV</button>
                <button type="button" className={styles.blueBtn} disabled={reportsBusy} onClick={downloadExamPdf}>Download Test PDF</button>
              </div>
            </div>
            <div className={styles.tableCard}>
              <table className={styles.table}>
                <thead><tr><th>{t('admin_manage_th_attempt')}</th><th>{t('admin_manage_th_user')}</th><th>{t('admin_manage_th_status')}</th><th>{t('admin_manage_th_high')}</th><th>{t('admin_manage_th_medium')}</th><th>{t('admin_manage_th_actions')}</th></tr></thead>
                <tbody>
                  {attemptRows.length === 0 ? <tr><td colSpan={6}>{t('admin_manage_no_attempts_reporting')}</td></tr> : attemptRows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.attemptId}</td><td>{r.username}</td><td>{r.paused ? t('status_paused') : r.status}</td><td>{r.highAlerts}</td><td>{r.mediumAlerts}</td>
                      <td className={styles.actionsCell}>
                        <button type="button" disabled={rowBusy[r.id]} onClick={() => handleOpenReport(r)}>
                          {rowBusy[r.id] ? t('admin_manage_btn_opening') : t('admin_manage_btn_report')}
                        </button>
                        <button type="button" disabled={rowBusy[r.id]} onClick={() => handleOpenVideo(r)}>{t('admin_manage_btn_video')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
