import React, { useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { adminApi } from '../../../services/admin.service'
import useLanguage from '../../../hooks/useLanguage'
import { buildQuestions, templateAnswers, templateLegend, templateQuestions } from '../../../utils/parseQuestionRows'
import styles from './AdminQuestionPools.module.scss'

function resolveError(err, fallback) {
  if (err?.userMessage) return err.userMessage
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string') return detail
  return fallback
}

const REASON_KEYS = {
  missing_text: 'admin_pools_import_err_missing_text',
  unknown_type: 'admin_pools_import_err_unknown_type',
  missing_correct_answer: 'admin_pools_import_err_missing_answer',
  need_2_options: 'admin_pools_import_err_need_2_options',
  need_1_option: 'admin_pools_import_err_need_1_option',
  truefalse_answer: 'admin_pools_import_err_truefalse',
  matching_pair_format: 'admin_pools_import_err_matching_format',
  one_correct: 'admin_pools_import_err_one_correct',
  orphan_answer: 'admin_pools_import_err_orphan_answer',
  duplicate_id: 'admin_pools_import_err_duplicate_id',
}

export default function BulkImportQuestionsModal({ pools, onClose, onImported }) {
  const { t } = useLanguage()
  const fileRef = useRef()
  const [target, setTarget] = useState('new')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [existingPoolId, setExistingPoolId] = useState(pools[0]?.id || '')
  const [mapped, setMapped] = useState([])
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)

  const validRows = useMemo(() => mapped.filter((row) => row.payload), [mapped])
  const invalidRows = useMemo(() => mapped.filter((row) => row.error), [mapped])

  const reasonText = (code) => t(REASON_KEYS[code] || 'admin_pools_import_err_unknown_type')

  const handleFile = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    setError('')
    try {
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: 'array' })
      const pickSheet = (title) => {
        const found = workbook.SheetNames.find((sheetTitle) => sheetTitle.toLowerCase() === title)
        return found ? workbook.Sheets[found] : null
      }
      const toMatrix = (sheet) => (sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false, raw: false }) : [])
      const questionsSheet = pickSheet('questions') || workbook.Sheets[workbook.SheetNames[0]]
      const answersSheet = pickSheet('answers')
      const rows = buildQuestions(toMatrix(questionsSheet), toMatrix(answersSheet))
      setMapped(rows)
      if (!rows.length) setError(t('admin_pools_import_no_rows'))
    } catch (err) {
      setMapped([])
      setError(t('admin_pools_import_parse_error'))
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const downloadTemplate = () => {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(templateQuestions()), 'Questions')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(templateAnswers()), 'Answers')
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(templateLegend()), 'Legend')
    XLSX.writeFile(workbook, 'question-import-template.xlsx')
  }

  const targetReady = target === 'existing' ? Boolean(existingPoolId) : Boolean(name.trim())
  const canImport = validRows.length > 0 && targetReady && !importing

  const handleImport = async () => {
    if (!canImport) return
    setImporting(true)
    setError('')
    let createdNewPoolName = ''
    try {
      let poolId = existingPoolId
      let poolName = pools.find((pool) => String(pool.id) === String(existingPoolId))?.name || ''
      if (target === 'new') {
        const { data } = await adminApi.createQuestionPool({ name: name.trim(), description: description.trim() || null })
        poolId = data.id
        poolName = data.name
        createdNewPoolName = data.name
      }
      const { data } = await adminApi.bulkCreatePoolQuestions(poolId, validRows.map((row) => row.payload))
      onImported(t('admin_pools_import_done', { count: data.created, pool: poolName }))
    } catch (err) {
      // If the new pool was created but the questions failed, it now exists empty —
      // tell the user so they can retry against it via "Existing pool" instead of duplicating it.
      if (createdNewPoolName) {
        setError(t('admin_pools_import_partial', { pool: createdNewPoolName }))
      } else {
        setError(resolveError(err, t('admin_pools_import_parse_error')))
      }
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={importing ? undefined : onClose}>
      <div className={styles.modalWide} role="dialog" aria-modal="true" aria-labelledby="bulk-import-title" onClick={(event) => event.stopPropagation()}>
        <h3 id="bulk-import-title" className={styles.modalTitle}>{t('admin_pools_import_title')}</h3>
        {error && <div className={styles.modalError}>{error}</div>}

        <div className={styles.formGroup}>
          <span className={styles.label}>{t('admin_pools_import_target')}</span>
          <div className={styles.radioRow}>
            <label>
              <input type="radio" name="bulk-target" checked={target === 'new'} onChange={() => setTarget('new')} />
              {t('admin_pools_import_target_new')}
            </label>
            <label>
              <input type="radio" name="bulk-target" checked={target === 'existing'} onChange={() => setTarget('existing')} disabled={!pools.length} />
              {t('admin_pools_import_target_existing')}
            </label>
          </div>
        </div>

        {target === 'new' ? (
          <>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="bulk-pool-name">{t('name')}</label>
              <input id="bulk-pool-name" className={styles.input} value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="bulk-pool-desc">{t('description')}</label>
              <input id="bulk-pool-desc" className={styles.input} value={description} onChange={(event) => setDescription(event.target.value)} />
            </div>
          </>
        ) : (
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="bulk-pool-select">{t('admin_pools_import_select_pool')}</label>
            <select id="bulk-pool-select" className={styles.input} value={existingPoolId} onChange={(event) => setExistingPoolId(event.target.value)}>
              {pools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name}</option>)}
            </select>
          </div>
        )}

        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="bulk-file">{t('admin_pools_import_file')}</label>
          <input id="bulk-file" ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleFile} />
          <div className={styles.filterMeta}>{t('admin_pools_import_file_hint')}</div>
          <button type="button" className={styles.actionBtn} onClick={downloadTemplate}>{t('admin_pools_import_download_template')}</button>
        </div>

        {mapped.length > 0 && (
          <div className={styles.previewBox}>
            <div className={styles.filterMeta}>{t('admin_pools_import_preview', { valid: validRows.length, invalid: invalidRows.length })}</div>
            <div className={styles.previewList}>
              {mapped.slice(0, 50).map((row) => (
                <div key={row.row} className={row.error ? styles.previewRowBad : styles.previewRowOk}>
                  <span className={styles.questionIndex}>{row.row}.</span>
                  <span>{row.payload ? row.payload.text : t('admin_pools_import_row_error', { row: row.row, reason: reasonText(row.error) })}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={styles.modalActions}>
          <button type="button" className={styles.btnCancel} onClick={onClose} disabled={importing}>{t('cancel')}</button>
          <button type="button" className={styles.btnPrimary} onClick={() => void handleImport()} disabled={!canImport}>
            {importing ? t('admin_pools_import_importing') : t('admin_pools_import_submit', { count: validRows.length })}
          </button>
        </div>
      </div>
    </div>
  )
}
