import React, { useState } from 'react'
import axios from 'axios'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { jwtDecode } from 'jwt-decode'
import { login as loginApi, setup as setupAdminApi, signupStatus as signupStatusApi } from '../../services/auth.service'
import useAuth from '../../hooks/useAuth'
import useLanguage from '../../hooks/useLanguage'
import { resolvePostLoginPath } from '../../utils/postLoginRedirect'
import styles from './Login.module.scss'

const apiBaseURL = (import.meta.env.VITE_API_BASE_URL || '/api/').replace(/\/?$/, '/')

function resolveApiUrl(path) {
  return new URL(path, new URL(apiBaseURL, window.location.origin)).toString()
}

const DEV_USERS = import.meta.env.DEV ? {
  admin: {
    email: 'admin@example.com',
    password: 'Password123!',
    name: 'Admin',
    user_id: 'ADM001',
    role: 'ADMIN',
  },
  learner: {
    email: 'learner1@example.com',
    password: 'Password123!',
    name: 'Learner 1',
    user_id: 'LRN001',
    role: 'LEARNER',
  },
} : {}

function isLocalDevHost() {
  if (typeof window === 'undefined') return false
  return ['localhost', '127.0.0.1'].includes(window.location.hostname)
}

function normalizeComparable(value) {
  return String(value || '').trim().toLowerCase()
}

function getErrorMessage(err, fallback) {
  if (typeof err?.userMessage === 'string' && err.userMessage.trim()) {
    return err.userMessage
  }
  if (typeof err?.message === 'string' && err.message.trim() && err.message !== 'Network Error') {
    return err.message
  }
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) {
    return detail
  }
  if (Array.isArray(detail) && detail.length > 0) {
    return detail.map((item) => item?.msg || 'Request validation failed').join(' ')
  }
  if (detail && typeof detail === 'object') {
    return detail.msg || fallback
  }
  return fallback
}

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [devUsers, setDevUsers] = useState(DEV_USERS)
  const { login } = useAuth()
  const { t } = useLanguage()
  const navigate = useNavigate()
  const location = useLocation()
  const showDevTools = isLocalDevHost()
  const returnTo = typeof location.state?.from === 'string' && location.state.from.startsWith('/')
    ? location.state.from
    : ''

  const clearStoredSession = () => {
    try {
      localStorage.removeItem('syra_tokens')
    } catch {
      // ignore storage failures
    }
  }

  const requestLogin = async (nextEmail, nextPassword) => {
    const { data } = await loginApi(nextEmail, nextPassword)
    return data
  }

  const normalizeSeedUsers = (data) => {
    const admin = data?.admin?.email && data?.admin?.password
      ? {
        ...DEV_USERS.admin,
        email: data.admin.email,
        password: data.admin.password,
      }
      : DEV_USERS.admin
    const learner = data?.learners?.[0]?.email && data?.learners?.[0]?.password
      ? {
        ...DEV_USERS.learner,
        email: data.learners[0].email,
        password: data.learners[0].password,
        user_id: data.learners[0].user_id || DEV_USERS.learner.user_id,
      }
      : DEV_USERS.learner

    return { admin, learner }
  }

  const resetLocalSeed = async () => {
    if (!showDevTools) {
      return null
    }

    try {
      const { data } = await axios.post(resolveApiUrl('testing/reset-seed'))
      const nextUsers = normalizeSeedUsers(data)
      setDevUsers(nextUsers)
      return nextUsers
    } catch {
      return null
    }
  }

  const adminAlreadySetupError = () => {
    const error = new Error('Admin already set up')
    error.response = { status: 409, data: { detail: 'Admin already set up' } }
    return error
  }

  const finalizeLogin = (data) => {
    login(data)
    const role = data?.access_token ? jwtDecode(data.access_token)?.role : null
    navigate(resolvePostLoginPath(role, returnTo), { replace: true })
  }

  const completeLogin = async (nextEmail, nextPassword) => {
    const data = await requestLogin(nextEmail, nextPassword)
    finalizeLogin(data)
    return data
  }

  const createUserAsAdmin = async (adminAccessToken, payload) => {
    const usersUrl = resolveApiUrl('users/')
    return axios.post(usersUrl, payload, {
      headers: {
        Authorization: `Bearer ${adminAccessToken}`,
      },
    })
  }

  const listUsersAsAdmin = async (adminAccessToken, search) => {
    const usersUrl = new URL(resolveApiUrl('users/'))
    usersUrl.searchParams.set('page_size', '100')
    if (search) {
      usersUrl.searchParams.set('search', search)
    }
    const { data } = await axios.get(usersUrl.toString(), {
      headers: {
        Authorization: `Bearer ${adminAccessToken}`,
      },
    })
    return Array.isArray(data?.items) ? data.items : []
  }

  const findDevLearnerAsAdmin = async (adminAccessToken, learnerUser) => {
    const exactEmail = normalizeComparable(learnerUser.email)
    const exactUserId = normalizeComparable(learnerUser.user_id)
    for (const search of [learnerUser.email, learnerUser.user_id]) {
      const items = await listUsersAsAdmin(adminAccessToken, search)
      const match = items.find((item) =>
        normalizeComparable(item?.email) === exactEmail
        || normalizeComparable(item?.user_id) === exactUserId,
      )
      if (match) {
        return match
      }
    }
    return null
  }

  const patchUserAsAdmin = async (adminAccessToken, userId, payload) => {
    const userUrl = resolveApiUrl(`users/${userId}`)
    return axios.patch(userUrl, payload, {
      headers: {
        Authorization: `Bearer ${adminAccessToken}`,
      },
    })
  }

  const resetUserPasswordAsAdmin = async (adminAccessToken, userId, nextPassword) => {
    const resetUrl = resolveApiUrl(`users/${userId}/reset-password`)
    return axios.post(resetUrl, { new_password: nextPassword }, {
      headers: {
        Authorization: `Bearer ${adminAccessToken}`,
      },
    })
  }

  const repairDevLearnerAsAdmin = async (adminAccessToken, learnerUser) => {
    try {
      await createUserAsAdmin(adminAccessToken, learnerUser)
      return
    } catch (err) {
      if (err.response?.status !== 409) {
        throw err
      }
    }

    const existingUser = await findDevLearnerAsAdmin(adminAccessToken, learnerUser)
    if (!existingUser?.id) {
      throw new Error('Existing dev learner account could not be repaired automatically.')
    }

    await patchUserAsAdmin(adminAccessToken, existingUser.id, {
      email: learnerUser.email,
      name: learnerUser.name,
      user_id: learnerUser.user_id,
      role: learnerUser.role,
      is_active: true,
    })
    await resetUserPasswordAsAdmin(adminAccessToken, existingUser.id, learnerUser.password)
  }

  const ensureAdminTokens = async (adminUser) => {
    const { data } = await signupStatusApi()
    const setupAllowed = Boolean(data?.allowed)

    if (setupAllowed) {
      await setupAdminApi(adminUser)
    }

    try {
      return await requestLogin(adminUser.email, adminUser.password)
    } catch (err) {
      if (!setupAllowed && err.response?.status === 401) {
        throw adminAlreadySetupError()
      }
      throw err
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const nextEmail = email.trim()
    const nextPassword = password
    setError('')
    if (!nextEmail) {
      setError(t('validation_email_required'))
      return
    }
    if (!nextPassword) {
      setError(t('validation_password_required'))
      return
    }
    setLoading(true)
    clearStoredSession()
    try {
      await completeLogin(nextEmail, nextPassword)
    } catch (err) {
      setError(getErrorMessage(err, t('login_failed')))
    } finally {
      setLoading(false)
    }
  }

  const requestFormSubmit = (event) => {
    if (loading) return
    const form = event.currentTarget.form
    if (!form) return
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit()
      return
    }
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }

  const handleAdminLogin = async () => {
    setError('')
    const adminUser = devUsers.admin
    setEmail(adminUser.email)
    setPassword(adminUser.password)
    setLoading(true)
    clearStoredSession()

    try {
      const adminTokens = await ensureAdminTokens(adminUser)
      finalizeLogin(adminTokens)
    } catch (err) {
      try {
        const seededUsers = await resetLocalSeed()
        if (!seededUsers?.admin) {
          throw err
        }

        setEmail(seededUsers.admin.email)
        setPassword(seededUsers.admin.password)
        const adminTokens = await ensureAdminTokens(seededUsers.admin)
        finalizeLogin(adminTokens)
      } catch (fallbackError) {
        const detail = fallbackError?.response?.data?.detail
        if (detail === 'Admin already set up') {
          setError(t('login_dev_admin_db_error'))
        } else {
          setError(getErrorMessage(fallbackError, t('login_admin_failed')))
        }
      }
    } finally {
      setLoading(false)
    }
  }

  const handleLearnerLogin = async () => {
    setError('')
    const learnerUser = devUsers.learner
    setEmail(learnerUser.email)
    setPassword(learnerUser.password)
    setLoading(true)
    clearStoredSession()

    try {
      await completeLogin(learnerUser.email, learnerUser.password)
    } catch (err) {
      try {
        const seededUsers = await resetLocalSeed()
        if (seededUsers?.learner) {
          setEmail(seededUsers.learner.email)
          setPassword(seededUsers.learner.password)
          await completeLogin(seededUsers.learner.email, seededUsers.learner.password)
          return
        }
        throw err
      } catch (fallbackError) {
        try {
          const adminUser = devUsers.admin
          const adminTokens = await ensureAdminTokens(adminUser)
          await repairDevLearnerAsAdmin(adminTokens.access_token, learnerUser)
          await completeLogin(learnerUser.email, learnerUser.password)
        } catch (repairError) {
          const detail = repairError?.response?.data?.detail
          if (detail === 'Admin already set up') {
            setError(t('login_learner_bootstrap_error'))
          } else {
            setError(getErrorMessage(repairError, t('login_learner_failed')))
          }
        }
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className={styles.page}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <div className={styles.brand}>
          <div className={styles.logo}>
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
              <rect width="48" height="48" rx="12" fill="#10b981" />
              <text x="50%" y="54%" dominantBaseline="middle" textAnchor="middle"
                fill="#fff" fontSize="22" fontWeight="800" fontFamily="system-ui">S</text>
            </svg>
          </div>
          <h1 className={styles.title}>syra</h1>
          <p className={styles.subtitle}>{t('login_subtitle')}</p>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.field}>
          <label htmlFor="email">{t('email')}</label>
          <input id="email" type="email" placeholder={t('login_email_placeholder')} value={email}
            onChange={(e) => setEmail(e.target.value)} disabled={loading} required autoFocus />
        </div>

        <div className={styles.field}>
          <label htmlFor="password">{t('password')}</label>
          <div className={styles.passwordInputWrap}>
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              placeholder={t('login_password_placeholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              required
            />
            <button
              type="button"
              className={styles.passwordToggle}
              onClick={() => setShowPassword((current) => !current)}
              aria-label={showPassword ? t('login_hide_password') : t('login_show_password')}
              aria-pressed={showPassword}
              disabled={loading}
            >
              {showPassword ? t('login_hide') : t('login_show')}
            </button>
          </div>
        </div>

        <button type="button" className={styles.btn} disabled={loading} onClick={requestFormSubmit}>
          {loading ? t('login_logging_in') : t('sign_in')}
        </button>

        {showDevTools && devUsers?.admin && devUsers?.learner && (
          <div className={styles.devTools}>
            <div className={styles.devToolsHeader}>
              <strong>Dev Tools</strong>
              <span>localhost only</span>
            </div>
            <p className={styles.devHint}>
              Quick role login for local development.
            </p>
            <p className={styles.devHint}>
              Admin: <strong>{devUsers.admin.email}</strong> / <strong>{devUsers.admin.password}</strong>
            </p>
            <p className={styles.devHint}>
              Learner: <strong>{devUsers.learner.email}</strong> / <strong>{devUsers.learner.password}</strong>
            </p>
            <div className={styles.devButtonRow}>
              <button type="button" className={styles.devBtn} disabled={loading} onClick={handleAdminLogin}>
                {loading ? 'Working...' : 'Admin'}
              </button>
              <button type="button" className={styles.devBtn} disabled={loading} onClick={handleLearnerLogin}>
                {loading ? 'Working...' : 'Learner'}
              </button>
            </div>
          </div>
        )}

        <div className={styles.actionsRow}>
          <Link className={styles.secondaryLink} to="/forgot-password">{t('login_forgot_password')}</Link>
          <Link className={styles.secondaryLink} to="/signup">{t('login_create_account')}</Link>
        </div>
      </form>
    </main>
  )
}
