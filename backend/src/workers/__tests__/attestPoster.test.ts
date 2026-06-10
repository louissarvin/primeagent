/**
 * attestPoster RH Chain enrichment tests.
 *
 * Wave RhChainAudit: verifies the per-tokenId helper that reads the RH
 * Chain swap position and shapes it for the audit payload. The full
 * attest-and-write path is exercised in `src/lib/__tests__/attestor.test.ts`
 * and `src/lib/__tests__/attestorBoot.test.ts`; here we focus on three
 * branches the worker MUST handle correctly:
 *
 *   1) happy path: getRhChainPosition returns a snapshot -> rhChain populated
 *   2) graceful skip: wiring disabled (`configured=false`) -> no RPC call
 *      AND rhChain undefined
 *   3) graceful skip: getRhChainPosition throws -> rhChain undefined, no
 *      rethrow (the audit cadence must not be blocked by an RPC fault)
 *   4) graceful skip: getRhChainPosition returns null -> rhChain undefined
 *
 * Implementation note: rather than using `mock.module` (which persists
 * across the whole Bun test run and would leak into the `rhChainRoutes`
 * test suite), we exercise the helper via `__internal.readRhChainSnapshotWith`
 * which takes the swap-client function as a dependency. This keeps the
 * production code path the same shape while avoiding suite-wide pollution.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

// Required env BEFORE any dynamic import that touches main-config.
process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BACKEND_RH_CHAIN_SWAP_ADDRESS ||=
  '0xc346333ea7Dc98FDDF752FdBd5928CE2460a8C7B';

const FAKE_OWNER = '0x1111111111111111111111111111111111111111' as const;
const FAKE_TOKEN_USDG = '0x7E955252E15c84f5768B83c41a71F9eba181802F' as const;
const FAKE_TOKEN_TSLA = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E' as const;

const workerMod = await import('../attestPoster.ts');
const { readRhChainSnapshotWith } = workerMod.__internal;

interface FakePosition {
  tokens: readonly `0x${string}`[];
  balances: readonly bigint[];
  swapNonce: bigint;
  withdrawNonce: bigint;
  revokedAt: number;
  paused: boolean;
  owner: `0x${string}`;
}

function makePosition(): FakePosition {
  return {
    tokens: [FAKE_TOKEN_USDG, FAKE_TOKEN_TSLA] as const,
    balances: [1_000_000n, 5n * 10n ** 18n] as const,
    swapNonce: 7n,
    withdrawNonce: 0n,
    revokedAt: 0,
    paused: false,
    owner: FAKE_OWNER,
  };
}

let callCount = 0;

describe('attestPoster.readRhChainSnapshot', () => {
  beforeEach(() => {
    callCount = 0;
  });

  afterEach(() => {
    // No env / module state to restore.
  });

  test('populates rhChain when the swap client returns a snapshot', async () => {
    const fn = async (): Promise<FakePosition> => {
      callCount += 1;
      return makePosition();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = await readRhChainSnapshotWith(42n, true, fn as any);

    expect(callCount).toBe(1);
    expect(snapshot).toBeDefined();
    // Shape only: swapAddress is sourced from BACKEND_RH_CHAIN_SWAP_ADDRESS
    // which may be remapped by other test files' module mocks under Bun's
    // suite-wide mock persistence. Asserting the regex keeps the test
    // hermetic to test ordering.
    expect(snapshot!.swapAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(snapshot!.tokens.length).toBe(2);
    // Balances must be stringified (bigint -> decimal string) so the
    // canonical JSON encoder in lib/attestor.ts can serialise them
    // without precision loss.
    expect(typeof snapshot!.balances[0]).toBe('string');
    expect(snapshot!.balances[1]).toBe((5n * 10n ** 18n).toString());
    expect(snapshot!.swapNonce).toBe('7');
    expect(snapshot!.paused).toBe(false);
    expect(snapshot!.owner).toBe(FAKE_OWNER);
  });

  test('graceful skip: returns undefined and skips RPC when wiring disabled', async () => {
    const fn = async (): Promise<FakePosition> => {
      callCount += 1;
      return makePosition();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = await readRhChainSnapshotWith(43n, false, fn as any);

    // The configured flag short-circuits the helper before the RPC seam.
    expect(callCount).toBe(0);
    expect(snapshot).toBeUndefined();
  });

  test('graceful skip: returns undefined when getRhChainPosition throws', async () => {
    const fn = async (): Promise<FakePosition> => {
      callCount += 1;
      throw new Error('rpc down');
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = await readRhChainSnapshotWith(44n, true, fn as any);

    expect(callCount).toBe(1);
    expect(snapshot).toBeUndefined();
  });

  test('graceful skip: returns undefined when getRhChainPosition returns null', async () => {
    const fn = async (): Promise<null> => {
      callCount += 1;
      return null;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = await readRhChainSnapshotWith(45n, true, fn as any);

    expect(callCount).toBe(1);
    expect(snapshot).toBeUndefined();
  });
});
