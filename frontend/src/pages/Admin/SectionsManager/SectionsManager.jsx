import React, { useEffect, useState, useCallback } from 'react'
import { adminApi } from '../../../services/admin.service'
import useLanguage from '../../../hooks/useLanguage'
import styles from './SectionsManager.module.css'

export default function SectionsManager({ examId, onChange }) {
  const { t } = useLanguage()

  // Sections state
  const [sections, setSections] = useState([])
  const [loadingSections, setLoadingSections] = useState(true)
  const [sectionsError, setSectionsError] = useState('')

  // Rename inline edit state: { [sectionId]: string }
  const [renameValues, setRenameValues] = useState({})
  const [renamingId, setRenamingId] = useState(null)
  const [renameBusy, setRenameBusy] = useState(false)

  // Delete confirm state
  const [deleteConfirmId, setDeleteConfirmId] = useState(null)
  const [deleteBusyId, setDeleteBusyId] = useState(null)

  // Add-section panel
  const [pools, setPools] = useState([])
  const [loadingPools, setLoadingPools] = useState(false)
  const [selectedPoolId, setSelectedPoolId] = useState('')
  const [poolQuestions, setPoolQuestions] = useState([])
  const [loadingPoolQuestions, setLoadingPoolQuestions] = useState(false)
  const [selectedQuestionIds, setSelectedQuestionIds] = useState(new Set())
  const [sectionTitle, setSectionTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createNotice, setCreateNotice] = useState('')
  const [showAddPanel, setShowAddPanel] = useState(false)

  const loadSections = useCallback(async () => {
    setLoadingSections(true)
    setSectionsError('')
    try {
      const { data } = await adminApi.getExamSections(examId)
      setSections(data || [])
    } catch {
      setSectionsError(t('admin_sections_load_error'))
    } finally {
      setLoadingSections(false)
    }
  }, [examId, t])

  const loadPools = useCallback(async () => {
    setLoadingPools(true)
    try {
      const { data } = await adminApi.questionPools()
      setPools(data || [])
    } catch {
      setPools([])
    } finally {
      setLoadingPools(false)
    }
  }, [])

  useEffect(() => {
    void loadSections()
  }, [loadSections])

  useEffect(() => {
    void loadPools()
  }, [loadPools])

  // Load pool questions when pool selection changes
  useEffect(() => {
    if (!selectedPoolId) {
      setPoolQuestions([])
      setSelectedQuestionIds(new Set())
      return
    }
    setLoadingPoolQuestions(true)
    adminApi
      .getPoolQuestions(selectedPoolId)
      .then(({ data }) => {
        const qs = data || []
        setPoolQuestions(qs)
        setSelectedQuestionIds(new Set(qs.map((q) => q.id)))
        // Default title to chosen pool name
        const chosenPool = pools.find((p) => String(p.id) === String(selectedPoolId))
        if (chosenPool) setSectionTitle(chosenPool.name || '')
      })
      .catch(() => {
        setPoolQuestions([])
        setSelectedQuestionIds(new Set())
      })
      .finally(() => {
        setLoadingPoolQuestions(false)
      })
  }, [selectedPoolId, pools])

  // Reorder handler
  const move = async (index, dir) => {
    const j = index + dir
    if (j < 0 || j >= sections.length) return
    const a = sections[index]
    const b = sections[j]
    try {
      await adminApi.reorderSections(examId, [
        { id: a.id, order: b.order },
        { id: b.id, order: a.order },
      ])
      const { data } = await adminApi.getExamSections(examId)
      setSections(data || [])
    } catch {
      setSectionsError(t('admin_sections_reorder_error'))
    }
  }

  // Start rename
  const startRename = (section) => {
    setRenamingId(section.id)
    setRenameValues((prev) => ({ ...prev, [section.id]: section.title || '' }))
  }

  const cancelRename = () => {
    setRenamingId(null)
  }

  const saveRename = async (sectionId) => {
    const newTitle = (renameValues[sectionId] || '').trim()
    if (!newTitle) return
    setRenameBusy(true)
    try {
      await adminApi.updateSection(sectionId, { title: newTitle })
      setRenamingId(null)
      await loadSections()
    } catch {
      setSectionsError(t('admin_sections_rename_error'))
    } finally {
      setRenameBusy(false)
    }
  }

  // Delete handlers
  const handleDelete = async (sectionId) => {
    if (deleteConfirmId !== sectionId) {
      setDeleteConfirmId(sectionId)
      return
    }
    setDeleteBusyId(sectionId)
    setDeleteConfirmId(null)
    try {
      await adminApi.deleteSection(sectionId)
      await loadSections()
      onChange?.()
    } catch {
      setSectionsError(t('admin_sections_delete_error'))
    } finally {
      setDeleteBusyId(null)
    }
  }

  // Toggle question checkbox
  const toggleQuestion = (qId) => {
    setSelectedQuestionIds((prev) => {
      const next = new Set(prev)
      if (next.has(qId)) {
        next.delete(qId)
      } else {
        next.add(qId)
      }
      return next
    })
  }

  // Create section from pool
  const handleCreate = async () => {
    if (!selectedPoolId || selectedQuestionIds.size === 0 || !sectionTitle.trim()) return
    setCreating(true)
    setCreateError('')
    setCreateNotice('')
    try {
      await adminApi.createSectionFromPool(examId, {
        pool_id: selectedPoolId,
        question_ids: [...selectedQuestionIds],
        title: sectionTitle.trim(),
      })
      setCreateNotice(t('admin_sections_created'))
      // Reset panel
      setSelectedPoolId('')
      setPoolQuestions([])
      setSelectedQuestionIds(new Set())
      setSectionTitle('')
      setShowAddPanel(false)
      await loadSections()
      onChange?.()
    } catch {
      setCreateError(t('admin_sections_create_error'))
    } finally {
      setCreating(false)
    }
  }

  const sortedSections = [...sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  return (
    <div className={styles.page}>
      {sectionsError && (
        <div className={styles.helperRow}>
          <div className={styles.errorMsg}>{sectionsError}</div>
          <button className={styles.btnSecondary} onClick={() => void loadSections()}>
            {t('retry')}
          </button>
        </div>
      )}

      {createNotice && <div className={styles.noticeMsg}>{createNotice}</div>}

      {/* Sections list */}
      <div className={styles.card}>
        <div className={styles.sectionTitle}>{t('admin_sections_title')}</div>
        {loadingSections && <div className={styles.empty}>{t('loading')}</div>}
        {!loadingSections && sortedSections.length === 0 && (
          <div className={styles.empty}>{t('admin_sections_empty')}</div>
        )}
        <div className={styles.list}>
          {sortedSections.map((section, index) => (
            <div key={section.id} className={styles.sectionRow}>
              <div className={styles.sectionInfo}>
                {renamingId === section.id ? (
                  <input
                    className={styles.input}
                    value={renameValues[section.id] ?? section.title}
                    onChange={(e) =>
                      setRenameValues((prev) => ({ ...prev, [section.id]: e.target.value }))
                    }
                    autoFocus
                    disabled={renameBusy}
                  />
                ) : (
                  <span className={styles.sectionName}>{section.title}</span>
                )}
                <span className={styles.qCount}>
                  {section.question_count ?? 0} {t('admin_sections_questions')}
                </span>
              </div>

              <div className={styles.rowActions}>
                {renamingId === section.id ? (
                  <>
                    <button
                      className={styles.btnPrimary}
                      onClick={() => void saveRename(section.id)}
                      disabled={renameBusy}
                    >
                      {t('confirm')}
                    </button>
                    <button
                      className={styles.btnSecondary}
                      onClick={cancelRename}
                      disabled={renameBusy}
                    >
                      {t('cancel')}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className={styles.btnSecondary}
                      onClick={() => startRename(section)}
                      disabled={deleteBusyId === section.id}
                    >
                      {t('edit')}
                    </button>
                    {deleteConfirmId === section.id ? (
                      <>
                        <button
                          className={styles.dangerBtn}
                          onClick={() => void handleDelete(section.id)}
                          disabled={deleteBusyId === section.id}
                        >
                          {deleteBusyId === section.id ? t('deleting') : t('confirm')}
                        </button>
                        <button
                          className={styles.btnSecondary}
                          onClick={() => setDeleteConfirmId(null)}
                          disabled={deleteBusyId === section.id}
                        >
                          {t('cancel')}
                        </button>
                      </>
                    ) : (
                      <button
                        className={styles.deleteBtn}
                        onClick={() => void handleDelete(section.id)}
                        disabled={deleteBusyId === section.id}
                      >
                        {t('delete')}
                      </button>
                    )}
                    <button
                      className={styles.btnSecondary}
                      onClick={() => void move(index, -1)}
                      disabled={index === 0}
                      aria-label={t('admin_sections_move_up')}
                      title={t('admin_sections_move_up')}
                    >
                      ↑
                    </button>
                    <button
                      className={styles.btnSecondary}
                      onClick={() => void move(index, 1)}
                      disabled={index === sortedSections.length - 1}
                      aria-label={t('admin_sections_move_down')}
                      title={t('admin_sections_move_down')}
                    >
                      ↓
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Add section panel toggle */}
      <div className={styles.addPanelToggle}>
        <button
          className={styles.btnPrimary}
          onClick={() => setShowAddPanel((v) => !v)}
        >
          {showAddPanel ? t('cancel') : t('admin_sections_add_from_pool')}
        </button>
      </div>

      {/* Add section from pool panel */}
      {showAddPanel && (
        <div className={styles.card}>
          <div className={styles.sectionTitle}>{t('admin_sections_add_from_pool')}</div>

          {createError && <div className={styles.errorMsg}>{createError}</div>}

          {/* Pool selector */}
          <label className={styles.label} htmlFor="sections-pool-select">
            {t('admin_sections_pick_pool')}
          </label>
          {loadingPools ? (
            <div className={styles.empty}>{t('loading')}</div>
          ) : (
            <select
              id="sections-pool-select"
              className={styles.select}
              value={selectedPoolId}
              onChange={(e) => setSelectedPoolId(e.target.value)}
            >
              <option value="">{t('admin_sections_select_pool_placeholder')}</option>
              {pools.map((pool) => (
                <option key={pool.id} value={pool.id}>
                  {pool.name}
                </option>
              ))}
            </select>
          )}

          {/* Section title */}
          {selectedPoolId && (
            <>
              <label className={styles.label} htmlFor="sections-title-input">
                {t('admin_sections_title_label')}
              </label>
              <input
                id="sections-title-input"
                className={styles.input}
                value={sectionTitle}
                onChange={(e) => setSectionTitle(e.target.value)}
                placeholder={t('name')}
              />

              {/* Questions checkbox list */}
              <div className={styles.label}>{t('admin_sections_pick_questions')}</div>
              {loadingPoolQuestions && <div className={styles.empty}>{t('loading')}</div>}
              {!loadingPoolQuestions && poolQuestions.length === 0 && (
                <div className={styles.empty}>{t('admin_sections_no_pool_questions')}</div>
              )}
              {!loadingPoolQuestions && poolQuestions.length > 0 && (
                <div className={styles.questionList}>
                  {poolQuestions.map((q) => (
                    <label key={q.id} className={styles.checkboxRow}>
                      <input
                        type="checkbox"
                        checked={selectedQuestionIds.has(q.id)}
                        onChange={() => toggleQuestion(q.id)}
                      />
                      <span className={styles.checkboxLabel}>{q.text}</span>
                    </label>
                  ))}
                </div>
              )}

              <div className={styles.formActions}>
                <button
                  className={styles.btnPrimary}
                  onClick={() => void handleCreate()}
                  disabled={
                    creating ||
                    selectedQuestionIds.size === 0 ||
                    !sectionTitle.trim()
                  }
                >
                  {creating ? t('saving') : t('admin_sections_create')}
                </button>
                <button
                  className={styles.btnSecondary}
                  onClick={() => setShowAddPanel(false)}
                  disabled={creating}
                >
                  {t('cancel')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
