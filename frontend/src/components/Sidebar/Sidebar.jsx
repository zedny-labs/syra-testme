import React, { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import useAuth from '../../hooks/useAuth'
import useLanguage from '../../hooks/useLanguage'
import styles from './Sidebar.module.scss'

const Icon = ({ d, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)

const ICONS = {
  home:        'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 22V12h6v10',
  exams:       'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2 M9 5a2 2 0 002 2h2a2 2 0 002-2 M9 5a2 2 0 012-2h2a2 2 0 012 2',
  attempts:    'M9 11l3 3L22 4 M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
  schedule:    'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  profile:     'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2 M12 3a4 4 0 110 8 4 4 0 010-8z',
  dashboard:   'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z',
  newTest:     'M12 5v14 M5 12h14',
  manageTests: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
  templates:   'M4 4h16v16H4z M4 9h16 M9 9v11',
  pools:       'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z',
  grading:     'M18 20V10 M12 20V4 M6 20v-6',
  categories:  'M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z M7 7h.01',
  certificates:'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  sessions:    'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75 M9 7a4 4 0 110 8 4 4 0 010-8z',
  candidates:  'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 3a4 4 0 110 8 4 4 0 010-8z M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75',
  users:       'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M9 3a4 4 0 110 8 4 4 0 010-8z',
  groups:      'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2 M23 21v-2a4 4 0 00-3-3.87 M16 3.13a4 4 0 010 7.75 M9 3a4 4 0 110 8 4 4 0 010-8z',
  roles:       'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  analysis:    'M2 20h.01 M7 20v-4 M12 20V10 M17 20V4 M22 20v-8',
  reports:     'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z M14 2v6h6 M12 18v-6 M9 15h6',
  settings:    'M12 15a3 3 0 110-6 3 3 0 010 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z',
  chevron:     'M6 9l6 6 6-6',
  auditLog:    'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2 M9 5a2 2 0 002 2h2a2 2 0 002-2 M9 12h6 M9 16h4',
}

function normalizePath(path) {
  if (!path || path === '/') return path || '/'
  return path.endsWith('/') ? path.slice(0, -1) : path
}

function pathMatches(currentPath, targetPath) {
  const current = normalizePath(currentPath)
  const target = normalizePath(targetPath)
  if (target === '/') return current === '/'
  return current === target || current.startsWith(`${target}/`)
}

function NavLink({ to, icon, label, active, onNavigate, collapsed = false }) {
  return (
    <Link
      to={to}
      className={`${styles.link} ${active ? styles.active : ''} ${collapsed ? styles.linkCollapsed : ''}`}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
    >
      <span className={styles.linkIcon}><Icon d={ICONS[icon] || ICONS.home} /></span>
      <span className={styles.linkLabel}>{label}</span>
    </Link>
  )
}

function Section({ label, children, defaultOpen = false, forceOpen = false, collapsed = false, t }) {
  const [open, setOpen] = useState(defaultOpen || forceOpen)

  useEffect(() => {
    if (forceOpen) {
      setOpen(true)
    }
  }, [forceOpen])

  return (
    <div className={styles.section}>
      {!collapsed && (
        <button
          type="button"
          className={styles.sectionHeader}
          aria-expanded={open}
          aria-label={`${open ? t('sidebar_section_collapse') : t('sidebar_section_expand')} ${label}`}
          onClick={() => setOpen(o => !o)}
        >
          <span className={styles.sectionLabel}>{label}</span>
          <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}>
            <Icon d={ICONS.chevron} size={14} />
          </span>
        </button>
      )}
      {collapsed ? (
        <div className={styles.sectionItems}>{children}</div>
      ) : (
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="items"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className={styles.sectionItems}
            >
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  )
}

export default function Sidebar({ collapsed = false, mobileOpen = false, onClose, onToggleCollapse }) {
  const { user, hasPermission } = useAuth()
  const { t } = useLanguage()
  const location = useLocation()
  const role = user?.role
  const isAdmin = role === 'ADMIN'
  const isInstructor = role === 'INSTRUCTOR'
  const isLearner = role === 'LEARNER'
  const isSuperAdmin = role === 'ADMIN'
  const dashboardPath = isAdmin ? '/admin/dashboard' : '/'
  const canViewDashboard = hasPermission?.('View Dashboard')
  const canTakeTests = hasPermission?.('Take Tests')
  const canViewOwnAttempts = hasPermission?.('View Own Attempts')
  const canViewOwnSchedule = hasPermission?.('View Own Schedule')
  const canCreateTests = isAdmin && hasPermission?.('Create Tests')
  const canManageTests = isAdmin && hasPermission?.('Edit Tests')
  const canEditSupportingTests = (isAdmin || isInstructor) && hasPermission?.('Edit Tests')
  const canManageCategories = (isAdmin || isInstructor) && hasPermission?.('Manage Categories')
  const canManageGradingScales = (isAdmin || isInstructor) && hasPermission?.('Manage Grading Scales')
  const canManageQuestionPools = (isAdmin || isInstructor) && hasPermission?.('Manage Question Pools')
  const canAssignSchedules = (isAdmin || isInstructor) && hasPermission?.('Assign Schedules')
  const canViewAttemptAnalysis = hasPermission?.('View Attempt Analysis')
  const canManageUsers = (isAdmin || isInstructor) && hasPermission?.('Manage Users')
  const canManageRoles = isSuperAdmin && hasPermission?.('Manage Roles')
  const canGenerateReports = isAdmin && hasPermission?.('Generate Reports')
  const canSystemSettings = isAdmin && hasPermission?.('System Settings')

  useEffect(() => {
    if (mobileOpen && onClose) onClose()
  }, [location.pathname])

  useEffect(() => {
    if (!mobileOpen || !onClose) return undefined
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [mobileOpen, onClose])

  function isActive(path) {
    return pathMatches(location.pathname, path)
  }

  const handleNavigate = onClose ? () => onClose() : undefined
  const learningActive = ['/tests', '/exams', '/schedule', '/attempts', '/profile', '/training', '/surveys'].some(isActive)
  const testsActive = [
    '/admin/tests',
    '/admin/exams',
    '/admin/templates',
    '/admin/question-pools',
    '/admin/grading-scales',
    '/admin/categories',
    '/admin/certificates',
    '/admin/courses',
    '/admin/surveys',
  ].some(isActive)
  const testingCenterActive = ['/admin/sessions', '/admin/candidates', '/admin/attempt-analysis', '/admin/live-monitor'].some(isActive)
  const usersActive = ['/admin/users', '/admin/roles', '/admin/user-groups'].some(isActive)
  const reportingActive = [
    '/admin/report-builder',
    '/admin/reports',
    '/admin/settings',
    '/admin/predefined-reports',
    '/admin/favorite-reports',
    '/admin/subscribers',
  ].some(isActive)
  const systemActive = ['/admin/integrations', '/admin/maintenance', '/admin/audit-log'].some(isActive)

  return (
    <>
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            className={styles.overlay}
            onClick={onClose}
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
        )}
      </AnimatePresence>

      <motion.aside
        className={`${styles.sidebar} glass ${mobileOpen ? styles.open : ''} ${collapsed ? styles.collapsed : ''}`}
        role="navigation"
        aria-label={t('sidebar_main_nav')}
        initial={false}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
      >
        <div className={styles.brand}>
          <div className={styles.brandHeader}>
            <Link to={dashboardPath} className={styles.brandLink} onClick={handleNavigate}>
              <span className={styles.brandLogo}>S</span>
              <span className={styles.brandTextWrap}>
                <span className={styles.brandText}>syra</span>
              </span>
            </Link>
            <button
              type="button"
              className={styles.collapseToggle}
              onClick={onToggleCollapse}
              aria-label={collapsed ? t('sidebar_expand') : t('sidebar_collapse')}
              title={collapsed ? t('sidebar_expand') : t('sidebar_collapse')}
            >
              <svg className="rtl-flip" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M9 4v16" />
                {collapsed ? <path d="m13 12 4-3v6l-4-3Z" /> : <path d="m15 12-4-3v6l4-3Z" />}
              </svg>
            </button>
          </div>
        </div>

        <nav className={styles.nav}>
          {canViewDashboard && (
            <Section label={t('sidebar_section_home')} forceOpen={isActive(dashboardPath)} collapsed={collapsed} t={t}>
              <NavLink to={dashboardPath} icon="home" label={t('dashboard')} active={isActive(dashboardPath)} onNavigate={handleNavigate} collapsed={collapsed} />
            </Section>
          )}

          <Section label={t('sidebar_my_learning')} forceOpen={learningActive} collapsed={collapsed} t={t}>
            {canTakeTests && <NavLink to="/tests" icon="exams" label={t('sidebar_my_tests')} active={isActive('/tests') || isActive('/exams')} onNavigate={handleNavigate} collapsed={collapsed} />}
            {canViewOwnSchedule && <NavLink to="/schedule" icon="schedule" label={t('sidebar_my_schedule')} active={isActive('/schedule')} onNavigate={handleNavigate} collapsed={collapsed} />}
            {canViewOwnAttempts && <NavLink to="/attempts" icon="attempts" label={t('sidebar_my_attempts')} active={isActive('/attempts')} onNavigate={handleNavigate} collapsed={collapsed} />}
            <NavLink to="/profile" icon="profile" label={t('profile')} active={isActive('/profile')} onNavigate={handleNavigate} collapsed={collapsed} />
            {isLearner && <NavLink to="/training" icon="exams" label={t('sidebar_training')} active={isActive('/training')} onNavigate={handleNavigate} collapsed={collapsed} />}
            {isLearner && <NavLink to="/surveys" icon="exams" label={t('sidebar_surveys')} active={isActive('/surveys')} onNavigate={handleNavigate} collapsed={collapsed} />}
          </Section>

          {(canCreateTests || canManageTests || canEditSupportingTests || canManageCategories || canManageGradingScales || canManageQuestionPools) && (
            <Section label={t('sidebar_section_tests')} forceOpen={testsActive} collapsed={collapsed} t={t}>
              {canCreateTests && <NavLink to="/admin/tests/new" icon="newTest" label={t('sidebar_new_test')} active={isActive('/admin/tests/new')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canManageTests && (
                <NavLink
                  to="/admin/tests"
                  icon="manageTests"
                  label={t('sidebar_manage_tests')}
                  active={isActive('/admin/tests') || isActive('/admin/exams')}
                  onNavigate={handleNavigate}
                  collapsed={collapsed}
                />
              )}
              {canEditSupportingTests && <NavLink to="/admin/templates" icon="templates" label={t('sidebar_test_templates')} active={isActive('/admin/templates')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canManageQuestionPools && <NavLink to="/admin/question-pools" icon="pools" label={t('question_pools')} active={isActive('/admin/question-pools')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canManageGradingScales && <NavLink to="/admin/grading-scales" icon="grading" label={t('grading_scales')} active={isActive('/admin/grading-scales')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canManageCategories && <NavLink to="/admin/categories" icon="categories" label={t('categories')} active={isActive('/admin/categories')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canManageTests && <NavLink to="/admin/certificates" icon="certificates" label={t('sidebar_manage_certs')} active={isActive('/admin/certificates')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canEditSupportingTests && <NavLink to="/admin/courses" icon="manageTests" label={t('sidebar_courses')} active={isActive('/admin/courses')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canEditSupportingTests && <NavLink to="/admin/surveys" icon="analysis" label={t('sidebar_surveys_admin')} active={isActive('/admin/surveys')} onNavigate={handleNavigate} collapsed={collapsed} />}
            </Section>
          )}

          {(canAssignSchedules || canViewAttemptAnalysis) && (
            <Section label={t('sidebar_testing_center')} forceOpen={testingCenterActive} collapsed={collapsed} t={t}>
              {canAssignSchedules && <NavLink to="/admin/sessions" icon="sessions" label={t('sidebar_testing_sessions')} active={isActive('/admin/sessions')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canViewAttemptAnalysis && <NavLink to="/admin/candidates" icon="candidates" label={t('sidebar_candidates')} active={isActive('/admin/candidates')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canViewAttemptAnalysis && <NavLink to="/admin/attempt-analysis" icon="analysis" label={t('attempt_analysis')} active={isActive('/admin/attempt-analysis')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canViewAttemptAnalysis && <NavLink to="/admin/live-monitor" icon="sessions" label={t('sidebar_live_monitor')} active={isActive('/admin/live-monitor')} onNavigate={handleNavigate} collapsed={collapsed} />}
            </Section>
          )}

          {(canManageUsers || canManageRoles) && (
            <Section label={t('sidebar_section_users')} forceOpen={usersActive} collapsed={collapsed} t={t}>
              {canManageUsers && <NavLink to="/admin/users" icon="users" label={t('sidebar_user_profiles')} active={isActive('/admin/users')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canManageRoles && <NavLink to="/admin/roles" icon="roles" label={t('roles')} active={isActive('/admin/roles')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {isAdmin && canManageUsers && <NavLink to="/admin/user-groups" icon="groups" label={t('sidebar_user_groups')} active={isActive('/admin/user-groups')} onNavigate={handleNavigate} collapsed={collapsed} />}
            </Section>
          )}

          {(canViewAttemptAnalysis || canGenerateReports || canSystemSettings) && (
            <Section label={t('sidebar_section_reporting')} forceOpen={reportingActive} collapsed={collapsed} t={t}>
              {canGenerateReports && <NavLink to="/admin/report-builder" icon="reports" label={t('sidebar_report_builder')} active={isActive('/admin/report-builder')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canGenerateReports && <NavLink to="/admin/reports" icon="reports" label={t('sidebar_scheduled_reports')} active={isActive('/admin/reports')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canSystemSettings && <NavLink to="/admin/settings" icon="settings" label={t('sidebar_settings')} active={isActive('/admin/settings')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canGenerateReports && <NavLink to="/admin/predefined-reports" icon="reports" label={t('sidebar_predefined_reports')} active={isActive('/admin/predefined-reports')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canGenerateReports && <NavLink to="/admin/favorite-reports" icon="reports" label={t('sidebar_favorite_reports')} active={isActive('/admin/favorite-reports')} onNavigate={handleNavigate} collapsed={collapsed} />}
              {canSystemSettings && <NavLink to="/admin/subscribers" icon="groups" label={t('sidebar_subscribers')} active={isActive('/admin/subscribers')} onNavigate={handleNavigate} collapsed={collapsed} />}
            </Section>
          )}

          {canSystemSettings && (
            <Section label={t('sidebar_section_system')} forceOpen={systemActive} collapsed={collapsed} t={t}>
              <NavLink to="/admin/integrations" icon="settings" label={t('sidebar_integrations')} active={isActive('/admin/integrations')} onNavigate={handleNavigate} collapsed={collapsed} />
              <NavLink to="/admin/maintenance" icon="settings" label={t('sidebar_maintenance')} active={isActive('/admin/maintenance')} onNavigate={handleNavigate} collapsed={collapsed} />
              <NavLink to="/admin/audit-log" icon="auditLog" label={t('sidebar_audit_log')} active={isActive('/admin/audit-log')} onNavigate={handleNavigate} collapsed={collapsed} />
            </Section>
          )}
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.versionRow}>
            <span className={styles.statusDot} aria-hidden="true" />
            <span className={styles.version}>syra v1.0</span>
          </div>
          <span className={styles.footerMeta}>{t('sidebar_secure_workspace')}</span>
        </div>
      </motion.aside>
    </>
  )
}
