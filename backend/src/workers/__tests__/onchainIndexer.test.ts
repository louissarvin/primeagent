import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Address, Hex } from 'viem';

// Required env BEFORE the dynamic imports.
process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

// Capture prisma writes performed by the indexer handlers.
const captured: {
  upserts: Array<{ where: unknown; create: unknown; update: unknown }>;
  updateMany: Array<{ where: unknown; data: unknown }>;
  attestationUpdates: Array<{ where: unknown; data: unknown }>;
} = {
  upserts: [],
  updateMany: [],
  attestationUpdates: [],
};

await mock.module('../../lib/prisma.ts', () => ({
  prismaQuery: {
    agentPolicy: {
      upsert: async (args: { where: unknown; create: unknown; update: unknown }) => {
        captured.upserts.push(args);
        return args.create;
      },
      updateMany: async (args: { where: unknown; data: unknown }) => {
        captured.updateMany.push(args);
        return { count: 1 };
      },
    },
    attestation: {
      updateMany: async (args: { where: unknown; data: unknown }) => {
        captured.attestationUpdates.push(args);
        return { count: 1 };
      },
    },
  },
}));

// Stub viem so the real `arbSys.getArbBlockNumber` reads a deterministic
// bigint instead of hitting Arbitrum. Mocking `../../services/arbSys.ts`
// directly bleeds across sibling test files (Bun mock.module persists);
// stubbing viem keeps the real service module live so the arbSys tests
// later in the run see the production module surface.
await mock.module('../../lib/viem.ts', () => ({
  ARB_SEPOLIA_CHAIN_ID: 421614 as const,
  RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
  getPublicClient: () => ({
    readContract: async () => 12345678n,
  }),
}));

const viemMod = await import('../../lib/viem.ts');
const runtimeMod = await import('../../lib/runtimeStore.ts');
const indexerMod = await import('../onchainIndexer.ts');

const { ARB_SEPOLIA_CHAIN_ID } = viemMod;
const { __internal: runtimeInternal, getRuntimeState } = runtimeMod;
const { __internal } = indexerMod;

const FAKE_USER: Address = '0x1111111111111111111111111111111111111111';
const FAKE_VAULT: Address = '0x2222222222222222222222222222222222222222';
const FAKE_TBA: Address = '0x3333333333333333333333333333333333333333';
const FAKE_PCH: Hex =
  '0x4444444444444444444444444444444444444444444444444444444444444444';
const FAKE_NULLIFIER: Hex =
  '0x5555555555555555555555555555555555555555555555555555555555555555';
const FAKE_TX: Hex =
  '0x6666666666666666666666666666666666666666666666666666666666666666';

const setup = {
  chainId: ARB_SEPOLIA_CHAIN_ID,
  diamond: null,
  factory: null,
  attestor: null,
  emergencyShutdown: null,
  client: {} as unknown,
  fromBlock: 'latest' as const,
};

describe('onchainIndexer handlers', () => {
  beforeEach(() => {
    captured.upserts.length = 0;
    captured.updateMany.length = 0;
    captured.attestationUpdates.length = 0;
    runtimeInternal.reset();
    __internal.reset();
  });
  afterEach(() => {
    runtimeInternal.reset();
    __internal.reset();
  });

  test('handleAgentDeployed upserts AgentPolicy and publishes a chain event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await __internal.handleAgentDeployed(setup as any, {
      tokenId: 42n,
      user: FAKE_USER,
      vault: FAKE_VAULT,
      tba: FAKE_TBA,
      agentId: 7n,
      permissionContextHash: FAKE_PCH,
    }, { txHash: FAKE_TX, blockNumber: 100n });

    expect(captured.upserts.length).toBe(1);
    const u = captured.upserts[0] as {
      where: { tokenId: bigint };
      create: { kernelAddress: string; grantTxHash: string };
    };
    expect(u.where.tokenId).toBe(42n);
    expect(u.create.kernelAddress).toBe(FAKE_TBA);
    expect(u.create.grantTxHash).toBe(FAKE_TX);

    const state = getRuntimeState(42n);
    expect(state.seq).toBe(1);
    expect(state.recent.length).toBe(1);
    const ev = state.recent[0];
    expect(ev.kind).toBe('chain');
    if (ev.kind === 'chain') {
      expect(ev.event).toBe('AgentDeployed');
      expect(ev.txHash).toBe(FAKE_TX);
    }
  });

  test('handlePolicyRevoked sets expiresAt to a past timestamp', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await __internal.handlePolicyRevoked(setup as any, { tokenId: 99n });

    expect(captured.updateMany.length).toBe(1);
    const um = captured.updateMany[0] as {
      where: { tokenId: bigint };
      data: { expiresAt: Date };
    };
    expect(um.where.tokenId).toBe(99n);
    expect(um.data.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  test('handleStateAttested back-fills txHash on the attestation row and publishes', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await __internal.handleStateAttested(setup as any, {
      tokenId: 1n,
      nullifier: FAKE_NULLIFIER,
    }, { txHash: FAKE_TX, blockNumber: 200n });

    // Wave F: two writes per StateAttested when ArbSys returns a block.
    // 1) primary txHash + chainId 2) best-effort arbBlock back-fill.
    expect(captured.attestationUpdates.length).toBe(2);
    const au = captured.attestationUpdates[0] as {
      where: { nullifier: Buffer };
      data: { txHash: Buffer; chainId: number };
    };
    expect(au.data.chainId).toBe(ARB_SEPOLIA_CHAIN_ID);
    expect(au.data.txHash.length).toBe(32);
    expect(au.where.nullifier.length).toBe(32);

    const au2 = captured.attestationUpdates[1] as {
      where: { nullifier: Buffer };
      data: { arbBlock: bigint };
    };
    expect(au2.data.arbBlock).toBe(12345678n);

    const state = getRuntimeState(1n);
    expect(state.recent.length).toBe(1);
    const ev = state.recent[0];
    if (ev.kind === 'chain') {
      expect(ev.event).toBe('StateAttested');
    }
  });

  test('handleVaultLiquidated flips status to halted_liquidated and publishes a risk event', () => {
    __internal.handleVaultLiquidated({
      tokenId: 5n,
      vault: FAKE_VAULT,
      liquidator: FAKE_USER,
      amount: 1_000n,
    });
    const state = getRuntimeState(5n);
    expect(state.status).toBe('halted_liquidated');
    const ev = state.recent[0];
    expect(ev.kind).toBe('risk');
    if (ev.kind === 'risk') {
      expect(ev.severity).toBe('critical');
    }
  });
});
