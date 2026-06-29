import React, { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { adminApi } from '../../../services/admin.service'
import AdminPageHeader from '../AdminPageHeader/AdminPageHeader'
import useAuth from '../../../hooks/useAuth'
import useLanguage from '../../../hooks/useLanguage'
import styles from './QuestionPoolDetail.module.scss'
import QuestionImageUpload from '../../../components/QuestionImageUpload/QuestionImageUpload'

const POOL_QUESTION_TYPES = [
  { value: 'MCQ', labelKey: 'question_type_mcq' },
  { value: 'MULTI', labelKey: 'admin_wizard_qtype_multiple_choice' },
  { value: 'TRUEFALSE', labelKey: 'question_type_truefalse' },
  { value: 'TEXT', labelKey: 'question_type_short_answer' },
  { value: 'ORDERING', labelKey: 'admin_wizard_qtype_ordering' },
  { value: 'FILLINBLANK', labelKey: 'admin_wizard_qtype_fill_blanks' },
  { value: 'MATCHING', labelKey: 'admin_wizard_qtype_matching' },
]

const MCQ_TYPES = new Set(['MCQ', 'MULTI'])

const blankQuestion = (questionType = 'MCQ') => ({
  text: '',
  question_type: questionType,
  options: MCQ_TYPES.has(questionType) ? ['', '', '', ''] : questionType === 'TRUEFALSE' ? ['True', 'False'] : [],
  correct_answer: questionType === 'TRUEFALSE' ? 'True' : '',
  image_url: null,
})

const normalizeQuestionType = (questionType) => {
  if (questionType === 'TRUE_FALSE') return 'TRUEFALSE'
  if (questionType === 'SHORT_ANSWER') return 'TEXT'
  if (questionType === 'FILL_IN_BLANK') return 'FILLINBLANK'
  if (questionType === 'MULTIPLE_CHOICE') return 'MULTI'
  return questionType || 'MCQ'
}

const normalizePoolQuestion = (question) => {
  const questionType = normalizeQuestionType(question?.question_type || question?.type)
  return {
    text: question?.text || '',
    question_type: questionType,
    options: MCQ_TYPES.has(questionType)
      ? (question?.options && question.options.length ? question.options : ['', '', '', ''])
      : questionType === 'TRUEFALSE'
        ? ['True', 'False']
        : [],
    correct_answer: question?.correct_answer || (questionType === 'TRUEFALSE' ? 'True' : ''),
    image_url: question?.image_url ?? null,
  }
}

function resolveError(err, fallback) {
  if (err?.userMessage) return err.userMessage
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string') return detail
  return fallback
}

export default function QuestionPoolDetail() {
  const { t } = useLanguage()
  const { id } = useParams()
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const currentUserId = String(user?.id || '')
  const [pool, setPool] = useState(null)
  const [poolForm, setPoolForm] = useState({ name: '', description: '' })
  const [editingPool, setEditingPool] = useState(false)
  const [questions, setQuestions] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(blankQuestion())
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [savingPool, setSavingPool] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deleteConfirmId, setDeleteConfirmId] = useState(null)
  const [deleteBusyId, setDeleteBusyId] = useState(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [poolResult, questionsResult] = await Promise.allSettled([
        adminApi.getQuestionPool(id),
        adminApi.getPoolQuestions(id),
      ])

      if (poolResult.status === 'fulfilled') {
        setPool(poolResult.value.data)
        setPoolForm({
          name: poolResult.value.data?.name || '',
          description: poolResult.value.data?.description || '',
        })
      } else {
        setPool(null)
        throw poolResult.reason
      }

      if (questionsResult.status === 'fulfilled') {
        setQuestions(questionsResult.value.data || [])
      } else {
        setQuestions([])
        setError(resolveError(questionsResult.reason, t('admin_pool_detail_load_questions_error')))
      }
    } catch (err) {
      setPool(null)
      setQuestions([])
      setError(resolveError(err, t('admin_pool_detail_load_error')))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [id])

  const canManagePool = isAdmin || String(pool?.created_by_id || '') === currentUserId

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setNotice('')
    setSaving(true)
    try {
      const payload = {
        text: form.text,
        question_type: form.question_type,
        correct_answer: form.correct_answer || null,
        options: form.question_type === 'MCQ'
          ? (form.options || []).map((option) => option.trim()).filter(Boolean)
          : form.question_type === 'TRUEFALSE'
            ? ['True', 'False']
            : null,
        image_url: form.image_url || null,
      }
      if (editingId) {
        await adminApi.updatePoolQuestion(id, editingId, payload)
        setNotice(t('admin_pool_detail_question_updated'))
      } else {
        await adminApi.createPoolQuestion(id, payload)
        setNotice(t('admin_pool_detail_question_added'))
      }
      setShowForm(false)
      setEditingId(null)
      setForm(blankQuestion())
      await load()
    } catch (err) {
      setError(resolveError(err, t('admin_pool_detail_save_question_error')))
    } finally {
      setSaving(false)
    }
  }

  const startEdit = (question) => {
    setForm(normalizePoolQuestion(question))
    setEditingId(question.id)
    setShowForm(true)
    setError('')
    setNotice('')
  }

  const handleDelete = async (questionId) => {
    if (deleteConfirmId !== questionId) {
      setDeleteConfirmId(questionId)
      return
    }
    setDeleteBusyId(questionId)
    setDeleteConfirmId(null)
    setError('')
    setNotice('')
    try {
      await adminApi.deletePoolQuestion(id, questionId)
      setNotice(t('admin_pool_detail_question_deleted'))
      await load()
    } catch (err) {
      setError(resolveError(err, t('admin_pool_detail_delete_question_error')))
    } finally {
      setDeleteBusyId(null)
    }
  }

  const savePool = async () => {
    if (!poolForm.name.trim()) return
    setSavingPool(true)
    setError('')
    setNotice('')
    try {
      await adminApi.updateQuestionPool(id, {
        name: poolForm.name.trim(),
        description: poolForm.description.trim(),
      })
      setEditingPool(false)
      setNotice(t('admin_pool_detail_pool_saved'))
      await load()
    } catch (err) {
      setError(resolveError(err, t('admin_pool_detail_save_pool_error')))
    } finally {
      setSavingPool(false)
    }
  }

  const setOption = (index, value) => setForm((current) => {
    const options = [...(current.options || [])]
    options[index] = value
    return { ...current, options }
  })

  return (
    <div className={styles.page}>
      <AdminPageHeader title={t('admin_pool_detail_title')} subtitle={pool?.name || ''}>
        <div className={styles.qActions}>
          {canManagePool && (
            <>
              <button
                className={styles.btnSecondary}
                onClick={() => {
                  setEditingPool((current) => !current)
                  setPoolForm({ name: pool?.name || '', description: pool?.description || '' })
                }}
                disabled={!pool}
              >
                {editingPool ? t('admin_pool_detail_cancel_pool_edit') : t('admin_pool_detail_edit_pool')}
              </button>
              <button className={styles.btnPrimary} onClick={() => { setShowForm(true); setEditingId(null); setForm(blankQuestion()) }} disabled={!pool}>
                {t('admin_pool_detail_add_question')}
              </button>
            </>
          )}
        </div>
      </AdminPageHeader>

      {error && (
        <div className={styles.helperRow}>
          <div className={styles.errorMsg}>{error}</div>
          <button className={styles.btnSecondary} onClick={() => void load()}>{t('retry')}</button>
        </div>
      )}
      {notice && <div className={styles.noticeMsg}>{notice}</div>}
      {loading && <div className={styles.empty}>{t('admin_pool_detail_loading')}</div>}
      {!loading && !pool && <div className={styles.empty}>{t('admin_pool_detail_not_available')}</div>}
      {!loading && !canManagePool && pool && <div className={styles.meta}>{t('admin_pool_detail_read_only')}</div>}

      {!loading && editingPool && pool && (
        <div className={styles.card}>
          <div className={styles.sectionTitle}>{t('admin_pool_detail_pool_details')}</div>
          <label className={styles.label} htmlFor="pool-detail-name">{t('name')}</label>
          <input
            id="pool-detail-name"
            className={styles.input}
            value={poolForm.name}
            onChange={(event) => setPoolForm((current) => ({ ...current, name: event.target.value }))}
          />
          <label className={styles.label} htmlFor="pool-detail-description">{t('description')}</label>
          <textarea
            id="pool-detail-description"
            className={styles.textarea}
            rows={3}
            value={poolForm.description}
            onChange={(event) => setPoolForm((current) => ({ ...current, description: event.target.value }))}
          />
          <div className={styles.formActions}>
            <button className={styles.btnPrimary} type="button" onClick={savePool} disabled={savingPool || !poolForm.name.trim()}>
              {savingPool ? t('saving') : t('admin_pool_detail_save_pool')}
            </button>
            <button className={styles.btnSecondary} type="button" onClick={() => setEditingPool(false)} disabled={savingPool}>{t('cancel')}</button>
          </div>
        </div>
      )}

      {!loading && showForm && pool && (
        <div className={styles.card}>
          <div className={styles.sectionTitle}>{editingId ? t('admin_pool_detail_edit_question') : t('admin_pool_detail_new_question')}</div>
          <form onSubmit={handleSubmit}>
            <label className={styles.label} htmlFor="pool-question-text">{t('admin_pool_detail_question_text')}</label>
            <textarea id="pool-question-text" className={styles.textarea} rows={3} value={form.text} onChange={(event) => setForm((current) => ({ ...current, text: event.target.value }))} required />
            <QuestionImageUpload
              value={form.image_url}
              onChange={(url) => setForm((current) => ({ ...current, image_url: url }))}
              disabled={saving}
              t={t}
            />

            <label className={styles.label} htmlFor="pool-question-type">{t('type')}</label>
            <select
              id="pool-question-type"
              className={styles.select}
              value={form.question_type}
              onChange={(event) => setForm((current) => ({
                ...blankQuestion(event.target.value),
                text: current.text,
                image_url: current.image_url,
              }))}
            >
              {POOL_QUESTION_TYPES.map((type) => (
                <option key={type.value} value={type.value}>{t(type.labelKey)}</option>
              ))}
            </select>

            {form.question_type === 'MCQ' && (
              <>
                <label className={styles.label} htmlFor="pool-question-option-0">{t('admin_pool_detail_options')}</label>
                {(form.options || []).map((option, index) => (
                  <input key={index} id={`pool-question-option-${index}`} className={styles.input} placeholder={`Option ${index + 1}`} value={option} onChange={(event) => setOption(index, event.target.value)} />
                ))}
                <label className={styles.label} htmlFor="pool-question-correct-answer">{t('admin_pool_detail_correct_answer')}</label>
                <input id="pool-question-correct-answer" className={styles.input} value={form.correct_answer} onChange={(event) => setForm((current) => ({ ...current, correct_answer: event.target.value }))} placeholder={t('admin_pool_detail_match_option')} />
              </>
            )}

            {form.question_type === 'TRUEFALSE' && (
              <>
                <label className={styles.label} htmlFor="pool-question-boolean-answer">{t('admin_pool_detail_correct_answer')}</label>
                <select id="pool-question-boolean-answer" className={styles.select} value={form.correct_answer} onChange={(event) => setForm((current) => ({ ...current, correct_answer: event.target.value }))}>
                  <option value="">{t('admin_pool_detail_select')}</option>
                  <option value="True">{t('bool_true')}</option>
                  <option value="False">{t('bool_false')}</option>
                </select>
              </>
            )}

            {form.question_type === 'TEXT' && (
              <>
                <label className={styles.label} htmlFor="pool-question-expected-answer">{t('admin_pool_detail_expected_answer')}</label>
                <input id="pool-question-expected-answer" className={styles.input} value={form.correct_answer} onChange={(event) => setForm((current) => ({ ...current, correct_answer: event.target.value }))} />
              </>
            )}

            <div className={styles.formActions}>
              <button className={styles.btnPrimary} type="submit" disabled={saving}>{saving ? t('saving') : (editingId ? t('update') : t('admin_pool_detail_add_question'))}</button>
              <button className={styles.btnSecondary} type="button" onClick={() => { setShowForm(false); setEditingId(null) }} disabled={saving}>{t('cancel')}</button>
            </div>
          </form>
        </div>
      )}

      {!loading && pool && (
        <div className={styles.card}>
          <div className={styles.meta}>
            <span><strong>{t('description')}:</strong> {pool?.description || '-'}</span>
            <span><strong>{questions.length}</strong> {t('admin_pool_detail_question_count')}</span>
          </div>
          <div className={styles.list}>
            {questions.length === 0 && <div className={styles.empty}>{t('admin_pool_detail_no_questions')}</div>}
            {questions.map((question, index) => (
              <div key={question.id} className={styles.qCard}>
                <div className={styles.qHeader}>
                  <span>Q{index + 1} <span className={styles.typeBadge}>{(() => { const qt = normalizeQuestionType(question.question_type); const tp = POOL_QUESTION_TYPES.find((pt) => pt.value === qt); return tp ? t(tp.labelKey) : qt })()}</span></span>
                  {canManagePool && (
                    <div className={styles.qActions}>
                      <button className={styles.btnSecondary} onClick={() => startEdit(question)} disabled={deleteBusyId === question.id} aria-label={`${t('edit')} ${question.text || `${t('question')} ${index + 1}`}`} title={`${t('edit')} ${question.text || `${t('question')} ${index + 1}`}`}>{t('edit')}</button>
                      {deleteConfirmId === question.id ? (
                        <>
                          <button className={styles.dangerBtn} onClick={() => void handleDelete(question.id)} disabled={deleteBusyId === question.id} aria-label={`${t('confirm_delete')} ${question.text || `${t('question')} ${index + 1}`}`}>
                            {deleteBusyId === question.id ? t('admin_pool_detail_deleting') : t('confirm')}
                          </button>
                          <button className={styles.btnSecondary} onClick={() => setDeleteConfirmId(null)} disabled={deleteBusyId === question.id} aria-label={`${t('admin_pool_detail_keep')} ${question.text || `${t('question')} ${index + 1}`}`}>{t('cancel')}</button>
                        </>
                      ) : (
                        <button className={styles.deleteBtn} onClick={() => void handleDelete(question.id)} disabled={deleteBusyId === question.id} aria-label={`${t('delete')} ${question.text || `${t('question')} ${index + 1}`}`} title={`${t('delete')} ${question.text || `${t('question')} ${index + 1}`}`}>{t('delete')}</button>
                      )}
                    </div>
                  )}
                </div>
                <div className={styles.qText}>{question.text}</div>
                {question.correct_answer && <div className={styles.qAnswer}>{t('admin_pool_detail_correct_answer')}: {question.correct_answer}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
