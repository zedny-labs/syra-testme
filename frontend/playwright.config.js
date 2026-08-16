// @ts-check
import { defineConfig, devices } from '@playwright/test'

const backendPort = process.env.PLAYWRIGHT_BACKEND_PORT || '8000'
const frontendPort = process.env.PLAYWRIGHT_FRONTEND_PORT || '5173'
const backendBaseURL = process.env.BACKEND_BASE_URL || `http://127.0.0.1:${backendPort}`
const baseURL = process.env.PLAYWRIGHT_BASE_URL || process.env.FRONTEND_BASE_URL || `http://127.0.0.1:${frontendPort}`
const apiBaseURL = process.env.API_BASE_URL || `${backendBaseURL}/api/`
const testDir = process.env.PLAYWRIGHT_TEST_DIR || '.generated-tests/e2e'
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER
  ? process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === 'true'
  : true

export default defineConfig({
  testDir,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-US',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `python -m alembic upgrade head && python -m uvicorn src.app.main:app --host 127.0.0.1 --port ${backendPort}`,
      cwd: '../backend',
      url: `${backendBaseURL}/api/health`,
      reuseExistingServer,
      timeout: 180_000,
      env: {
        ...process.env,
        JWT_SECRET: process.env.JWT_SECRET || process.env.SECRET_KEY || 'test-secret-key-with-at-least-32-chars',
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql+psycopg://postgres:password@localhost:5432/syra_lms',
        AUTO_APPLY_MIGRATIONS: process.env.AUTO_APPLY_MIGRATIONS || 'false',
        BACKEND_BASE_URL: backendBaseURL,
        FRONTEND_BASE_URL: process.env.FRONTEND_BASE_URL || `http://127.0.0.1:${frontendPort}`,
        E2E_SEED_ENABLED: process.env.E2E_SEED_ENABLED || 'true',
        PRECHECK_ALLOW_TEST_BYPASS: process.env.PRECHECK_ALLOW_TEST_BYPASS || 'true',
        MEDIA_STORAGE_PROVIDER: process.env.MEDIA_STORAGE_PROVIDER || 'local',
        PROCTORING_VIDEO_STORAGE_PROVIDER: process.env.PROCTORING_VIDEO_STORAGE_PROVIDER || 'supabase',
      },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${frontendPort}`,
      cwd: '.',
      url: baseURL,
      reuseExistingServer,
      timeout: 180_000,
      env: {
        ...process.env,
        VITE_API_BASE_URL: apiBaseURL,
      },
    },
  ],
})
