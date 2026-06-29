import React, { useRef, useState } from 'react'
import { adminApi } from '../../services/admin.service'
import styles from './QuestionImageUpload.module.scss'

const ACCEPT = 'image/png,image/jpeg,image/webp'
const ALLOWED = ['image/png', 'image/jpeg', 'image/webp']
const MAX_BYTES = 5 * 1024 * 1024

export default function QuestionImageUpload({ value, onChange, disabled = false, t }) {
  const inputRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  const pick = () => {
    if (disabled || uploading) return
    inputRef.current?.click()
  }

  const handleFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = '' // allow re-selecting the same file
    if (!file) return
    setError('')
    if (!ALLOWED.includes(file.type)) {
      setError(t('admin_questions_image_bad_type'))
      return
    }
    if (file.size > MAX_BYTES) {
      setError(t('admin_questions_image_too_large'))
      return
    }
    setUploading(true)
    try {
      const { data } = await adminApi.uploadQuestionImage(file)
      onChange(data.image_url)
    } catch {
      setError(t('admin_questions_image_upload_failed'))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <span className={styles.label}>{t('admin_questions_image_label')}</span>
      {value ? (
        <div className={styles.preview}>
          <img className={styles.thumb} src={value} alt={t('admin_questions_image_alt')} />
          <button type="button" className={styles.removeBtn} onClick={() => onChange(null)} disabled={disabled || uploading}>
            {t('admin_questions_image_remove')}
          </button>
        </div>
      ) : (
        <button type="button" className={styles.addBtn} onClick={pick} disabled={disabled || uploading}>
          {uploading ? t('admin_questions_image_uploading') : t('admin_questions_image_add')}
        </button>
      )}
      <input ref={inputRef} type="file" accept={ACCEPT} className={styles.hiddenInput} onChange={handleFile} />
      {error && <div className={styles.error}>{error}</div>}
    </div>
  )
}
