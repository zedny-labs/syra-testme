import React, { useEffect, useMemo, useState } from 'react'
import { adminApi } from '../../../services/admin.service'
import AdminPageHeader from '../AdminPageHeader/AdminPageHeader'
import useAuth from '../../../hooks/useAuth'
import useLanguage from '../../../hooks/useLanguage'
import styles from './AdminTemplates.module.scss'

function resolveError(err) {
  if (err?.userMessage) return err.userMessage
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string') return detail
  return 'Action failed.'
}

export default function AdminTemplates() {
  const { t } = useLanguage()
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const currentUserId = String(user?.id || '')
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [config, setConfig] = useState('{}')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [modal, setModal] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [modalError, setModalError] = useState('')
  const [deleteConfirmId, setDeleteConfirmId] = useState(null)
  const [search, setSearch] = useState('')
  const [ownershipFilter, setOwnershipFilter] = useState('ALL')
  const [sortDir, setSortDir] = useState('ASC')

  const load = async () => {
    setLoading(true)
    try {
      const { data } = await adminApi.examTemplates()
      setTemplates(data || [])
      setLoadError('')
    } catch (err) {
      setLoadError(resolveError(err) || t('admin_templates_load_error'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const canManageTemplate = (template) => isAdmin || String(template?.created_by_id || '') === currentUserId
  const normalizedSearch = search.trim().toLowerCase()

  const filteredTemplates = useMemo(() => {
    const next = templates.filter((template) => {
      const isOwned = String(template?.created_by_id || '') === currentUserId
      if (ownershipFilter === 'MINE' && !isOwned) return false
      if (ownershipFilter === 'READ_ONLY' && canManageTemplate(template)) return false
      if (!normalizedSearch) return true
      const haystack = [
        template?.name,
        template?.description,
        template?.created_by_id,
      ]
        .map((value) => String(value || '').toLowerCase())
        .join(' ')
      return haystack.includes(normalizedSearch)
    })

    next.sort((left, right) => {
      const result = String(left?.name || '').localeCompare(String(right?.name || ''), undefined, { sensitivity: 'base' })
      return sortDir === 'ASC' ? result : result * -1
    })
    return next
  }, [templates, ownershipFilter, normalizedSearch, sortDir, currentUserId, isAdmin])

  const hasActiveFilters = Boolean(normalizedSearch || ownershipFilter !== 'ALL')
  const ownTemplatesCount = templates.filter((template) => String(template?.created_by_id || '') === currentUserId).length
  const readOnlyCount = templates.filter((template) => !canManageTemplate(template)).length
  const summaryCards = [
    {
      label: t('admin_templates_saved_templates'),
      value: templates.length,
      helper: t('admin_templates_blueprints_helper'),
    },
    {
      label: t('admin_stat_visible_now'),
      value: filteredTemplates.length,
      helper: hasActiveFilters ? t('admin_stat_matching_filters') : t('admin_templates_all_loaded'),
    },
    {
      label: t('admin_templates_owned_by_you'),
      value: ownTemplatesCount,
      helper: t('admin_templates_owned_helper'),
    },
    {
      label: t('admin_templates_read_only'),
      value: readOnlyCount,
      helper: t('admin_templates_read_only_helper'),
    },
  ]

  const resetModal = () => {
    if (saving) return
    setModal(false)
    setName('')
    setDescription('')
    setConfig('{}')
    setEditingId(null)
    setModalError('')
  }

  const openCreateModal = () => {
    setName('')
    setDescription('')
    setConfig('{}')
    setEditingId(null)
    setModalError('')
    setModal(true)
  }

  const openEditModal = (template) => {
    setEditingId(template.id)
    setName(template.name || '')
    setDescription(template.description || '')
    setConfig(template.config ? JSON.stringify(template.config, null, 2) : '{}')
    setModalError('')
    setModal(true)
  }

  const clearFilters = () => {
    setSearch('')
    setOwnershipFilter('ALL')
  }

  const handleSubmit = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setModalError(t('admin_templates_name_required'))
      return
    }
    setModalError('')
    setNotice('')
    setSaving(true)
    try {
      const parsed = config ? JSON.parse(config) : {}
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error(t('admin_templates_config_must_be_object'))
      }
      if (editingId) {
        await adminApi.updateExamTemplate(editingId, {
          name: trimmedName,
          description: description.trim() || null,
          config: parsed,
        })
        setNotice(t('admin_templates_updated_notice'))
      } else {
        await adminApi.createExamTemplate({
          name: trimmedName,
          description: description.trim() || null,
          config: parsed,
        })
        setNotice(t('admin_templates_created_notice'))
      }
      resetModal()
      await load()
    } catch (err) {
      setModalError(resolveError(err) || err.message || t('admin_templates_save_failed'))
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
    setDeleteConfirmId(null)
    setError('')
    setNotice('')
    try {
      await adminApi.deleteExamTemplate(id)
      setNotice(t('admin_templates_deleted_notice'))
      await load()
    } catch (err) {
      setError(resolveError(err) || t('admin_templates_delete_failed'))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className={styles.page}>
      <AdminPageHeader title={t('admin_templates_page_title')} subtitle={t('admin_templates_page_subtitle')}>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={openCreateModal}
        >
          {t('admin_templates_new_template')}
        </button>
      </AdminPageHeader>

      {notice && <div className={styles.noticeBanner}>{notice}</div>}
      {error && (
        <div className={styles.helperRow}>
          <div className={styles.errorBanner}>{error}</div>
          <button type="button" className={styles.actionBtn} onClick={() => void load()}>{t('retry')}</button>
        </div>
      )}
      {loadError && (
        <div className={styles.helperRow}>
          <div className={styles.errorBanner}>{loadError}</div>
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
            placeholder={t('admin_templates_search_placeholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            className={styles.sortBtn}
            value={ownershipFilter}
            onChange={(event) => setOwnershipFilter(event.target.value)}
          >
            <option value="ALL">{t('admin_templates_filter_all')}</option>
            <option value="MINE">{t('admin_templates_owned_by_you')}</option>
            <option value="READ_ONLY">{t('admin_templates_filter_read_only')}</option>
          </select>
          <button
            type="button"
            className={styles.sortBtn}
            onClick={() => setSortDir((current) => (current === 'ASC' ? 'DESC' : 'ASC'))}
          >
            {sortDir === 'ASC' ? t('sort_name_az') : t('sort_name_za')}
          </button>
          <div className={styles.toolbarActions}>
            <button type="button" className={styles.actionBtn} onClick={() => void load()} disabled={loading}>{t('refresh')}</button>
            <button type="button" className={styles.actionBtn} onClick={clearFilters} disabled={!hasActiveFilters}>{t('clear_filters')}</button>
          </div>
        </div>
        <div className={styles.filterMeta}>
          {t('admin_templates_showing_count', { filtered: filteredTemplates.length, total: templates.length })}
        </div>
      </div>

      {loading ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_templates_loading')}</div>
          <div className={styles.emptyText}>{t('admin_templates_loading_sub')}</div>
        </div>
      ) : filteredTemplates.length === 0 && hasActiveFilters ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_templates_no_match')}</div>
          <div className={styles.emptyText}>{t('admin_templates_clear_filters_hint')}</div>
          <button type="button" className={styles.actionBtn} onClick={clearFilters}>{t('clear_filters')}</button>
        </div>
      ) : filteredTemplates.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_templates_none_yet')}</div>
          <div className={styles.emptyText}>{t('admin_templates_empty_state')}</div>
        </div>
      ) : (
        <div className={styles.grid}>
          {filteredTemplates.map((template) => {
            const templateLabel = template.name || t('admin_templates_this_template')

            return (
              <div key={template.id} className={styles.card} data-template-name={template.name || ''}>
                {!canManageTemplate(template) && (
                  <div className={styles.readOnlyNote}>{t('admin_templates_read_only_notice')}</div>
                )}
                <div className={styles.cardHeader}>
                  <div>
                    <span className={styles.cardTitle}>{template.name}</span>
                    <span className={styles.configBadge}>
                      {t('admin_templates_config_fields_count', { count: Object.keys(template?.config || {}).length })}
                    </span>
                  </div>
                  <div className={styles.actionBtns}>
                    {canManageTemplate(template) && (
                      <button
                        type="button"
                        className={styles.actionBtn}
                        onClick={() => openEditModal(template)}
                        disabled={deletingId === template.id}
                        aria-label={`${t('edit')} ${templateLabel}`}
                        title={`${t('edit')} ${templateLabel}`}
                      >
                        {t('edit')}
                      </button>
                    )}
                    {isAdmin && (
                      deleteConfirmId === template.id ? (
                        <>
                          <button
                            type="button"
                            className={styles.actionBtnDanger}
                            onClick={() => void handleDelete(template.id)}
                            disabled={deletingId === template.id}
                            aria-label={`${t('confirm')} ${t('delete')} ${templateLabel}`}
                          >
                            {deletingId === template.id ? t('admin_deleting') : t('confirm')}
                          </button>
                          <button
                            type="button"
                            className={styles.actionBtn}
                            onClick={() => setDeleteConfirmId(null)}
                            disabled={deletingId === template.id}
                            aria-label={`${t('admin_templates_keep')} ${templateLabel}`}
                          >
                            {t('cancel')}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={styles.actionBtn}
                          onClick={() => void handleDelete(template.id)}
                          disabled={deletingId === template.id}
                          aria-label={`${t('delete')} ${templateLabel}`}
                          title={`${t('delete')} ${templateLabel}`}
                        >
                          {t('delete')}
                        </button>
                      )
                    )}
                  </div>
                </div>
                <div className={template.description ? styles.cardMeta : styles.cardMetaMuted}>
                  {template.description || t('admin_templates_no_description')}
                </div>
                <div className={styles.cardFooter}>
                  {canManageTemplate(template)
                    ? String(template?.created_by_id || '') === currentUserId
                      ? t('admin_templates_owned_by_you')
                      : t('admin_templates_editable_as_admin')
                    : t('admin_templates_read_only_shared')}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {modal && (
        <div className={styles.modalOverlay} onClick={resetModal}>
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="template-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="template-dialog-title" className={styles.modalTitle}>
              {editingId ? t('admin_templates_edit_template') : t('admin_templates_new_template')}
            </h3>
            {modalError && <div className={styles.modalError}>{modalError}</div>}
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="template-name">{t('admin_templates_name_label')}</label>
              <input
                id="template-name"
                className={styles.input}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="template-description">{t('admin_templates_description_label')}</label>
              <input
                id="template-description"
                className={styles.input}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="template-config">{t('admin_templates_config_json_label')}</label>
              <textarea
                id="template-config"
                className={styles.textarea}
                value={config}
                onChange={(event) => setConfig(event.target.value)}
                rows={6}
              />
            </div>
            <div className={styles.modalActions}>
              <button type="button" className={styles.btnCancel} onClick={resetModal} disabled={saving}>
                {t('cancel')}
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={() => void handleSubmit()}
                disabled={saving || !name.trim()}
              >
                {saving
                  ? t('saving')
                  : editingId
                    ? t('admin_templates_update_template')
                    : t('admin_templates_save_template')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
