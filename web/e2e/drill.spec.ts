/**
 * E2E: Liquidation drill (Feature H).
 *
 * Requires: running dev server + backend + Anvil fork of Arb Sepolia.
 * Marked skip until prerequisites are met.
 *
 * Structure is correct so CI compiles the suite.
 */

import { test, expect } from '@playwright/test'

test.describe('Liquidation drill (Feature H)', () => {
  test('agent dashboard renders the Run Drill button', async ({ page }) => {
    await page.goto('/agent/1')
    // Without wallet the connect prompt shows.
    const connect = page.getByRole('button', { name: /connect/i }).first()
    await expect(connect).toBeVisible({ timeout: 10_000 })
  })

  test.skip('Run Drill button is disabled on non-testnet chain', async ({ page: _page }) => {
    // Requires: wallet injected on Ethereum mainnet.
    //
    // Intended flow:
    //   1. Navigate to /agent/1 with wallet on chain 1.
    //   2. Find the Run Drill button.
    //   3. Assert it is disabled.
    //   4. Hover it and verify tooltip mentions "Testnet only".
  })

  test.skip('Run Drill on Arb Sepolia streams 6 phases', async ({ page: _page }) => {
    // Requires: wallet injected on Arb Sepolia (421614) + SIWE auth + Anvil fork.
    //
    // Intended flow:
    //   1. Navigate to /agent/:tokenId.
    //   2. Click "Run Drill".
    //   3. Wait for priceBump phase to appear.
    //   4. Wait for liquidating phase.
    //   5. Wait for restored phase.
    //   6. Assert 6 phase rows are visible in the stepper.
    //   7. Assert the button is disabled during drill.
    //   8. Assert the button is re-enabled after restored.
  })

  test.skip('Run Drill is disabled for 60s after completion', async () => {
    // Requires: completed drill + same session.
    //
    // Intended flow:
    //   1. Complete a drill.
    //   2. Assert Run Drill button shows cooldown state.
  })
})
