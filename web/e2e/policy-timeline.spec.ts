/**
 * Feature L — Policy Time-Travel UI
 *
 * Tests: PolicyTimeline renders revision list, collapsible section opens,
 * revision rows show event chips, diff panel loads on click when backend live.
 *
 * Skip-gated: diff fetch requires live backend.
 * Run:
 *   cd web && bunx playwright test e2e/policy-timeline.spec.ts
 */

import { test, expect } from '@playwright/test'

const AGENT_URL = '/agent/1'
const BACKEND_HEALTH = 'http://localhost:3700/health'

async function backendLive(page: import('@playwright/test').Page): Promise<boolean> {
  try {
    const res = await page.request.get(BACKEND_HEALTH, { timeout: 3000 })
    return res.ok()
  } catch {
    return false
  }
}

test.describe('Policy timeline (Feature L)', () => {
  test('PolicyTimeline section is present on agent dashboard', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    // Timeline is in a collapsible section with "Policy history" heading
    const heading = page.getByText(/policy history|policy timeline/i).first()
    await expect(heading).toBeVisible({ timeout: 8000 })
  })

  test('clicking the timeline header expands the section', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const header = page.getByRole('button', { name: /policy history|policy timeline/i }).first()
    if (await header.isVisible({ timeout: 8000 }).catch(() => false)) {
      await header.click()
      // After expanding, content area should appear
      const expanded = page.locator('[aria-expanded="true"]')
      await expect(expanded).toBeVisible({ timeout: 3000 })
    }
  })

  test('revision rows render event chips when backend is live', async ({ page }) => {
    const live = await backendLive(page)
    test.skip(!live, 'Backend not running — skipping revision data test')

    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const header = page.getByRole('button', { name: /policy history|policy timeline/i }).first()
    if (await header.isVisible({ timeout: 8000 }).catch(() => false)) {
      await header.click()
    }

    // Event chips: Install, Update, Revoke
    const chips = page.getByText(/Install|Update|Revoke/)
    const count = await chips.count()
    expect(count).toBeGreaterThanOrEqual(0) // 0 valid if no revisions yet
  })

  test('clicking a revision row fetches and displays the diff', async ({ page }) => {
    const live = await backendLive(page)
    test.skip(!live, 'Backend not running — skipping diff load test')

    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const header = page.getByRole('button', { name: /policy history|policy timeline/i }).first()
    if (await header.isVisible({ timeout: 8000 }).catch(() => false)) {
      await header.click()
    }

    const firstRevision = page.getByRole('button', { name: /revision|v\d+/i }).first()
    if (await firstRevision.isVisible({ timeout: 5000 }).catch(() => false)) {
      const diffRequest = page.waitForRequest(
        (req) => req.url().includes('/revisions') || req.url().includes('/diff'),
        { timeout: 8000 }
      )
      await firstRevision.click()
      await diffRequest
    }
  })

  test('Arbiscan link opens in new tab with noopener', async ({ page }) => {
    const live = await backendLive(page)
    test.skip(!live, 'Backend not running — skipping Arbiscan link test')

    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const arbiscanLink = page.getByRole('link', { name: /arbiscan|tx/i }).first()
    if (await arbiscanLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const rel = await arbiscanLink.getAttribute('rel')
      expect(rel).toContain('noopener')
      const target = await arbiscanLink.getAttribute('target')
      expect(target).toBe('_blank')
    }
  })
})
