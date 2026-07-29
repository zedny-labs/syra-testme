import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { adminApi } from '../../../services/admin.service'
import useAuth from '../../../hooks/useAuth'
import useLanguage from '../../../hooks/useLanguage'
import AdminPageHeader from '../AdminPageHeader/AdminPageHeader'
import { readPaginatedItems, readPaginatedTotal } from '../../../utils/pagination'
import styles from './AdminUsers.module.scss'

const EMPTY_FORM = { user_id: '', name: '', email: '', password: '', role: 'LEARNER', is_active: true }
const ROLES = ['ADMIN', 'INSTRUCTOR', 'LEARNER']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SORT_OPTIONS = [
  { value: 'name_asc', labelKey: 'admin_users_sort_name_az' },
  { value: 'name_desc', labelKey: 'admin_users_sort_name_za' },
  { value: 'email_asc', labelKey: 'admin_users_sort_email_az' },
  { value: 'role_asc', labelKey: 'admin_users_sort_role' },
  { value: 'created_desc', labelKey: 'admin_users_sort_newest' },
  { value: 'created_asc', labelKey: 'admin_users_sort_oldest' },
]

const SUMMARY_ROLES = ['ADMIN', 'INSTRUCTOR', 'LEARNER']

function resolveError(err) {
  if (err?.userMessage) return err.userMessage
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string') return detail
  return 'Action failed.'
}

function validateUserForm(form, isCreate, t) {
  if (!form.user_id.trim()) return t('admin_users_err_user_id_required')
  if (!form.name.trim()) return t('admin_users_err_name_required')
  if (!form.email.trim()) return t('admin_users_err_email_required')
  if (!EMAIL_RE.test(form.email.trim())) return t('admin_users_err_email_invalid')
  if (isCreate && form.password.length < 8) return t('admin_users_err_password_min')
  return ''
}

function mapSortOption(sortOption) {
  if (sortOption === 'name_asc') return { sort_by: 'name', sort_dir: 'asc' }
  if (sortOption === 'name_desc') return { sort_by: 'name', sort_dir: 'desc' }
  if (sortOption === 'email_asc') return { sort_by: 'email', sort_dir: 'asc' }
  if (sortOption === 'role_asc') return { sort_by: 'role', sort_dir: 'asc' }
  if (sortOption === 'created_asc') return { sort_by: 'created_at', sort_dir: 'asc' }
  return { sort_by: 'created_at', sort_dir: 'desc' }
}

export default function AdminUsers() {
  const { t } = useLanguage()
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const searchParamValue = searchParams.get('search') || ''
  const [users, setUsers] = useState([])
  const [totalUsers, setTotalUsers] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState(searchParamValue)
  const [roleFilter, setRoleFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [selected, setSelected] = useState([])
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [fieldErrors, setFieldErrors] = useState({})
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [sortBy, setSortBy] = useState('created_desc')
  const [deleteId, setDeleteId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [deleteBusyId, setDeleteBusyId] = useState(null)
  const [showResetPw, setShowResetPw] = useState(false)
  const [resetPwValue, setResetPwValue] = useState('')
  const [resetPwSaving, setResetPwSaving] = useState(false)
  const abortRef = useRef(null)
  const isAdmin = user?.role === 'ADMIN'
  const modalBusy = saving || resetPwSaving

  const load = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setLoadError('')
    try {
      const { sort_by, sort_dir } = mapSortOption(sortBy)
      const params = {
        skip: (page - 1) * pageSize,
        limit: pageSize,
        sort_by,
        sort_dir,
      }
      if (search.trim()) params.search = search.trim()
      if (roleFilter !== 'All') params.role = roleFilter
      if (statusFilter === 'Active') params.is_active = true
      if (statusFilter === 'Inactive') params.is_active = false

      const { data } = await adminApi.users(params, { signal: controller.signal })
      if (controller.signal.aborted) return
      const nextUsers = readPaginatedItems(data)
      const nextTotal = readPaginatedTotal(data)
      setUsers(nextUsers)
      setTotalUsers(nextTotal)
      setSelected((prev) => prev.filter((id) => nextUsers.some((nextUser) => nextUser.id === id)))
      setError('')
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') return
      setUsers([])
      setTotalUsers(0)
      setLoadError(resolveError(err) || t('admin_users_err_load'))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [page, pageSize, roleFilter, search, sortBy, statusFilter])

  useEffect(() => { void load() }, [load])

  useEffect(() => () => {
    if (abortRef.current) abortRef.current.abort()
  }, [])

  useEffect(() => {
    setSearch(searchParamValue)
    setPage(1)
  }, [searchParamValue])

  const totalPages = Math.max(1, Math.ceil(totalUsers / pageSize))
  const pageUsers = users
  const activeUsers = users.filter((listedUser) => listedUser.is_active !== false).length
  const inactiveUsers = Math.max(users.length - activeUsers, 0)
  const hasActiveFilters = Boolean(search.trim() || roleFilter !== 'All' || statusFilter !== 'All')
  const summaryCards = [
    { label: t('admin_users_matching_users'), value: totalUsers, sub: hasActiveFilters ? t('admin_users_filters_active') : t('admin_users_all_matching_sort') },
    { label: t('admin_users_users_on_page'), value: users.length, sub: `${t('admin_users_page')} ${page} ${t('admin_users_of')} ${totalPages}` },
    { label: t('admin_users_active_on_page'), value: activeUsers, sub: `${inactiveUsers} ${t('admin_users_inactive_accounts_on_page')}` },
    { label: isAdmin ? t('admin_users_selected_users') : t('admin_users_your_access'), value: isAdmin ? selected.length : t('admin_users_read_only'), sub: isAdmin ? t('admin_users_bulk_actions_hint') : t('admin_users_non_admin_hint') },
  ]
  const roleSummary = SUMMARY_ROLES.map((role) => ({
    role,
    count: users.filter((listedUser) => listedUser.role === role).length,
  }))
  const deleteTarget = deleteId ? users.find((listedUser) => listedUser.id === deleteId) : null
  const deleteTargetLabel = deleteTarget?.name || deleteTarget?.email || deleteTarget?.user_id || 'this user'
  const userModalTitleId = modal === 'create' ? 'user-create-dialog-title' : 'user-edit-dialog-title'
  const editingSelf = modal !== 'create' && modal?.id === user?.id

  const exportCSV = () => {
    const rows = [
      ['User ID', 'Name', 'Email', 'Role', 'Status'],
      ...pageUsers.map((u) => [u.user_id || '', u.name || '', u.email || '', u.role || '', u.is_active !== false ? 'Active' : 'Inactive']),
    ]
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'users-export.csv'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }
  const allPageSelected = isAdmin && pageUsers.length > 0 && pageUsers.every((listedUser) => selected.includes(listedUser.id))

  const clearFilters = () => {
    setSearch('')
    setRoleFilter('All')
    setStatusFilter('All')
    setSortBy('created_desc')
    setPageSize(10)
    setPage(1)
  }


  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages)
    }
  }, [page, totalPages])

  const toggleSelect = (id) => setSelected((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]))
  const toggleAll = () => setSelected((prev) => {
    const pageIds = pageUsers.map((listedUser) => listedUser.id)
    if (allPageSelected) {
      return prev.filter((id) => !pageIds.includes(id))
    }
    return Array.from(new Set([...prev, ...pageIds]))
  })

  const openCreate = () => {
    setForm({ ...EMPTY_FORM })
    setFieldErrors({})
    setShowResetPw(false)
    setResetPwValue('')
    setError('')
    setNotice('')
    setModal('create')
  }

  const openEdit = (listedUser) => {
    setForm({
      user_id: listedUser.user_id || '',
      name: listedUser.name || '',
      email: listedUser.email || '',
      password: '',
      role: listedUser.role || 'LEARNER',
      is_active: listedUser.is_active !== false,
    })
    setFieldErrors({})
    setShowResetPw(false)
    setResetPwValue('')
    setError('')
    setNotice('')
    setModal(listedUser)
  }

  const handleResetPassword = async () => {
    if (!resetPwValue.trim() || resetPwValue.length < 8) {
      setError(t('admin_users_err_new_password_min'))
      return
    }
    setResetPwSaving(true)
    setError('')
    setNotice('')
    try {
      await adminApi.resetUserPassword(modal.id, resetPwValue)
      setNotice(t('admin_users_password_reset_success'))
      setShowResetPw(false)
      setResetPwValue('')
    } catch (err) {
      setError(resolveError(err) || t('admin_users_err_reset_password'))
    } finally {
      setResetPwSaving(false)
    }
  }

  const handleSave = async () => {
    const validationError = validateUserForm(form, modal === 'create', t)
    if (validationError) {
      setFieldErrors({})
      setError(validationError)
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    setFieldErrors({})
    try {
      const payload = {
        ...form,
        user_id: form.user_id.trim(),
        name: form.name.trim(),
        email: form.email.trim(),
      }
      if (modal === 'create') {
        await adminApi.createUser(payload)
        setNotice(t('admin_users_user_created'))
      } else {
        await adminApi.updateUser(modal.id, {
          user_id: payload.user_id,
          name: payload.name,
          email: payload.email,
          ...(editingSelf ? {} : { role: payload.role, is_active: payload.is_active }),
        })
        setNotice(t('admin_users_user_updated'))
      }
      setModal(null)
      if (page !== 1) {
        setPage(1)
      } else {
        await load()
      }
    } catch (err) {
      setFieldErrors(err.validation?.fields || {})
      setError(resolveError(err) || t('admin_users_err_save'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id) => {
    setError('')
    setNotice('')
    setDeleteBusyId(id)
    try {
      await adminApi.deleteUser(id)
      setDeleteId(null)
      setNotice(t('admin_users_user_deleted'))
      if (page > 1 && users.length === 1) {
        setPage(page - 1)
      } else {
        await load()
      }
    } catch (err) {
      setError(resolveError(err) || t('admin_users_err_delete'))
    } finally {
      setDeleteBusyId(null)
    }
  }

  const handleBulkDelete = async () => {
    setBulkDeleting(true)
    setError('')
    setNotice('')
    const toDelete = selected.filter(id => id !== user?.id)
    if (toDelete.length !== selected.length) {
      setError(t('admin_users_err_cannot_delete_self'))
    }
    let failed = 0
    for (const id of toDelete) {
      try {
        await adminApi.deleteUser(id)
      } catch {
        failed += 1
      }
    }
    setSelected([])
    if (page > 1 && toDelete.length === users.length) {
      setPage(page - 1)
    } else {
      await load()
    }
    if (failed > 0) {
      setError(`${failed} ${t('admin_users_err_bulk_delete_partial')}`)
    } else if (toDelete.length > 0) {
      setNotice(t('admin_users_selected_deleted'))
    }
    setBulkDeleting(false)
  }

  const initials = (listedUser) => (listedUser.name || listedUser.user_id || '?').slice(0, 2).toUpperCase()

  return (
    <div className={styles.page}>
      <AdminPageHeader title={t('admin_users_title')} subtitle={t('admin_users_subtitle')}>
        {isAdmin ? (
          <button type="button" className={styles.btnPrimary} onClick={openCreate} disabled={Boolean(deleteBusyId)}>+ {t('admin_users_new_user')}</button>
        ) : (
          <span className={styles.readOnlyHint}>{t('admin_users_read_only_access')}</span>
        )}
      </AdminPageHeader>
      {loadError && (
        <div className={styles.loadError}>
          <div className={styles.loadErrorRow}>
            <span>{loadError}</span>
            <button type="button" className={styles.retryBtn} onClick={() => void load()} disabled={loading}>
              {loading ? t('admin_users_retrying') : t('admin_users_retry')}
            </button>
          </div>
        </div>
      )}
      {error && <div className={styles.error}>{error}</div>}
      {notice && <div className={styles.notice}>{notice}</div>}

      <div className={styles.summaryGrid}>
        {summaryCards.map((card) => (
          <div key={card.label} className={styles.summaryCard}>
            <div className={styles.summaryLabel}>{card.label}</div>
            <div className={styles.summaryValue}>{card.value}</div>
            <div className={styles.summarySub}>{card.sub}</div>
          </div>
        ))}
      </div>

      <div className={styles.roleChips}>
        {roleSummary.map((item) => (
          <span key={item.role} className={`${styles.roleChip} ${styles['roleChip' + item.role]}`}>
            {item.role}: {item.count}
          </span>
        ))}
      </div>

      <div className={styles.toolbarPanel}>
        <div className={styles.toolbar}>
          <input className={styles.search} placeholder={t('admin_users_search_placeholder')} value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} />
          <select className={styles.filterSelect} value={roleFilter} onChange={(event) => { setRoleFilter(event.target.value); setPage(1) }}>
            <option value="All">{t('admin_users_all_roles')}</option>
            {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
          </select>
          <select className={styles.filterSelect} value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1) }}>
            <option value="All">{t('admin_users_all_status')}</option>
            <option value="Active">{t('admin_users_active')}</option>
            <option value="Inactive">{t('admin_users_inactive')}</option>
          </select>
          <select className={styles.filterSelect} value={sortBy} onChange={(event) => { setSortBy(event.target.value); setPage(1) }}>
            {SORT_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>)}
          </select>
          <select className={`${styles.filterSelect} ${styles.pageSizeSelect}`} value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1) }}>
            <option value={10}>10 / {t('admin_users_page')}</option>
            <option value={25}>25 / {t('admin_users_page')}</option>
            <option value={50}>50 / {t('admin_users_page')}</option>
          </select>
          <button type="button" className={styles.exportBtn} onClick={exportCSV} disabled={pageUsers.length === 0}>
            {t('admin_users_export_csv')}
          </button>
        </div>
        <div className={styles.toolbarActions}>
          <button type="button" className={styles.secondaryBtn} onClick={() => void load()} disabled={loading}>
            {loading ? t('admin_users_refreshing') : t('admin_users_refresh')}
          </button>
          <button type="button" className={styles.secondaryBtn} onClick={clearFilters} disabled={!hasActiveFilters}>
            {t('admin_users_clear_filters')}
          </button>
          <div className={styles.filterMeta}>
            {t('admin_users_showing')} {users.length} {t('admin_users_users_label')} {t('admin_users_on_this_page_across')} {totalUsers} {t('admin_users_matching')}.
          </div>
        </div>
      </div>

      {isAdmin && selected.length > 0 && (
        <div className={styles.bulkBar}>
          <span>{selected.length} {t('admin_users_selected_on_page')}</span>
          <button type="button" className={styles.btnDanger} onClick={handleBulkDelete} disabled={bulkDeleting}>
            {bulkDeleting ? t('admin_users_deleting') : t('admin_users_delete_selected')}
          </button>
        </div>
      )}

      <div className={styles.tableWrap}>
        {loading ? (
          <div className={styles.empty}>{t('admin_users_loading')}</div>
        ) : totalUsers === 0 && hasActiveFilters ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyTitle}>{t('admin_users_no_matches')}</div>
            <div className={styles.emptyText}>{t('admin_users_no_matches_text')}</div>
            <button type="button" className={styles.secondaryBtn} onClick={clearFilters}>
              {t('admin_users_clear_filters')}
            </button>
          </div>
        ) : users.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyTitle}>{t('admin_users_no_users_yet')}</div>
            <div className={styles.emptyText}>{t('admin_users_no_users_yet_text')}</div>
          </div>
        ) : pageUsers.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyTitle}>{t('admin_users_no_matches')}</div>
            <div className={styles.emptyText}>{t('admin_users_no_matches_text')}</div>
            <button type="button" className={styles.secondaryBtn} onClick={clearFilters}>
              {t('admin_users_clear_filters')}
            </button>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                {isAdmin && <th><input type="checkbox" checked={allPageSelected} onChange={toggleAll} /></th>}
                <th>{t('admin_users_th_avatar')}</th>
                <th>{t('admin_users_th_user_id')}</th>
                <th>{t('admin_users_th_name')}</th>
                <th>{t('admin_users_th_email')}</th>
                <th>{t('admin_users_th_role')}</th>
                <th>{t('admin_users_th_status')}</th>
                {isAdmin && <th>{t('admin_users_th_actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {pageUsers.map((listedUser) => {
                const userActionLabel = listedUser.name || listedUser.email || listedUser.user_id || 'this user'

                return (
                <tr key={listedUser.id}>
                  {isAdmin && <td><input type="checkbox" checked={selected.includes(listedUser.id)} onChange={() => toggleSelect(listedUser.id)} /></td>}
                  <td><div className={styles.avatar}>{initials(listedUser)}</div></td>
                  <td className={styles.codeCell}>{listedUser.user_id}</td>
                  <td>{listedUser.name || '-'}</td>
                  <td className={styles.emailCell}>{listedUser.email || '-'}</td>
                  <td><span className={`${styles.roleBadge} ${styles['role' + listedUser.role]}`}>{listedUser.role}</span></td>
                  <td><span className={`${styles.statusBadge} ${listedUser.is_active !== false ? styles.statusActive : styles.statusInactive}`}>{listedUser.is_active !== false ? t('admin_users_active') : t('admin_users_inactive')}</span></td>
                  {isAdmin && (
                    <td>
                      <div className={styles.actionBtns}>
                        <button
                          type="button"
                          className={styles.actionBtn}
                          onClick={() => openEdit(listedUser)}
                          disabled={deleteBusyId === listedUser.id}
                          aria-label={`Edit user ${userActionLabel}`}
                          title={`Edit user ${userActionLabel}`}
                        >
                          {t('admin_users_edit')}
                        </button>
                        <button
                          type="button"
                          className={styles.actionBtnDanger}
                          onClick={() => setDeleteId(listedUser.id)}
                          disabled={deleteBusyId === listedUser.id || listedUser.id === user?.id}
                          aria-label={`${t('admin_users_delete')} ${userActionLabel}`}
                          title={`${t('admin_users_delete')} ${userActionLabel}`}
                        >
                          {deleteBusyId === listedUser.id ? t('admin_users_deleting') : t('admin_users_delete')}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {totalPages > 1 && (
        <div className={styles.pagination}>
          <span className={styles.pageInfo}>{totalUsers} {t('admin_users_matching')} | {t('admin_users_page')} {page} {t('admin_users_of')} {totalPages}</span>
          <button type="button" className={styles.pageBtn} disabled={page === 1} onClick={() => setPage((value) => value - 1)}>{t('admin_users_previous')}</button>
          <button type="button" className={styles.pageBtn} disabled={page === totalPages} onClick={() => setPage((value) => value + 1)}>{t('admin_users_next')}</button>
        </div>
      )}

      {isAdmin && modal && (
        <div className={styles.modalOverlay} onClick={() => { if (!modalBusy) setModal(null) }}>
          <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby={userModalTitleId} onClick={(event) => event.stopPropagation()}>
            <h3 id={userModalTitleId} className={styles.modalTitle}>{modal === 'create' ? t('admin_users_create_user') : t('admin_users_edit_user')}</h3>
            {['user_id', 'name', 'email'].map((field) => {
              const inputId = `user-modal-${field.replace('_', '-')}`
              const labelKeys = { user_id: 'admin_users_th_user_id', name: 'admin_users_th_name', email: 'admin_users_th_email' }
              const label = t(labelKeys[field])

              return (
              <div key={field} className={styles.formGroup}>
                <label className={styles.label} htmlFor={inputId}>{label}</label>
                <input
                  id={inputId}
                  className={`${styles.input} ${fieldErrors[field] ? styles.inputInvalid : ''}`}
                  aria-invalid={fieldErrors[field] ? 'true' : 'false'}
                  value={form[field]}
                  onChange={(event) => {
                    setForm((current) => ({ ...current, [field]: event.target.value }))
                    setFieldErrors((current) => {
                      if (!current[field]) return current
                      const next = { ...current }
                      delete next[field]
                      return next
                    })
                  }}
                />
                {fieldErrors[field] && <div className={styles.fieldError}>{fieldErrors[field]}</div>}
              </div>
              )
            })}
            {modal === 'create' && (
              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="user-modal-password">{t('admin_users_password')}</label>
                <input
                  id="user-modal-password"
                  type="password"
                  className={`${styles.input} ${fieldErrors.password ? styles.inputInvalid : ''}`}
                  aria-invalid={fieldErrors.password ? 'true' : 'false'}
                  value={form.password}
                  onChange={(event) => {
                    setForm((current) => ({ ...current, password: event.target.value }))
                    setFieldErrors((current) => {
                      if (!current.password) return current
                      const next = { ...current }
                      delete next.password
                      return next
                    })
                  }}
                />
                {fieldErrors.password && <div className={styles.fieldError}>{fieldErrors.password}</div>}
              </div>
            )}
            {modal !== 'create' && (
              <div className={styles.formGroup}>
                <button
                  type="button"
                  className={styles.btnReset}
                  onClick={() => { setShowResetPw((value) => !value); setResetPwValue('') }}
                  disabled={modalBusy}
                  aria-expanded={showResetPw ? 'true' : 'false'}
                  aria-controls="user-reset-password-panel"
                >
                  {showResetPw ? t('admin_users_cancel_reset') : t('admin_users_reset_password')}
                </button>
                {showResetPw && (
                  <div id="user-reset-password-panel" className={styles.resetPwRow}>
                    <input
                      id="user-modal-reset-password"
                      type="password"
                      className={styles.input}
                      placeholder={t('admin_users_new_password_placeholder')}
                      value={resetPwValue}
                      onChange={(event) => setResetPwValue(event.target.value)}
                    />
                    <button
                      type="button"
                      className={styles.btnPrimary}
                      onClick={handleResetPassword}
                      disabled={resetPwSaving || resetPwValue.length < 8}
                    >
                      {resetPwSaving ? t('admin_users_saving') : t('admin_users_set_password')}
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="user-modal-role">{t('admin_users_th_role')}</label>
              <select
                id="user-modal-role"
                className={`${styles.select} ${fieldErrors.role ? styles.inputInvalid : ''}`}
                aria-invalid={fieldErrors.role ? 'true' : 'false'}
                value={form.role}
                disabled={editingSelf}
                onChange={(event) => {
                  setForm((current) => ({ ...current, role: event.target.value }))
                  setFieldErrors((current) => {
                    if (!current.role) return current
                    const next = { ...current }
                    delete next.role
                    return next
                  })
                }}
              >
                {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
              {fieldErrors.role && <div className={styles.fieldError}>{fieldErrors.role}</div>}
            </div>
            <div className={styles.formGroup}>
              <label className={styles.checkboxLabel}>
                <input
                  id="user-modal-active"
                  type="checkbox"
                  checked={form.is_active}
                  disabled={editingSelf}
                  onChange={(event) => setForm((current) => ({ ...current, is_active: event.target.checked }))}
                />
                <span className={styles.checkboxText}>{t('admin_users_active')}</span>
              </label>
            </div>
            {editingSelf && (
              <div className={styles.notice}>{t('admin_users_self_edit_notice')}</div>
            )}
            <div className={styles.modalActions}>
              <button type="button" className={styles.btnCancel} onClick={() => setModal(null)} disabled={modalBusy}>{t('admin_users_cancel')}</button>
              <button type="button" className={styles.btnPrimary} onClick={handleSave} disabled={saving}>
                {saving ? t('admin_users_saving') : t('admin_users_save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {isAdmin && deleteId && (
        <div className={styles.modalOverlay} onClick={() => { if (deleteBusyId !== deleteId) setDeleteId(null) }}>
          <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="user-delete-dialog-title" aria-describedby="user-delete-dialog-description" onClick={(event) => event.stopPropagation()}>
            <h3 id="user-delete-dialog-title" className={styles.modalTitle}>Delete User?</h3>
            <p id="user-delete-dialog-description" className={styles.modalWarning}>Delete the account for {deleteTargetLabel}. This cannot be undone.</p>
            <div className={styles.modalActions}>
              <button type="button" className={styles.btnCancel} onClick={() => setDeleteId(null)} disabled={deleteBusyId === deleteId} aria-label={`Cancel deleting ${deleteTargetLabel}`}>Cancel</button>
              <button type="button" className={styles.btnDanger} onClick={() => handleDelete(deleteId)} disabled={deleteBusyId === deleteId} aria-label={`Delete ${deleteTargetLabel}`}>
                {deleteBusyId === deleteId ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
