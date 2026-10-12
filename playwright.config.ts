import { defineConfig } from '@playwright/test'

// Browser journeys drive the installed Google Chrome (channel 'chrome') in a fresh temporary profile, so no
// browser download is needed and the user's own Chrome profile is never touched.
export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm web:dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
