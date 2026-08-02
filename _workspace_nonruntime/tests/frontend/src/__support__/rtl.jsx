/**
 * Shared React Testing Library wrapper for the unit suite.
 *
 * Every component test imports `render` from `@testing-library/react`, which is
 * aliased to this module in `vitest.config.js`. We re-export the full RTL API
 * untouched and only override `render` / `renderHook` so that every rendered
 * tree is wrapped in the app's real <LanguageProvider>. Components call
 * useLanguage(); without the provider they throw
 * "useLanguage must be used within a <LanguageProvider>".
 *
 * IMPORTANT: this file is copied into the generated `unit/src` tree next to the
 * mirrored app source, so `../hooks/useLanguage` resolves to the SAME module
 * instance the components import — i.e. the same LanguageContext. Importing the
 * provider from the original frontend/src tree would create a second context
 * object and the provider would not satisfy the components' useContext().
 *
 * The real RTL implementation is imported via its ESM build path so it bypasses
 * the bare-specifier alias (which would otherwise recurse into this file).
 */
import { createElement } from 'react'
import * as rtl from '@testing-library/react/dist/@testing-library/react.esm.js'

import { LanguageProvider } from '../hooks/useLanguage'

// Compose LanguageProvider as the OUTERMOST provider, preserving any per-test
// `wrapper` (e.g. a custom context) nested inside it.
function buildWrapper(UserWrapper) {
  return function AllProviders({ children }) {
    const tree = UserWrapper ? createElement(UserWrapper, null, children) : children
    return createElement(LanguageProvider, null, tree)
  }
}

export function render(ui, options = {}) {
  return rtl.render(ui, { ...options, wrapper: buildWrapper(options.wrapper) })
}

export function renderHook(callback, options = {}) {
  return rtl.renderHook(callback, { ...options, wrapper: buildWrapper(options.wrapper) })
}

// Re-export screen, fireEvent, waitFor, cleanup, act, within, etc. unchanged.
// The explicit render/renderHook above take precedence over these star exports.
export * from '@testing-library/react/dist/@testing-library/react.esm.js'
