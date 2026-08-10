import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { configDefaults } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  css: {
    preprocessorOptions: {
      scss: {
        // Make the canonical breakpoint helpers available in every SCSS file
        // without a per-file @use. See src/styles/_breakpoints.scss.
        loadPaths: [fileURLToPath(new URL('./src/styles', import.meta.url))],
        additionalData: `@use 'breakpoints' as bp;\n`,
      },
    },
  },
  server: {
    port: 5173
  },
  build: {
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined
          }

          if (
            id.includes(`${'node_modules/react/'}`) ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/react-router-dom/')
          ) {
            return 'react-vendor'
          }

          if (id.includes('node_modules/framer-motion/')) {
            return 'motion-vendor'
          }

          if (id.includes('node_modules/recharts/')) {
            return 'charts-vendor'
          }

          if (id.includes('node_modules/@mui/')) {
            return 'ui-vendor'
          }

          if (
            id.includes('node_modules/axios/') ||
            id.includes('node_modules/jwt-decode/')
          ) {
            return 'data-vendor'
          }

          return undefined
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
})
