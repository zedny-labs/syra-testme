import React, { useCallback, useEffect, useRef, useState } from 'react'
import { adminApi } from '../../../services/admin.service'
import AdminPageHeader from '../AdminPageHeader/AdminPageHeader'
import { normalizeAdminTest } from '../../../utils/assessmentAdapters'
import { readPaginatedItems } from '../../../utils/pagination'
import useLanguage from '../../../hooks/useLanguage'
import styles from './AdminUserGroups.module.scss'

function resolveError(err, fallback) {
  if (err?.userMessage) return err.userMessage
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string') return detail
  return fallback || 'Action failed.'
}

export default function AdminUserGroups() {
  const { t } = useLanguage()
  const [groups, setGroups] = useState([])
  const [users, setUsers] = useState([])
  const [allTests, setAllTests] = useState([])
  const [allSchedules, setAllSchedules] = useState([])
  const [loading, setLoading] = useState(true)
  const [usersReady, setUsersReady] = useState(false)
  const [testsReady, setTestsReady] = useState(false)
  const [schedulesReady, setSchedulesReady] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [sortDir, setSortDir] = useState('asc')

  // Modal state
  const [modal, setModal] = useState(false)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [modalError, setModalError] = useState('')
  const [saving, setSaving] = useState(false)

  // Expand / member state (per-card)
  const [expanded, setExpanded] = useState({})
  const [cardMembers, setCardMembers] = useState({})
  const [expandLoadingId, setExpandLoadingId] = useState(null)
  const [addUserId, setAddUserId] = useState({})
  const [addingMemberId, setAddingMemberId] = useState(null)
  const [removingMemberId, setRemovingMemberId] = useState(null)

  // Delete state
  const [deleteConfirmId, setDeleteConfirmId] = useState(null)
  const [deleteBusyId, setDeleteBusyId] = useState(null)

  // Bulk assign state (per-card)
  const [bulkState, setBulkState] = useState({})

  const abortRef = useRef(null)

  const load = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setError('')
    try {
      const [groupsRes, usersRes, testsRes, schedulesRes] = await Promise.allSettled([
        adminApi.userGroups({ signal: controller.signal }),
        adminApi.users({ role: 'LEARNER', skip: 0, limit: 200 }, { signal: controller.signal }),
        adminApi.allTests({}, { signal: controller.signal }),
        adminApi.schedules({ signal: controller.signal }),
      ])
      if (controller.signal.aborted) return

      if (groupsRes.status === 'fulfilled') {
        setGroups(groupsRes.value.data || [])
      } else {
        setGroups([])
        setError(resolveError(groupsRes.reason, t('admin_groups_failed_load_groups')))
      }

      if (usersRes.status === 'fulfilled') {
        setUsers(readPaginatedItems(usersRes.value.data).filter((u) => u.role === 'LEARNER'))
        setUsersReady(true)
      } else {
        setUsers([])
        setUsersReady(false)
      }

      if (testsRes.status === 'fulfilled') {
        setAllTests((testsRes.value.data?.items || []).map(normalizeAdminTest))
        setTestsReady(true)
      } else {
        setAllTests([])
        setTestsReady(false)
      }

      if (schedulesRes.status === 'fulfilled') {
        setAllSchedules(schedulesRes.value.data || [])
        setSchedulesReady(true)
      } else {
        setAllSchedules([])
        setSchedulesReady(false)
      }
    } catch (err) {
      if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') return
      setGroups([])
      setError(resolveError(err, t('admin_groups_failed_load_groups')))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => {
      if (abortRef.current) abortRef.current.abort()
    }
  }, [load])

  // Filtering & sorting
  const normalizedSearch = search.trim().toLowerCase()
  const filtered = [...groups]
    .filter((g) => !normalizedSearch
      || g.name.toLowerCase().includes(normalizedSearch)
      || (g.description || '').toLowerCase().includes(normalizedSearch))
    .sort((a, b) => (sortDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)))
  const hasActiveFilters = Boolean(normalizedSearch) || sortDir !== 'asc'

  const totalMembers = groups.reduce((sum, g) => sum + Number(g.member_count || 0), 0)
  const summaryCards = [
    { label: t('admin_groups_total_groups'), value: groups.length, helper: t('admin_groups_total_groups_helper') },
    { label: t('admin_groups_visible_now'), value: filtered.length, helper: hasActiveFilters ? t('admin_groups_visible_filtered') : t('admin_groups_visible_all') },
    { label: t('admin_groups_total_members'), value: totalMembers, helper: t('admin_groups_total_members_helper') },
    { label: t('admin_groups_available_learners'), value: users.length, helper: usersReady ? t('admin_groups_available_learners_helper') : t('admin_groups_learners_loading') },
  ]

  const clearFilters = () => {
    setSearch('')
    setSortDir('asc')
  }

  // Expand / collapse members
  const toggleExpand = async (groupId) => {
    if (expanded[groupId]) {
      setExpanded((prev) => ({ ...prev, [groupId]: false }))
      return
    }
    setExpandLoadingId(groupId)
    setError('')
    try {
      const { data } = await adminApi.getUserGroupMembers(groupId)
      setCardMembers((prev) => ({ ...prev, [groupId]: data || [] }))
      setExpanded((prev) => ({ ...prev, [groupId]: true }))
    } catch (err) {
      setError(resolveError(err, t('admin_groups_failed_load_members')))
    } finally {
      setExpandLoadingId(null)
    }
  }

  // Create group modal
  const resetModal = () => {
    if (saving) return
    setModal(false)
    setFormName('')
    setFormDesc('')
    setModalError('')
  }

  const handleCreate = async () => {
    const trimmedName = formName.trim()
    if (!trimmedName) {
      setModalError(t('admin_groups_name_required'))
      return
    }
    setSaving(true)
    setModalError('')
    setNotice('')
    try {
      await adminApi.createUserGroup({ name: trimmedName, description: formDesc.trim() || null })
      setNotice(t('admin_groups_group_created'))
      resetModal()
      await load()
    } catch (err) {
      setModalError(resolveError(err, t('admin_groups_failed_create')))
    } finally {
      setSaving(false)
    }
  }

  // Delete group
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
      await adminApi.deleteUserGroup(id)
      setNotice(t('admin_groups_group_deleted'))
      setExpanded((prev) => ({ ...prev, [id]: false }))
      await load()
    } catch (err) {
      setError(resolveError(err, t('admin_groups_failed_delete')))
    } finally {
      setDeleteBusyId(null)
    }
  }

  // Add member
  const handleAddMember = async (groupId) => {
    const userId = addUserId[groupId]
    if (!userId) return
    setAddingMemberId(groupId)
    setError('')
    setNotice('')
    try {
      await adminApi.addUserGroupMember(groupId, userId)
      setAddUserId((prev) => ({ ...prev, [groupId]: '' }))
      setNotice(t('admin_groups_member_added'))
      const { data } = await adminApi.getUserGroupMembers(groupId)
      setCardMembers((prev) => ({ ...prev, [groupId]: data || [] }))
      await load()
    } catch (err) {
      setError(resolveError(err, t('admin_groups_failed_add_member')))
    } finally {
      setAddingMemberId(null)
    }
  }

  // Remove member
  const handleRemoveMember = async (groupId, userId) => {
    setRemovingMemberId(userId)
    setError('')
    setNotice('')
    try {
      await adminApi.removeUserGroupMember(groupId, userId)
      setNotice(t('admin_groups_member_removed'))
      const { data } = await adminApi.getUserGroupMembers(groupId)
      setCardMembers((prev) => ({ ...prev, [groupId]: data || [] }))
      await load()
    } catch (err) {
      setError(resolveError(err, t('admin_groups_failed_remove_member')))
    } finally {
      setRemovingMemberId(null)
    }
  }

  // Bulk assign
  const getBulk = (groupId) => bulkState[groupId] || { testId: '', scheduledAt: '', accessMode: 'OPEN', busy: false, notice: '' }
  const setBulk = (groupId, patch) => setBulkState((prev) => ({ ...prev, [groupId]: { ...getBulk(groupId), ...patch } }))

  const handleBulkAssign = async (event, groupId) => {
    event.preventDefault()
    const bulk = getBulk(groupId)
    const members = cardMembers[groupId] || []
    if (!bulk.testId || !bulk.scheduledAt || members.length === 0) {
      setError(t('admin_groups_bulk_assign_required'))
      return
    }
    setBulk(groupId, { busy: true, notice: '' })
    setError('')
    let created = 0
    let updated = 0
    try {
      for (const member of members) {
        const existing = allSchedules.find((s) => String(s.exam_id) === String(bulk.testId) && String(s.user_id) === String(member.id))
        const payload = { scheduled_at: new Date(bulk.scheduledAt).toISOString(), access_mode: bulk.accessMode }
        if (existing) {
          await adminApi.updateSchedule(existing.id, payload)
          updated += 1
        } else {
          await adminApi.createSchedule({ exam_id: bulk.testId, user_id: member.id, ...payload })
          created += 1
        }
      }
      const { data } = await adminApi.schedules()
      setAllSchedules(data || [])
      setBulk(groupId, { busy: false, notice: `Done: ${created} created, ${updated} updated for ${members.length} member${members.length === 1 ? '' : 's'}.` })
    } catch (err) {
      setError(resolveError(err, t('admin_groups_bulk_assign_failed')))
      setBulk(groupId, { busy: false })
    }
  }

  // Non-members for a given group
  const getNonMembers = (groupId) => {
    const members = cardMembers[groupId] || []
    return users.filter((u) => !members.find((m) => m.id === u.id || m.user_id === u.user_id))
  }

  return (
    <div className={styles.page}>
      <AdminPageHeader title={t('admin_groups_title')} subtitle={t('admin_groups_subtitle')}>
        <button type="button" className={styles.btnPrimary} onClick={() => { setModal(true); setModalError('') }}>
          {t('admin_groups_new_group')}
        </button>
      </AdminPageHeader>

      {notice && <div className={styles.noticeBanner}>{notice}</div>}
      {error && (
        <div className={styles.helperRow}>
          <div className={styles.errorBanner}>{error}</div>
          <button type="button" className={styles.actionBtn} onClick={() => void load()}>{t('admin_groups_retry')}</button>
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
            placeholder={t('admin_groups_search_placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className={styles.sortBtn}
            onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
          >
            {sortDir === 'asc' ? t('sort_name_az') : t('sort_name_za')}
          </button>
          <div className={styles.toolbarActions}>
            <button type="button" className={styles.actionBtn} onClick={() => void load()} disabled={loading}>{t('refresh')}</button>
            <button type="button" className={styles.actionBtn} onClick={clearFilters} disabled={!hasActiveFilters}>{t('clear_filters')}</button>
          </div>
        </div>
        <div className={styles.filterMeta}>
          {t('admin_groups_showing_count', { filtered: filtered.length, total: groups.length })}
        </div>
      </div>

      {loading ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_groups_loading')}</div>
          <div className={styles.emptyText}>{t('admin_groups_loading_sub')}</div>
        </div>
      ) : filtered.length === 0 && hasActiveFilters ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_groups_no_match')}</div>
          <div className={styles.emptyText}>{t('admin_groups_no_match_hint')}</div>
          <button type="button" className={styles.actionBtn} onClick={clearFilters}>{t('clear_filters')}</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_groups_no_groups')}</div>
          <div className={styles.emptyText}>{t('admin_groups_no_groups_hint')}</div>
        </div>
      ) : (
        <div className={styles.grid}>
          {filtered.map((group) => {
            const groupLabel = group.name || t('admin_groups_this_group')
            const members = cardMembers[group.id] || []
            const nonMembers = getNonMembers(group.id)
            const bulk = getBulk(group.id)

            return (
              <div key={group.id} className={styles.card} data-user-group-name={group.name || ''}>
                <div className={styles.cardHeader}>
                  <div>
                    <span className={styles.cardTitle}>{group.name}</span>
                    {group.member_count != null && (
                      <span className={styles.memberCountBadge}>{group.member_count} {t('admin_groups_members_label')}</span>
                    )}
                  </div>
                  <div className={styles.actionBtns}>
                    {deleteConfirmId === group.id ? (
                      <>
                        <button type="button" className={styles.actionBtnDanger} onClick={() => void handleDelete(group.id)} disabled={deleteBusyId === group.id} aria-label={`${t('confirm_delete')} ${groupLabel}`}>
                          {deleteBusyId === group.id ? t('admin_groups_deleting') : t('admin_groups_confirm')}
                        </button>
                        <button type="button" className={styles.actionBtn} onClick={() => setDeleteConfirmId(null)} disabled={deleteBusyId === group.id} aria-label={`${t('admin_groups_keep')} ${groupLabel}`}>
                          {t('admin_groups_cancel')}
                        </button>
                      </>
                    ) : (
                      <button type="button" className={styles.actionBtn} onClick={() => void handleDelete(group.id)} disabled={deleteBusyId === group.id} aria-label={`${t('delete')} ${groupLabel}`} title={`${t('delete')} ${groupLabel}`}>
                        {t('admin_groups_delete')}
                      </button>
                    )}
                  </div>
                </div>
                <div className={group.description ? styles.cardMeta : styles.cardMetaMuted}>
                  {group.description || t('admin_groups_no_description')}
                </div>

                {expanded[group.id] && (
                  <div className={styles.memberSection}>
                    {/* Add member */}
                    {usersReady && nonMembers.length > 0 && (
                      <div className={styles.addMemberRow}>
                        <select
                          className={styles.select}
                          value={addUserId[group.id] || ''}
                          onChange={(e) => setAddUserId((prev) => ({ ...prev, [group.id]: e.target.value }))}
                        >
                          <option value="">{t('admin_groups_select_learner')}</option>
                          {nonMembers.map((u) => (
                            <option key={u.id} value={u.id}>{u.name || u.user_id} ({u.email})</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={styles.btnSmPrimary}
                          onClick={() => void handleAddMember(group.id)}
                          disabled={addingMemberId === group.id || !addUserId[group.id]}
                        >
                          {addingMemberId === group.id ? t('admin_groups_adding') : t('admin_groups_add')}
                        </button>
                      </div>
                    )}

                    {/* Members list */}
                    {members.length === 0 ? (
                      <div className={styles.memberEmpty}>{t('admin_groups_no_members')}</div>
                    ) : (
                      members.map((member) => (
                        <div key={member.id} className={styles.memberRow}>
                          <div>
                            <div className={styles.memberName}>{member.name || member.user_id}</div>
                            <div className={styles.memberEmail}>{member.email}</div>
                          </div>
                          <button
                            type="button"
                            className={styles.actionBtnDanger}
                            onClick={() => void handleRemoveMember(group.id, member.id)}
                            disabled={removingMemberId === member.id}
                          >
                            {removingMemberId === member.id ? t('admin_groups_removing') : t('admin_groups_remove')}
                          </button>
                        </div>
                      ))
                    )}

                    {/* Bulk assign */}
                    {members.length > 0 && testsReady && schedulesReady && (
                      <div className={styles.bulkSection}>
                        <div className={styles.bulkTitle}>{t('admin_groups_bulk_assignment')}</div>
                        <div className={styles.bulkDesc}>{t('admin_groups_bulk_assignment_description')}</div>
                        {bulk.notice && <div className={styles.bulkNotice}>{bulk.notice}</div>}
                        <form className={styles.bulkForm} onSubmit={(e) => void handleBulkAssign(e, group.id)}>
                          <div className={styles.bulkFormRow}>
                            <label className={styles.bulkLabel}>{t('admin_groups_test_label')}</label>
                            <select className={styles.select} value={bulk.testId} onChange={(e) => setBulk(group.id, { testId: e.target.value })} required>
                              <option value="">{t('admin_groups_select_test')}</option>
                              {allTests.map((test) => (
                                <option key={test.id} value={test.id}>{test.title || test.name} ({test.status || '-'})</option>
                              ))}
                            </select>
                          </div>
                          <div className={styles.bulkFormRow}>
                            <label className={styles.bulkLabel}>{t('admin_groups_scheduled_datetime')}</label>
                            <input type="datetime-local" className={styles.bulkInput} value={bulk.scheduledAt} onChange={(e) => setBulk(group.id, { scheduledAt: e.target.value })} required />
                          </div>
                          <div className={styles.bulkFormRow}>
                            <label className={styles.bulkLabel}>{t('admin_groups_access_mode')}</label>
                            <select className={styles.select} value={bulk.accessMode} onChange={(e) => setBulk(group.id, { accessMode: e.target.value })}>
                              <option value="OPEN">OPEN</option>
                              <option value="RESTRICTED">RESTRICTED</option>
                            </select>
                          </div>
                          <button className={styles.btnSmPrimary} type="submit" disabled={bulk.busy || !bulk.testId || !bulk.scheduledAt}>
                            {bulk.busy ? t('admin_groups_assigning') : t('admin_groups_assign_all_members')}
                          </button>
                        </form>
                      </div>
                    )}
                  </div>
                )}

                <button type="button" className={styles.expandBtn} onClick={() => void toggleExpand(group.id)} disabled={expandLoadingId === group.id}>
                  {expandLoadingId === group.id ? t('admin_groups_loading_members') : expanded[group.id] ? t('admin_groups_hide_members') : t('admin_groups_show_members')}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Create Group Modal */}
      {modal && (
        <div className={styles.modalOverlay} onClick={resetModal}>
          <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="group-dialog-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="group-dialog-title" className={styles.modalTitle}>{t('admin_groups_new_group')}</h3>
            {modalError && <div className={styles.modalError}>{modalError}</div>}
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="group-name">{t('admin_groups_name_label')}</label>
              <input id="group-name" className={styles.input} value={formName} onChange={(e) => setFormName(e.target.value)} />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="group-desc">{t('admin_groups_description_label')}</label>
              <textarea id="group-desc" className={styles.textarea} value={formDesc} onChange={(e) => setFormDesc(e.target.value)} rows={3} />
            </div>
            <div className={styles.modalActions}>
              <button type="button" className={styles.btnCancel} onClick={resetModal} disabled={saving}>{t('admin_groups_cancel')}</button>
              <button type="button" className={styles.btnPrimary} onClick={() => void handleCreate()} disabled={saving || !formName.trim()}>
                {saving ? t('admin_groups_saving') : t('admin_groups_save_group')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
