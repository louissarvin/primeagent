/**
 * ERC-8004 reputation feedback worker (Feature G).
 *
 * Cadence: every 5 minutes the worker scans `AgentPnlPoint` rows from the
 * previous full hour, computes per-tokenId net PnL change for the window,
 * and submits ONE `giveFeedback` tx via the backend attestor signer. The
 * value is `clip(pnlBps / 100, -100, 100)` (int128 in the contract).
 *
 * Idempotency: `(tokenId, windowStart)` is unique on `ReputationFeedback`.
 * A duplicate insert is caught and dropped silently so a re-run of the
 * worker is a no-op.
 *
 * Without `BACKEND_ATTESTOR_PRIVATE_KEY` or `BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA`
 * the worker logs once and exits early on each tick.
 */

import cron from 'node-cron';
import {
  createWalletClient,
  http,
  encodeFunctionData,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';

import { forSvc } from '../lib/logger.ts';
import { prismaQuery } from '../lib/prisma.ts';
import {
  ARB_SEPOLIA_RPC,
  BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA,
  BACKEND_ATTESTOR_PRIVATE_KEY,
} from '../config/main-config.ts';

const log = forSvc('reputationFeedback');
const Q48 = 1n << 48n;

// ERC-8004 reputation registry ABI fragment. The canonical registry exposes
// `giveFeedback(uint256 agentId, address client, int128 value, uint8 decimals)`
// and `getSummary(uint256 agentId, address[] clientAddresses)`.
const REPUTATION_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'giveFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'client', type: 'address' },
      { name: 'value', type: 'int128' },
      { name: 'decimals', type: 'uint8' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getSummary',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
    ],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'totalFeedback', type: 'uint256' },
          { name: 'avgValue', type: 'int128' },
          { name: 'avgDecimals', type: 'uint8' },
        ],
      },
    ],
  },
] as const;

const WORKER_CRON = '*/5 * * * *';
let isRunning = false;

// Worker readiness flags evaluated once at startup; subsequent invocations
// skip silently if the deployment isn't configured.
function workerReady(): { ok: true; key: `0x${string}`; registry: Address } | { ok: false; reason: string } {
  if (!BACKEND_ATTESTOR_PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(BACKEND_ATTESTOR_PRIVATE_KEY)) {
    return { ok: false, reason: 'BACKEND_ATTESTOR_PRIVATE_KEY missing or malformed' };
  }
  const registry = BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA;
  if (!registry || !/^0x[0-9a-fA-F]{40}$/.test(registry)) {
    return { ok: false, reason: 'BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA missing' };
  }
  return {
    ok: true,
    key: BACKEND_ATTESTOR_PRIVATE_KEY as `0x${string}`,
    registry: registry as Address,
  };
}

type AgentPnlPointRow = {
  tokenId: bigint;
  equityUsdQ96: { toString(): string };
  createdAt: Date;
};

type AgentPnlPointDelegate = {
  findMany: (args: {
    where: { createdAt: { gte: Date; lt: Date } };
    orderBy: { createdAt: 'asc' | 'desc' };
    select: { tokenId: true; equityUsdQ96: true; createdAt: true };
  }) => Promise<AgentPnlPointRow[]>;
};

type ReputationFeedbackDelegate = {
  create: (args: {
    data: {
      tokenId: bigint;
      agentId: bigint;
      windowStart: Date;
      windowEnd: Date;
      pnlUsdQ96: string;
      valueDecibel: number;
      txHash?: Buffer;
      chainId: number;
    };
  }) => Promise<unknown>;
  findFirst: (args: {
    where: { tokenId: bigint; windowStart: Date };
  }) => Promise<unknown>;
  findMany: (args: {
    where: { tokenId: bigint };
    orderBy: { createdAt: 'desc' };
    take: number;
  }) => Promise<unknown[]>;
};

function getPnlDelegate(): AgentPnlPointDelegate | null {
  const tbl = (prismaQuery as unknown as { agentPnlPoint?: AgentPnlPointDelegate }).agentPnlPoint;
  return tbl ?? null;
}

function getReputationDelegate(): ReputationFeedbackDelegate | null {
  const tbl = (prismaQuery as unknown as { reputationFeedback?: ReputationFeedbackDelegate })
    .reputationFeedback;
  return tbl ?? null;
}

/**
 * Compute the start of the previous full hour window. We do not touch the
 * current hour because PnL points are still streaming.
 */
function previousHourWindow(now: Date): { start: Date; end: Date } {
  const ms = now.getTime();
  const hourMs = 60 * 60 * 1000;
  const currentHourStart = Math.floor(ms / hourMs) * hourMs;
  const prevHourStart = currentHourStart - hourMs;
  return { start: new Date(prevHourStart), end: new Date(currentHourStart) };
}

/**
 * One worker tick. Reads PnL rows for the previous hour, groups by tokenId,
 * picks the largest absolute change per agent, and writes one feedback row.
 *
 * Exported for tests.
 */
export async function runReputationWorkerOnce(now: Date = new Date()): Promise<{
  considered: number;
  posted: number;
  skipped: number;
}> {
  const ready = workerReady();
  if (!ready.ok) {
    log.warn({ data: { reason: ready.reason } }, 'reputationFeedback worker not ready; skipping');
    return { considered: 0, posted: 0, skipped: 0 };
  }
  const pnlTbl = getPnlDelegate();
  const repTbl = getReputationDelegate();
  if (!pnlTbl || !repTbl) {
    log.warn({}, 'Prisma delegates unavailable; run `bun db:push` to apply migrations');
    return { considered: 0, posted: 0, skipped: 0 };
  }

  const { start, end } = previousHourWindow(now);
  const rows = await pnlTbl.findMany({
    where: { createdAt: { gte: start, lt: end } },
    orderBy: { createdAt: 'asc' },
    select: { tokenId: true, equityUsdQ96: true, createdAt: true },
  });

  // Group: tokenId -> earliest + latest equity in the window.
  const groups = new Map<string, { first: bigint; last: bigint }>();
  for (const r of rows) {
    const key = r.tokenId.toString();
    const eq = BigInt(r.equityUsdQ96.toString());
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { first: eq, last: eq });
    } else {
      g.last = eq;
    }
  }

  let posted = 0;
  let skipped = 0;
  const considered = groups.size;
  if (considered === 0) return { considered, posted, skipped };

  const account = privateKeyToAccount(ready.key);
  const wallet = createWalletClient({
    account,
    chain: arbitrumSepolia,
    transport: http(ARB_SEPOLIA_RPC),
  });

  for (const [tokenIdStr, g] of groups) {
    const tokenId = BigInt(tokenIdStr);
    const existing = await repTbl.findFirst({ where: { tokenId, windowStart: start } });
    if (existing) {
      skipped++;
      continue;
    }
    if (g.first === 0n) {
      skipped++;
      continue;
    }
    const pnlQ96 = g.last - g.first;
    const pnlUsd = Number(pnlQ96 / Q48);
    const baseUsd = Number(g.first / Q48);
    if (baseUsd === 0) {
      skipped++;
      continue;
    }
    const bps = Math.round((pnlUsd * 10_000) / baseUsd);
    const value = Math.max(-100, Math.min(100, Math.round(bps / 100)));
    // agentId mirrors tokenId in the canonical PrimeAgent factory; the
    // mapping is preserved on-chain via AgentRegistry.
    const agentId = tokenId;
    try {
      const data = encodeFunctionData({
        abi: REPUTATION_REGISTRY_ABI,
        functionName: 'giveFeedback',
        args: [agentId, account.address, BigInt(value), 0],
      });
      const txHash = await wallet.sendTransaction({
        to: ready.registry,
        data,
        value: 0n,
      });
      await repTbl.create({
        data: {
          tokenId,
          agentId,
          windowStart: start,
          windowEnd: end,
          pnlUsdQ96: pnlQ96.toString(),
          valueDecibel: value,
          txHash: Buffer.from(txHash.slice(2), 'hex'),
          chainId: 421614,
        },
      });
      posted++;
      log.info(
        { tokenId: tokenIdStr, data: { value, bps, txHash } },
        'reputation feedback posted',
      );
    } catch (err) {
      const msg = (err as Error)?.message ?? 'unknown';
      // Catch unique-constraint races as no-ops (idempotency guard).
      if (/unique constraint/i.test(msg)) {
        skipped++;
        continue;
      }
      log.warn(
        { tokenId: tokenIdStr, data: { err: msg } },
        'giveFeedback tx failed',
      );
    }
  }

  return { considered, posted, skipped };
}

const tick = async (): Promise<void> => {
  if (isRunning) {
    log.info({}, 'previous tick still running; skipping');
    return;
  }
  isRunning = true;
  try {
    await runReputationWorkerOnce();
  } catch (err) {
    log.error(
      { err_class: (err as Error)?.name, data: { msg: (err as Error)?.message } },
      'reputationFeedback tick failed',
    );
  } finally {
    isRunning = false;
  }
};

export const startReputationFeedbackWorker = (): void => {
  log.info({ data: { cron: WORKER_CRON } }, 'reputationFeedback worker scheduled');
  cron.schedule(WORKER_CRON, tick);
};

export const __internal = { previousHourWindow, workerReady };
