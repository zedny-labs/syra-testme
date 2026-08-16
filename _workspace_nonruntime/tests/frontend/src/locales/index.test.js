import { describe, expect, it } from 'vitest'

import { languages, rtlLanguages, translations } from './index'

// useLanguage.js derives `dir` purely from rtlLanguages, while
// applyDocumentAttributes() sets document.documentElement.dir from each
// language's own `dir` field in `languages`. These two sources of truth must
// agree, or the app and the <html dir> attribute would disagree about which
// languages are RTL.
describe('rtlLanguages / languages dir consistency', () => {
  it('flags exactly the languages whose metadata says dir: rtl', () => {
    const metadataRtl = languages.filter((l) => l.dir === 'rtl').map((l) => l.code).sort()
    expect([...rtlLanguages].sort()).toEqual(metadataRtl)
  })

  it('currently covers Arabic and Urdu', () => {
    expect(new Set(rtlLanguages)).toEqual(new Set(['ar', 'ur']))
  })

  it('every language entry has ltr or rtl (no typos/missing values)', () => {
    languages.forEach((l) => {
      expect(['ltr', 'rtl']).toContain(l.dir)
    })
  })
})

describe('ar/ur translation completeness', () => {
  const enKeys = Object.keys(translations.en)

  it.each(['ar', 'ur'])('%s has no keys missing relative to en', (locale) => {
    const missing = enKeys.filter((key) => !(key in translations[locale]))
    expect(missing).toEqual([])
  })
})
