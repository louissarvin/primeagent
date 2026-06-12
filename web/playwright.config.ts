/**
 * Playwright E2E config.
 *
 * Install:
 *   bun add -d @playwright/test
 *   bunx playwright install chromium
 *
 * Run:
 *   # Make sure backend (3700) and web (3200) are running locally.
 *   bunx playwright test
 *
 * The test in `e2e/happy-path.spec.ts` exercises the landing -> connect ->
 * dashboard route flow. It does NOT exercise wallet signing because that
 * needs a real injected provider; it covers the rendered surface.
 */

import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.WEB_PORT ?? 3200)
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
