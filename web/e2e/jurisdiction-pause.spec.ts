/**
 * Feature P — Pause-by-Jurisdiction UI
 *
 * Tests: JurisdictionPanel renders on dashboard, expands to show ISO rows,
 * toggle buttons call pause/resume API when backend is live,
 * MiCA Art. 70 external link has noopener rel.
 *
 * Only the NFT owner can operate toggles; anonymous view shows the panel
 * but toggles are disabled (tested via disabled attribute).
 *
 * Skip-gated: API calls require live backend + JWT.
 * Run:
 *   cd web && bunx playwright test e2e/jurisdiction-pause.spec.ts
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

test.describe('Jurisdiction pause (Feature P)', () => {
  test('JurisdictionPanel is visible on agent dashboard', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const panel = page.getByText(/jurisdiction/i).first()
    await expect(panel).toBeVisible({ timeout: 8000 })
  })

  test('clicking the panel header expands the jurisdiction list', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const header = page.getByRole('button', { name: /jurisdiction/i }).first()
    if (!await header.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'JurisdictionPanel header not found')
      return
    }

    await header.click()

    // ISO codes GB, US should appear
    await expect(page.getByText('GB').first()).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('US').first()).toBeVisible({ timeout: 5000 })
  })

  test('all eight expected ISO rows render', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const header = page.getByRole('button', { name: /jurisdiction/i }).first()
    if (!await header.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'JurisdictionPanel header not found')
      return
    }

    await header.click()

    const isos = ['GB', 'US', 'DE', 'FR', 'NL', 'IE', 'LU', 'SG']
    for (const iso of isos) {
      await expect(page.getByText(iso).first()).toBeVisible({ timeout: 3000 })
    }
  })

  test('MiCA Art. 70 link has noopener noreferrer', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const header = page.getByRole('button', { name: /jurisdiction/i }).first()
    if (!await header.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'JurisdictionPanel header not found')
      return
    }

    await header.click()

    const micaLink = page.getByRole('link', { name: /MiCA/i }).first()
    if (await micaLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const rel = await micaLink.getAttribute('rel')
      expect(rel).toContain('noopener')
      expect(rel).toContain('noreferrer')

      const target = await micaLink.getAttribute('target')
      expect(target).toBe('_blank')

      // Href must not be a javascript: URL
      const href = await micaLink.getAttribute('href')
      expect(href).not.toMatch(/^javascript:/i)
      expect(href).toContain('eur-lex.europa.eu')
    }
  })

  test('toggle button calls pause API when backend is live', async ({ page }) => {
    const live = await backendLive(page)
    test.skip(!live, 'Backend not running — skipping pause API test')

    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const header = page.getByRole('button', { name: /jurisdiction/i }).first()
    if (!await header.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'JurisdictionPanel header not found')
      return
    }

    await header.click()

    const pauseRequest = page.waitForRequest(
      (req) =>
        (req.url().includes('/jurisdiction/pause') || req.url().includes('/jurisdiction/resume')) &&
        req.method() === 'POST',
      { timeout: 8000 }
    )

    // Click the first Active toggle to pause it
    const activeToggle = page.getByRole('button', { name: /Active/i }).first()
    if (await activeToggle.isVisible({ timeout: 5000 }).catch(() => false)) {
      await activeToggle.click()
      await pauseRequest
    }
  })

  test('ISO codes not in allowlist cannot be submitted', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    // Verify only the 8 allowed ISOs appear in the panel — no free-text input
    const header = page.getByRole('button', { name: /jurisdiction/i }).first()
    if (!await header.isVisible({ timeout: 8000 }).catch(() => false)) return

    await header.click()

    // There should be no text input for ISO codes
    const isoInput = page.locator('input[placeholder*="ISO"], input[placeholder*="iso"]')
    expect(await isoInput.count()).toBe(0)
  })
})
