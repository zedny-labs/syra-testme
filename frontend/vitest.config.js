import path from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const frontendRoot = fileURLToPath(new URL('./', import.meta.url))

// Points at the copied helper inside the generated unit tree (see
// scripts/run-vitest.mjs). Using the copied location guarantees the wrapper's
// LanguageProvider shares the exact same LanguageContext module instance the
// components import. Normalize to POSIX separators for the alias matcher.
const rtlWrapper = path
  .join(frontendRoot, '.generated-tests', 'unit', 'src', '__support__', 'rtl.jsx')
  .replace(/\\/g, '/')

export default defineConfig({
  root: path.join(frontendRoot, '.generated-tests', 'unit'),
  plugins: [react()],
  resolve: {
    // Every test imports `render` from '@testing-library/react'; route the bare
    // specifier through our wrapper so all renders include <LanguageProvider>.
    // The exact-match regex leaves deep imports (e.g. the ESM build path used
    // inside the wrapper) untouched, preventing recursion.
    alias: [{ find: /^@testing-library\/react$/, replacement: rtlWrapper }],
  },
  server: {
    fs: {
      allow: [frontendRoot],
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx,ts,tsx}'],
    exclude: ['tests/e2e/**'],
  },
})
