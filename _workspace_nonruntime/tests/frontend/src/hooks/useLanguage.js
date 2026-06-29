// Test override for the i18n hook (overlaid onto the generated test tree by
// frontend/scripts/run-vitest.mjs).
//
// The real useLanguage() throws unless a <LanguageProvider> is mounted, but the
// mirrored unit tests render components in isolation without that provider.
// This copy supplies a stable default English context so any component may call
// useLanguage() during a unit test. Translations are pulled from the real
// ../locales bundle, so t() returns the same strings as production and existing
// text-based assertions keep working.
import { translations, languages, rtlLanguages } from '../locales';

const lang = 'en';

function t(key, vars) {
  let str = translations[lang]?.[key] ?? translations.en?.[key] ?? key;
  if (vars && typeof vars === 'object') {
    Object.entries(vars).forEach(([k, v]) => {
      str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v ?? ''));
    });
  }
  return str;
}

const context = {
  lang,
  t,
  setLanguage: () => {},
  dir: rtlLanguages.includes(lang) ? 'rtl' : 'ltr',
  fontFamily: null,
  languages,
};

export function LanguageProvider({ children }) {
  return children;
}

export default function useLanguage() {
  return context;
}