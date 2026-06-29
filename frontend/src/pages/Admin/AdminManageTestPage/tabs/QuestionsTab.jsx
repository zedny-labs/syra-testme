import React, { memo } from 'react'
import useLanguage from '../../../../hooks/useLanguage'
import styles from '../AdminManageTestPage.module.scss'
import QuestionImageUpload from '../../../../components/QuestionImageUpload/QuestionImageUpload'

function QuestionsTab({
  questions,
  questionSearch,
  setQuestionSearch,
  questionForm,
  lockedExamFields,
  handleQuestionTypeChange,
  setQuestionForm,
  questionTypes,
  questionBusy,
  editingQuestionId,
  resetQuestionForm,
  handleQuestionSubmit,
  filteredQuestions,
  questionTypeOf,
  deletingQuestionBusyId,
  deleteQuestionId,
  setDeleteQuestionId,
  startEditQuestion,
  handleDeleteQuestion,
}) {
  const { t } = useLanguage()
  return (
    <section className={styles.full}>
      <h3 className={styles.tabPanelHeader}>{t('admin_questions_tab_header')} <span className={styles.countPill}>{questions.length}</span></h3>
      <div className={styles.row}>
        <label>{t('admin_questions_search_label')}<input placeholder={t('admin_questions_search_placeholder')} value={questionSearch} onChange={(e) => setQuestionSearch(e.target.value)} /></label>
        <label>{t('admin_questions_total_label')}<input readOnly value={String(questions.length)} /></label>
      </div>
      <form className={styles.sectionCard} onSubmit={handleQuestionSubmit}>
        <div className={styles.sectionHeader}>{editingQuestionId ? t('admin_questions_edit_question') : t('admin_questions_add_question')}</div>
        <div className={styles.row}>
          <label>{t('type')}
            <select value={questionForm.question_type} disabled={lockedExamFields} onChange={(e) => handleQuestionTypeChange(e.target.value)}>
              {questionTypes.map((qt) => <option key={qt} value={qt}>{qt}</option>)}
            </select>
          </label>
        </div>
        <label>{t('admin_questions_question_text')}<textarea rows={3} value={questionForm.text} disabled={lockedExamFields} onChange={(e) => setQuestionForm((p) => ({ ...p, text: e.target.value }))} /></label>
        <QuestionImageUpload
          value={questionForm.image_url}
          onChange={(url) => setQuestionForm((p) => ({ ...p, image_url: url }))}
          disabled={lockedExamFields}
          t={t}
        />
        {questionForm.question_type === 'ORDERING' && (
          <div className={styles.typeHint}>{t('admin_questions_hint_ordering')}</div>
        )}
        {questionForm.question_type === 'FILLINBLANK' && (
          <div className={styles.typeHint}>{t('admin_questions_hint_fillinblank')}</div>
        )}
        {questionForm.question_type === 'MATCHING' && (
          <div className={styles.typeHint}>{t('admin_questions_hint_matching')}</div>
        )}
        {questionForm.question_type === 'TEXT' && (
          <div className={styles.typeHint}>{t('admin_questions_hint_text')}</div>
        )}
        {['MCQ', 'MULTI', 'TRUEFALSE', 'ORDERING', 'FILLINBLANK', 'MATCHING'].includes(questionForm.question_type) && (
          <label>
            {questionForm.question_type === 'MATCHING' ? t('admin_questions_label_pairs') : questionForm.question_type === 'FILLINBLANK' ? t('admin_questions_label_acceptable_answers') : t('admin_questions_label_options')}
            <textarea rows={4} value={questionForm.options_text} disabled={lockedExamFields} onChange={(e) => setQuestionForm((p) => ({ ...p, options_text: e.target.value }))} />
          </label>
        )}
        <label>
          {questionForm.question_type === 'ORDERING' ? t('admin_questions_label_correct_order') : questionForm.question_type === 'MATCHING' ? t('admin_questions_label_correct_matching') : t('admin_questions_label_correct_answer')}
          <input value={questionForm.correct_answer} disabled={lockedExamFields || questionForm.question_type === 'ORDERING'} onChange={(e) => setQuestionForm((p) => ({ ...p, correct_answer: e.target.value }))} />
        </label>
        <div className={styles.row}>
          <label>{t('admin_questions_points')}<input type="number" step="0.5" min="0.5" value={questionForm.points} disabled={lockedExamFields} onChange={(e) => setQuestionForm((p) => ({ ...p, points: e.target.value }))} /></label>
          <label>{t('admin_questions_order')}<input type="number" min="0" value={questionForm.order} disabled={lockedExamFields} onChange={(e) => setQuestionForm((p) => ({ ...p, order: e.target.value }))} /></label>
        </div>
        <div className={styles.inlineActions}>
          <button type="submit" className={styles.blueBtn} disabled={questionBusy || lockedExamFields}>{questionBusy ? t('saving') : editingQuestionId ? t('admin_questions_update_question') : t('admin_questions_add_question')}</button>
          <button type="button" className={styles.ghostBtn} onClick={resetQuestionForm}>{t('reset')}</button>
        </div>
      </form>
      <div className={styles.tableCard}>
        <table className={styles.table}>
          <thead><tr><th>{t('admin_questions_order')}</th><th>{t('type')}</th><th>{t('question')}</th><th>{t('admin_questions_points')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>
            {filteredQuestions.length === 0 ? (
              <tr><td colSpan={5}>{t('admin_questions_no_questions_found')}</td></tr>
            ) : filteredQuestions.map((q) => (
              <tr key={q.id}>
                <td>{q.order ?? 0}</td>
                <td>{questionTypeOf(q)}</td>
                <td>{q.text}</td>
                <td>{q.points ?? 1}</td>
                <td className={styles.actionsCell}>
                  <button type="button" disabled={lockedExamFields || deletingQuestionBusyId === q.id} onClick={() => startEditQuestion(q)} aria-label={`${t('edit')} ${q.text || `${t('question')} ${q.order ?? 0}`}`} title={`${t('edit')} ${q.text || `${t('question')} ${q.order ?? 0}`}`}>{t('edit')}</button>
                  {deleteQuestionId === q.id ? (
                    <>
                      <button
                        type="button"
                        className={styles.dangerInlineBtn}
                        disabled={lockedExamFields || deletingQuestionBusyId === q.id}
                        onClick={() => handleDeleteQuestion(q.id)}
                        aria-label={`${t('confirm_delete')} ${q.text || `${t('question')} ${q.order ?? 0}`}`}
                      >
                        {deletingQuestionBusyId === q.id ? t('admin_questions_deleting') : t('confirm_delete')}
                      </button>
                      <button type="button" disabled={deletingQuestionBusyId === q.id} onClick={() => setDeleteQuestionId(null)} aria-label={`${t('cancel')} ${q.text || `${t('question')} ${q.order ?? 0}`}`}>{t('cancel')}</button>
                    </>
                  ) : (
                    <button type="button" disabled={lockedExamFields || deletingQuestionBusyId === q.id} onClick={() => handleDeleteQuestion(q.id)} aria-label={`${t('delete')} ${q.text || `${t('question')} ${q.order ?? 0}`}`} title={`${t('delete')} ${q.text || `${t('question')} ${q.order ?? 0}`}`}>{t('delete')}</button>
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

export default memo(QuestionsTab)
