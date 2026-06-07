import React, { Suspense, lazy, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation, useParams } from 'react-router-dom'
import ErrorBoundary from '../components/ErrorBoundary/ErrorBoundary'
import Navbar from '../components/Navbar/Navbar'
import ScrollProgress from '../components/ScrollProgress/ScrollProgress'
import ScrollRestoration from '../components/ScrollRestoration/ScrollRestoration'
import ScrollTopButton from '../components/ScrollTopButton/ScrollTopButton'
import Sidebar from '../components/Sidebar/Sidebar'
import Loader from '../components/common/Loader/Loader'
import useAuth from '../hooks/useAuth'
import useLanguage from '../hooks/useLanguage'
import api, { cancelRouteScopedRequests } from '../services/api'

function lazyPage(importer, options = {}) {
  const LazyComponent = lazy(importer)
  const { fullPage = false, labelKey = 'loading' } = options

  return function LazyPage(props) {
    const { t } = useLanguage()
    return (
      <Suspense fallback={<Loader fullPage={fullPage} label={t(labelKey)} />}>
        <LazyComponent {...props} />
      </Suspense>
    )
  }
}

const Login = lazyPage(() => import('../pages/Login/Login'), { fullPage: true, labelKey: 'loading_sign_in' })
const Landing = lazyPage(() => import('../pages/Landing/Landing'), { fullPage: true, labelKey: 'loading' })
const Home = lazyPage(() => import('../pages/Home/Home'), { labelKey: 'loading_dashboard' })
const Exams = lazyPage(() => import('../pages/Exams/Exams'), { labelKey: 'loading_tests' })
const ExamInstructions = lazyPage(() => import('../pages/ExamInstructions/ExamInstructions'), { labelKey: 'loading_instructions' })
const ForgotPassword = lazyPage(() => import('../pages/Auth/ForgotPassword'), { fullPage: true, labelKey: 'loading_recovery' })
const ResetPassword = lazyPage(() => import('../pages/Auth/ResetPassword'), { fullPage: true, labelKey: 'loading_reset_form' })
const ChangePassword = lazyPage(() => import('../pages/Auth/ChangePassword'), { labelKey: 'loading_password_settings' })
const SignUp = lazyPage(() => import('../pages/Auth/SignUp'), { fullPage: true, labelKey: 'loading_signup' })
const SystemCheckPage = lazyPage(() => import('../pages/SystemCheckPage/SystemCheckPage'), { labelKey: 'loading_system_check' })
const VerifyIdentityPage = lazyPage(() => import('../pages/VerifyIdentityPage/VerifyIdentityPage'), { labelKey: 'loading_identity_check' })
const RulesPage = lazyPage(() => import('../pages/RulesPage/RulesPage'), { labelKey: 'loading_rules' })
const Proctoring = lazyPage(() => import('../pages/Proctoring/Proctoring'), { labelKey: 'loading_test_session' })
const Attempts = lazyPage(() => import('../pages/Attempts/Attempts'), { labelKey: 'loading_attempts' })
const AttemptResult = lazyPage(() => import('../pages/AttemptResult/AttemptResult'), { labelKey: 'loading_results' })
const Schedule = lazyPage(() => import('../pages/Schedule/Schedule'), { labelKey: 'loading_schedule' })
const Profile = lazyPage(() => import('../pages/Profile/Profile'), { labelKey: 'loading_profile' })
const NotFound = lazyPage(() => import('../pages/NotFound/NotFound'), { fullPage: true, labelKey: 'loading_page' })
const AccessDenied = lazyPage(() => import('../pages/AccessDenied/AccessDenied'), { labelKey: 'loading_checking_access' })
const AdminDashboard = lazyPage(() => import('../pages/Admin/AdminDashboard/AdminDashboard'), { labelKey: 'loading_admin_dashboard' })
const AdminExams = lazyPage(() => import('../pages/Admin/AdminExams/AdminExams'), { labelKey: 'loading_tests' })
const AdminNewTestWizard = lazyPage(() => import('../pages/Admin/AdminNewTestWizard/AdminNewTestWizard'), { labelKey: 'loading_test_editor' })
const AdminCategories = lazyPage(() => import('../pages/Admin/AdminCategories/AdminCategories'), { labelKey: 'loading_categories' })
const AdminGradingScales = lazyPage(() => import('../pages/Admin/AdminGradingScales/AdminGradingScales'), { labelKey: 'loading_grading_scales' })
const AdminQuestionPools = lazyPage(() => import('../pages/Admin/AdminQuestionPools/AdminQuestionPools'), { labelKey: 'loading_question_pools' })
const AdminTestingSessions = lazyPage(() => import('../pages/Admin/AdminTestingSessions/AdminTestingSessions'), { labelKey: 'loading_sessions' })
const AdminCandidates = lazyPage(() => import('../pages/Admin/AdminCandidates/AdminCandidates'), { labelKey: 'loading_candidates' })
const AdminAttemptAnalysis = lazyPage(() => import('../pages/Admin/AdminAttemptAnalysis/AdminAttemptAnalysis'), { labelKey: 'loading_attempt_analysis' })
const AdminRolesPermissions = lazyPage(() => import('../pages/Admin/AdminRolesPermissions/AdminRolesPermissions'), { labelKey: 'loading_role_permissions' })
const AdminUsers = lazyPage(() => import('../pages/Admin/AdminUsers/AdminUsers'), { labelKey: 'loading_users' })
const AdminTemplates = lazyPage(() => import('../pages/Admin/AdminTemplates/AdminTemplates'), { labelKey: 'loading_templates' })
const AdminCertificates = lazyPage(() => import('../pages/Admin/AdminCertificates/AdminCertificates'), { labelKey: 'loading_certificates' })
const AdminReports = lazyPage(() => import('../pages/Admin/AdminReports/AdminReports'), { labelKey: 'loading_reports' })
const AdminCourses = lazyPage(() => import('../pages/Admin/AdminCourses/AdminCourses'), { labelKey: 'loading_courses' })
const AdminUserGroups = lazyPage(() => import('../pages/Admin/AdminUserGroups/AdminUserGroups'), { labelKey: 'loading_groups' })
const AdminSettings = lazyPage(() => import('../pages/Admin/AdminSettings/AdminSettings'), { labelKey: 'loading_settings' })
const AdminSurveys = lazyPage(() => import('../pages/Admin/AdminSurveys/AdminSurveys'), { labelKey: 'loading_surveys' })
const AdminAttemptVideos = lazyPage(() => import('../pages/Admin/AdminAttemptVideos/AdminAttemptVideos'), { labelKey: 'loading_recordings' })
const AdminManageTestPage = lazyPage(() => import('../pages/Admin/AdminManageTestPage/AdminManageTestPage'), { labelKey: 'loading_manage_test' })
const QuestionPoolDetail = lazyPage(() => import('../pages/Admin/QuestionPoolDetail/QuestionPoolDetail'), { labelKey: 'loading_pool_details' })
const TrainingCourses = lazyPage(() => import('../pages/TrainingCourses/TrainingCourses'), { labelKey: 'loading_training' })
const MySurveys = lazyPage(() => import('../pages/MySurveys/MySurveys'), { labelKey: 'loading_surveys' })
const AdminPredefinedReports = lazyPage(() => import('../pages/Admin/AdminPredefinedReports/AdminPredefinedReports'), { labelKey: 'loading_predefined_reports' })
const AdminFavoriteReports = lazyPage(() => import('../pages/Admin/AdminFavoriteReports/AdminFavoriteReports'), { labelKey: 'loading_favorites' })
const AdminIntegrations = lazyPage(() => import('../pages/Admin/AdminIntegrations/AdminIntegrations'), { labelKey: 'loading_integrations' })
const AdminMaintenance = lazyPage(() => import('../pages/Admin/AdminMaintenance/AdminMaintenance'), { labelKey: 'loading_maintenance' })
const AdminSubscribers = lazyPage(() => import('../pages/Admin/AdminSubscribers/AdminSubscribers'), { labelKey: 'loading_subscribers' })
const AdminCustomReports = lazyPage(() => import('../pages/Admin/AdminCustomReports/AdminCustomReports'), { labelKey: 'loading_custom_reports' })
const AdminAuditLog = lazyPage(() => import('../pages/Admin/AdminAuditLog/AdminAuditLog'), { labelKey: 'loading_audit_log' })
const AdminLiveMonitor = lazyPage(() => import('../pages/Admin/AdminLiveMonitor/AdminLiveMonitor'), { labelKey: 'loading_live_monitor' })
const Maintenance = lazyPage(() => import('../pages/Maintenance/Maintenance'), { fullPage: true, labelKey: 'loading_maintenance_notice' })

const MAINTENANCE_CACHE_TTL_MS = 120000
let maintenanceCache = {
  data: null,
  fetchedAt: 0,
  inflight: null,
}

async function readMaintenanceStatus() {
  const now = Date.now()
  if (maintenanceCache.fetchedAt && (now - maintenanceCache.fetchedAt) < MAINTENANCE_CACHE_TTL_MS) {
    return maintenanceCache.data
  }
  if (maintenanceCache.inflight) {
    return maintenanceCache.inflight
  }

  maintenanceCache.inflight = api.get('admin-settings/maintenance/public')
    .then(({ data }) => {
      if (!data || typeof data.mode !== 'string') {
        throw new Error('Maintenance status unavailable')
      }
      maintenanceCache.data = {
        mode: data.mode,
        banner: typeof data.banner === 'string' ? data.banner : '',
      }
      maintenanceCache.fetchedAt = Date.now()
      return maintenanceCache.data
    })
    .finally(() => {
      maintenanceCache.inflight = null
    })

  return maintenanceCache.inflight
}

function RequireLogin({ children }) {
  const location = useLocation()
  const { user, loading } = useAuth()
  const { t } = useLanguage()

  if (loading) return <Loader fullPage label={t('loading_authenticating')} />
  if (!user) {
    // Guests opening the site root see the marketing landing first; any other
    // protected deep-link still goes straight to login.
    const target = location.pathname === '/' ? '/welcome' : '/login'
    return (
      <Navigate
        to={target}
        replace
        state={{ from: `${location.pathname}${location.search}${location.hash}` }}
      />
    )
  }
  return children
}

function RequireAccess({ children, roles, permission }) {
  const { user, hasPermission, permissionsLoading, permissionsError } = useAuth()
  const { t } = useLanguage()

  if (roles && roles.length > 0 && !roles.includes(user.role)) {
    return <Navigate to="/access-denied" replace />
  }
  if (permission && permissionsLoading) {
    return <Loader fullPage label={t('loading_access')} />
  }
  if (permission && permissionsError) {
    return (
      <div className="maintenance-page">
        <h2>{t('error_permissions_unavailable')}</h2>
        <p>{permissionsError}</p>
        <button type="button" onClick={() => window.location.reload()}>{t('retry')}</button>
      </div>
    )
  }
  if (permission && !hasPermission(permission)) {
    return <Navigate to="/access-denied" replace />
  }
  return children
}

function Shell({ children }) {
  const { user } = useAuth()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('syra_sidebar_collapsed') === 'true'
    } catch {
      return false
    }
  })
  const [maintenance, setMaintenance] = useState({ mode: 'off', banner: '' })
  const [maintenanceError, setMaintenanceError] = useState('')
  const location = useLocation()
  const isAttemptTakeMode = /^\/attempts\/[^/]+\/take$/.test(location.pathname)
  const isLegacyExamMode = ['/exam/', '/system-check/', '/verify-identity/', '/rules/']
    .some((prefix) => location.pathname.startsWith(prefix))
  const isTestJourneyMode = /^\/tests\/[^/]+(\/(system-check|verify-identity|rules))?$/.test(location.pathname)
  const isVideoReviewMode = /^\/admin\/(videos|attempts\/[^/]+\/videos)/.test(location.pathname)
  const isExamMode = isAttemptTakeMode || isLegacyExamMode || isTestJourneyMode || isVideoReviewMode
  useEffect(() => {
    async function loadSettings() {
      try {
        const data = await readMaintenanceStatus()
        setMaintenance(data)
        setMaintenanceError('')
      } catch {
        // Silently ignore — maintenance check failure should not block the app.
        // The banner only appears when maintenance mode is actively enabled.
        setMaintenanceError('')
      }
    }

    loadSettings()
    const id = setInterval(loadSettings, 120000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  useEffect(() => {
    try {
      window.localStorage.setItem('syra_sidebar_collapsed', sidebarCollapsed ? 'true' : 'false')
    } catch {
      // ignore storage failures
    }
  }, [sidebarCollapsed])

  useEffect(() => () => {
    cancelRouteScopedRequests('navigation')
  }, [location.key])

  if (!user) return children

  if (maintenance.mode === 'down' && user.role !== 'ADMIN') {
    return (
      <div className="maintenance-page">
        {maintenance.banner && <div className="maintenance-banner">{maintenance.banner}</div>}
        <h2>Maintenance in progress</h2>
        <p>Please try again later.</p>
      </div>
    )
  }

  return (
    <>
      <a href="#app-main-content" className="skip-link">Skip to content</a>
      <ScrollRestoration />
      {!isExamMode && <ScrollProgress />}
      {maintenanceError && (
        <div className="maintenance-banner">
          {maintenanceError}
        </div>
      )}
      {maintenance.mode !== 'off' && (
        <div className="maintenance-banner">
          {maintenance.banner || 'Maintenance in progress'}
        </div>
      )}
      <div
        className={`app-shell ${isExamMode ? 'app-shell--exam' : ''}`}
        style={!isExamMode ? { '--sidebar-width': sidebarCollapsed ? '88px' : '248px' } : undefined}
      >
        {!isExamMode && (
          <Sidebar
            collapsed={sidebarCollapsed}
            mobileOpen={mobileOpen}
            onClose={() => setMobileOpen(false)}
            onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
          />
        )}
        <div className="app-shell__main">
          {!isExamMode && (
            <Navbar
              onMenuToggle={() => setMobileOpen((prev) => !prev)}
            />
          )}
          <AnimatePresence mode="wait">
            <motion.main
              key={location.pathname}
              id="app-main-content"
              className={`app-shell__content ${isExamMode ? 'app-shell__content--exam' : 'glass'}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
            >
              <ErrorBoundary>{children}</ErrorBoundary>
            </motion.main>
          </AnimatePresence>
        </div>
      </div>
      {!isExamMode && <ScrollTopButton />}
    </>
  )
}

function AuthenticatedLayout() {
  return (
    <RequireLogin>
      <Shell>
        <Outlet />
      </Shell>
    </RequireLogin>
  )
}

const ADMIN_ROLES = ['ADMIN']
const SUPER_ADMIN = ['ADMIN']
const ANALYSIS_ROLES = ['ADMIN', 'INSTRUCTOR']
const ADMIN_OR_INSTRUCTOR_ROLES = ['ADMIN', 'INSTRUCTOR']
const LEARNER_ROLES = ['LEARNER']
const withAccess = (element, roles, permission) => (
  <RequireAccess roles={roles} permission={permission}>
    {element}
  </RequireAccess>
)

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function LegacyTestDetailRedirect() {
  const { id } = useParams()
  if (!id || !UUID_PATTERN.test(id)) {
    return <Navigate to="/admin/tests" replace />
  }
  return <Navigate to={`/admin/tests/${id}/manage`} replace />
}

function LegacyTestEditRedirect() {
  const { id } = useParams()
  if (!id || !UUID_PATTERN.test(id)) {
    return <Navigate to="/admin/tests" replace />
  }
  return <Navigate to={`/admin/tests/${id}/edit`} replace />
}

function LegacyLearnerTestsRedirect() {
  return <Navigate to="/tests" replace />
}

function LegacyLearnerTestDetailRedirect() {
  const { examId } = useParams()
  if (!examId) {
    return <Navigate to="/tests" replace />
  }
  return <Navigate to={`/tests/${examId}`} replace />
}

function LegacyLearnerSystemCheckRedirect() {
  const { examId } = useParams()
  if (!examId) {
    return <Navigate to="/tests" replace />
  }
  return <Navigate to={`/tests/${examId}/system-check`} replace />
}

function LegacyLearnerVerifyIdentityRedirect() {
  const { examId } = useParams()
  if (!examId) {
    return <Navigate to="/tests" replace />
  }
  return <Navigate to={`/tests/${examId}/verify-identity`} replace />
}

function LegacyLearnerRulesRedirect() {
  const { examId } = useParams()
  if (!examId) {
    return <Navigate to="/tests" replace />
  }
  return <Navigate to={`/tests/${examId}/rules`} replace />
}

function LegacyAttemptTakeRedirect() {
  const { attemptId } = useParams()
  if (!attemptId) {
    return <Navigate to="/attempts" replace />
  }
  return <Navigate to={`/attempts/${attemptId}/take`} replace />
}

function HomeRoute() {
  const { user } = useAuth()
  if (user?.role === 'ADMIN') {
    return <Navigate to="/admin/dashboard" replace />
  }
  if (user?.role === 'INSTRUCTOR') {
    return <Navigate to="/profile" replace />
  }
  return <Home />
}

const router = createBrowserRouter(
  [
    { path: '/welcome', element: <ErrorBoundary><Landing /></ErrorBoundary> },
    { path: '/login', element: <ErrorBoundary><Login /></ErrorBoundary> },
    { path: '/signup', element: <ErrorBoundary><SignUp /></ErrorBoundary> },
    { path: '/forgot-password', element: <ErrorBoundary><ForgotPassword /></ErrorBoundary> },
    { path: '/reset-password', element: <ErrorBoundary><ResetPassword /></ErrorBoundary> },
    { path: '/maintenance', element: <ErrorBoundary><Maintenance /></ErrorBoundary> },
    { path: '/exams', element: <LegacyLearnerTestsRedirect /> },
    { path: '/exams/:examId', element: <LegacyLearnerTestDetailRedirect /> },
    { path: '/system-check/:examId', element: <LegacyLearnerSystemCheckRedirect /> },
    { path: '/verify-identity/:examId', element: <LegacyLearnerVerifyIdentityRedirect /> },
    { path: '/rules/:examId', element: <LegacyLearnerRulesRedirect /> },
    { path: '/exam/:attemptId', element: <LegacyAttemptTakeRedirect /> },
    { path: '/admin/exams', element: <Navigate to="/admin/tests" replace /> },
    { path: '/admin/exams/:id', element: <LegacyTestDetailRedirect /> },
    { path: '/admin/exams/:id/manage', element: <LegacyTestDetailRedirect /> },
    { path: '/admin/exams/new', element: <Navigate to="/admin/tests/new" replace /> },
    { path: '/admin/exams/:id/edit', element: <LegacyTestEditRedirect /> },
    { path: '/admin/tests/:id', element: <LegacyTestDetailRedirect /> },
    { path: '/admin/new', element: <Navigate to="/admin/tests/new" replace /> },
    { path: '/admin/schedules', element: <Navigate to="/admin/sessions" replace /> },
    { path: '/admin/roles-permissions', element: <Navigate to="/admin/roles" replace /> },

    {
      element: <AuthenticatedLayout />,
      children: [
        { path: '/change-password', element: <ChangePassword /> },
        { path: '/access-denied', element: <AccessDenied /> },

        { path: '/', element: withAccess(<HomeRoute />, undefined, 'View Dashboard') },
        { path: '/tests', element: withAccess(<Exams />, undefined, 'Take Tests') },
        { path: '/tests/:testId', element: <ExamInstructions /> },
        { path: '/training', element: withAccess(<TrainingCourses />, LEARNER_ROLES) },
        { path: '/surveys', element: withAccess(<MySurveys />, LEARNER_ROLES) },
        { path: '/tests/:testId/system-check', element: <SystemCheckPage /> },
        { path: '/tests/:testId/verify-identity', element: <VerifyIdentityPage /> },
        { path: '/tests/:testId/rules', element: <RulesPage /> },
        { path: '/attempts/:attemptId/take', element: <Proctoring /> },
        { path: '/attempts', element: withAccess(<Attempts />, undefined, 'View Own Attempts') },
        { path: '/attempts/:id', element: <AttemptResult /> },
        { path: '/attempt-result/:id', element: <AttemptResult /> },
        { path: '/schedule', element: withAccess(<Schedule />, undefined, 'View Own Schedule') },
        { path: '/profile', element: <Profile /> },

        { path: '/admin', element: withAccess(<AdminDashboard />, ADMIN_ROLES, 'View Dashboard') },
        { path: '/admin/dashboard', element: withAccess(<AdminDashboard />, ADMIN_ROLES, 'View Dashboard') },
        { path: '/admin/tests', element: withAccess(<AdminExams />, ADMIN_ROLES, 'Edit Tests') },
        { path: '/admin/tests/:id', element: <LegacyTestDetailRedirect /> },
        { path: '/admin/tests/:id/manage', element: withAccess(<AdminManageTestPage />, ADMIN_ROLES, 'Edit Tests') },
        { path: '/admin/tests/new', element: withAccess(<AdminNewTestWizard />, ADMIN_ROLES, 'Create Tests') },
        { path: '/admin/tests/:id/edit', element: withAccess(<AdminNewTestWizard />, ADMIN_ROLES, 'Edit Tests') },
        { path: '/admin/attempts/:attemptId/videos', element: withAccess(<AdminAttemptVideos />, ANALYSIS_ROLES, 'View Attempt Analysis') },
        { path: '/admin/videos/:attemptId', element: withAccess(<AdminAttemptVideos />, ANALYSIS_ROLES, 'View Attempt Analysis') },
        { path: '/admin/videos', element: withAccess(<AdminAttemptVideos />, ANALYSIS_ROLES, 'View Attempt Analysis') },
        { path: '/admin/categories', element: withAccess(<AdminCategories />, ADMIN_OR_INSTRUCTOR_ROLES, 'Manage Categories') },
        { path: '/admin/grading-scales', element: withAccess(<AdminGradingScales />, ADMIN_OR_INSTRUCTOR_ROLES, 'Manage Grading Scales') },
        { path: '/admin/question-pools', element: withAccess(<AdminQuestionPools />, ADMIN_OR_INSTRUCTOR_ROLES, 'Manage Question Pools') },
        { path: '/admin/question-pools/:id', element: withAccess(<QuestionPoolDetail />, ADMIN_OR_INSTRUCTOR_ROLES, 'Manage Question Pools') },
        { path: '/admin/sessions', element: withAccess(<AdminTestingSessions />, ADMIN_OR_INSTRUCTOR_ROLES, 'Assign Schedules') },
        { path: '/admin/candidates', element: withAccess(<AdminCandidates />, ANALYSIS_ROLES, 'View Attempt Analysis') },
        { path: '/admin/attempt-analysis', element: withAccess(<AdminAttemptAnalysis />, ANALYSIS_ROLES, 'View Attempt Analysis') },
        { path: '/admin/live-monitor', element: withAccess(<AdminLiveMonitor />, ANALYSIS_ROLES, 'View Attempt Analysis') },
        { path: '/admin/users', element: withAccess(<AdminUsers />, ADMIN_OR_INSTRUCTOR_ROLES, 'Manage Users') },
        { path: '/admin/roles', element: withAccess(<AdminRolesPermissions />, SUPER_ADMIN, 'Manage Roles') },
        { path: '/admin/templates', element: withAccess(<AdminTemplates />, ADMIN_OR_INSTRUCTOR_ROLES, 'Edit Tests') },
        { path: '/admin/certificates', element: withAccess(<AdminCertificates />, ADMIN_ROLES, 'Edit Tests') },
        { path: '/admin/reports', element: withAccess(<AdminReports />, ADMIN_ROLES, 'Generate Reports') },
        { path: '/admin/courses', element: withAccess(<AdminCourses />, ADMIN_OR_INSTRUCTOR_ROLES, 'Edit Tests') },
        { path: '/admin/user-groups', element: withAccess(<AdminUserGroups />, ADMIN_ROLES, 'Manage Users') },
        { path: '/admin/settings', element: withAccess(<AdminSettings />, ADMIN_ROLES, 'System Settings') },
        { path: '/admin/surveys', element: withAccess(<AdminSurveys />, ADMIN_OR_INSTRUCTOR_ROLES, 'Edit Tests') },
        { path: '/admin/predefined-reports', element: withAccess(<AdminPredefinedReports />, ADMIN_ROLES, 'Generate Reports') },
        { path: '/admin/favorite-reports', element: withAccess(<AdminFavoriteReports />, ADMIN_ROLES, 'Generate Reports') },
        { path: '/admin/report-builder', element: withAccess(<AdminCustomReports />, ADMIN_ROLES, 'Generate Reports') },
        { path: '/admin/integrations', element: withAccess(<AdminIntegrations />, ADMIN_ROLES, 'System Settings') },
        { path: '/admin/maintenance', element: withAccess(<AdminMaintenance />, ADMIN_ROLES, 'System Settings') },
        { path: '/admin/subscribers', element: withAccess(<AdminSubscribers />, ADMIN_ROLES, 'System Settings') },
        { path: '/admin/audit-log', element: withAccess(<AdminAuditLog />, ADMIN_ROLES, 'View Audit Log') },
      ],
    },

    { path: '*', element: <NotFound /> },
  ],
  {
    future: {
      v7_startTransition: true,
      v7_relativeSplatPath: true,
    },
  },
)

export default function AppRoutes() {
  return (
    <RouterProvider
      router={router}
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    />
  )
}
