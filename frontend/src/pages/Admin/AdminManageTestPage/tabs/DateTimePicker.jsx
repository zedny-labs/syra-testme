import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import useLanguage from '../../../../hooks/useLanguage'
import styles from './DateTimePicker.module.scss'

// ── date helpers (no external date lib) ─────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0')

// Serialize a Date to the "YYYY-MM-DDTHH:mm" local shape that datetime-local /
// `new Date(str)` expect (parent still does `new Date(value).toISOString()`).
function toInputValue(date) {
  if (!date) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function parseValue(str) {
  if (!str) return null
  const d = new Date(str)
  return Number.isNaN(d.getTime()) ? null : d
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }

// Build a 6-row (42-cell) grid of Dates covering the month `view` sits in,
// padded with leading/trailing days so weeks line up under the weekday header.
function monthGrid(view) {
  const first = new Date(view.getFullYear(), view.getMonth(), 1)
  const start = addDays(first, -first.getDay()) // back up to Sunday
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1)          // 1..12
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5)         // 0,5,..,55

export default function DateTimePicker({ value, onChange, disabled }) {
  const { t } = useLanguage()
  const selected = useMemo(() => parseValue(value), [value])
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(() => startOfDay(selected || new Date()))
  const rootRef = useRef(null)

  // Close on outside-click / Escape.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Keep the visible month in sync when a value arrives from outside.
  useEffect(() => { if (selected) setView(startOfDay(selected)) }, [selected])

  const today = startOfDay(new Date())
  const locale = (typeof navigator !== 'undefined' && navigator.language) || 'en-US'
  const monthLabel = view.toLocaleDateString(locale, { month: 'long', year: 'numeric' })
  const weekdays = useMemo(() => {
    const base = new Date(2024, 0, 7) // a Sunday
    return Array.from({ length: 7 }, (_, i) => addDays(base, i).toLocaleDateString(locale, { weekday: 'short' }))
  }, [locale])

  const commit = (date) => onChange(toInputValue(date))

  // Merge a chosen calendar day with the currently-selected time (default 09:00).
  const pickDay = (day) => {
    const base = selected || new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0)
    commit(new Date(day.getFullYear(), day.getMonth(), day.getDate(), base.getHours(), base.getMinutes()))
  }

  // Merge a chosen time with the currently-selected day (default today).
  const pickTime = ({ h12, min, meridiem }) => {
    const d = selected ? new Date(selected) : new Date(today)
    const cur12 = ((d.getHours() + 11) % 12) + 1
    const curMer = d.getHours() >= 12 ? 'PM' : 'AM'
    const H = h12 ?? cur12
    const M = min ?? d.getMinutes()
    const mer = meridiem ?? curMer
    let h24 = H % 12
    if (mer === 'PM') h24 += 12
    d.setHours(h24, M, 0, 0)
    commit(d)
  }

  const applyPreset = (date) => { commit(date); setView(startOfDay(date)); setOpen(false) }
  const presets = () => {
    const now = new Date()
    const inHour = new Date(now.getTime() + 60 * 60 * 1000)
    const tomorrow9 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0)
    const daysToMon = ((8 - now.getDay()) % 7) || 7
    const nextMon9 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToMon, 9, 0)
    return [
      { key: 'in1h', label: t('dtp_in_1h'), date: inHour },
      { key: 'tom9', label: t('dtp_tomorrow_9'), date: tomorrow9 },
      { key: 'mon9', label: t('dtp_next_monday_9'), date: nextMon9 },
    ]
  }

  const grid = monthGrid(view)
  const cur12 = selected ? ((selected.getHours() + 11) % 12) + 1 : 9
  const curMin = selected ? Math.round(selected.getMinutes() / 5) * 5 % 60 : 0
  const curMer = selected && selected.getHours() >= 12 ? 'PM' : 'AM'

  const triggerText = selected
    ? selected.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })
      + ' · ' + selected.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
    : t('dtp_pick')

  return (
    <div className={styles.dtp} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''} ${selected ? '' : styles.placeholder}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((o) => !o)}
      >
        <svg className={styles.calIcon} width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="3" y="4.5" width="18" height="17" rx="3" /><path d="M3 9h18M8 2.5v4M16 2.5v4" />
        </svg>
        <span className={styles.triggerText}>{triggerText}</span>
        <svg className={`${styles.chev} ${open ? styles.chevUp : ''}`} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className={styles.pop}
            role="dialog"
            aria-label={t('dtp_pick')}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
          >
            <div className={styles.presets}>
              {presets().map((p) => (
                <button key={p.key} type="button" className={styles.chip} onClick={() => applyPreset(p.date)}>
                  {p.label}
                </button>
              ))}
            </div>

            <div className={styles.calHead}>
              <button type="button" className={styles.navBtn} aria-label="previous month" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}>
                <svg className="rtl-flip" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
              </button>
              <div className={styles.monthLabel}>{monthLabel}</div>
              <button type="button" className={styles.navBtn} aria-label="next month" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}>
                <svg className="rtl-flip" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
              </button>
            </div>

            <div className={styles.weekRow}>
              {weekdays.map((w, i) => <span key={i} className={styles.weekday}>{w}</span>)}
            </div>

            <div className={styles.grid}>
              {grid.map((day) => {
                const inMonth = day.getMonth() === view.getMonth()
                const isPast = day < today
                const isToday = sameDay(day, today)
                const isSel = sameDay(day, selected)
                return (
                  <button
                    key={day.toISOString()}
                    type="button"
                    disabled={isPast}
                    className={[
                      styles.day,
                      inMonth ? '' : styles.outMonth,
                      isToday ? styles.today : '',
                      isSel ? styles.selDay : '',
                    ].join(' ')}
                    onClick={() => pickDay(day)}
                  >
                    {day.getDate()}
                  </button>
                )
              })}
            </div>

            <div className={styles.timeRow}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
              <select className={styles.timeSel} value={cur12} onChange={(e) => pickTime({ h12: Number(e.target.value) })}>
                {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
              <span className={styles.colon}>:</span>
              <select className={styles.timeSel} value={curMin} onChange={(e) => pickTime({ min: Number(e.target.value) })}>
                {MINUTES.map((m) => <option key={m} value={m}>{pad(m)}</option>)}
              </select>
              <div className={styles.meridiem}>
                {['AM', 'PM'].map((mer) => (
                  <button
                    key={mer}
                    type="button"
                    className={`${styles.merBtn} ${curMer === mer ? styles.merOn : ''}`}
                    onClick={() => pickTime({ meridiem: mer })}
                  >
                    {mer}
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.popFoot}>
              <button type="button" className={styles.clearBtn} onClick={() => { onChange(''); setOpen(false) }}>{t('dtp_clear')}</button>
              <button type="button" className={styles.doneBtn} onClick={() => setOpen(false)}>{t('dtp_done')}</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
