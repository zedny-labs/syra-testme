import React, { memo } from 'react'
import useLanguage from '../../../../hooks/useLanguage'
import styles from '../AdminManageTestPage.module.scss'
import DateTimePicker from './DateTimePicker'

function SessionsTab({
  sessions,
  sessionForm,
  setSessionForm,
  learners,
  isArchived,
  sessionFormReady,
  sessionBusy,
  handleCreateSession,
  users,
  deleteSessionId,
  deletingSessionBusyId,
  setDeleteSessionId,
  handleDeleteSession,
}) {
  const { t } = useLanguage()
  return (
    <section className={styles.full}>
      <h3 className={styles.tabPanelHeader}>{t('admin_sessions_tab_header')} <span className={styles.countPill}>{sessions.length}</span></h3>
      <form className={styles.sectionCard} onSubmit={handleCreateSession}>
        <div className={styles.row}>
          <label>{t('admin_sessions_learner')}
            <select value={sessionForm.user_id} disabled={isArchived} onChange={(e) => setSessionForm((p) => ({ ...p, user_id: e.target.value }))}>
              <option value="">{t('admin_sessions_select_learner')}</option>
              {learners.map((u) => <option key={u.id} value={u.id}>{u.user_id} - {u.name}</option>)}
            </select>
          </label>
          <label>{t('admin_sessions_schedule_datetime')}
            <DateTimePicker
              value={sessionForm.scheduled_at}
              disabled={isArchived}
              onChange={(val) => setSessionForm((p) => ({ ...p, scheduled_at: val }))}
            />
          </label>
        </div>
        <div className={styles.row}>
          <label>{t('admin_sessions_access_mode')}
            <select value={sessionForm.access_mode} disabled={isArchived} onChange={(e) => setSessionForm((p) => ({ ...p, access_mode: e.target.value }))}>
              <option value="OPEN">OPEN</option>
              <option value="RESTRICTED">RESTRICTED</option>
            </select>
          </label>
          <label>{t('notes')}<input value={sessionForm.notes} disabled={isArchived} onChange={(e) => setSessionForm((p) => ({ ...p, notes: e.target.value }))} /></label>
        </div>
        <p className={styles.muted}>{t('admin_sessions_requirement_hint')}</p>
        <div className={styles.inlineActions}>
          <button type="submit" className={styles.blueBtn} disabled={sessionBusy || isArchived || !sessionFormReady}>
            {sessionBusy ? t('saving') : t('admin_sessions_assign_update')}
          </button>
        </div>
      </form>
      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead><tr><th>{t('admin_sessions_th_session_id')}</th><th>{t('admin_candidates_th_user')}</th><th>{t('admin_sessions_th_scheduled_at')}</th><th>{t('admin_sessions_access_mode')}</th><th>{t('notes')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {sessions.length === 0 ? (
              <tr><td colSpan={6}>{t('admin_sessions_no_sessions')}</td></tr>
            ) : sessions.map((session) => (
              <tr key={session.id}>
                <td>{String(session.id).slice(0, 8)}</td>
                <td>{users.find((user) => String(user.id) === String(session.user_id))?.user_id || String(session.user_id).slice(0, 8)}</td>
                <td>{new Date(session.scheduled_at).toLocaleString()}</td>
                <td>{session.access_mode}</td>
                <td>{session.notes || '-'}</td>
                <td className={styles.actionsCell}>
                  {deleteSessionId === session.id ? (
                    <>
                      <button
                        type="button"
                        className={styles.dangerInlineBtn}
                        disabled={isArchived || deletingSessionBusyId === session.id}
                        onClick={() => handleDeleteSession(session.id)}
                        aria-label={`${t('confirm_delete')} ${(users.find((user) => String(user.id) === String(session.user_id))?.user_id || String(session.user_id).slice(0, 8))}`}
                      >
                        {deletingSessionBusyId === session.id ? t('admin_sessions_deleting') : t('confirm_delete')}
                      </button>
                      <button type="button" disabled={deletingSessionBusyId === session.id} onClick={() => setDeleteSessionId(null)} aria-label={`${t('cancel')} ${(users.find((user) => String(user.id) === String(session.user_id))?.user_id || String(session.user_id).slice(0, 8))}`}>{t('cancel')}</button>
                    </>
                  ) : (
                    <button type="button" disabled={isArchived || deletingSessionBusyId === session.id} onClick={() => handleDeleteSession(session.id)} aria-label={`${t('delete')} ${(users.find((user) => String(user.id) === String(session.user_id))?.user_id || String(session.user_id).slice(0, 8))}`} title={`${t('delete')} ${(users.find((user) => String(user.id) === String(session.user_id))?.user_id || String(session.user_id).slice(0, 8))}`}>{t('delete')}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default memo(SessionsTab)
