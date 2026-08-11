import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminApi } from '../../../services/admin.service'
import { normalizeAdminTest } from '../../../utils/assessmentAdapters'
import AdminPageHeader from '../AdminPageHeader/AdminPageHeader'
import useAuth from '../../../hooks/useAuth'
import useLanguage from '../../../hooks/useLanguage'
import styles from './AdminCourses.module.scss'

const COURSE_STATUS_KEYS = [
  { value: 'DRAFT', labelKey: 'draft' },
  { value: 'PUBLISHED', labelKey: 'published' },
]

function resolveError(err, fallback) {
  if (err?.userMessage) return err.userMessage
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string') return detail
  return fallback
}

export default function AdminCourses() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { t } = useLanguage()
  const isAdmin = user?.role === 'ADMIN'
  const currentUserId = String(user?.id || '')

  const [courses, setCourses] = useState([])
  const [nodes, setNodes] = useState({})
  const [allTests, setAllTests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [warning, setWarning] = useState('')

  // Modal state
  const [modal, setModal] = useState(false)
  const [form, setForm] = useState({ title: '', description: '', status: 'DRAFT' })
  const [modalError, setModalError] = useState('')
  const [saving, setSaving] = useState(false)

  // Inline edit state
  const [editingCourse, setEditingCourse] = useState(null)
  const [savingCourseId, setSavingCourseId] = useState(null)

  // Module state
  const [nodeTitles, setNodeTitles] = useState({})
  const [editingNode, setEditingNode] = useState(null)
  const [editNodeTitle, setEditNodeTitle] = useState('')
  const [busyNodeId, setBusyNodeId] = useState(null)
  const [deleteNodeConfirmId, setDeleteNodeConfirmId] = useState(null)

  // Delete confirm
  const [deleteCourseConfirmId, setDeleteCourseConfirmId] = useState(null)

  // Expanded course tests
  const [expandedCourse, setExpandedCourse] = useState(null)

  // Toolbar
  const [search, setSearch] = useState('')
  const [sortDir, setSortDir] = useState('asc')

  const load = async () => {
    setLoading(true)
    setError('')
    setWarning('')
    try {
      const [coursesRes, testsRes, nodesRes] = await Promise.allSettled([
        adminApi.courses(),
        adminApi.allTests({ page_size: 200 }),
        adminApi.nodes(),
      ])
      if (coursesRes.status !== 'fulfilled') {
        setCourses([])
        setNodes({})
        setAllTests([])
        setError(resolveError(coursesRes.reason, t('admin_courses_load_error')))
        return
      }

      const courseList = coursesRes.value.data || []
      setCourses(courseList)
      if (testsRes.status === 'fulfilled') {
        const testRows = testsRes.value.data?.items || []
        setAllTests(testRows.map(normalizeAdminTest))
      } else {
        setAllTests([])
        setWarning(t('admin_courses_tests_warning'))
      }

      const nodeMap = Object.fromEntries(courseList.map((course) => [course.id, []]))
      if (nodesRes.status === 'fulfilled') {
        for (const node of nodesRes.value.data || []) {
          const courseId = String(node.course_id || '')
          if (!courseId) continue
          if (!nodeMap[courseId]) nodeMap[courseId] = []
          nodeMap[courseId].push(node)
        }
      } else {
        setWarning((current) => (
          current
            ? `${current} ${t('admin_courses_modules_warning')}`
            : t('admin_courses_modules_warning')
        ))
      }

      Object.values(nodeMap).forEach((rows) => {
        rows.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
      })
      setNodes(nodeMap)
    } catch (err) {
      setCourses([])
      setNodes({})
      setAllTests([])
      setError(resolveError(err, t('admin_courses_load_error')))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [isAdmin])

  const canManageCourse = (course) => isAdmin || String(course?.created_by_id || '') === currentUserId

  const getTestsForCourse = (courseId) => {
    const courseNodeIds = new Set((nodes[courseId] || []).map((node) => String(node.id)))
    return allTests.filter((test) => courseNodeIds.has(String(test.node_id)))
  }

  // Filtering and sorting
  const normalizedSearch = search.trim().toLowerCase()
  const filtered = [...courses]
    .filter((course) => !normalizedSearch
      || course.title.toLowerCase().includes(normalizedSearch)
      || (course.description || '').toLowerCase().includes(normalizedSearch))
    .sort((left, right) => (sortDir === 'asc'
      ? left.title.localeCompare(right.title)
      : right.title.localeCompare(left.title)))
  const hasActiveFilters = Boolean(normalizedSearch) || sortDir !== 'asc'

  // Summary card data
  const publishedCount = courses.filter((c) => c.status === 'PUBLISHED').length
  const draftCount = courses.filter((c) => c.status === 'DRAFT').length
  const summaryCards = [
    {
      label: t('admin_courses_total'),
      value: courses.length,
      helper: t('admin_courses_total_helper'),
    },
    {
      label: t('admin_courses_visible_now'),
      value: filtered.length,
      helper: hasActiveFilters ? t('admin_courses_visible_now_filtered') : t('admin_courses_visible_now_all'),
    },
    {
      label: t('admin_courses_summary_published'),
      value: publishedCount,
      helper: t('admin_courses_summary_published_helper'),
    },
    {
      label: t('admin_courses_summary_draft'),
      value: draftCount,
      helper: t('admin_courses_summary_draft_helper'),
    },
  ]

  const clearFilters = () => {
    setSearch('')
    setSortDir('asc')
  }

  // Modal helpers
  const resetModal = () => {
    if (saving) return
    setModal(false)
    setForm({ title: '', description: '', status: 'DRAFT' })
    setModalError('')
  }

  const handleCreate = async () => {
    const trimmedTitle = form.title.trim()
    if (!trimmedTitle) {
      setModalError(t('admin_courses_title_required'))
      return
    }
    setSaving(true)
    setModalError('')
    setNotice('')
    try {
      await adminApi.createCourse({
        title: trimmedTitle,
        description: form.description.trim() || null,
        status: form.status,
      })
      setNotice(t('admin_courses_created'))
      resetModal()
      await load()
    } catch (err) {
      setModalError(resolveError(err, t('admin_courses_create_error')))
    } finally {
      setSaving(false)
    }
  }

  const saveCourseEdit = async (event) => {
    event.preventDefault()
    if (!editingCourse?.title?.trim()) {
      setError(t('admin_courses_title_required'))
      return
    }
    setSavingCourseId(editingCourse.id)
    setError('')
    setNotice('')
    try {
      await adminApi.updateCourse(editingCourse.id, {
        title: editingCourse.title.trim(),
        description: editingCourse.description?.trim() || null,
        status: editingCourse.status,
      })
      setEditingCourse(null)
      setNotice(t('admin_courses_updated'))
      await load()
    } catch (err) {
      setError(resolveError(err, t('admin_courses_update_error')))
    } finally {
      setSavingCourseId(null)
    }
  }

  const toggleCourseStatus = async (course) => {
    setSavingCourseId(course.id)
    setError('')
    setNotice('')
    try {
      await adminApi.updateCourse(course.id, {
        title: course.title,
        description: course.description,
        status: course.status === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED',
      })
      setNotice(course.status === 'PUBLISHED' ? t('admin_courses_moved_draft') : t('admin_courses_published'))
      await load()
    } catch (err) {
      setError(resolveError(err, t('admin_courses_status_error')))
    } finally {
      setSavingCourseId(null)
    }
  }

  const deleteCourse = async (id) => {
    if (deleteCourseConfirmId !== id) {
      setDeleteCourseConfirmId(id)
      return
    }
    setDeleteCourseConfirmId(null)
    setSavingCourseId(id)
    setError('')
    setNotice('')
    try {
      await adminApi.deleteCourse(id)
      setNotice(t('admin_courses_deleted'))
      await load()
    } catch (err) {
      setError(resolveError(err, t('admin_courses_delete_error')))
    } finally {
      setSavingCourseId(null)
    }
  }

  const addNode = async (courseId) => {
    const nodeTitle = String(nodeTitles[courseId] || '').trim()
    if (!nodeTitle) {
      setError(t('admin_courses_module_title_required'))
      return
    }
    setBusyNodeId(courseId)
    setError('')
    setNotice('')
    try {
      await adminApi.createNode({ course_id: courseId, title: nodeTitle, order: (nodes[courseId]?.length || 0) + 1 })
      setNodeTitles((prev) => ({ ...prev, [courseId]: '' }))
      setNotice(t('admin_courses_module_added'))
      await load()
    } catch (err) {
      setError(resolveError(err, t('admin_courses_add_module_error')))
    } finally {
      setBusyNodeId(null)
    }
  }

  const saveNodeEdit = async (node) => {
    if (!editNodeTitle.trim()) {
      setError(t('admin_courses_module_title_required'))
      return
    }
    setBusyNodeId(node.id)
    setError('')
    setNotice('')
    try {
      await adminApi.updateNode(node.id, { title: editNodeTitle.trim(), order: node.order })
      setEditingNode(null)
      setNotice(t('admin_courses_module_updated'))
      await load()
    } catch (err) {
      setError(resolveError(err, t('admin_courses_update_module_error')))
    } finally {
      setBusyNodeId(null)
    }
  }

  const deleteNode = async (nodeId) => {
    if (deleteNodeConfirmId !== nodeId) {
      setDeleteNodeConfirmId(nodeId)
      return
    }
    setDeleteNodeConfirmId(null)
    setBusyNodeId(nodeId)
    setError('')
    setNotice('')
    try {
      await adminApi.deleteNode(nodeId)
      setNotice(t('admin_courses_module_deleted'))
      await load()
    } catch (err) {
      setError(resolveError(err, t('admin_courses_delete_module_error')))
    } finally {
      setBusyNodeId(null)
    }
  }

  return (
    <div className={styles.page}>
      <AdminPageHeader title={t('admin_courses_title')} subtitle={t('admin_courses_subtitle')}>
        <button
          type="button"
          className={styles.btnPrimary}
          onClick={() => {
            setModal(true)
            setModalError('')
          }}
        >
          {t('admin_courses_new_course')}
        </button>
      </AdminPageHeader>

      {notice && <div className={styles.noticeBanner}>{notice}</div>}
      {warning && <div className={styles.warningBanner}>{warning}</div>}
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
            placeholder={t('admin_courses_search_placeholder')}
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
          {t('admin_courses_showing_count', { filtered: filtered.length, total: courses.length })}
        </div>
      </div>

      {loading ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_courses_loading')}</div>
          <div className={styles.emptyText}>{t('admin_courses_loading_sub')}</div>
        </div>
      ) : filtered.length === 0 && hasActiveFilters ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_courses_no_match')}</div>
          <div className={styles.emptyText}>{t('admin_courses_no_match_hint')}</div>
          <button type="button" className={styles.actionBtn} onClick={clearFilters}>{t('clear_filters')}</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>{t('admin_courses_empty')}</div>
          <div className={styles.emptyText}>{t('admin_courses_empty_hint')}</div>
        </div>
      ) : (
        <div className={styles.grid}>
          {filtered.map((course) => {
            const courseLabel = course.title || t('admin_courses_this_course')
            const moduleCount = (nodes[course.id] || []).length

            return (
              <div key={course.id} className={styles.card} data-course-title={course.title || ''}>
                {!canManageCourse(course) && (
                  <div className={styles.readOnlyNote}>{t('admin_courses_read_only')}</div>
                )}

                {editingCourse?.id === course.id ? (
                  <form onSubmit={saveCourseEdit} className={styles.editForm}>
                    <input className={styles.input} value={editingCourse.title} onChange={(event) => setEditingCourse((current) => ({ ...current, title: event.target.value }))} required />
                    <textarea className={styles.input} rows={2} value={editingCourse.description || ''} onChange={(event) => setEditingCourse((current) => ({ ...current, description: event.target.value }))} />
                    <select className={styles.input} value={editingCourse.status || 'DRAFT'} onChange={(event) => setEditingCourse((current) => ({ ...current, status: event.target.value }))}>
                      {COURSE_STATUS_KEYS.map((statusOption) => (
                        <option key={statusOption.value} value={statusOption.value}>{t(statusOption.labelKey)}</option>
                      ))}
                    </select>
                    <div className={styles.modalActions}>
                      <button className={styles.btnCancel} type="button" onClick={() => setEditingCourse(null)} disabled={savingCourseId === course.id}>{t('cancel')}</button>
                      <button className={styles.btnPrimary} type="submit" disabled={savingCourseId === course.id}>{savingCourseId === course.id ? t('saving') : t('save')}</button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className={styles.cardHeader}>
                      <div>
                        <span className={styles.cardTitle}>{course.title}</span>
                        <span className={course.status === 'PUBLISHED' ? styles.statusBadgePublished : styles.statusBadgeDraft}>
                          {course.status === 'PUBLISHED' ? t('published') : t('draft')}
                        </span>
                      </div>
                      <div className={styles.actionBtns}>
                        {canManageCourse(course) && (
                          <>
                            <button type="button" className={styles.actionBtn} onClick={() => void toggleCourseStatus(course)} disabled={savingCourseId === course.id} aria-label={`${course.status === 'PUBLISHED' ? t('admin_courses_unpublish') : t('admin_courses_publish')} ${courseLabel}`} title={`${course.status === 'PUBLISHED' ? t('admin_courses_unpublish') : t('admin_courses_publish')} ${courseLabel}`}>
                              {savingCourseId === course.id ? t('saving') : course.status === 'PUBLISHED' ? t('admin_courses_unpublish') : t('admin_courses_publish')}
                            </button>
                            <button type="button" className={styles.actionBtn} onClick={() => setEditingCourse({ ...course })} disabled={savingCourseId === course.id} aria-label={`${t('edit')} ${courseLabel}`} title={`${t('edit')} ${courseLabel}`}>{t('edit')}</button>
                          </>
                        )}
                        {canManageCourse(course) && (
                          deleteCourseConfirmId === course.id ? (
                            <>
                              <button type="button" className={styles.actionBtnDanger} onClick={() => void deleteCourse(course.id)} disabled={savingCourseId === course.id} aria-label={`${t('confirm_delete')} ${courseLabel}`}>
                                {savingCourseId === course.id ? t('admin_courses_deleting') : t('confirm')}
                              </button>
                              <button type="button" className={styles.actionBtn} onClick={() => setDeleteCourseConfirmId(null)} disabled={savingCourseId === course.id} aria-label={`${t('cancel_delete')} ${courseLabel}`}>
                                {t('cancel')}
                              </button>
                            </>
                          ) : (
                            <button type="button" className={styles.actionBtn} onClick={() => void deleteCourse(course.id)} disabled={savingCourseId === course.id} aria-label={`${t('delete')} ${courseLabel}`} title={`${t('delete')} ${courseLabel}`}>
                              {t('delete')}
                            </button>
                          )
                        )}
                      </div>
                    </div>

                    <div className={course.description ? styles.cardMeta : styles.cardMetaMuted}>
                      {course.description || t('admin_courses_no_description')}
                    </div>

                    {moduleCount > 0 && (
                      <div className={styles.moduleCountBadge}>
                        {moduleCount} {moduleCount === 1 ? t('admin_courses_module_singular') : t('admin_courses_module_plural')}
                      </div>
                    )}
                  </>
                )}

                {/* Modules section */}
                <div className={styles.modules}>
                  {(nodes[course.id] || []).map((node) => (
                    <div key={node.id} className={styles.moduleRow}>
                      {editingNode === node.id ? (
                        <>
                          <input className={styles.input} value={editNodeTitle} onChange={(event) => setEditNodeTitle(event.target.value)} autoFocus />
                          <button type="button" className={styles.actionBtn} onClick={() => void saveNodeEdit(node)} disabled={busyNodeId === node.id} aria-label={`${t('save')} ${node.title || t('admin_courses_this_module')} ${courseLabel}`}>{busyNodeId === node.id ? t('saving') : t('save')}</button>
                          <button type="button" className={styles.actionBtn} onClick={() => setEditingNode(null)} disabled={busyNodeId === node.id} aria-label={`${t('cancel')} ${node.title || t('admin_courses_this_module')} ${courseLabel}`}>{t('cancel')}</button>
                        </>
                      ) : (
                        <>
                          <span className={styles.moduleChip}>{node.title}</span>
                          {canManageCourse(course) && (
                            <>
                              <button type="button" className={styles.actionBtn} onClick={() => { setEditingNode(node.id); setEditNodeTitle(node.title) }} disabled={busyNodeId === node.id} aria-label={`${t('edit')} ${node.title || t('admin_courses_this_module')} ${courseLabel}`} title={`${t('edit')} ${node.title || t('admin_courses_this_module')} ${courseLabel}`}>{t('edit')}</button>
                              {deleteNodeConfirmId === node.id ? (
                                <>
                                  <button type="button" className={styles.actionBtnDanger} onClick={() => void deleteNode(node.id)} disabled={busyNodeId === node.id} aria-label={`${t('confirm_delete')} ${node.title || t('admin_courses_this_module')} ${courseLabel}`}>{busyNodeId === node.id ? t('admin_courses_deleting') : t('confirm')}</button>
                                  <button type="button" className={styles.actionBtn} onClick={() => setDeleteNodeConfirmId(null)} disabled={busyNodeId === node.id} aria-label={`${t('cancel_delete')} ${node.title || t('admin_courses_this_module')} ${courseLabel}`}>{t('cancel')}</button>
                                </>
                              ) : (
                                <button type="button" className={styles.actionBtnDanger} onClick={() => void deleteNode(node.id)} disabled={busyNodeId === node.id} aria-label={`${t('delete')} ${node.title || t('admin_courses_this_module')} ${courseLabel}`} title={`${t('delete')} ${node.title || t('admin_courses_this_module')} ${courseLabel}`}>{t('delete')}</button>
                              )}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                  {canManageCourse(course) && (
                    <div className={styles.addModule}>
                      <input
                        className={styles.input}
                        placeholder={t('admin_courses_new_module_title')}
                        value={nodeTitles[course.id] || ''}
                        onChange={(event) => setNodeTitles((prev) => ({ ...prev, [course.id]: event.target.value }))}
                      />
                      <button type="button" className={styles.actionBtn} onClick={() => void addNode(course.id)} disabled={busyNodeId === course.id}>{busyNodeId === course.id ? t('admin_courses_adding') : t('add')}</button>
                    </div>
                  )}
                </div>

                {/* Linked tests toggle */}
                <div className={styles.courseExams}>
                  <button
                    type="button"
                    className={styles.expandBtn}
                    onClick={() => setExpandedCourse(expandedCourse === course.id ? null : course.id)}
                  >
                    {expandedCourse === course.id ? t('admin_courses_hide') : t('admin_courses_show')} {t('admin_courses_linked_tests')} ({getTestsForCourse(course.id).length})
                  </button>
                  {expandedCourse === course.id && (
                    <div className={styles.examsTable}>
                      {getTestsForCourse(course.id).length === 0 ? (
                        <div className={styles.questionEmpty}>{t('admin_courses_no_linked_tests')}</div>
                      ) : (
                        getTestsForCourse(course.id).map((test) => (
                          <div key={test.id} className={styles.testItem}>
                            <span className={styles.testTitle}>{test.title}</span>
                            <span className={styles.testMeta}>{test.status || '-'}</span>
                            <span className={styles.testMeta}>{test.type || '-'}</span>
                            {isAdmin && (
                              <button type="button" className={styles.actionBtn} onClick={() => navigate(`/admin/tests/${test.id}/manage`)} aria-label={`${t('admin_courses_manage_test')} ${test.title || t('admin_courses_test')} ${t('admin_courses_from_course')} ${courseLabel}`} title={`${t('admin_courses_manage_test')} ${test.title || t('admin_courses_test')} ${t('admin_courses_from_course')} ${courseLabel}`}>{t('admin_courses_manage_test')}</button>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Create course modal */}
      {modal && (
        <div className={styles.modalOverlay} onClick={resetModal}>
          <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="course-dialog-title" onClick={(event) => event.stopPropagation()}>
            <h3 id="course-dialog-title" className={styles.modalTitle}>{t('admin_courses_new_course_title')}</h3>
            {modalError && <div className={styles.modalError}>{modalError}</div>}
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="course-title">{t('title')}</label>
              <input id="course-title" className={styles.input} value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="course-description">{t('description')}</label>
              <textarea id="course-description" className={styles.input} rows={3} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="course-status">{t('status')}</label>
              <select id="course-status" className={styles.input} value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value }))}>
                {COURSE_STATUS_KEYS.map((statusOption) => (
                  <option key={statusOption.value} value={statusOption.value}>{t(statusOption.labelKey)}</option>
                ))}
              </select>
            </div>
            <div className={styles.modalActions}>
              <button type="button" className={styles.btnCancel} onClick={resetModal} disabled={saving}>{t('cancel')}</button>
              <button type="button" className={styles.btnPrimary} onClick={() => void handleCreate()} disabled={saving || !form.title.trim()}>
                {saving ? t('admin_courses_creating') : t('admin_courses_save_course')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
