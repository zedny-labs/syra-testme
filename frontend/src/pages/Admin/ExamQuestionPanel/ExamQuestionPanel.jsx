import React, { useMemo, useState } from 'react'
import { adminApi } from '../../../services/admin.service'
import useLanguage from '../../../hooks/useLanguage'
import styles from './ExamQuestionPanel.module.scss'
import QuestionImageUpload from '../../../components/QuestionImageUpload/QuestionImageUpload'
import QuestionTypeFields from '../../../components/QuestionTypeFields/QuestionTypeFields'
import {
  normalizeQuestionType,
  emptyAnswerState,
  questionToAnswerState,
  answerStateToPayload,
  validateAnswerState,
} from '../../../utils/questionPayload'

const DEFAULT_TYPES = [
  { value: 'MCQ', labelKey: 'question_type_mcq' },
  { value: 'TEXT', labelKey: 'question_type_text' },
]

function createEmptyQuestion(type) {
  return { text: '', question_type: type, answer: emptyAnswerState(type), points: 1, image_url: null }
}

function resolveLabel(type, t) {
  if (type.label) return type.label
  if (type.labelKey) return t(type.labelKey)
  return type.value
}

function labelForType(types, value, t) {
  const type = types.find((tp) => tp.value === value)
  return type ? resolveLabel(type, t) : value
}

export default function ExamQuestionPanel({ examId, questions = [], onUpdate, questionTypes }) {
  const { t } = useLanguage()
  const types = (questionTypes || DEFAULT_TYPES).map((tp) => ({ ...tp, label: resolveLabel(tp, t) }))
  const defaultType = types[0]?.value || 'MCQ'
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ ...createEmptyQuestion(defaultType) })
  const [editId, setEditId] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deleteConfirmId, setDeleteConfirmId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  const totalPoints = useMemo(
    () => questions.reduce((sum, question) => sum + Number(question.points || 0), 0),
    [questions],
  )

  const activeTypeLabel = labelForType(types, form.question_type, t)

  const validationMessage = (() => {
    if (!form.text.trim()) return t('admin_questions_text_required')
    if (!Number(form.points) || Number(form.points) <= 0) return t('admin_questions_points_required')
    const answerKey = validateAnswerState(form.question_type, form.answer)
    return answerKey ? t(answerKey) : ''
  })()

  const canMutate = Boolean(examId) && !saving && !refreshing

  const resetDraft = (type = defaultType) => {
    setForm(createEmptyQuestion(type))
    setEditId(null)
    setError('')
    setNotice('')
  }

  const closeEditor = () => {
    setShowForm(false)
    resetDraft(defaultType)
  }

  const refreshQuestions = async (successMessage) => {
    if (!examId) return
    setRefreshing(true)
    try {
      const { data } = await adminApi.getQuestions(examId)
      onUpdate?.(data || [])
      if (successMessage) setNotice(successMessage)
    } catch (e) {
      setError(e.response?.data?.detail || t('admin_questions_refresh_error'))
    } finally {
      setRefreshing(false)
    }
  }

  const openAdd = (type = defaultType) => {
    resetDraft(type)
    setShowForm(true)
  }

  const openEdit = (question) => {
    const nextType = normalizeQuestionType(question.question_type || question.type)
    setForm({
      text: question.text,
      question_type: nextType,
      answer: questionToAnswerState(question),
      points: question.points || 1,
      image_url: question.image_url ?? null,
    })
    setEditId(question.id)
    setError('')
    setNotice('')
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!examId) {
      setError(t('admin_questions_create_test_first'))
      return
    }
    if (validationMessage) {
      setError(validationMessage)
      return
    }

    setSaving(true)
    setError('')
    setNotice('')

    const questionType = form.question_type || 'MCQ'
    const { options, correct_answer } = answerStateToPayload(questionType, form.answer)
    const payload = {
      exam_id: examId,
      text: form.text.trim(),
      type: questionType,
      options,
      correct_answer,
      points: Number(form.points),
      order: editId
        ? (questions.find((question) => question.id === editId)?.order || 0)
        : (questions?.length || 0) + 1,
      image_url: form.image_url || null,
    }

    try {
      if (editId) {
        await adminApi.updateQuestion(editId, payload)
        await refreshQuestions(t('admin_questions_question_updated'))
      } else {
        await adminApi.addQuestion(payload)
        await refreshQuestions(t('admin_questions_question_added'))
      }
      setShowForm(false)
      resetDraft(defaultType)
    } catch (e) {
      setError(e.response?.data?.detail || t('admin_questions_save_error'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id) => {
    if (deleteConfirmId !== id) {
      setDeleteConfirmId(id)
      return
    }

    setDeletingId(id)
    setError('')
    setNotice('')

    try {
      await adminApi.deleteQuestion(id)
      setDeleteConfirmId(null)
      await refreshQuestions(t('admin_questions_question_deleted'))
    } catch (e) {
      setError(e.response?.data?.detail || t('admin_questions_delete_error'))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.summaryRow}>
        <span className={styles.summaryChip}>{t('admin_questions_questions_count')}: {questions.length}</span>
        <span className={styles.summaryChip}>{t('admin_questions_total_points')}: {totalPoints}</span>
        <span className={styles.summaryChip}>{examId ? t('admin_questions_ready') : t('admin_questions_save_test_first')}</span>
      </div>

      {notice && <div className={styles.notice}>{notice}</div>}
      {error && <div className={styles.error}>{error}</div>}

      {!showForm && (
        <div className={styles.quickAddSection}>
          <div className={styles.quickAddHeader}>
            <div>
              <div className={styles.sectionTitle}>{t('admin_questions_quick_add')}</div>
              <div className={styles.sectionSub}>{t('admin_questions_quick_add_sub')}</div>
            </div>
            {refreshing && <span className={styles.loadingPill}>{t('admin_questions_refreshing_list')}</span>}
          </div>
          <div className={styles.quickAddGrid}>
            {types.map((type) => (
              <button
                key={type.value}
                type="button"
                className={styles.quickAddBtn}
                onClick={() => openAdd(type.value)}
                disabled={!examId || refreshing || deletingId != null}
              >
                {t('add')} {type.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {questions.length === 0 && !showForm && (
        <div className={styles.empty}>
          {examId ? t('admin_questions_empty') : t('admin_questions_empty_no_test')}
        </div>
      )}

      {questions.map((question, index) => (
        <div key={question.id} className={styles.question}>
          <span className={styles.qNum}>{index + 1}</span>
          <div className={styles.qContent}>
            <div className={styles.qTopRow}>
              <div className={styles.qText}>{question.text}</div>
              <div className={styles.qChips}>
                <span className={styles.qChip}>{labelForType(types, question.question_type, t)}</span>
                <span className={styles.qChip}>{Number(question.points || 1)} pts</span>
              </div>
            </div>
            <div className={styles.qMeta}>
              {t('admin_questions_correct_answer_label')}: {question.correct_answer || '-'}
              {question.options?.length ? ` | ${question.options.length} ${t('admin_questions_options_count')}` : ''}
            </div>
            {question.options?.length ? (
              <div className={styles.optionList}>
                {question.options.map((option, optionIndex) => (
                  <span key={`${question.id}-option-${optionIndex}`} className={styles.optionChip}>
                    {String.fromCharCode(65 + optionIndex)}. {option}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className={styles.qActions}>
            <button type="button" className={styles.qBtn} onClick={() => openEdit(question)} disabled={saving || deletingId != null} aria-label={`${t('edit')} ${question.text || `${t('question')} ${index + 1}`}`} title={`${t('edit')} ${question.text || `${t('question')} ${index + 1}`}`}>{t('edit')}</button>
            {deleteConfirmId === question.id ? (
              <>
                <button
                  type="button"
                  className={`${styles.qBtn} ${styles.qBtnDanger}`}
                  onClick={() => handleDelete(question.id)}
                  disabled={deletingId === question.id}
                  aria-label={`${t('confirm_delete')} ${question.text || `${t('question')} ${index + 1}`}`}
                >
                  {deletingId === question.id ? t('admin_questions_deleting') : t('confirm_delete')}
                </button>
                <button type="button" className={styles.qBtn} onClick={() => setDeleteConfirmId(null)} disabled={deletingId === question.id} aria-label={`${t('admin_questions_keep')} ${question.text || `${t('question')} ${index + 1}`}`}>{t('cancel')}</button>
              </>
            ) : (
              <button type="button" className={`${styles.qBtn} ${styles.qBtnDanger}`} onClick={() => handleDelete(question.id)} disabled={saving || deletingId != null} aria-label={`${t('delete')} ${question.text || `${t('question')} ${index + 1}`}`} title={`${t('delete')} ${question.text || `${t('question')} ${index + 1}`}`}>{t('delete')}</button>
            )}
          </div>
        </div>
      ))}

      {showForm && (
        <div className={styles.addForm}>
          <div className={styles.addFormHeader}>
            <div>
              <div className={styles.addFormTitle}>{editId ? t('admin_questions_edit_question') : `${t('add')} ${activeTypeLabel}`}</div>
              <div className={styles.addFormSub}>{t('admin_questions_form_sub')}</div>
            </div>
            <span className={styles.formStatus}>{editId ? t('admin_questions_editing_existing') : t('admin_questions_new_draft')}</span>
          </div>

          <div className={styles.formGroup}>
            <label className={styles.label}>{t('type')}</label>
            <select
              className={styles.select}
              value={form.question_type}
              onChange={(e) => {
                const nextType = e.target.value
                setForm(createEmptyQuestion(nextType))
                setError('')
              }}
              disabled={saving}
            >
              {types.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </div>

          <div className={styles.formGroup}>
            <label className={styles.label}>{t('admin_questions_question_text')}</label>
            <input
              className={styles.input}
              value={form.text}
              onChange={(e) => setForm((current) => ({ ...current, text: e.target.value }))}
              placeholder={t('admin_questions_enter_question')}
              disabled={saving}
            />
          </div>

          <div className={styles.formGroup}>
            <QuestionImageUpload
              value={form.image_url}
              onChange={(url) => setForm((current) => ({ ...current, image_url: url }))}
              disabled={saving}
              t={t}
            />
          </div>

          <div className={styles.formGroup}>
            <QuestionTypeFields
              type={form.question_type}
              state={form.answer}
              onChange={(answer) => setForm((current) => ({ ...current, answer }))}
              disabled={saving}
              t={t}
            />
          </div>

          <div className={styles.formGroup}>
            <label className={styles.label}>{t('admin_questions_points')}</label>
            <input
              className={styles.input}
              type="number"
              min="1"
              max="100"
              value={form.points}
              onChange={(e) => setForm((current) => ({ ...current, points: Number(e.target.value) }))}
              disabled={saving}
            />
          </div>

          {validationMessage && <div className={styles.validationHint}>{validationMessage}</div>}

          <div className={styles.formActions}>
            <button type="button" className={styles.btnCancel} onClick={closeEditor} disabled={saving}>{t('cancel')}</button>
            <button type="button" className={styles.btnSecondary} onClick={() => resetDraft(form.question_type)} disabled={saving}>{t('reset')}</button>
            <button type="button" className={styles.btnPrimary} onClick={handleSave} disabled={!canMutate || Boolean(validationMessage)}>
              {saving ? (editId ? t('admin_questions_updating') : t('admin_questions_adding')) : `${editId ? t('update') : t('add')} ${t('question')}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
