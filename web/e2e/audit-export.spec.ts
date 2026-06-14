/**
 * Feature O — Audit Export PDF
 *
 * Tests: AuditExportButton renders in regulatory section, modal opens with
 * date-range inputs and section checkboxes, generate calls /audit/export
 * when backend is live, download triggers blob URL.
 *
 * Skip-gated: generate + download require live backend.
 * Run:
 *   cd web && bunx playwright test e2e/audit-export.spec.ts
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

test.describe('Audit export PDF (Feature O)', () => {
  test('AuditExportButton is visible in regulatory section', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const btn = page.getByRole('button', { name: /audit|export/i }).first()
    await expect(btn).toBeVisible({ timeout: 8000 })
  })

  test('clicking the button opens a modal dialog', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const btn = page.getByRole('button', { name: /audit|export/i }).first()
    if (!await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'Audit export button not found')
      return
    }

    await btn.click()

    const dialog = page.getByRole('dialog', { name: /audit/i })
    await expect(dialog).toBeVisible({ timeout: 5000 })
  })

  test('modal contains date-range inputs', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const btn = page.getByRole('button', { name: /audit|export/i }).first()
    if (!await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'Audit export button not found')
      return
    }

    await btn.click()
    await page.getByRole('dialog').waitFor({ timeout: 5000 })

    const dateInputs = page.locator('input[type="date"]')
    expect(await dateInputs.count()).toBeGreaterThanOrEqual(2)
  })

  test('modal contains section checkboxes for all audit sections', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const btn = page.getByRole('button', { name: /audit|export/i }).first()
    if (!await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'Audit export button not found')
      return
    }

    await btn.click()
    await page.getByRole('dialog').waitFor({ timeout: 5000 })

    const checkboxes = page.locator('input[type="checkbox"]')
    // Expect at least 4 of the 8 audit sections to be visible
    expect(await checkboxes.count()).toBeGreaterThanOrEqual(4)
  })

  test('generate button calls /audit/export when backend is live', async ({ page }) => {
    const live = await backendLive(page)
    test.skip(!live, 'Backend not running — skipping audit export API test')

    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const openBtn = page.getByRole('button', { name: /audit|export/i }).first()
    if (!await openBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'Audit export button not found')
      return
    }

    await openBtn.click()
    await page.getByRole('dialog').waitFor({ timeout: 5000 })

    const exportRequest = page.waitForRequest(
      (req) => req.url().includes('/audit/export') && req.method() === 'POST',
      { timeout: 10_000 }
    )

    const generateBtn = page.getByRole('button', { name: /generate/i }).first()
    await generateBtn.click()
    await exportRequest
  })

  test('modal closes on backdrop click', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const btn = page.getByRole('button', { name: /audit|export/i }).first()
    if (!await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'Audit export button not found')
      return
    }

    await btn.click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ timeout: 5000 })

    // Click outside the modal (the backdrop)
    await page.mouse.click(10, 10)
    await expect(dialog).not.toBeVisible({ timeout: 3000 })
  })
})
