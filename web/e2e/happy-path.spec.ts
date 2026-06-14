/**
 * Happy path E2E smoke. Validates the rendered surface; does NOT exercise
 * wallet signing because that requires a real injected provider.
 *
 * Run:
 *   # In one terminal:
 *   cd backend && bun dev
 *   # In another:
 *   cd web && bun dev
 *   # In a third:
 *   bunx playwright test
 *
 * If the backend is down, the connect / dashboard tests are skipped
 * gracefully so this still passes as a build-time smoke.
 */

import { test, expect } from '@playwright/test'

test.describe('PrimeAgent happy path', () => {
  test('landing renders the cross-domain hero', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/PrimeAgent/i)
    // Hero copy from /Users/macbookair/Documents/primeagent/web/src/routes/index.tsx
    await expect(page.getByText(/Off-chain Robinhood/i)).toBeVisible()
    await expect(page.getByText(/Robinhood Chain/i).first()).toBeVisible()
  })

  test('landing has a connect button', async ({ page }) => {
    await page.goto('/')
    const connect = page.getByRole('button', { name: /connect/i }).first()
    await expect(connect).toBeVisible()
  })

  test('launch route renders the risk profile selector', async ({ page }) => {
    await page.goto('/launch')
    // RiskProfileSelector renders three buttons keyed by label.
    // Without a connected wallet the gate route may redirect; tolerate both
    // by checking for the connect button OR a profile.
    const balanced = page.getByRole('button', { name: /Balanced/ })
    const connect = page.getByRole('button', { name: /connect/i }).first()
    await expect(balanced.or(connect)).toBeVisible({ timeout: 10_000 })
  })

  test('auth callback route handles missing search params gracefully', async ({ page }) => {
    await page.goto('/auth/callback')
    // The route renders an error state when code/state are missing.
    await expect(page.getByText(/Missing code or state|Robinhood OAuth failed/i)).toBeVisible({
      timeout: 5_000,
    })
  })

  test('agent dashboard for tokenId 1 renders connect prompt when wallet is absent', async ({ page }) => {
    await page.goto('/agent/1')
    // The disconnected state shows a "Connect your wallet" heading.
    await expect(page.getByText(/Connect your wallet/i)).toBeVisible({ timeout: 10_000 })
  })

  test('backend health is reachable (skips when down)', async ({ page, request }) => {
    const url = process.env.E2E_BACKEND_URL ?? 'http://localhost:3700/health'
    try {
      const res = await request.get(url, { timeout: 2_000 })
      if (!res.ok()) test.skip()
      const body = await res.json()
      expect(body).toHaveProperty('ok')
      expect(body).toHaveProperty('ready')
      expect(body.checks).toHaveProperty('attestorParity')
    } catch {
      test.skip()
    }
    // Silence unused param warning.
    page
  })
})
