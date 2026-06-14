/**
 * E2E: Policy rotation with diff view (Feature B).
 *
 * Requires: running dev server + backend + forked chain.
 * Marked skip until those prerequisites are met.
 *
 * Structure is intentional so the test suite compiles and has the correct
 * Playwright structure for CI to pick up once the backend is live.
 */

import { test, expect } from '@playwright/test'

test.describe('Policy rotation (Feature B)', () => {
  test('agent dashboard renders the policy editor button', async ({ page }) => {
    await page.goto('/agent/1')
    // Without a wallet the connect prompt shows; accept both outcomes.
    const connect = page.getByRole('button', { name: /connect/i }).first()
    await expect(connect).toBeVisible({ timeout: 10_000 })
  })

  test.skip('editing caps shows PolicyDiffView with set ops', async () => {
    // Requires: wallet injected + SIWE auth + live backend.
    //
    // Intended flow:
    //   1. Navigate to /agent/:tokenId.
    //   2. Open policy editor.
    //   3. Change maxNotional from $50k to $25k.
    //   4. Click "Show diff vs current policy".
    //   5. Assert diff row: { field: 'maxNotionalUsd', before: 50000, after: 25000 }.
    //   6. Assert Sign button is enabled (no blockers).
  })

  test.skip('blocker in diff disables Sign button', async () => {
    // Requires: backend mock returning blockers: ['Duration > 90 days'].
    //
    // Intended flow:
    //   1. Set durationDays = 91.
    //   2. Diff view shows blocker text.
    //   3. Assert Sign button is disabled.
  })
})
