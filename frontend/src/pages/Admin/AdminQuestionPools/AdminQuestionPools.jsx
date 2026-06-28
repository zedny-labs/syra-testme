import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminApi } from '../../../services/admin.service'
import AdminPageHeader from '../AdminPageHeader/AdminPageHeader'
import useAuth from '../../../hooks/useAuth'
import useLanguage from '../../../hooks/useLanguage'
import styles from './AdminQuestionPools.module.scss'

function resolveError(err, fallback) {
  if (err?.userMessage) return err.userMessage
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string') return detail
  return fallback
}

export default function AdminQuestionPools() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const currentUserId = String(user?.id || '')
  const [pools, setPools] = useState([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState({})
  const [poolQuestions, setPoolQuestions] = useState({})
  const [expandLoadingId, setExpandLoadingId] = useState(null)
  const [modal, setModal] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [modalError, setModalError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState(null)
  const [deleteBusyId, setDeleteBusyId] = useState(null)
  const [search, setSearch] = useState('')
  const [sortDir, setSortDir] = useState('asc')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const { data } = await adminApi.questionPools()
      setPools(data || [])
    } catch (err) {
      setError(resolveError(err, t('admin_pools_load_error')))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const canManagePool = (pool) => isAdmin || String(pool?.created_by_id || '') === currentUserId
  const normalizedSearch = search.trim().toLowerCase()
  const filtered = [...pools]
    .filter((pool) => !normalizedSearch
      || pool.name.toLowerCase().includes(normalizedSearch)
      || (pool.description || '').toLowerCase().includes(normalizedSearch))
    .sort((left, right) => (sortDir === 'asc'
      ? left.name.localeCompare(right.name)
      : right.name.localeCompare(left.name)))
  const hasActiveFilters = Boolean(normalizedSearch) || sortDir !== 'asc'
  const totalQuestions = pools.reduce((sum, pool) => sum + Number(pool.question_count || 0), 0)
  const readOnlyPools = pools.filter((pool) => !canManagePool(pool)).length
  const summaryCards = [
    {
      label: t('admin_pools_loaded_pools'),
      value: pools.length,
      helper: t('admin_pools_loaded_pools_helper'),
    },
    {
      label: t('admin_pools_visible_now'),
      value: filtered.length,
      helper: hasActiveFilters ? t('admin_pools_visible_now_filtered') : t('admin_pools_visible_now_all'),
    },
    {
      label: t('admin_pools_indexed_questions'),
      value: totalQuestions,
      helper: t('admin_pools_indexed_questions_helper'),
    },
    {
      label: t('admin_pools_read_only_pools'),
      value: readOnlyPools,
      helper: t('admin_pools_read_only_pools_helper'),
    },
  ]

  const clearFilters = () => {
    setSearch('')
    setSortDir('asc')
  }

  const toggleExpand = async (poolId) => {
    if (expanded[poolId]) {
      setExpanded((prev) => ({ ...prev, [poolId]: false }))
      return
    }

    setExpandLoadingId(poolId)
    setError('')
    try {
      const { data } = await adminApi.getPoolQuestions(poolId)
      setPoolQuestions((prev) => ({ ...prev, [poolId]: data || [] }))
      setExpanded((prev) => ({ ...prev, [poolId]: true }))
    } catch (err) {
      setError(resolveError(err, t('admin_pools_load_questions_error')))
    } finally {
      setExpandLoadingId(null)
    }
  }

  const resetModal = () => {
    if (saving) return
    setModal(false)
    setName('')
    setDescription('')
    setModalError('')
  }

  const handleCreate = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setModalError(t('admin_pools_name_required'))
      return
    }

    setSaving(true)
    setModalError('')
    setNotice('')
    try {
      await adminApi.createQuestionPool({ name: trimmedName, description: description.trim() || null })
      setNotice(t('admin_pools_created'))
      resetModal()
      await load()
    } catch (err) {
      setModalError(resolveError(err, t('admin_pools_create_error')))
    } finally {
      setSaving(false)
    }
  }

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
      await adminApi.deleteQuestionPool(id)
      setNotice(t('admin_pools_deleted'))
      await load()
    } catch (err) {
      setError(resolveError(err, t('admin_pools_delete_error')))
    } finally {
      setDeleteBusyId(null)
    }
  }

  return (
    <div className={styles.page}>
      <AdminPageHeader title={t('admin_pools_title')} subtitle={t('admin_pools_subtitle')}>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={() => {
            setModal(true)
            setModalError('')
          }}
        >
          {t('admin_pools_new_pool')}
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
            placeholder={t('admin_pools_search_placeholder')}
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
          {t('admin_pools_showing_count', { filtered: filtered.length, total: pools.length })}
        </div>
      </div>

      {loading ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_pools_loading')}</div>
          <div className={styles.emptyText}>{t('admin_pools_loading_sub')}</div>
        </div>
      ) : filtered.length === 0 && hasActiveFilters ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_pools_no_match')}</div>
          <div className={styles.emptyText}>{t('admin_pools_no_match_hint')}</div>
          <button type="button" className={styles.actionBtn} onClick={clearFilters}>{t('clear_filters')}</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_pools_empty')}</div>
          <div className={styles.emptyText}>{t('admin_pools_empty_hint')}</div>
        </div>
      ) : (
        <div className={styles.grid}>
          {filtered.map((pool) => {
            const poolLabel = pool.name || t('admin_pools_this_pool')

            return (
            <div key={pool.id} className={styles.card}>
              {!canManagePool(pool) && (
                <div className={styles.readOnlyNote}>{t('admin_pools_read_only_note')}</div>
              )}
              <div className={styles.cardHeader}>
                <div>
                  <span className={styles.cardTitle}>{pool.name}</span>
                  {pool.question_count != null && (
                    <span className={styles.qCountBadge}>{pool.question_count} {t('questions')}</span>
                  )}
                </div>
                <div className={styles.actionBtns}>
                  <button type="button" className={styles.actionBtn} onClick={() => navigate(`/admin/question-pools/${pool.id}`)} disabled={deleteBusyId === pool.id} aria-label={`${t('admin_pools_open')} ${poolLabel}`} title={`${t('admin_pools_open')} ${poolLabel}`}>
                    {t('admin_pools_open')}
                  </button>
                  {canManagePool(pool) && (
                    deleteConfirmId === pool.id ? (
                      <>
                        <button type="button" className={styles.actionBtnDanger} onClick={() => void handleDelete(pool.id)} disabled={deleteBusyId === pool.id} aria-label={`${t('confirm_delete')} ${poolLabel}`}>
                          {deleteBusyId === pool.id ? t('admin_pools_deleting') : t('confirm')}
                        </button>
                        <button type="button" className={styles.actionBtn} onClick={() => setDeleteConfirmId(null)} disabled={deleteBusyId === pool.id} aria-label={`${t('admin_pools_keep')} ${poolLabel}`}>
                          {t('cancel')}
                        </button>
                      </>
                    ) : (
                      <button type="button" className={styles.actionBtn} onClick={() => void handleDelete(pool.id)} disabled={deleteBusyId === pool.id} aria-label={`${t('delete')} ${poolLabel}`} title={`${t('delete')} ${poolLabel}`}>
                        {t('delete')}
                      </button>
                    )
                  )}
                </div>
              </div>
              <div className={pool.description ? styles.cardMeta : styles.cardMetaMuted}>
                {pool.description || t('admin_pools_no_description')}
              </div>

              {expanded[pool.id] && poolQuestions[pool.id] && (
                <div className={styles.questionList}>
                  {poolQuestions[pool.id].length === 0 ? (
                    <div className={styles.questionEmpty}>{t('admin_pools_no_questions')}</div>
                  ) : (
                    poolQuestions[pool.id].map((question, index) => (
                      <div key={question.id || index} className={styles.questionItem}>
                        <span className={styles.questionIndex}>{index + 1}.</span>
                        <span>{question.text}</span>
                      </div>
                    ))
                  )}
                </div>
              )}

              <button type="button" className={styles.expandBtn} onClick={() => void toggleExpand(pool.id)} disabled={expandLoadingId === pool.id}>
                {expandLoadingId === pool.id ? t('admin_pools_loading_questions') : expanded[pool.id] ? t('admin_pools_hide_questions') : t('admin_pools_show_questions')}
              </button>
            </div>
            )
          })}
        </div>
      )}

      {modal && (
        <div className={styles.modalOverlay} onClick={resetModal}>
          <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="question-pool-dialog-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="question-pool-dialog-title" className={styles.modalTitle}>{t('admin_pools_new_pool_title')}</h3>
            {modalError && <div className={styles.modalError}>{modalError}</div>}
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="pool-name">{t('name')}</label>
              <input id="pool-name" className={styles.input} value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="pool-description">{t('description')}</label>
              <input id="pool-description" className={styles.input} value={description} onChange={(event) => setDescription(event.target.value)} />
            </div>
            <div className={styles.modalActions}>
              <button type="button" className={styles.btnCancel} onClick={resetModal} disabled={saving}>{t('cancel')}</button>
              <button type="button" className={styles.btnPrimary} onClick={() => void handleCreate()} disabled={saving || !name.trim()}>
                {saving ? t('admin_pools_creating') : t('admin_pools_create_pool')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
