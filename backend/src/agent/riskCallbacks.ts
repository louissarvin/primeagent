/**
 * Risk callbacks (PrimeAgent.md section 10.4).
 *
 * Polls `IMarginEngine.netCollateralUsdQ96(vault)` every 5 seconds. When the
 * available collateral falls below 110% of an approximated required margin,
 * a sliding "near-call" counter increments. After three consecutive
 * near-call readings within 30 seconds, the runtime enters the margin-call
 * path: it builds a fresh snapshot, calls `strategy.onMarginCall`, and
 * publishes each returned Action plus a critical RiskEvent.
 *
 * Required-margin approximation: the engine's `netCollateralUsdQ96` view is
 * the only stable surface in Wave A. The full `required_margin` formula
 * lives in the Stylus `margin_engine` crate (PrimeAgent.md section 8.3) and
 * is not exposed yet. We approximate required = 20% of total notional, where
 * total notional = sum of |qty * markPrice| across all stock positions.
 * Document this; revisit when the Stylus crate exposes `required_margin`.
 *
 * 60s budget on onMarginCall: if the call does not return in time we log
 * and continue to await. The on-chain `EmergencyShutdown.liquidate`
 * permissionless path becomes profitable for a third-party keeper.
 */

import { forSvc } from '../lib/logger.ts';
import { netCollateralUsdQ96 } from '../lib/marginEngine.ts';
import { Q96 } from '../lib/units.ts';
import { publishEvent } from '../lib/runtimeStore.ts';
import { persistAction } from '../lib/actionLogger.ts';
import { emit as emitWebhook } from '../services/webhookEmitter.ts';
import {
  AGENT_VAULT_ABI,
  POSITION_NFT_ABI,
} from '../lib/contracts/abis.ts';
import { getContractAddresses } from '../lib/contracts/addresses.ts';
import { getPublicClient } from '../lib/viem.ts';

import type { ActiveAgent } from './runtime.ts';
import { buildSnapshot } from './snapshotBuilder.ts';
import { registerRiskHandler } from './runtime.ts';
import type { Action, MarketSnapshot } from './Strategy.ts';

const log = forSvc('tickLoop');

const NEAR_CALL_THRESHOLD = 3;
const NEAR_CALL_WINDOW_MS = 30_000;
const MARGIN_CALL_BUDGET_MS = 60_000;
/** Required margin approximation: 20% of total notional. */
const REQUIRED_RATIO_NUM = 20n;
const REQUIRED_RATIO_DEN = 100n;
/** Buffer: agent flagged near-call when available < buffer * required. */
const BUFFER_NUM = 11n;
const BUFFER_DEN = 10n;

/**
 * Approximate required margin = 20% * sum(|qty| * markPrice) across the
 * snapshot's on-chain and off-chain positions. Returns Q96.48 USD.
 */
function approximateRequiredMarginUsdQ96(snapshot: MarketSnapshot): bigint {
  let notional = 0n;
  const accumulate = (map: MarketSnapshot['onChain']): void => {
    for (const sym of Object.keys(map)) {
      const p = map[sym as keyof typeof map];
      if (!p) continue;
      const q = p.qty < 0n ? -p.qty : p.qty;
      // qty is Q96.48, mark is Q96.48 USD; product is Q192 USD. Scale down by Q96.
      const term = (q * p.markPriceQ96) / Q96;
      notional += term;
    }
  };
  accumulate(snapshot.onChain);
  accumulate(snapshot.offChain);
  return (notional * REQUIRED_RATIO_NUM) / REQUIRED_RATIO_DEN;
}

async function readVaultForToken(agent: ActiveAgent): Promise<`0x${string}` | null> {
  try {
    const client = getPublicClient(agent.chainId);
    const addrs = getContractAddresses(agent.chainId);
    const vault = (await client.readContract({
      address: addrs.positionNFT,
      abi: POSITION_NFT_ABI,
      functionName: 'vaultOf',
      args: [agent.tokenId],
    })) as `0x${string}`;
    if (!vault || vault === '0x0000000000000000000000000000000000000000') return null;
    return vault;
  } catch (err) {
    log.warn(
      { tokenId: agent.tokenId.toString(), err_class: (err as Error)?.name },
      'risk poll vaultOf failed',
    );
    return null;
  }
}

async function triggerMarginCall(agent: ActiveAgent): Promise<void> {
  const { seq } = publishEvent(agent.tokenId, {
    kind: 'risk',
    tokenId: agent.tokenId,
    ts: Date.now(),
    severity: 'critical',
    message: 'margin_call_triggered',
  });
  persistAction({
    tokenId: agent.tokenId,
    tick: seq,
    type: 'risk_trip',
    reason: 'margin_call',
    payload: { trigger: 'near_call_threshold', threshold: NEAR_CALL_THRESHOLD },
    chainId: agent.chainId,
  });
  emitWebhook('margin_call_triggered', {
    tokenId: agent.tokenId,
    chainId: agent.chainId,
    data: { trigger: 'near_call_threshold' },
  });
  log.error(
    { tokenId: agent.tokenId.toString() },
    'margin call triggered',
  );

  let snapshot: MarketSnapshot;
  try {
    snapshot = await buildSnapshot({
      tokenId: agent.tokenId,
      chainId: agent.chainId,
      userId: agent.userId,
      accountId: agent.accountId,
    });
  } catch (err) {
    log.error(
      { tokenId: agent.tokenId.toString(), err_class: (err as Error)?.name },
      'margin call snapshot build failed',
    );
    return;
  }

  if (!agent.strategy.onMarginCall) {
    log.warn(
      { tokenId: agent.tokenId.toString() },
      'strategy has no onMarginCall handler; agent will rely on permissionless liquidation',
    );
    return;
  }

  // 60s budget: race the strategy against a timer. We still await the
  // strategy promise (no cancellation in TS), but we log and continue when
  // the budget expires.
  let actions: Action[] = [];
  let timedOut = false;
  const timeout = new Promise<Action[]>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve([]);
    }, MARGIN_CALL_BUDGET_MS);
  });

  try {
    actions = await Promise.race([agent.strategy.onMarginCall(snapshot), timeout]);
  } catch (err) {
    log.error(
      { tokenId: agent.tokenId.toString(), err_class: (err as Error)?.name },
      'onMarginCall threw',
    );
    return;
  }

  if (timedOut) {
    log.error(
      { tokenId: agent.tokenId.toString() },
      'onMarginCall exceeded 60s budget; permissionless liquidation now profitable',
    );
  }

  for (const a of actions) {
    publishEvent(agent.tokenId, {
      kind: 'action',
      tokenId: agent.tokenId,
      ts: Date.now(),
      data: {
        type: a.kind,
        symbol: a.symbol,
        side: a.side,
        qty: a.quantity?.toString(),
      },
    });
    log.info(
      {
        tokenId: agent.tokenId.toString(),
        data: { kind: a.kind, symbol: a.symbol, side: a.side, reason: a.reason },
      },
      'margin call action emitted',
    );
  }
}

/**
 * Poll the margin engine. Called every 5s by the runtime cron task.
 */
export async function poll(agent: ActiveAgent): Promise<void> {
  if (agent.status !== 'running') return;

  const vault = await readVaultForToken(agent);
  if (!vault) return;

  const available = await netCollateralUsdQ96(agent.chainId, vault);
  if (available === 0n) {
    // Engine not configured or read failed; lib/marginEngine logs separately.
    return;
  }

  // We need a snapshot to estimate required margin. Build a lightweight one
  // by reading the same vault state the snapshotBuilder uses; this avoids a
  // recursive dependency on `loop.ts`.
  let required: bigint;
  try {
    const snapshot = await buildSnapshot({
      tokenId: agent.tokenId,
      chainId: agent.chainId,
      userId: agent.userId,
      accountId: agent.accountId,
    });
    required = approximateRequiredMarginUsdQ96(snapshot);
  } catch {
    return;
  }

  if (required === 0n) {
    // No open positions; nothing to call.
    agent.nearCallCount = 0;
    return;
  }

  const buffered = (required * BUFFER_NUM) / BUFFER_DEN;
  const now = Date.now();
  if (available < buffered) {
    if (now - agent.lastNearCallAt > NEAR_CALL_WINDOW_MS) {
      agent.nearCallCount = 0;
    }
    agent.nearCallCount += 1;
    agent.lastNearCallAt = now;
    publishEvent(agent.tokenId, {
      kind: 'risk',
      tokenId: agent.tokenId,
      ts: now,
      severity: 'warn',
      message: `near margin: available=${available.toString()} < 110% * required=${required.toString()} (count=${agent.nearCallCount})`,
    });
    if (agent.nearCallCount >= NEAR_CALL_THRESHOLD) {
      agent.nearCallCount = 0;
      await triggerMarginCall(agent);
    }
  } else {
    agent.nearCallCount = 0;
  }
}

registerRiskHandler(poll);

/**
 * Test-only inspection. Production callers MUST NOT use this.
 */
export const __internal = {
  approximateRequiredMarginUsdQ96,
  triggerMarginCall,
};
