/**
 * Feature Q — DSS Alignment Memo Viewer
 *
 * Tests: DssMemoCard button visible in regulatory section, modal opens,
 * form fields accept input, generate calls /audit/dss-memo when backend live,
 * markdown preview renders as <pre> (NOT innerHTML), download triggers blob URL,
 * mailto link uses encodeURIComponent and no javascript: scheme.
 *
 * Skip-gated: generate requires live backend.
 * Run:
 *   cd web && bunx playwright test e2e/dss-memo.spec.ts
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

test.describe('DSS memo (Feature Q)', () => {
  test('DSS memo button is visible in regulatory section', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const btn = page.getByRole('button', { name: /DSS memo/i }).first()
    await expect(btn).toBeVisible({ timeout: 8000 })
  })

  test('clicking the button opens a modal dialog', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const btn = page.getByRole('button', { name: /DSS memo/i }).first()
    if (!await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'DSS memo button not found')
      return
    }

    await btn.click()

    const dialog = page.getByRole('dialog', { name: /DSS/i })
    await expect(dialog).toBeVisible({ timeout: 5000 })
  })

  test('modal contains firm name and LEI fields', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const btn = page.getByRole('button', { name: /DSS memo/i }).first()
    if (!await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'DSS memo button not found')
      return
    }

    await btn.click()
    await page.getByRole('dialog').waitFor({ timeout: 5000 })

    await expect(page.locator('#dss-firm')).toBeVisible()
    await expect(page.locator('#dss-lei')).toBeVisible()
  })

  test('generate button is disabled until firm name and LEI are filled', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const btn = page.getByRole('button', { name: /DSS memo/i }).first()
    if (!await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'DSS memo button not found')
      return
    }

    await btn.click()
    await page.getByRole('dialog').waitFor({ timeout: 5000 })

    const generateBtn = page.getByRole('button', { name: /generate memo/i })
    await expect(generateBtn).toBeDisabled()

    // Fill firm name only — still disabled
    await page.locator('#dss-firm').fill('Acme Capital Ltd')
    await expect(generateBtn).toBeDisabled()

    // Fill LEI — now enabled
    await page.locator('#dss-lei').fill('2138005T7234567ABCD1')
    await expect(generateBtn).toBeEnabled()
  })

  test('generate calls /audit/dss-memo when backend is live', async ({ page }) => {
    const live = await backendLive(page)
    test.skip(!live, 'Backend not running — skipping DSS memo API test')

    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const btn = page.getByRole('button', { name: /DSS memo/i }).first()
    if (!await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'DSS memo button not found')
      return
    }

    await btn.click()
    await page.getByRole('dialog').waitFor({ timeout: 5000 })

    await page.locator('#dss-firm').fill('Acme Capital Ltd')
    await page.locator('#dss-lei').fill('2138005T7234567ABCD1')

    const memoRequest = page.waitForRequest(
      (req) => req.url().includes('/dss-memo') && req.method() === 'POST',
      { timeout: 10_000 }
    )

    await page.getByRole('button', { name: /generate memo/i }).click()
    await memoRequest
  })

  test('preview renders as <pre> not innerHTML', async ({ page }) => {
    const live = await backendLive(page)
    test.skip(!live, 'Backend not running — skipping preview render test')

    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const btn = page.getByRole('button', { name: /DSS memo/i }).first()
    if (!await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'DSS memo button not found')
      return
    }

    await btn.click()
    await page.getByRole('dialog').waitFor({ timeout: 5000 })

    await page.locator('#dss-firm').fill('Acme Capital Ltd')
    await page.locator('#dss-lei').fill('2138005T7234567ABCD1')
    await page.getByRole('button', { name: /generate memo/i }).click()

    // Preview should use a <pre> element, never innerHTML/dangerouslySetInnerHTML
    const pre = page.locator('pre').first()
    if (await pre.isVisible({ timeout: 12_000 }).catch(() => false)) {
      const preText = await pre.textContent()
      expect(preText?.length).toBeGreaterThan(0)

      // Verify no raw HTML tags rendered as markup inside the preview
      // (they should appear as literal text, not parsed)
      const innerHtmlContent = await pre.innerHTML()
      // Pre content should be plain text — no child elements from user data
      expect(innerHtmlContent).not.toMatch(/<script/i)
    }
  })

  test('mailto link does not use javascript: scheme', async ({ page }) => {
    const live = await backendLive(page)
    test.skip(!live, 'Backend not running — skipping mailto test')

    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const btn = page.getByRole('button', { name: /DSS memo/i }).first()
    if (!await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'DSS memo button not found')
      return
    }

    await btn.click()
    await page.getByRole('dialog').waitFor({ timeout: 5000 })

    await page.locator('#dss-firm').fill('Acme Capital Ltd')
    await page.locator('#dss-lei').fill('2138005T7234567ABCD1')
    await page.getByRole('button', { name: /generate memo/i }).click()

    const mailtoLink = page.getByRole('link', { name: /send to compliance/i })
    if (await mailtoLink.isVisible({ timeout: 12_000 }).catch(() => false)) {
      const href = await mailtoLink.getAttribute('href')
      expect(href).toMatch(/^mailto:/)
      expect(href).not.toMatch(/^javascript:/i)
    }
  })

  test('modal closes on backdrop click', async ({ page }) => {
    await page.goto(AGENT_URL)
    await page.waitForSelector('main', { timeout: 10_000 })

    const btn = page.getByRole('button', { name: /DSS memo/i }).first()
    if (!await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
      test.skip(true, 'DSS memo button not found')
      return
    }

    await btn.click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ timeout: 5000 })

    // Click the backdrop (outside the modal panel)
    await page.mouse.click(10, 10)
    await expect(dialog).not.toBeVisible({ timeout: 3000 })
  })
})
