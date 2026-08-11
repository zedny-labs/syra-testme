import React, { useEffect, useState } from 'react'
import AdminPageHeader from '../AdminPageHeader/AdminPageHeader'
import { createSurvey, deleteSurvey, listResponses, listSurveys, updateSurvey } from '../../../services/survey.service'
import useAuth from '../../../hooks/useAuth'
import useLanguage from '../../../hooks/useLanguage'
import styles from './AdminSurveys.module.scss'

const useSurveyQuestionTypes = (t) => [
  { value: 'TEXT', label: t('survey_question_type_text') },
  { value: 'MCQ', label: t('survey_question_type_mcq') },
  { value: 'MULTI_SELECT', label: t('survey_question_type_multi_select') },
  { value: 'RATING', label: t('survey_question_type_rating') },
  { value: 'BOOLEAN', label: t('survey_question_type_boolean') },
]

const CHOICE_TYPES = new Set(['MCQ', 'MULTI_SELECT'])

const blankQuestion = (questionType = 'TEXT') => ({
  text: '',
  question_type: questionType,
  options: CHOICE_TYPES.has(questionType) ? ['', ''] : [],
})

const normalizeQuestion = (question = {}) => {
  const questionType = question.question_type || 'TEXT'
  return {
    text: question.text || '',
    question_type: questionType,
    options: CHOICE_TYPES.has(questionType)
      ? (Array.isArray(question.options) && question.options.length > 0 ? question.options : ['', ''])
      : [],
  }
}

function resolveError(err) {
  if (err?.userMessage) return err.userMessage
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string') return detail
  return null
}

export default function AdminSurveys() {
  const { user } = useAuth()
  const { t } = useLanguage()
  const SURVEY_QUESTION_TYPES = useSurveyQuestionTypes(t)
  const isAdmin = user?.role === 'ADMIN'
  const currentUserId = String(user?.id || '')

  const [surveys, setSurveys] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Modal state
  const [modal, setModal] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [questions, setQuestions] = useState([blankQuestion()])
  const [isActive, setIsActive] = useState(true)
  const [modalError, setModalError] = useState('')
  const [saving, setSaving] = useState(false)

  // Responses modal state
  const [responsesModal, setResponsesModal] = useState(false)
  const [responseSurveyId, setResponseSurveyId] = useState(null)
  const [responses, setResponses] = useState([])
  const [responsesLoading, setResponsesLoading] = useState(false)

  // Card-level state
  const [expanded, setExpanded] = useState({})
  const [statusBusyId, setStatusBusyId] = useState(null)
  const [deleteBusyId, setDeleteBusyId] = useState(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState(null)

  // Toolbar state
  const [search, setSearch] = useState('')
  const [sortDir, setSortDir] = useState('asc')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const { data } = await listSurveys()
      setSurveys(data || [])
    } catch (err) {
      setError(resolveError(err) || t('admin_surveys_load_failed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const canManageSurvey = (survey) => isAdmin || String(survey?.created_by_id || '') === currentUserId

  // Filtering and sorting
  const normalizedSearch = search.trim().toLowerCase()
  const filtered = [...surveys]
    .filter((survey) => !normalizedSearch
      || survey.title.toLowerCase().includes(normalizedSearch)
      || (survey.description || '').toLowerCase().includes(normalizedSearch))
    .sort((left, right) => (sortDir === 'asc'
      ? left.title.localeCompare(right.title)
      : right.title.localeCompare(left.title)))

  const hasActiveFilters = Boolean(normalizedSearch) || sortDir !== 'asc'
  const activeSurveys = surveys.filter((s) => s.is_active !== false).length
  const inactiveSurveys = surveys.filter((s) => s.is_active === false).length

  const summaryCards = [
    {
      label: t('admin_surveys_total_surveys'),
      value: surveys.length,
      helper: t('admin_surveys_total_surveys_helper'),
    },
    {
      label: t('admin_surveys_visible_now'),
      value: filtered.length,
      helper: hasActiveFilters ? t('admin_surveys_visible_now_filtered') : t('admin_surveys_visible_now_all'),
    },
    {
      label: t('admin_surveys_active_count'),
      value: activeSurveys,
      helper: t('admin_surveys_active_count_helper'),
    },
    {
      label: t('admin_surveys_inactive_count'),
      value: inactiveSurveys,
      helper: t('admin_surveys_inactive_count_helper'),
    },
  ]

  const clearFilters = () => {
    setSearch('')
    setSortDir('asc')
  }

  // Question helpers
  const addQuestion = () => setQuestions((current) => [...current, blankQuestion()])
  const removeQuestion = (idx) => setQuestions((current) => current.filter((_, index) => index !== idx))
  const updateQuestion = (idx, patch) => setQuestions((current) => current.map((question, index) => (index === idx ? { ...question, ...patch } : question)))
  const addOption = (idx) => setQuestions((current) => current.map((question, index) => (
    index === idx ? { ...question, options: [...(question.options || []), ''] } : question
  )))
  const updateOption = (idx, optionIdx, value) => setQuestions((current) => current.map((question, index) => (
    index === idx
      ? { ...question, options: (question.options || []).map((option, currentIdx) => (currentIdx === optionIdx ? value : option)) }
      : question
  )))
  const removeOption = (idx, optionIdx) => setQuestions((current) => current.map((question, index) => (
    index === idx
      ? { ...question, options: (question.options || []).filter((_, currentIdx) => currentIdx !== optionIdx) }
      : question
  )))

  // Modal open/close
  const openCreateModal = () => {
    setEditingId('')
    setTitle('')
    setDescription('')
    setQuestions([blankQuestion()])
    setIsActive(true)
    setModalError('')
    setModal(true)
  }

  const openEditModal = (survey) => {
    setEditingId(survey.id)
    setTitle(survey.title || '')
    setDescription(survey.description || '')
    const nextQuestions = Array.isArray(survey.questions) && survey.questions.length > 0 ? survey.questions : [blankQuestion()]
    setQuestions(nextQuestions.map((q) => normalizeQuestion(q)))
    setIsActive(survey.is_active !== false)
    setModalError('')
    setModal(true)
  }

  const resetModal = () => {
    if (saving) return
    setModal(false)
    setEditingId('')
    setTitle('')
    setDescription('')
    setQuestions([blankQuestion()])
    setIsActive(true)
    setModalError('')
  }

  const handleSave = async () => {
    const cleanedQuestions = questions
      .map((question) => ({
        text: String(question.text || '').trim(),
        question_type: question.question_type || 'TEXT',
        options: CHOICE_TYPES.has(question.question_type)
          ? (question.options || []).map((option) => option.trim()).filter(Boolean)
          : undefined,
      }))
      .filter((question) => question.text)

    if (!title.trim()) {
      setModalError(t('admin_surveys_title_required'))
      return
    }
    if (!cleanedQuestions.length) {
      setModalError(t('admin_surveys_add_question'))
      return
    }
    const invalidChoice = cleanedQuestions.find((question) => CHOICE_TYPES.has(question.question_type) && (question.options?.length || 0) < 2)
    if (invalidChoice) {
      setModalError(t('admin_surveys_choice_min_options'))
      return
    }

    setSaving(true)
    setModalError('')
    setNotice('')
    try {
      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        questions: cleanedQuestions,
        is_active: isActive,
      }
      if (editingId) {
        await updateSurvey(editingId, payload)
        setNotice(t('admin_surveys_updated'))
      } else {
        await createSurvey(payload)
        setNotice(t('admin_surveys_created'))
      }
      resetModal()
      await load()
    } catch (err) {
      setModalError(resolveError(err) || t('admin_surveys_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  // Toggle active/inactive on card
  const toggleActive = async (survey) => {
    setStatusBusyId(survey.id)
    setError('')
    setNotice('')
    try {
      await updateSurvey(survey.id, { is_active: !(survey.is_active !== false) })
      setNotice(survey.is_active ? t('admin_surveys_deactivated') : t('admin_surveys_activated'))
      await load()
    } catch (err) {
      setError(resolveError(err) || t('admin_surveys_status_update_failed'))
    } finally {
      setStatusBusyId(null)
    }
  }

  // Delete with confirmation
  const handleDelete = async (id) => {
    if (deleteConfirmId !== id) {
      setDeleteConfirmId(id)
      return
    }
    setDeleteBusyId(id)
    setDeleteConfirmId(null)
    setError('')
    setNotice('')
    try {
      await deleteSurvey(id)
      if (responseSurveyId === id) {
        setResponsesModal(false)
        setResponseSurveyId(null)
        setResponses([])
      }
      setNotice(t('admin_surveys_deleted'))
      await load()
    } catch (err) {
      setError(resolveError(err) || t('admin_surveys_delete_failed'))
    } finally {
      setDeleteBusyId(null)
    }
  }

  // Expand questions inside card
  const toggleExpand = (surveyId) => {
    setExpanded((prev) => ({ ...prev, [surveyId]: !prev[surveyId] }))
  }

  // Responses modal
  const openResponses = async (surveyId) => {
    setResponseSurveyId(surveyId)
    setResponsesModal(true)
    setResponsesLoading(true)
    setResponses([])
    try {
      const { data } = await listResponses(surveyId)
      setResponses(data || [])
    } catch (err) {
      setResponses([])
      setError(resolveError(err) || t('admin_surveys_responses_load_failed'))
    } finally {
      setResponsesLoading(false)
    }
  }

  const closeResponsesModal = () => {
    setResponsesModal(false)
    setResponseSurveyId(null)
    setResponses([])
  }

  const exportResponsesCSV = () => {
    const survey = surveys.find((s) => s.id === responseSurveyId)
    if (!responses.length) return
    const questionKeys = Object.keys(responses[0]?.answers || {})
    const rows = [
      ['#', t('admin_surveys_date'), ...questionKeys],
      ...responses.map((r, i) => [
        i + 1,
        r.created_at ? new Date(r.created_at).toLocaleString() : '',
        ...questionKeys.map((q) => {
          const a = r.answers?.[q]
          return Array.isArray(a) ? a.join('; ') : String(a ?? '')
        }),
      ]),
    ]
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `survey-responses-${survey?.title || responseSurveyId}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  const responseSurvey = surveys.find((s) => s.id === responseSurveyId)

  return (
    <div className={styles.page}>
      <AdminPageHeader title={t('admin_surveys_title')} subtitle={t('admin_surveys_subtitle')}>
        <button type="button" className={styles.btnPrimary} onClick={openCreateModal}>
          {t('admin_surveys_new_survey')}
        </button>
      </AdminPageHeader>

      {notice && <div className={styles.noticeBanner}>{notice}</div>}
      {error && (
        <div className={styles.helperRow}>
          <div className={styles.errorBanner}>{error}</div>
          <button type="button" className={styles.actionBtn} onClick={() => void load()}>{t('retry')}</button>
        </div>
      )}

      <div className={styles.summaryGrid}>
        {summaryCards.map((card) => (
          <div key={card.label} className={styles.summaryCard}>
            <div className={styles.summaryLabel}>{card.label}</div>
            <div className={styles.summaryValue}>{card.value}</div>
            <div className={styles.summarySub}>{card.helper}</div>
          </div>
        ))}
      </div>

      <div className={styles.toolbarPanel}>
        <div className={styles.toolbar}>
          <input
            type="text"
            className={styles.searchInput}
            placeholder={t('admin_surveys_search_placeholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="button"
            className={styles.sortBtn}
            onClick={() => setSortDir((direction) => (direction === 'asc' ? 'desc' : 'asc'))}
          >
            {sortDir === 'asc' ? t('sort_name_az') : t('sort_name_za')}
          </button>
          <div className={styles.toolbarActions}>
            <button type="button" className={styles.actionBtn} onClick={() => void load()} disabled={loading}>{t('refresh')}</button>
            <button type="button" className={styles.actionBtn} onClick={clearFilters} disabled={!hasActiveFilters}>{t('clear_filters')}</button>
          </div>
        </div>
        <div className={styles.filterMeta}>
          {t('admin_surveys_showing_count', { filtered: filtered.length, total: surveys.length })}
        </div>
      </div>

      {loading ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_surveys_loading_title')}</div>
          <div className={styles.emptyText}>{t('admin_surveys_loading_sub')}</div>
        </div>
      ) : filtered.length === 0 && hasActiveFilters ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_surveys_no_match')}</div>
          <div className={styles.emptyText}>{t('admin_surveys_no_match_hint')}</div>
          <button type="button" className={styles.actionBtn} onClick={clearFilters}>{t('clear_filters')}</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_surveys_empty')}</div>
          <div className={styles.emptyText}>{t('admin_surveys_empty_hint')}</div>
        </div>
      ) : (
        <div className={styles.grid}>
          {filtered.map((survey) => {
            const surveyLabel = survey.title || t('admin_surveys_this_survey')
            const surveyQuestions = Array.isArray(survey.questions) ? survey.questions : []

            return (
              <div key={survey.id} className={styles.card} data-survey-title={survey.title || ''}>
                {!canManageSurvey(survey) && (
                  <div className={styles.readOnlyNote}>{t('admin_surveys_read_only')}</div>
                )}
                <div className={styles.cardHeader}>
                  <div>
                    <span className={styles.cardTitle}>{survey.title}</span>
                    {survey.is_active !== false
                      ? <span className={styles.activeBadge}>{t('admin_surveys_active')}</span>
                      : <span className={styles.inactiveBadge}>{t('admin_surveys_inactive')}</span>}
                    <span className={styles.qCountBadge}>{surveyQuestions.length} {t('admin_surveys_questions_count')}</span>
                    {survey.response_count != null && (
                      <span className={styles.responseChip}>{survey.response_count} {t('admin_surveys_response_count')}</span>
                    )}
                  </div>
                  <div className={styles.actionBtns}>
                    {canManageSurvey(survey) && (
                      <>
                        <button type="button" className={styles.actionBtn} onClick={() => openEditModal(survey)} disabled={deleteBusyId === survey.id} aria-label={`${t('edit')} ${surveyLabel}`} title={`${t('edit')} ${surveyLabel}`}>
                          {t('edit')}
                        </button>
                        <button type="button" className={styles.actionBtn} onClick={() => void toggleActive(survey)} disabled={statusBusyId === survey.id} aria-label={`${survey.is_active ? t('admin_surveys_deactivate') : t('admin_surveys_activate')} ${surveyLabel}`}>
                          {statusBusyId === survey.id ? t('saving') : survey.is_active ? t('admin_surveys_deactivate') : t('admin_surveys_activate')}
                        </button>
                        <button type="button" className={styles.actionBtn} onClick={() => void openResponses(survey.id)} aria-label={`${t('admin_surveys_responses')} ${surveyLabel}`}>
                          {t('admin_surveys_responses')}
                        </button>
                      </>
                    )}
                    {canManageSurvey(survey) && (
                      deleteConfirmId === survey.id ? (
                        <>
                          <button type="button" className={styles.actionBtnDanger} onClick={() => void handleDelete(survey.id)} disabled={deleteBusyId === survey.id} aria-label={`${t('confirm')} ${t('delete').toLowerCase()} ${surveyLabel}`}>
                            {deleteBusyId === survey.id ? t('admin_surveys_deleting') : t('confirm')}
                          </button>
                          <button type="button" className={styles.actionBtn} onClick={() => setDeleteConfirmId(null)} disabled={deleteBusyId === survey.id}>
                            {t('cancel')}
                          </button>
                        </>
                      ) : (
                        <button type="button" className={styles.actionBtn} onClick={() => void handleDelete(survey.id)} disabled={deleteBusyId === survey.id} aria-label={`${t('delete')} ${surveyLabel}`} title={`${t('delete')} ${surveyLabel}`}>
                          {t('delete')}
                        </button>
                      )
                    )}
                  </div>
                </div>
                <div className={survey.description ? styles.cardMeta : styles.cardMetaMuted}>
                  {survey.description || t('admin_surveys_no_description')}
                </div>

                {expanded[survey.id] && (
                  <div className={styles.questionList}>
                    {surveyQuestions.length === 0 ? (
                      <div className={styles.questionEmpty}>{t('admin_surveys_no_questions')}</div>
                    ) : (
                      surveyQuestions.map((question, index) => (
                        <div key={question.id || index} className={styles.questionItem}>
                          <span className={styles.questionIndex}>{index + 1}.</span>
                          <span>{question.text}</span>
                          <span className={styles.questionTypeBadge}>{question.question_type}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}

                <button type="button" className={styles.expandBtn} onClick={() => toggleExpand(survey.id)}>
                  {expanded[survey.id] ? t('admin_surveys_hide_questions') : t('admin_surveys_show_questions')}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Create / Edit Survey Modal */}
      {modal && (
        <div className={styles.modalOverlay} onClick={resetModal}>
          <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="survey-dialog-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="survey-dialog-title" className={styles.modalTitle}>
              {editingId ? t('admin_surveys_edit_survey') : t('admin_surveys_new_survey')}
            </h3>
            {modalError && <div className={styles.modalError}>{modalError}</div>}

            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="survey-title">{t('admin_surveys_field_title')}</label>
              <input id="survey-title" className={styles.input} value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="survey-description">{t('admin_surveys_field_description')}</label>
              <textarea id="survey-description" className={styles.textarea} value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.checkboxLabel}>
                <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
                {t('admin_surveys_active_label')}
              </label>
            </div>

            <div className={styles.formGroup}>
              <label className={styles.label}>{t('admin_surveys_questions')}</label>
              {questions.map((question, index) => (
                <div key={index} className={styles.questionCard}>
                  <div className={styles.questionHeader}>
                    <input
                      className={styles.input}
                      value={question.text}
                      onChange={(event) => updateQuestion(index, { text: event.target.value })}
                      placeholder={`${t('admin_surveys_question_label')} ${index + 1}`}
                    />
                    <select
                      className={styles.typeSelect}
                      value={question.question_type}
                      onChange={(event) => updateQuestion(index, normalizeQuestion({ text: question.text, question_type: event.target.value }))}
                    >
                      {SURVEY_QUESTION_TYPES.map((type) => (
                        <option key={type.value} value={type.value}>{type.label}</option>
                      ))}
                    </select>
                    {questions.length > 1 && (
                      <button type="button" className={styles.deleteBtn} onClick={() => removeQuestion(index)}>{t('remove')}</button>
                    )}
                  </div>

                  {CHOICE_TYPES.has(question.question_type) && (
                    <div className={styles.choiceGrid}>
                      {(question.options || []).map((option, optionIdx) => (
                        <div key={optionIdx} className={styles.optionRow}>
                          <input
                            className={styles.input}
                            value={option}
                            onChange={(event) => updateOption(index, optionIdx, event.target.value)}
                            placeholder={`${t('admin_surveys_option_label')} ${optionIdx + 1}`}
                          />
                          {(question.options || []).length > 2 && (
                            <button type="button" className={styles.deleteBtn} onClick={() => removeOption(index, optionIdx)}>{t('remove')}</button>
                          )}
                        </div>
                      ))}
                      <button type="button" className={styles.btnSecondary} onClick={() => addOption(index)}>{t('admin_surveys_add_option')}</button>
                    </div>
                  )}

                  {question.question_type === 'RATING' && (
                    <div className={styles.rowSub}>{t('admin_surveys_rating_hint')}</div>
                  )}
                  {question.question_type === 'BOOLEAN' && (
                    <div className={styles.rowSub}>{t('admin_surveys_boolean_hint')}</div>
                  )}
                </div>
              ))}
              <div className={styles.qActions}>
                <button type="button" className={styles.btnSecondary} onClick={addQuestion}>{t('admin_surveys_add_question_btn')}</button>
              </div>
            </div>

            <div className={styles.modalActions}>
              <button type="button" className={styles.btnCancel} onClick={resetModal} disabled={saving}>{t('cancel')}</button>
              <button type="button" className={styles.btnPrimary} onClick={() => void handleSave()} disabled={saving || !title.trim()}>
                {saving ? t('saving') : t('admin_surveys_save_survey')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Responses Modal */}
      {responsesModal && (
        <div className={styles.modalOverlay} onClick={closeResponsesModal}>
          <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="responses-dialog-title" onClick={(event) => event.stopPropagation()}>
            <div className={styles.responsesHeader}>
              <h3 id="responses-dialog-title" className={styles.modalTitle} style={{ margin: 0 }}>
                {t('admin_surveys_responses')} {responseSurvey ? `— ${responseSurvey.title}` : ''} ({responses.length})
              </h3>
              {responses.length > 0 && (
                <button type="button" className={styles.exportBtn} onClick={exportResponsesCSV}>{t('admin_surveys_export_csv')}</button>
              )}
            </div>

            {responsesLoading && <div className={styles.rowSub}>{t('admin_surveys_loading_responses')}</div>}
            {!responsesLoading && responses.length === 0 && <div className={styles.rowSub}>{t('admin_surveys_no_responses')}</div>}
            {!responsesLoading && responses.map((response, index) => {
              const answers = response.answers || {}
              return (
                <div key={index} className={styles.responseCard}>
                  <div className={styles.responseHeader}>
                    {t('admin_surveys_response_number')} #{index + 1}
                    {response.created_at && <span className={styles.responseTime}>{new Date(response.created_at).toLocaleString()}</span>}
                  </div>
                  {Object.entries(answers).map(([questionText, answer]) => (
                    <div key={questionText} className={styles.responseRow}>
                      <div className={styles.responseQ}>{questionText}</div>
                      <div className={styles.responseA}>{Array.isArray(answer) ? answer.join(', ') : String(answer)}</div>
                    </div>
                  ))}
                </div>
              )
            })}

            <div className={styles.modalActions}>
              <button type="button" className={styles.btnCancel} onClick={closeResponsesModal}>{t('admin_surveys_close')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
