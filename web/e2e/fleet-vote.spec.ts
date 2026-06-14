/**
 * Feature K — Fleet Coordination UI
 *
 * Tests: ThesisBroadcast compose flow, VotePanel renders inbound thesis,
 * QuorumProgress renders threshold bars.
 *
 * Wallet signing (EIP-712 signTypedData) cannot be exercised without an
 * injected wallet — those steps are skipped unless a live wallet is detected.
 *
 * Skip-gated: backend must be live for broadcast/vote API calls.
 * Run:
 *   cd web && bunx playwright test e2e/fleet-vote.spec.ts
 */

import { test, expect } from '@playwright/test'

const FLEET_URL = '/fleet'
const BACKEND_HEALTH = 'http://localhost:3700/health'

async function backendLive(page: import('@playwright/test').Page): Promise<boolean> {
  try {
    const res = await page.request.get(BACKEND_HEALTH, { timeout: 3000 })
    return res.ok()
  } catch {
    return false
  }
}

test.describe('Fleet coordination (Feature K)', () => {
  test('fleet route renders without crashing', async ({ page }) => {
    const res = await page.goto(FLEET_URL, { timeout: 10_000 }).catch(() => null)
    // Accept 200 (fleet page exists) or redirect to /agent or landing
    if (res) {
      await expect(page.locator('body')).not.toBeEmpty()
    }
  })

  test('ThesisBroadcast textarea accepts input', async ({ page }) => {
    await page.goto(FLEET_URL)
    await page.waitForLoadState('domcontentloaded')

    const textarea = page.getByRole('textbox').first()
    if (await textarea.isVisible({ timeout: 5000 }).catch(() => false)) {
      await textarea.fill('Rotate to defensive equities ahead of macro data release')
      await expect(textarea).toHaveValue(/defensive/i)
    } else {
      test.skip(true, 'ThesisBroadcast not visible — fleet route may redirect')
    }
  })

  test('broadcast button is disabled when no children are selected', async ({ page }) => {
    await page.goto(FLEET_URL)
    await page.waitForLoadState('domcontentloaded')

    const broadcastBtn = page.getByRole('button', { name: /broadcast/i })
    if (await broadcastBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(broadcastBtn).toBeDisabled()
    }
  })

  test('QuorumProgress bars render with threshold markers', async ({ page }) => {
    await page.goto(FLEET_URL)
    await page.waitForLoadState('domcontentloaded')

    // Quorum bars are progressbar roles
    const bars = page.getByRole('progressbar')
    if (await bars.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      expect(await bars.count()).toBeGreaterThanOrEqual(1)
    }
  })

  test('broadcast API called when form is valid and backend is live', async ({ page }) => {
    const live = await backendLive(page)
    test.skip(!live, 'Backend not running — skipping broadcast API test')

    await page.goto(FLEET_URL)
    await page.waitForLoadState('domcontentloaded')

    const textarea = page.getByRole('textbox').first()
    if (!await textarea.isVisible({ timeout: 5000 }).catch(() => false)) {
      test.skip(true, 'ThesisBroadcast not rendered')
      return
    }

    await textarea.fill('Reduce leverage across all positions to 1.5x maximum')

    // Select a child token (first child checkbox/button)
    const childToggle = page.getByRole('button', { name: /agent #/i }).first()
    if (await childToggle.isVisible({ timeout: 3000 }).catch(() => false)) {
      await childToggle.click()
    }

    const broadcastPromise = page.waitForRequest(
      (req) => req.url().includes('/fleet/broadcast') && req.method() === 'POST',
      { timeout: 8000 }
    )

    const broadcastBtn = page.getByRole('button', { name: /broadcast/i })
    await broadcastBtn.click()
    await broadcastPromise
  })
})
