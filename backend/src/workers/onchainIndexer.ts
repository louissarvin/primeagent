/**
 * On-chain event indexer for PrimeAgent.
 *
 * Per the research-derived 7-event priority queue, this worker subscribes
 * via `viem.publicClient.watchContractEvent` to the events that drive the
 * dashboard and the SSE feed. The indexer is the authoritative writer for
 * `AgentPolicy.*` columns; runtime ephemera (side-balance pushes, liquidations)
 * flows into `lib/runtimeStore.ts` for the SSE consumer.
 *
 * Why watchContractEvent over `eth_getLogs` polling: Arbitrum produces blocks
 * at 250ms; Timeboost-ordered races mean `getLogs` with a 2s poll loses event
 * ordering on the same block. viem's `watchContractEvent` uses log filters
 * + ws (when ws transport is set) so we see logs in their canonical order.
 *
 * Subscription priority (bootstrap):
 *   1. PrimeAgentFactory.AgentDeployed -> upsert AgentPolicy skeleton
 *   2. Erc7715PolicyAuditFacet.PolicyInstalled -> read getPolicy + write row
 *   3. Erc7715PolicyAuditFacet.PolicyUpdated -> same re-read pattern
 *   4. Erc7715PolicyAuditFacet.PolicyRevoked -> set expiresAt = now-1s
 *   5. RobinhoodMcpAttestor.StateAttested -> back-fill Attestation.txHash
 *   6. AgentVault.SideBalancePushed/Pulled/BaseAssetLiquidated -> runtime SSE
 *   7. EmergencyShutdown.ShutdownActivated/ResumeExecuted/VaultLiquidated
 *
 * Vault-address scoping: vault addresses are not known until AgentDeployed
 * fires. We cache the per-tokenId vault and subscribe to vault events lazily
 * once the AgentPolicy row lands.
 *
 * Defensive posture:
 *   - One bad log never crashes the listener; we log and skip.
 *   - Per-chain configuration is independent; if Arb Sepolia is configured
 *     but RH Chain is not, only the Arb listeners mount.
 *   - The worker is long-lived; we use a `mounted` flag, not the cron
 *     `isRunning` pattern.
 */

import {
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  http,
  webSocket,
  createPublicClient,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';

import {
  ARB_SEPOLIA_CHAIN_ID,
  RH_CHAIN_TESTNET_CHAIN_ID,
  type SupportedChainId,
  robinhoodChainTestnet,
} from '../lib/viem.ts';
// Read env directly so the indexer remains testable when main-config is
// mocked. The defaults below mirror the ones in main-config.
const ARB_SEPOLIA_RPC = (): string =>
  process.env.ARB_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
const RH_CHAIN_RPC = (): string =>
  process.env.RH_CHAIN_RPC || 'https://rpc.testnet.chain.robinhood.com';

import {
  AGENT_VAULT_ABI,
  EMERGENCY_SHUTDOWN_ABI,
  ERC7715_POLICY_AUDIT_FACET_ABI,
  PRIME_AGENT_FACTORY_ABI,
  ROBINHOOD_MCP_ATTESTOR_ABI,
} from '../lib/contracts/abis.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { publishEvent, updateStatus, listActiveTokenIds } from '../lib/runtimeStore.ts';
import { forSvc } from '../lib/logger.ts';
import { increment } from '../lib/metrics.ts';
import { emit as emitWebhook } from '../services/webhookEmitter.ts';
import { getArbBlockNumber } from '../services/arbSys.ts';
import {
  COMPUTED_PRESET_HASHES,
  type RiskPresetId,
} from '../agent/risk/presets.ts';

/**
 * Map the on-chain `LibPolicy.Policy.presetHash` (bytes32) back to a
 * `RiskPresetId` from the frozen registry. Returns null when the hash is
 * `bytes32(0)` (custom policy: no preset), or when no preset matches (an
 * older / unknown preset hash). Comparison is case-insensitive on the hex
 * string to tolerate either casing from viem.
 */
function resolvePresetIdFromHash(hash: `0x${string}` | null): RiskPresetId | null {
  if (!hash) return null;
  const norm = hash.toLowerCase();
  if (norm === '0x' + '0'.repeat(64)) return null;
  for (const [id, h] of Object.entries(COMPUTED_PRESET_HASHES) as Array<[
    RiskPresetId,
    `0x${string}`,
  ]>) {
    if (h.toLowerCase() === norm) return id;
  }
  return null;
}

const log = forSvc('indexer');

interface ChainSetup {
  chainId: SupportedChainId;
  client: PublicClient;
  fromBlock: bigint | 'latest';
  factory: Address | null;
  diamond: Address | null;
  attestor: Address | null;
  emergencyShutdown: Address | null;
}

// Per-chain vault subscription cache so AgentDeployed never wires duplicate
// listeners on the same vault.
const subscribedVaults = new Map<SupportedChainId, Set<string>>();
// tokenId -> vault address for inverse lookup when vault events fire.
const tokenIdByVault = new Map<string, bigint>();

let mounted = false;

/**
 * Lightweight status surface read by the ops `/health` route (Wave E2). The
 * counters are intentionally coarse: `subscriptions` counts every successful
 * `watchContractEvent` mount across all chains (factory + policy + attestor
 * + shutdown + each vault wired by AgentDeployed); `lastEventAt` records the
 * wall-clock time of the most recent `onLogs` callback. A stuck listener
 * shows as `lastEventAt` going stale relative to the chain's block cadence.
 */
let indexerSubscriptions = 0;
let indexerLastEventAt: Date | null = null;

function bumpSubscriptions(): void {
  indexerSubscriptions += 1;
}
function noteEvent(): void {
  indexerLastEventAt = new Date();
}

export function getIndexerStatus(): {
  subscriptions: number;
  lastEventAt: Date | null;
} {
  return {
    subscriptions: indexerSubscriptions,
    lastEventAt: indexerLastEventAt,
  };
}

function parseFromBlock(raw: string | undefined): bigint | 'latest' {
  if (!raw || raw === 'latest') return 'latest';
  try {
    return BigInt(raw);
  } catch {
    return 'latest';
  }
}

function maybeAddress(v: string | undefined): Address | null {
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
  return v as Address;
}

function buildClient(chainId: SupportedChainId): PublicClient {
  if (chainId === ARB_SEPOLIA_CHAIN_ID) {
    const ws = process.env.BACKEND_WS_RPC_ARB_SEPOLIA;
    if (ws) {
      return createPublicClient({
        chain: arbitrumSepolia,
        transport: webSocket(ws),
      }) as PublicClient;
    }
    log.warn(
      { chainId, svc: 'indexer' },
      'no websocket RPC configured; falling back to http polling at 2s interval',
    );
    return createPublicClient({
      chain: arbitrumSepolia,
      transport: http(ARB_SEPOLIA_RPC(), { batch: true }),
      pollingInterval: 2_000,
    }) as PublicClient;
  }
  // RH Chain
  const ws = process.env.BACKEND_WS_RPC_RH_CHAIN;
  if (ws) {
    return createPublicClient({
      chain: robinhoodChainTestnet,
      transport: webSocket(ws),
    }) as PublicClient;
  }
  log.warn(
    { chainId, svc: 'indexer' },
    'no websocket RPC configured; falling back to http polling at 2s interval',
  );
  return createPublicClient({
    chain: robinhoodChainTestnet,
    transport: http(RH_CHAIN_RPC(), { batch: true }),
    pollingInterval: 2_000,
  }) as PublicClient;
}

function setupFor(chainId: SupportedChainId): ChainSetup {
  if (chainId === ARB_SEPOLIA_CHAIN_ID) {
    return {
      chainId,
      client: buildClient(chainId),
      fromBlock: parseFromBlock(process.env.BACKEND_INDEXER_FROM_BLOCK_ARB_SEPOLIA),
      factory: maybeAddress(process.env.BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA),
      diamond: maybeAddress(process.env.BACKEND_DIAMOND_ADDRESS_ARB_SEPOLIA),
      attestor: maybeAddress(process.env.BACKEND_ATTESTOR_ADDRESS_ARB_SEPOLIA),
      emergencyShutdown: maybeAddress(
        process.env.BACKEND_EMERGENCY_SHUTDOWN_ADDRESS_ARB_SEPOLIA,
      ),
    };
  }
  return {
    chainId,
    client: buildClient(chainId),
    fromBlock: parseFromBlock(process.env.BACKEND_INDEXER_FROM_BLOCK_RH_CHAIN),
    factory: null,
    diamond: null,
    attestor: maybeAddress(process.env.BACKEND_ATTESTOR_ADDRESS_RH_CHAIN),
    emergencyShutdown: null,
  };
}

// ===== Handlers (exported as `__internal` for tests) ======================

async function readFullPolicy(
  setup: ChainSetup,
  tokenId: bigint,
): Promise<{
  permissionContextHash: Hex;
  allowedContracts: Address[];
  allowedSelectors: Hex[];
  maxNotionalUsdQ96: bigint;
  dailyCapUsdQ96: bigint;
  expiresAt: bigint;
} | null> {
  if (!setup.diamond) return null;
  try {
    const policy = (await setup.client.readContract({
      address: setup.diamond,
      abi: ERC7715_POLICY_AUDIT_FACET_ABI,
      functionName: 'getPolicy',
      args: [tokenId],
    })) as {
      tokenId: bigint;
      permissionContextHash: Hex;
      allowedContracts: readonly Address[];
      allowedSelectors: readonly Hex[];
      maxNotionalUsdQ96: bigint;
      dailyCapUsdQ96: bigint;
      expiresAt: bigint;
      issuedAt: bigint;
      dailySpentUsdQ96Slot: bigint;
      dailyWindowStart: bigint;
    };
    return {
      permissionContextHash: policy.permissionContextHash,
      allowedContracts: [...policy.allowedContracts],
      allowedSelectors: [...policy.allowedSelectors],
      maxNotionalUsdQ96: policy.maxNotionalUsdQ96,
      dailyCapUsdQ96: policy.dailyCapUsdQ96,
      expiresAt: policy.expiresAt,
    };
  } catch (err) {
    log.error(
      {
        chainId: setup.chainId,
        tokenId: tokenId.toString(),
        err_class: (err as Error)?.name,
      },
      'getPolicy read failed',
    );
    return null;
  }
}

/**
 * Best-effort read of `Erc7715PolicyAuditFacet.getPresetHash(tokenId)`.
 * Returns null on any failure (function absent on older deployments, RPC
 * timeout, decode error) so the upsert path can fall back to `presetId =
 * null` without disrupting the row write.
 */
async function readPresetHash(
  setup: ChainSetup,
  tokenId: bigint,
): Promise<`0x${string}` | null> {
  if (!setup.diamond) return null;
  try {
    const hash = (await setup.client.readContract({
      address: setup.diamond,
      abi: ERC7715_POLICY_AUDIT_FACET_ABI,
      functionName: 'getPresetHash',
      args: [tokenId],
    })) as `0x${string}`;
    return hash;
  } catch (err) {
    log.debug(
      {
        chainId: setup.chainId,
        tokenId: tokenId.toString(),
        err_class: (err as Error)?.name,
      },
      'getPresetHash read failed; falling back to presetId=null',
    );
    return null;
  }
}

async function handleAgentDeployed(
  setup: ChainSetup,
  args: {
    tokenId: bigint;
    user: Address;
    vault: Address;
    tba: Address;
    agentId: bigint;
    permissionContextHash: Hex;
  },
  meta: { txHash?: Hex; blockNumber?: bigint },
): Promise<void> {
  try {
    // `chainId` is sourced from the chain-scoped subscription; we never
    // hard-code Arbitrum Sepolia here because the same handler runs for RH
    // Chain too. `presetId` is left null on initial deploy; the
    // PolicyInstalled / PolicyUpdated handlers below populate it via the
    // audit facet's `getPresetHash` accessor.
    //
    // The `chainId` + `presetId` columns are added by the Wave A schema
    // patch (`prisma/schema.prisma`). The generated client is regenerated
    // by `bun db:push`; until the operator runs it the in-tree types do
    // not include these fields, so we cast the upsert args to bypass.
    await prismaQuery.agentPolicy.upsert({
      where: { tokenId: args.tokenId },
      create: {
        tokenId: args.tokenId,
        kernelAddress: args.tba,
        permissionContextHash: Buffer.from(args.permissionContextHash.slice(2), 'hex'),
        allowedContracts: [],
        allowedSelectors: [],
        maxNotionalUsdQ96: '0',
        dailyCapUsdQ96: '0',
        // 1970 sentinel; the PolicyInstalled handler will fill in the real value.
        expiresAt: new Date(0),
        grantTxHash: meta.txHash ?? '0x',
        chainId: setup.chainId,
        presetId: null,
      },
      update: {
        kernelAddress: args.tba,
        permissionContextHash: Buffer.from(args.permissionContextHash.slice(2), 'hex'),
        grantTxHash: meta.txHash ?? '0x',
        chainId: setup.chainId,
      },
    } as unknown as Parameters<typeof prismaQuery.agentPolicy.upsert>[0]);

    tokenIdByVault.set(`${setup.chainId}:${args.vault.toLowerCase()}`, args.tokenId);

    log.info(
      {
        chainId: setup.chainId,
        tokenId: args.tokenId.toString(),
        kernelAddr: args.tba,
        vaultAddr: args.vault,
        txHash: meta.txHash,
      },
      'AgentDeployed processed',
    );

    publishEvent(args.tokenId, {
      kind: 'chain',
      tokenId: args.tokenId,
      ts: Date.now(),
      event: 'AgentDeployed',
      txHash: meta.txHash,
      blockNumber: meta.blockNumber,
      data: {
        user: args.user,
        vault: args.vault,
        tba: args.tba,
        agentId: args.agentId.toString(),
      },
    });

    // Subscribe to this vault's events lazily.
    subscribeToVault(setup, args.vault);
  } catch (err) {
    log.error(
      {
        chainId: setup.chainId,
        tokenId: args.tokenId.toString(),
        err_class: (err as Error)?.name,
      },
      'AgentDeployed handler failed',
    );
  }
}

async function handlePolicyInstalledOrUpdated(
  setup: ChainSetup,
  args: { tokenId: bigint; permissionContextHash: Hex; expiresAt: bigint },
  meta: {
    txHash?: Hex;
    eventName: 'PolicyInstalled' | 'PolicyUpdated' | 'PolicyInstalledV2' | 'PolicyUpdatedV2';
    blockNumber?: bigint;
    logIndex?: number;
  },
): Promise<void> {
  try {
    const full = await readFullPolicy(setup, args.tokenId);
    if (!full) {
      log.warn(
        { chainId: setup.chainId, tokenId: args.tokenId.toString() },
        `${meta.eventName}: getPolicy returned null; skipping write`,
      );
      return;
    }

    // Resolve the `presetId` from the on-chain `presetHash`. Custom
    // policies (bytes32(0)) and unknown hashes both yield null, which is
    // the correct value for `AgentPolicy.presetId` per the schema comment.
    const presetHash = await readPresetHash(setup, args.tokenId);
    const presetId = resolvePresetIdFromHash(presetHash);

    // Wave L: write `AgentPolicy.upsert` AND `PolicyRevision.create` in a
    // single Prisma transaction. The unique `(chainId, txHash, logIndex)`
    // on PolicyRevision absorbs duplicate-log replays as P2002 which we
    // swallow without rolling back the AgentPolicy upsert.
    //
    // Same `chainId` + `presetId` Wave A migration caveat as
    // `handleAgentDeployed`; cast bypasses the in-tree Prisma types until
    // the operator runs `bun db:push`.
    const arbBlock = await getArbBlockNumber(setup.chainId);
    const txHashBuf = Buffer.from((meta.txHash ?? '0x').slice(2), 'hex');

    await prismaQuery.$transaction(async (tx) => {
      // Wave L: extended tx surface; `policyRevision` is not yet emitted
      // by the in-tree Prisma client. Mirror the `prismaExt` cast pattern
      // from `lib/prismaExtensions.ts` against the transaction client.
      const txExt = tx as unknown as typeof tx & {
        policyRevision: {
          aggregate: (args: unknown) => Promise<{ _max: { revisionNumber: number | null } }>;
          create: (args: unknown) => Promise<unknown>;
        };
      };
      await tx.agentPolicy.upsert({
        where: { tokenId: args.tokenId },
        create: {
          tokenId: args.tokenId,
          kernelAddress: '0x',
          permissionContextHash: Buffer.from(full.permissionContextHash.slice(2), 'hex'),
          allowedContracts: full.allowedContracts,
          allowedSelectors: full.allowedSelectors,
          maxNotionalUsdQ96: full.maxNotionalUsdQ96.toString(),
          dailyCapUsdQ96: full.dailyCapUsdQ96.toString(),
          expiresAt: new Date(Number(full.expiresAt) * 1000),
          grantTxHash: meta.txHash ?? '0x',
          chainId: setup.chainId,
          presetId,
        },
        update: {
          permissionContextHash: Buffer.from(full.permissionContextHash.slice(2), 'hex'),
          allowedContracts: full.allowedContracts,
          allowedSelectors: full.allowedSelectors,
          maxNotionalUsdQ96: full.maxNotionalUsdQ96.toString(),
          dailyCapUsdQ96: full.dailyCapUsdQ96.toString(),
          expiresAt: new Date(Number(full.expiresAt) * 1000),
          chainId: setup.chainId,
          presetId,
        },
      } as unknown as Parameters<typeof tx.agentPolicy.upsert>[0]);

      try {
        const next = await txExt.policyRevision.aggregate({
          where: { tokenId: args.tokenId },
          _max: { revisionNumber: true },
        });
        const revisionNumber = (next._max.revisionNumber ?? 0) + 1;

        await txExt.policyRevision.create({
          data: {
            tokenId: args.tokenId,
            revisionNumber,
            eventName: meta.eventName,
            permissionContextHash: Buffer.from(full.permissionContextHash.slice(2), 'hex'),
            allowedContracts: full.allowedContracts,
            allowedSelectors: full.allowedSelectors,
            maxNotionalUsdQ96: full.maxNotionalUsdQ96.toString(),
            dailyCapUsdQ96: full.dailyCapUsdQ96.toString(),
            expiresAt: new Date(Number(full.expiresAt) * 1000),
            presetId,
            chainId: setup.chainId,
            txHash: txHashBuf,
            blockNumber: meta.blockNumber ?? 0n,
            logIndex: meta.logIndex ?? 0,
            arbBlock,
          },
        });
      } catch (revErr) {
        const code = (revErr as { code?: string }).code;
        if (code === 'P2002') {
          // Duplicate log: indexer reconnect after RPC blip. The AgentPolicy
          // upsert is still useful (idempotent), the revision row already
          // exists so we swallow.
          log.debug(
            {
              chainId: setup.chainId,
              tokenId: args.tokenId.toString(),
              txHash: meta.txHash,
            },
            'PolicyRevision duplicate log absorbed',
          );
        } else {
          throw revErr;
        }
      }
    });

    log.info(
      {
        chainId: setup.chainId,
        tokenId: args.tokenId.toString(),
        txHash: meta.txHash,
      },
      `${meta.eventName} processed`,
    );
  } catch (err) {
    log.error(
      {
        chainId: setup.chainId,
        tokenId: args.tokenId.toString(),
        err_class: (err as Error)?.name,
      },
      `${meta.eventName} handler failed`,
    );
  }
}

async function handlePolicyRevoked(
  setup: ChainSetup,
  args: { tokenId: bigint },
): Promise<void> {
  try {
    const past = new Date(Date.now() - 1_000);
    await prismaQuery.agentPolicy.updateMany({
      where: { tokenId: args.tokenId, deletedAt: null },
      data: { expiresAt: past },
    });
    // Notify operator: a policy revocation is operationally significant; the
    // runtime should already be pausing via the runtime store side of the
    // pipeline, but the webhook fans the event out to off-stack listeners
    // (PagerDuty, Slack, etc).
    emitWebhook('policy_revoked', {
      tokenId: args.tokenId,
      chainId: setup.chainId,
      data: { tokenId: args.tokenId.toString() },
    });
    log.info(
      { chainId: setup.chainId, tokenId: args.tokenId.toString() },
      'PolicyRevoked processed',
    );
  } catch (err) {
    log.error(
      {
        chainId: setup.chainId,
        tokenId: args.tokenId.toString(),
        err_class: (err as Error)?.name,
      },
      'PolicyRevoked handler failed',
    );
  }
}

async function handleStateAttested(
  setup: ChainSetup,
  args: { tokenId: bigint; nullifier: Hex },
  meta: { txHash?: Hex; blockNumber?: bigint },
): Promise<void> {
  try {
    const nullifierBytes = Buffer.from(args.nullifier.slice(2), 'hex');
    const txHashBytes = meta.txHash
      ? Buffer.from(meta.txHash.slice(2), 'hex')
      : null;

    // Correlate against the L2 block number via ArbSys (Wave F). Solidity
    // `block.number` on Arbitrum returns the L1 block; viem's
    // `log.blockNumber` is also the L1 value. The canonical L2 ordering
    // comes from `ArbSys.arbBlockNumber()`. `null` on non-Arbitrum chains
    // or RPC failure; we still proceed with the write in that case.
    const arbBlock = await getArbBlockNumber(setup.chainId);

    if (txHashBytes) {
      // The `txHash` + `chainId` columns are added by the Wave A schema
      // patch (`prisma/schema.prisma`). The generated client is regenerated
      // by `bun db:push`; until the operator runs it the in-tree types do
      // not include these fields, so we cast the `data` payload to bypass.
      await prismaQuery.attestation.updateMany({
        where: { nullifier: nullifierBytes },
        data: {
          txHash: txHashBytes,
          chainId: setup.chainId,
        } as unknown as Parameters<typeof prismaQuery.attestation.updateMany>[0]['data'],
      });

      // Best-effort `arbBlock` back-fill via a separate write. Wave F adds
      // this column conceptually; the schema migration lands in a follow-up
      // wave. Any column-missing failure is logged at debug and ignored so
      // the primary `txHash` write above is preserved.
      if (arbBlock !== null) {
        try {
          await prismaQuery.attestation.updateMany({
            where: { nullifier: nullifierBytes },
            data: {
              arbBlock,
            } as unknown as Parameters<typeof prismaQuery.attestation.updateMany>[0]['data'],
          });
        } catch (innerErr) {
          log.debug(
            {
              chainId: setup.chainId,
              err_class: (innerErr as Error)?.name,
              data: { msg: (innerErr as Error)?.message },
            },
            'attestation.arbBlock back-fill skipped (column likely absent)',
          );
        }
      }
    }

    log.info(
      {
        chainId: setup.chainId,
        tokenId: args.tokenId.toString(),
        attestation_nullifier: args.nullifier,
        txHash: meta.txHash,
        data: { arbBlock: arbBlock !== null ? arbBlock.toString() : null },
      },
      'StateAttested processed',
    );

    publishEvent(args.tokenId, {
      kind: 'chain',
      tokenId: args.tokenId,
      ts: Date.now(),
      event: 'StateAttested',
      txHash: meta.txHash,
      blockNumber: meta.blockNumber,
      data: { nullifier: args.nullifier },
    });
  } catch (err) {
    log.error(
      {
        chainId: setup.chainId,
        tokenId: args.tokenId.toString(),
        err_class: (err as Error)?.name,
      },
      'StateAttested handler failed',
    );
  }
}

function handleVaultEvent(
  setup: ChainSetup,
  vault: Address,
  eventName: string,
  args: Record<string, unknown>,
  meta: { txHash?: Hex; blockNumber?: bigint },
): void {
  const tokenId = tokenIdByVault.get(`${setup.chainId}:${vault.toLowerCase()}`);
  if (typeof tokenId === 'undefined') return;
  publishEvent(tokenId, {
    kind: 'chain',
    tokenId,
    ts: Date.now(),
    event: eventName,
    txHash: meta.txHash,
    blockNumber: meta.blockNumber,
    data: args,
  });
}

function handleShutdownActivated(reason: string): void {
  for (const tokenId of listActiveTokenIds()) {
    updateStatus(tokenId, 'halted_shutdown');
    publishEvent(tokenId, {
      kind: 'risk',
      tokenId,
      ts: Date.now(),
      severity: 'critical',
      message: `Emergency shutdown activated: ${reason}`,
    });
    // The EmergencyShutdown event applies globally; we emit one webhook per
    // currently-known active tokenId so the operator can correlate which
    // agents will be halted. The shutdown facet is shared across chains in
    // the spec, so chainId defaults to Arbitrum Sepolia in the payload.
    emitWebhook('stylus_reactivation_required', {
      tokenId,
      data: { reason },
    });
  }
}

function handleVaultLiquidated(args: {
  tokenId: bigint;
  vault: Address;
  liquidator: Address;
  amount: bigint;
}): void {
  updateStatus(args.tokenId, 'halted_liquidated');
  publishEvent(args.tokenId, {
    kind: 'risk',
    tokenId: args.tokenId,
    ts: Date.now(),
    severity: 'critical',
    message: `Vault liquidated by ${args.liquidator}, amount=${args.amount.toString()}`,
  });
  // Liquidation is terminal. Notify operator immediately.
  emitWebhook('liquidation_detected', {
    tokenId: args.tokenId,
    data: {
      vault: args.vault,
      liquidator: args.liquidator,
      amount: args.amount.toString(),
    },
  });
}

// ===== Subscription wiring ================================================

function subscribeToVault(setup: ChainSetup, vault: Address): void {
  let set = subscribedVaults.get(setup.chainId);
  if (!set) {
    set = new Set();
    subscribedVaults.set(setup.chainId, set);
  }
  const key = vault.toLowerCase();
  if (set.has(key)) return;
  set.add(key);

  const VAULT_EVENT_NAMES = [
    'SideBalancePushed',
    'SideBalancePulled',
    'BaseAssetLiquidated',
  ] as const;

  for (const eventName of VAULT_EVENT_NAMES) {
    try {
      setup.client.watchContractEvent({
        address: vault,
        abi: AGENT_VAULT_ABI,
        eventName,
        onLogs: (logs) => {
          noteEvent();
          increment('indexer_events_seen_total', logs.length);
          for (const lg of logs) {
            const ev = lg as Log & { args?: Record<string, unknown> };
            handleVaultEvent(setup, vault, eventName, ev.args ?? {}, {
              txHash: ev.transactionHash ?? undefined,
              blockNumber: ev.blockNumber ?? undefined,
            });
          }
        },
        onError: (err) => {
          log.error(
            {
              chainId: setup.chainId,
              vaultAddr: vault,
              err_class: err?.name,
            },
            `vault.${eventName} watcher errored`,
          );
        },
      });
      bumpSubscriptions();
      log.info(
        { chainId: setup.chainId, vaultAddr: vault },
        `subscribed to AgentVault.${eventName}`,
      );
    } catch (err) {
      log.error(
        {
          chainId: setup.chainId,
          vaultAddr: vault,
          err_class: (err as Error)?.name,
        },
        `failed to subscribe to AgentVault.${eventName}`,
      );
    }
  }
}

function subscribeFactoryEvents(setup: ChainSetup): void {
  if (!setup.factory) return;
  try {
    setup.client.watchContractEvent({
      address: setup.factory,
      abi: PRIME_AGENT_FACTORY_ABI,
      eventName: 'AgentDeployed',
      fromBlock: setup.fromBlock === 'latest' ? undefined : setup.fromBlock,
      onLogs: (logs) => {
        noteEvent();
        increment('indexer_events_seen_total', logs.length);
        for (const lg of logs) {
          const ev = lg as Log & {
            args?: {
              tokenId?: bigint;
              user?: Address;
              vault?: Address;
              tba?: Address;
              agentId?: bigint;
              permissionContextHash?: Hex;
            };
          };
          const a = ev.args;
          if (
            !a ||
            typeof a.tokenId === 'undefined' ||
            !a.user ||
            !a.vault ||
            !a.tba ||
            typeof a.agentId === 'undefined' ||
            !a.permissionContextHash
          ) {
            log.error(
              { chainId: setup.chainId, err_code: 'BAD_EVENT_ARGS' },
              'AgentDeployed log missing args; skipping',
            );
            continue;
          }
          void handleAgentDeployed(
            setup,
            {
              tokenId: a.tokenId,
              user: a.user,
              vault: a.vault,
              tba: a.tba,
              agentId: a.agentId,
              permissionContextHash: a.permissionContextHash,
            },
            {
              txHash: ev.transactionHash ?? undefined,
              blockNumber: ev.blockNumber ?? undefined,
            },
          );
        }
      },
      onError: (err) => {
        log.error(
          { chainId: setup.chainId, err_class: err?.name },
          'factory watcher errored',
        );
      },
    });
    bumpSubscriptions();
    log.info(
      { chainId: setup.chainId },
      'subscribed to PrimeAgentFactory.AgentDeployed',
    );
  } catch (err) {
    log.error(
      { chainId: setup.chainId, err_class: (err as Error)?.name },
      'failed to subscribe to PrimeAgentFactory.AgentDeployed',
    );
  }
}

function subscribePolicyEvents(setup: ChainSetup): void {
  if (!setup.diamond) return;
  const wire = (
    eventName: 'PolicyInstalled' | 'PolicyUpdated' | 'PolicyRevoked',
  ): void => {
    try {
      setup.client.watchContractEvent({
        address: setup.diamond as Address,
        abi: ERC7715_POLICY_AUDIT_FACET_ABI,
        eventName,
        fromBlock: setup.fromBlock === 'latest' ? undefined : setup.fromBlock,
        onLogs: (logs) => {
          noteEvent();
          increment('indexer_events_seen_total', logs.length);
          for (const lg of logs) {
            const ev = lg as Log & {
              args?: {
                tokenId?: bigint;
                permissionContextHash?: Hex;
                expiresAt?: bigint;
              };
            };
            const a = ev.args ?? {};
            if (typeof a.tokenId === 'undefined') {
              log.error(
                { chainId: setup.chainId, err_code: 'BAD_EVENT_ARGS' },
                `${eventName} log missing tokenId; skipping`,
              );
              continue;
            }
            if (eventName === 'PolicyRevoked') {
              void handlePolicyRevoked(setup, { tokenId: a.tokenId });
            } else {
              if (!a.permissionContextHash || typeof a.expiresAt === 'undefined') {
                log.error(
                  { chainId: setup.chainId, err_code: 'BAD_EVENT_ARGS' },
                  `${eventName} log missing args; skipping`,
                );
                continue;
              }
              void handlePolicyInstalledOrUpdated(
                setup,
                {
                  tokenId: a.tokenId,
                  permissionContextHash: a.permissionContextHash,
                  expiresAt: a.expiresAt,
                },
                {
                  txHash: ev.transactionHash ?? undefined,
                  eventName,
                  blockNumber: ev.blockNumber ?? undefined,
                  logIndex: typeof ev.logIndex === 'number' ? ev.logIndex : 0,
                },
              );
            }
          }
        },
        onError: (err) => {
          log.error(
            { chainId: setup.chainId, err_class: err?.name },
            `policy.${eventName} watcher errored`,
          );
        },
      });
      bumpSubscriptions();
      log.info(
        { chainId: setup.chainId },
        `subscribed to Erc7715PolicyAuditFacet.${eventName}`,
      );
    } catch (err) {
      log.error(
        {
          chainId: setup.chainId,
          err_class: (err as Error)?.name,
        },
        `failed to subscribe to Erc7715PolicyAuditFacet.${eventName}`,
      );
    }
  };
  wire('PolicyInstalled');
  wire('PolicyUpdated');
  wire('PolicyRevoked');
}

function subscribeAttestorEvents(setup: ChainSetup): void {
  if (!setup.attestor) return;
  try {
    setup.client.watchContractEvent({
      address: setup.attestor,
      abi: ROBINHOOD_MCP_ATTESTOR_ABI,
      eventName: 'StateAttested',
      fromBlock: setup.fromBlock === 'latest' ? undefined : setup.fromBlock,
      onLogs: (logs) => {
        noteEvent();
        increment('indexer_events_seen_total', logs.length);
        for (const lg of logs) {
          const ev = lg as Log & {
            args?: { tokenId?: bigint; nullifier?: Hex };
          };
          const a = ev.args ?? {};
          if (typeof a.tokenId === 'undefined' || !a.nullifier) {
            log.error(
              { chainId: setup.chainId, err_code: 'BAD_EVENT_ARGS' },
              'StateAttested log missing args; skipping',
            );
            continue;
          }
          void handleStateAttested(
            setup,
            { tokenId: a.tokenId, nullifier: a.nullifier },
            {
              txHash: ev.transactionHash ?? undefined,
              blockNumber: ev.blockNumber ?? undefined,
            },
          );
        }
      },
      onError: (err) => {
        log.error(
          { chainId: setup.chainId, err_class: err?.name },
          'StateAttested watcher errored',
        );
      },
    });
    bumpSubscriptions();
    log.info(
      { chainId: setup.chainId },
      'subscribed to RobinhoodMcpAttestor.StateAttested',
    );
  } catch (err) {
    log.error(
      { chainId: setup.chainId, err_class: (err as Error)?.name },
      'failed to subscribe to RobinhoodMcpAttestor.StateAttested',
    );
  }
}

function subscribeShutdownEvents(setup: ChainSetup): void {
  if (!setup.emergencyShutdown) return;
  const addr = setup.emergencyShutdown;
  try {
    setup.client.watchContractEvent({
      address: addr,
      abi: EMERGENCY_SHUTDOWN_ABI,
      eventName: 'ShutdownActivated',
      onLogs: (logs) => {
        noteEvent();
        increment('indexer_events_seen_total', logs.length);
        for (const lg of logs) {
          const ev = lg as Log & { args?: { reason?: string } };
          handleShutdownActivated(ev.args?.reason ?? 'unknown');
        }
      },
      onError: (err) => {
        log.error(
          { chainId: setup.chainId, err_class: err?.name },
          'ShutdownActivated watcher errored',
        );
      },
    });
    setup.client.watchContractEvent({
      address: addr,
      abi: EMERGENCY_SHUTDOWN_ABI,
      eventName: 'VaultLiquidated',
      onLogs: (logs) => {
        noteEvent();
        increment('indexer_events_seen_total', logs.length);
        for (const lg of logs) {
          const ev = lg as Log & {
            args?: {
              tokenId?: bigint;
              vault?: Address;
              liquidator?: Address;
              amount?: bigint;
            };
          };
          const a = ev.args ?? {};
          if (
            typeof a.tokenId === 'undefined' ||
            !a.vault ||
            !a.liquidator ||
            typeof a.amount === 'undefined'
          ) {
            log.error(
              { chainId: setup.chainId, err_code: 'BAD_EVENT_ARGS' },
              'VaultLiquidated log missing args; skipping',
            );
            continue;
          }
          handleVaultLiquidated({
            tokenId: a.tokenId,
            vault: a.vault,
            liquidator: a.liquidator,
            amount: a.amount,
          });
        }
      },
      onError: (err) => {
        log.error(
          { chainId: setup.chainId, err_class: err?.name },
          'VaultLiquidated watcher errored',
        );
      },
    });
    bumpSubscriptions();
    bumpSubscriptions();
    log.info(
      { chainId: setup.chainId },
      'subscribed to EmergencyShutdown.{ShutdownActivated,VaultLiquidated}',
    );
  } catch (err) {
    log.error(
      { chainId: setup.chainId, err_class: (err as Error)?.name },
      'failed to subscribe to EmergencyShutdown events',
    );
  }
}

function mountChain(chainId: SupportedChainId): void {
  const setup = setupFor(chainId);
  if (!setup.factory && !setup.diamond && !setup.attestor && !setup.emergencyShutdown) {
    log.info(
      { chainId },
      'indexer disabled (no contract addresses configured for this chain)',
    );
    return;
  }
  subscribeFactoryEvents(setup);
  subscribePolicyEvents(setup);
  subscribeAttestorEvents(setup);
  subscribeShutdownEvents(setup);
}

/**
 * Mount all watchContractEvent subscriptions. Idempotent: calling twice is a
 * no-op (the second call returns immediately). Called from `index.ts` after
 * workers but before `fastify.listen`.
 */
export async function startOnchainIndexer(): Promise<void> {
  if (mounted) return;
  mounted = true;
  mountChain(ARB_SEPOLIA_CHAIN_ID);
  mountChain(RH_CHAIN_TESTNET_CHAIN_ID);
  log.info({ svc: 'indexer' }, 'on-chain indexer mounted');
}

/**
 * Test-only handlers. Tests call these directly with synthetic args; the
 * production path runs them via the viem `onLogs` callbacks above.
 */
export const __internal = {
  handleAgentDeployed,
  handlePolicyInstalledOrUpdated,
  handlePolicyRevoked,
  handleStateAttested,
  handleVaultLiquidated,
  handleShutdownActivated,
  setupFor,
  reset(): void {
    subscribedVaults.clear();
    tokenIdByVault.clear();
    mounted = false;
    indexerSubscriptions = 0;
    indexerLastEventAt = null;
  },
};
