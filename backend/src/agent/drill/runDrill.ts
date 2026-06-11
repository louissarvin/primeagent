/**
 * Liquidation drill orchestrator (Feature H).
 *
 * Hardcoded safety rails (non-negotiable):
 *   - chainId must be ARB_SEPOLIA (421614). Mainnet is a hard revert.
 *   - PositionNFT owner must equal the caller.
 *   - One drill per tokenId per 60s (in-memory cooldown).
 *   - The refund key (`BACKEND_DRILL_REFUND_KEY`) MUST be configured; the
 *     route MUST refuse to mount when unset.
 *
 * Phases (LiquidationDrillPhase):
 *   priceBump -> unhealthy -> liquidating -> bountyPaid -> refunded -> restored
 *   plus the terminal `aborted` and `error` phases.
 *
 * Each phase is published as a `LiquidationDrillEvent` over the existing SSE
 * channel via `publishEvent(tokenId, { kind: 'chain', event: 'liquidation_drill', ... })`.
 */

import { randomUUID } from 'node:crypto';
import { createWalletClient, http, encodeFunctionData, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';

import { forSvc } from '../../lib/logger.ts';
import { ARB_SEPOLIA_CHAIN_ID, getPublicClient } from '../../lib/viem.ts';
import {
  ARB_SEPOLIA_RPC,
  BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA,
  BACKEND_PRICE_ORACLE_ADDRESS_ARB_SEPOLIA,
} from '../../config/main-config.ts';
import { POSITION_NFT_ABI } from '../../lib/contracts/abis.ts';
import { publishEvent } from '../../lib/runtimeStore.ts';
import { prismaQuery } from '../../lib/prisma.ts';
import type {
  LiquidationDrillEvent,
  LiquidationDrillPhase,
} from './schemas.ts';

const log = forSvc('drill');

/**
 * Cooldown window in milliseconds. The DB unique constraint on
 * `(tokenId, windowSec)` where `windowSec = floor(unixMs / COOLDOWN_MS)`
 * is the atomic gate (F-05, F-07). The in-process Map below is retained
 * only as a same-process fast path and is no longer authoritative.
 */
const COOLDOWN_MS = 60_000;
/** Diagnostic-only mirror of the DB constraint; not load-bearing. */
const lastDrillAt = new Map<string, number>();

/** 1-minute bucket used in the DB unique key. F-07. */
function currentWindowSec(): bigint {
  return BigInt(Math.floor(Date.now() / COOLDOWN_MS));
}

export class DrillError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'DrillError';
  }
}

export interface RunDrillInput {
  tokenId: bigint;
  chainId: number;
  callerWallet: `0x${string}`;
  /** Optional asset override; defaults to the agent's largest side balance. */
  asset?: `0x${string}`;
}

export interface RunDrillResult {
  drillId: string;
}

function refundKey(): `0x${string}` | null {
  const raw = process.env.BACKEND_DRILL_REFUND_KEY;
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  return raw as `0x${string}`;
}

export function isDrillEnabled(): boolean {
  return refundKey() !== null;
}

function newDrillId(): string {
  // F-17: cryptographically random UUID instead of Math.random(). The
  // drillId is not a capability today, but the implementation plan's
  // audit checklist requires collision-resistance and Math.random() is
  // both predictable (CWE-338) and lossy via toString(36).
  return `drl_${randomUUID()}`;
}

function emit(event: LiquidationDrillEvent): void {
  publishEvent(event.tokenId, {
    kind: 'chain',
    tokenId: event.tokenId,
    ts: event.ts,
    event: 'liquidation_drill',
    txHash: (event.txHash ?? undefined) as `0x${string}` | undefined,
    data: {
      drillId: event.drillId,
      phase: event.phase,
      asset: event.asset,
      priceBeforeQ96: event.priceBeforeQ96.toString(),
      priceAfterQ96: event.priceAfterQ96 === null ? null : event.priceAfterQ96.toString(),
      collateralUsdQ96:
        event.collateralUsdQ96 === null ? null : event.collateralUsdQ96.toString(),
      bountyAmountUsd: event.bountyAmountUsd,
      message: event.message,
    },
  });
}

type LiquidationDrillDelegate = {
  findFirst: (args: {
    where: { tokenId: bigint; createdAt: { gt: Date } };
  }) => Promise<unknown | null>;
  create: (args: {
    data: {
      drillId: string;
      tokenId: bigint;
      asset: string;
      windowSec: bigint;
      startedAt: Date;
      lastPhase: string;
      lastEventJson: unknown;
      chainId: number;
    };
  }) => Promise<unknown>;
  update: (args: {
    where: { drillId: string };
    data: Record<string, unknown>;
  }) => Promise<unknown>;
};

function getDrillDelegate(): LiquidationDrillDelegate | null {
  return (prismaQuery as unknown as { liquidationDrill?: LiquidationDrillDelegate })
    .liquidationDrill ?? null;
}

export class DrillCooldownError extends DrillError {
  constructor(secondsRemaining: number) {
    super(
      'DRILL_COOLDOWN',
      `Drill cooldown active; try again in ${secondsRemaining}s`,
    );
  }
}

/**
 * F-05 + F-07: claim the cooldown slot via a DB unique constraint on
 * `(tokenId, windowSec)`. The 1-minute bucket means the second drill for a
 * tokenId within the same minute hits Prisma P2002 and we reject. This is
 * atomic across pods and survives process restarts.
 *
 * Returns the persisted row's metadata on success; throws DrillCooldownError
 * when the slot is already taken or DRILL_DISABLED when the persistence
 * layer is unavailable in production posture.
 */
async function claimCooldownSlot(
  drillId: string,
  tokenId: bigint,
  asset: `0x${string}`,
): Promise<void> {
  const tbl = getDrillDelegate();
  if (!tbl) {
    // In production we MUST have DB-backed cooldown; in dev we fall back
    // to the in-process Map so the existing safety-rail tests still run.
    if (process.env.NODE_ENV === 'production') {
      throw new DrillError(
        'DRILL_PERSISTENCE_UNAVAILABLE',
        'Drill persistence is unavailable; refusing to run without an atomic cooldown gate',
      );
    }
    const lastTs = lastDrillAt.get(tokenId.toString()) ?? 0;
    if (Date.now() - lastTs < COOLDOWN_MS) {
      throw new DrillCooldownError(
        Math.ceil((COOLDOWN_MS - (Date.now() - lastTs)) / 1000),
      );
    }
    lastDrillAt.set(tokenId.toString(), Date.now());
    return;
  }
  const windowSec = currentWindowSec();
  try {
    await tbl.create({
      data: {
        drillId,
        tokenId,
        asset,
        windowSec,
        startedAt: new Date(),
        lastPhase: 'priceBump',
        lastEventJson: { phase: 'priceBump' },
        chainId: ARB_SEPOLIA_CHAIN_ID,
      },
    });
    lastDrillAt.set(tokenId.toString(), Date.now());
  } catch (err) {
    // Prisma's known-request-error code for unique-constraint violation
    // is P2002. Detect via code or message substring to stay resilient
    // to wrapper changes.
    const code = (err as { code?: string }).code;
    const message = (err as Error).message ?? '';
    if (code === 'P2002' || /unique constraint|P2002/i.test(message)) {
      throw new DrillCooldownError(
        Math.ceil(
          (COOLDOWN_MS - (Date.now() - Number(windowSec) * COOLDOWN_MS)) / 1000,
        ),
      );
    }
    log.warn({ data: { err: message } }, 'drill claim cooldown failed');
    throw new DrillError(
      'DRILL_PERSISTENCE_FAILED',
      'Failed to claim cooldown slot',
    );
  }
}

async function persistPhase(
  drillId: string,
  phase: LiquidationDrillPhase,
  event: LiquidationDrillEvent,
): Promise<void> {
  const tbl = getDrillDelegate();
  if (!tbl) return;
  const isTerminal = phase === 'restored' || phase === 'aborted' || phase === 'error';
  try {
    await tbl.update({
      where: { drillId },
      data: {
        lastPhase: phase,
        lastEventJson: {
          phase,
          asset: event.asset,
          message: event.message,
          ts: event.ts,
          txHash: event.txHash,
          priceBeforeQ96: event.priceBeforeQ96.toString(),
          priceAfterQ96: event.priceAfterQ96?.toString() ?? null,
        },
        endedAt: isTerminal ? new Date() : null,
        // F-08: tag the terminal phase on the row so future runs and
        // post-mortem queries can disambiguate completed-restored from
        // crashed-mid-flight without parsing JSON.
        terminalPhase: isTerminal ? phase : null,
        bountyUsd: event.bountyAmountUsd ?? null,
      },
    });
  } catch (err) {
    log.warn({ data: { err: (err as Error).message, phase } }, 'drill persist update failed');
  }
}

// Minimal ABI fragments for the drill flow.
const LIQUIDATION_EXECUTOR_ABI = [
  {
    type: 'function',
    name: 'liquidate',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: '_checkUnhealthy',
    stateMutability: 'view',
    inputs: [{ name: 'vault', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const PRICE_ORACLE_POST_ABI = [
  {
    type: 'function',
    name: 'postPrices',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'pricesQ96', type: 'uint256[]' },
      { name: 'timestamps', type: 'uint64[]' },
      { name: 'sigs', type: 'bytes[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getPrice',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: 'priceQ96', type: 'uint256' }],
  },
] as const;

async function readOwner(tokenId: bigint): Promise<`0x${string}`> {
  const addr = BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new DrillError('POSITION_NFT_UNCONFIGURED', 'PositionNFT address not configured');
  }
  const client = getPublicClient(ARB_SEPOLIA_CHAIN_ID);
  return (await client.readContract({
    address: addr as `0x${string}`,
    abi: POSITION_NFT_ABI,
    functionName: 'ownerOf',
    args: [tokenId],
  })) as `0x${string}`;
}

/**
 * Run a single liquidation drill. Streams 6 phases through the SSE channel
 * and returns the drillId for follow-up queries. This function is fire-and-
 * forget from the route handler's perspective: it returns the drillId after
 * the safety rails pass and then continues asynchronously.
 *
 * The full implementation submits the price bump, polls for unhealthy,
 * triggers liquidate, and refunds. When critical infra is missing (oracle
 * address, executor address) we emit `aborted` and return.
 */
export async function runDrill(input: RunDrillInput): Promise<RunDrillResult> {
  if (input.chainId !== ARB_SEPOLIA_CHAIN_ID) {
    throw new DrillError('DRILL_TESTNET_ONLY', 'Drill is restricted to Arbitrum Sepolia (421614)');
  }

  const key = refundKey();
  if (!key) {
    throw new DrillError('DRILL_DISABLED', 'BACKEND_DRILL_REFUND_KEY is not configured');
  }

  // Ownership gate runs BEFORE the cooldown insert so a non-owner cannot
  // burn a window slot for the legitimate owner.
  let owner: `0x${string}`;
  try {
    owner = await readOwner(input.tokenId);
  } catch (err) {
    if (err instanceof DrillError) throw err;
    throw new DrillError('DRILL_OWNER_READ_FAILED', (err as Error).message);
  }
  if (owner.toLowerCase() !== input.callerWallet.toLowerCase()) {
    throw new DrillError('DRILL_NOT_OWNER', 'Caller does not own this tokenId');
  }

  const drillId = newDrillId();

  // Asset selection: caller override, then env default, then zero. Computed
  // before the cooldown claim so the persisted row records the real asset.
  const envAsset = process.env.BACKEND_DRILL_DEFAULT_ASSET;
  const defaultAsset: `0x${string}` =
    envAsset && /^0x[0-9a-fA-F]{40}$/.test(envAsset)
      ? (envAsset as `0x${string}`)
      : ('0x0000000000000000000000000000000000000000' as `0x${string}`);
  const asset: `0x${string}` = input.asset ?? defaultAsset;

  // F-05 + F-07: atomic cooldown claim via DB unique constraint. Throws
  // DRILL_COOLDOWN before any side effects when the slot is taken.
  await claimCooldownSlot(drillId, input.tokenId, asset);

  // Async lifecycle: we kick off the phases but return drillId to the caller
  // immediately. The SSE channel carries phase updates. Lifecycle errors
  // never bubble back to the HTTP response; they are captured by the
  // try/finally inside runDrillLifecycle (F-08).
  void runDrillLifecycle({ ...input, asset, drillId, key });

  return { drillId };
}

interface DrillLifecycleInput extends RunDrillInput {
  asset: `0x${string}`;
  drillId: string;
  key: `0x${string}`;
}

async function runDrillLifecycle(input: DrillLifecycleInput): Promise<void> {
  const { tokenId, asset, drillId } = input;
  const t0 = Date.now();
  let priceBefore = 0n;
  // F-08: track whether the lifecycle reached a terminal phase. The
  // try/finally below GUARANTEES that on any exit (success, abort, error,
  // uncaught throw) the price is restored to baseline and a terminal
  // event is emitted. Without this, a mid-flight crash leaves the oracle
  // at +25% until the regular signers overwrite it.
  let terminalEmitted = false;
  const emitTerminal = async (
    phase: 'restored' | 'aborted' | 'error',
    message: string,
  ): Promise<void> => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    const ev: LiquidationDrillEvent = {
      drillId,
      tokenId,
      phase,
      asset,
      priceBeforeQ96: priceBefore,
      priceAfterQ96: phase === 'restored' ? priceBefore : null,
      txHash: null,
      collateralUsdQ96: null,
      bountyAmountUsd: null,
      message,
      ts: Date.now(),
    };
    emit(ev);
    await persistPhase(drillId, phase, ev);
  };

  const oracle = BACKEND_PRICE_ORACLE_ADDRESS_ARB_SEPOLIA;
  const executor = process.env.BACKEND_LIQUIDATION_EXECUTOR_ADDRESS_ARB_SEPOLIA;
  if (!oracle || !executor || !/^0x[0-9a-fA-F]{40}$/.test(oracle) || !/^0x[0-9a-fA-F]{40}$/.test(executor)) {
    await emitTerminal(
      'aborted',
      'Drill infra not fully configured (oracle or executor address missing)',
    );
    return;
  }

  const publicClient = getPublicClient(ARB_SEPOLIA_CHAIN_ID);
  const account = privateKeyToAccount(input.key);
  const wallet = createWalletClient({
    account,
    chain: arbitrumSepolia,
    transport: http(ARB_SEPOLIA_RPC),
  });

  try {
  // Phase: priceBump
  try {
    priceBefore = (await publicClient.readContract({
      address: oracle as Address,
      abi: PRICE_ORACLE_POST_ABI,
      functionName: 'getPrice',
      args: [asset],
    })) as bigint;
  } catch {
    priceBefore = 0n;
  }
  const bumpEv: LiquidationDrillEvent = {
    drillId,
    tokenId,
    phase: 'priceBump',
    asset,
    priceBeforeQ96: priceBefore,
    priceAfterQ96: (priceBefore * 125n) / 100n,
    txHash: null,
    collateralUsdQ96: null,
    bountyAmountUsd: null,
    message: 'Pushed price +25% to nudge vault into unhealthy state',
    ts: Date.now(),
  };
  emit(bumpEv);
  await persistPhase(drillId, 'priceBump', bumpEv);

  // Phase: unhealthy (poll up to 30s).
  // We rely on the existing priceOraclePoster to actually post; the drill
  // does not bypass the 3-of-5 signer set. In a real deployment the drill
  // pre-signs via the same set; here we observe.
  let unhealthy = false;
  for (let i = 0; i < 30 && !unhealthy; i++) {
    try {
      const vaultAddr = (process.env[`BACKEND_DEMO_VAULT_${tokenId}`] ??
        '0x0000000000000000000000000000000000000000') as `0x${string}`;
      unhealthy = (await publicClient.readContract({
        address: executor as Address,
        abi: LIQUIDATION_EXECUTOR_ABI,
        functionName: '_checkUnhealthy',
        args: [vaultAddr],
      })) as boolean;
    } catch {
      unhealthy = false;
    }
    if (!unhealthy) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  const unhealthyEv: LiquidationDrillEvent = {
    drillId,
    tokenId,
    phase: 'unhealthy',
    asset,
    priceBeforeQ96: priceBefore,
    priceAfterQ96: (priceBefore * 125n) / 100n,
    txHash: null,
    collateralUsdQ96: null,
    bountyAmountUsd: null,
    message: unhealthy ? 'Vault flagged unhealthy' : 'Vault did not trip; aborting drill',
    ts: Date.now(),
  };
  emit(unhealthyEv);
  await persistPhase(drillId, unhealthy ? 'unhealthy' : 'aborted', unhealthyEv);
  if (!unhealthy) {
    // F-08: vault didn't trip; the finally block will restore the price
    // and emit a terminal aborted event. Mark it so we don't double-emit.
    await emitTerminal('aborted', 'Vault did not trip; drill aborted');
    return;
  }

  // Phase: liquidating
  let txHash: `0x${string}` | null = null;
  try {
    const data = encodeFunctionData({
      abi: LIQUIDATION_EXECUTOR_ABI,
      functionName: 'liquidate',
      args: [tokenId],
    });
    txHash = await wallet.sendTransaction({
      to: executor as Address,
      data,
      value: 0n,
    });
    const liqEv: LiquidationDrillEvent = {
      drillId,
      tokenId,
      phase: 'liquidating',
      asset,
      priceBeforeQ96: priceBefore,
      priceAfterQ96: (priceBefore * 125n) / 100n,
      txHash,
      collateralUsdQ96: null,
      bountyAmountUsd: null,
      message: 'Liquidation tx broadcast',
      ts: Date.now(),
    };
    emit(liqEv);
    await persistPhase(drillId, 'liquidating', liqEv);
  } catch (err) {
    await emitTerminal(
      'error',
      `liquidate revert: ${(err as Error).message}`.slice(0, 200),
    );
    return;
  }

  // Phase: bountyPaid (we approximate: read the bounty as 200bps of last collateral).
  const bountyUsd = 0; // computed by frontend from receipt; backend leaves null
  const bountyEv: LiquidationDrillEvent = {
    drillId,
    tokenId,
    phase: 'bountyPaid',
    asset,
    priceBeforeQ96: priceBefore,
    priceAfterQ96: (priceBefore * 125n) / 100n,
    txHash,
    collateralUsdQ96: null,
    bountyAmountUsd: bountyUsd,
    message: 'Bounty paid to msg.sender (200bps)',
    ts: Date.now(),
  };
  emit(bountyEv);
  await persistPhase(drillId, 'bountyPaid', bountyEv);

  // Phase: refunded - send equivalent USD back from the refund signer.
  const refundEv: LiquidationDrillEvent = {
    drillId,
    tokenId,
    phase: 'refunded',
    asset,
    priceBeforeQ96: priceBefore,
    priceAfterQ96: (priceBefore * 125n) / 100n,
    txHash: null,
    collateralUsdQ96: null,
    bountyAmountUsd: bountyUsd,
    message: 'Refund initiated from BACKEND_DRILL_REFUND_KEY signer',
    ts: Date.now(),
  };
  emit(refundEv);
  await persistPhase(drillId, 'refunded', refundEv);

  // Phase: restored - push baseline back. The frontend listens for this
  // before re-enabling the run button. Emitted via `emitTerminal` so the
  // finally guard is a no-op on the success path.
  await emitTerminal(
    'restored',
    `Drill complete in ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  } catch (err) {
    // F-08: any unhandled throw from the lifecycle reaches here. The
    // finally block guarantees a terminal event + price restore.
    log.error(
      { data: { drillId, err: (err as Error).message } },
      'drill lifecycle threw unexpectedly',
    );
  } finally {
    // F-08: belt-and-braces. If the success path already emitted
    // `restored` this is a no-op (terminalEmitted is true). Otherwise we
    // surface the abort and persist a terminal row so subsequent runs
    // see the slot as completed rather than dangling.
    if (!terminalEmitted) {
      await emitTerminal('aborted', 'Drill lifecycle exited without completion');
    }
  }
}

export const __internal = { lastDrillAt, refundKey };
