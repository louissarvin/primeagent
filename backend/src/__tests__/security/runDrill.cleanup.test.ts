/**
 * F-08 [MEDIUM-but-HIGH-impact] Drill state cleanup on error path.
 *
 * BEFORE: the drill lifecycle's `aborted`/`error` early-returns did NOT
 * release in-process cooldown, did NOT mark a terminal phase on the DB row,
 * and did NOT guarantee the oracle price was restored. A mid-flight crash
 * left the oracle at +25% indefinitely.
 *
 * AFTER: the lifecycle is wrapped in try/finally. On ANY exit (success,
 * abort, error, uncaught throw) a terminal phase is emitted exactly once
 * and the row's `terminalPhase` column is populated. Subsequent runs in
 * the same window are still blocked by the `(tokenId, windowSec)` unique
 * constraint, which is the correct outcome — the slot is consumed for
 * that minute regardless of whether the run succeeded.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const VALID_REFUND_KEY = '0x' + 'a'.repeat(64);
const POSITION_NFT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OWNER = '0x1111111111111111111111111111111111111111';

describe('F-08 drill lifecycle finally guard', () => {
  beforeEach(() => {
    process.env.BACKEND_DRILL_REFUND_KEY = VALID_REFUND_KEY;
    process.env.BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA = POSITION_NFT;
    delete process.env.BACKEND_PRICE_ORACLE_ADDRESS_ARB_SEPOLIA;
    delete process.env.BACKEND_LIQUIDATION_EXECUTOR_ADDRESS_ARB_SEPOLIA;
  });

  afterEach(() => {
    delete process.env.BACKEND_DRILL_REFUND_KEY;
    delete process.env.BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA;
  });

  test('AFTER fix: unconfigured infra produces a terminal "aborted" persisted phase', async () => {
    let updateCalls: Array<{ where: unknown; data: Record<string, unknown> }> = [];
    await mock.module('../../lib/prisma.ts', () => ({
      prismaQuery: {
        liquidationDrill: {
          findFirst: async () => null,
          create: async () => ({ drillId: 'drl_test' }),
          update: async (args: { where: unknown; data: Record<string, unknown> }) => {
            updateCalls.push(args);
            return {};
          },
        },
        user: { findUnique: async () => null },
        errorLog: { create: async () => undefined },
      },
    }));
    await mock.module('../../lib/viem.ts', () => ({
      ARB_SEPOLIA_CHAIN_ID: 421614 as const,
      RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
      getPublicClient: () => ({
        readContract: async () => OWNER as `0x${string}`,
      }),
    }));

    const { runDrill, __internal } = await import('../../agent/drill/runDrill.ts');
    __internal.lastDrillAt.clear();

    const result = await runDrill({
      tokenId: 42n,
      chainId: 421614,
      callerWallet: OWNER as `0x${string}`,
    });
    expect(result.drillId).toMatch(/^drl_/);

    // The lifecycle is `void`-launched, so wait a couple of macrotasks
    // for the persistPhase update to fire.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }

    // Expect at least one update with terminalPhase set to 'aborted'.
    const terminalAborted = updateCalls.find(
      (c) => c.data.terminalPhase === 'aborted' && c.data.lastPhase === 'aborted',
    );
    expect(terminalAborted).toBeDefined();
    expect(terminalAborted!.data.endedAt).toBeInstanceOf(Date);
  });
});
