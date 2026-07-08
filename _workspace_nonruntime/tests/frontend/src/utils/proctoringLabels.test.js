import { describe, expect, it, vi } from 'vitest'

import { translateEventType, translateSeverity } from './proctoringLabels'

describe('translateEventType', () => {
  it('maps known event types to their locale keys', () => {
    const t = vi.fn((key) => `translated:${key}`)
    expect(translateEventType('FACE_MISMATCH', t)).toBe('translated:admin_wizard_alert_face_mismatch')
    expect(translateEventType('TAB_SWITCH', t)).toBe('translated:admin_wizard_alert_tab_switch')
    expect(translateEventType('SCREEN_SHARE_LOST', t)).toBe('translated:proctor_event_SCREEN_SHARE_LOST')
  })

  it('aliases FORBIDDEN_OBJECT to FORBIDDEN_OBJ locale key', () => {
    const t = vi.fn((key) => key)
    expect(translateEventType('FORBIDDEN_OBJECT', t)).toBe('admin_wizard_alert_forbidden_obj')
    expect(translateEventType('FORBIDDEN_OBJ', t)).toBe('admin_wizard_alert_forbidden_obj')
  })

  it('normalizes whitespace and lowercase before lookup', () => {
    const t = (key) => key
    expect(translateEventType('  face mismatch  ', t)).toBe('admin_wizard_alert_face_mismatch')
    expect(translateEventType('tab_switch', t)).toBe('admin_wizard_alert_tab_switch')
  })

  it('falls back to a humanized string for unknown event types', () => {
    const t = vi.fn()
    expect(translateEventType('SOMETHING_ELSE', t)).toBe('SOMETHING ELSE')
    expect(t).not.toHaveBeenCalled()
  })

  it('returns falsy input unchanged', () => {
    const t = vi.fn()
    expect(translateEventType('', t)).toBe('')
    expect(translateEventType(null, t)).toBe(null)
    expect(translateEventType(undefined, t)).toBe(undefined)
  })
})

describe('translateSeverity', () => {
  it('maps known severities to locale keys', () => {
    const t = (key) => `t:${key}`
    expect(translateSeverity('HIGH', t)).toBe('t:proctor_severity_high')
    expect(translateSeverity('medium', t)).toBe('t:proctor_severity_medium')
    expect(translateSeverity('Low', t)).toBe('t:proctor_severity_low')
  })

  it('returns the raw severity when unknown', () => {
    const t = vi.fn()
    expect(translateSeverity('CRITICAL', t)).toBe('CRITICAL')
    expect(t).not.toHaveBeenCalled()
  })

  it('returns falsy input unchanged', () => {
    const t = vi.fn()
    expect(translateSeverity('', t)).toBe('')
    expect(translateSeverity(null, t)).toBe(null)
  })
})
