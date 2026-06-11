/**
 * Builds a `MarketSnapshot` per tick from authoritative on-chain reads plus
 * the off-chain MCP feed. EqualFi DNA: never trust a JS-side optimistic
 * projection; the snapshot is rebuilt from on-chain state every cycle.
 *
 * On-chain reads (viem `multicall`):
 *   1. PositionNFT.vaultOf(tokenId)            -> vault address
 *   2. AgentVault.totalBaseAssets()            -> USDC cash (6 decimals)
 *   3. AgentVault.sideBalance(asset) for each of the 5 tracked stocks
 *   4. AgentVault.paused() ... (we use the EmergencyShutdown.registered check)
 *   5. EmergencyShutdown.globalShutdown()      -> system pause flag
 *   6. PriceOracle.getPrice(asset) for each tracked stock              (Q96.48 USD)
 *
 * Off-chain read:
 *   - Stub mode: `RobinhoodMcpAttestor.getOffChainState(tokenId)` returns
 *     the last attested cents-shape state.
 *   - Live mode: `fetchAccountState(userId, accountId)` calls the MCP
 *     client. Both paths return position lists in cents; we convert here.
 *
 * Cache: NONE. The snapshot is single-use per tick. Caching would leak
 * stale state into the LLM context window or the deterministic strategy.
 *
 * Failure handling: any price read that reverts (stale signer set, missing
 * feed) substitutes 0n and the position's markPriceQ96 becomes 0n. The
 * strategy is responsible for handling 0n markPrice (the example strategy
 * treats it as "no signal").
 */

import type { Address } from 'viem';

import {
  AGENT_VAULT_ABI,
  EMERGENCY_SHUTDOWN_ABI,
  POSITION_NFT_ABI,
  PRICE_ORACLE_ABI,
  ROBINHOOD_MCP_ATTESTOR_ABI,
} from '../lib/contracts/abis.ts';
import { getContractAddresses } from '../lib/contracts/addresses.ts';
import { netCollateralUsdQ96 } from '../lib/marginEngine.ts';
import { fetchAccountState } from '../mcp/client.ts';
import { Q96, centsToUsdQ96, usdToQ96 } from '../lib/units.ts';
import { getPublicClient, type SupportedChainId } from '../lib/viem.ts';
import { forSvc } from '../lib/logger.ts';
import { ROBINHOOD_USE_LIVE } from '../config/main-config.ts';
import { getRhChainPosition } from '../lib/rhChainSwapClient.ts';
import { RH_CHAIN_TOKENS } from './rhSwapPlanner.ts';
import { getRobinhoodLangchainTools } from './integrations/robinhoodMcp.ts';

import {
  type MarketPosition,
  type MarketSnapshot,
  type PendingOrder,
  STOCK_SYMBOLS,
  type StockSymbol,
} from './Strategy.ts';

const log = forSvc('tickLoop');

/**
 * Per-chain map from stock symbol to ERC-20 address. Populated lazily from
 * env vars `BACKEND_STOCK_ADDR_<SYMBOL>_ARB_SEPOLIA`. Symbols missing an
 * env mapping become unavailable for the snapshot (markPrice 0n, qty 0n).
 */
function stockAddressFor(symbol: StockSymbol): Address | null {
  const envName = `BACKEND_STOCK_ADDR_${symbol}_ARB_SEPOLIA`;
  const v = process.env[envName];
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
  return v as Address;
}

/**
 * Optional override hook for tests; replaces the entire snapshot read so a
 * test can pin a synthetic state without standing up viem mocks for every
 * contract call.
 */
let snapshotOverride:
  | ((input: BuildSnapshotInput) => Promise<MarketSnapshot>)
  | null = null;

export interface BuildSnapshotInput {
  tokenId: bigint;
  chainId: SupportedChainId;
  userId: string;
  accountId: string;
}

/**
 * Build a single-tick snapshot. Throws only on truly unrecoverable errors
 * (the indexer must keep running even if one tick fails); the caller in
 * `loop.ts` catches and publishes a `RiskEvent`.
 */
export async function buildSnapshot(input: BuildSnapshotInput): Promise<MarketSnapshot> {
  if (snapshotOverride) return snapshotOverride(input);

  const { tokenId, chainId, userId, accountId } = input;
  const publicClient = getPublicClient(chainId);
  const addrs = getContractAddresses(chainId);

  // 1) Resolve the vault. PositionNFT.vaultOf(tokenId) -> address.
  let vault: Address;
  try {
    vault = (await publicClient.readContract({
      address: addrs.positionNFT,
      abi: POSITION_NFT_ABI,
      functionName: 'vaultOf',
      args: [tokenId],
    })) as Address;
  } catch (err) {
    log.error(
      { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
      'PositionNFT.vaultOf failed',
    );
    throw err;
  }

  if (!vault || vault === ('0x0000000000000000000000000000000000000000' as Address)) {
    throw new Error(`vaultOf(${tokenId}) returned zero address; agent not deployed`);
  }

  // 2) + 3) + 5) + 6) batched via viem multicall. Each call is independently
  // recoverable: a single revert (eg missing price feed) becomes 0n.
  const stockAddresses: Array<{ symbol: StockSymbol; address: Address | null }> =
    STOCK_SYMBOLS.map((s) => ({ symbol: s, address: stockAddressFor(s) }));

  const calls: Array<{
    address: Address;
    abi: typeof AGENT_VAULT_ABI | typeof EMERGENCY_SHUTDOWN_ABI | typeof PRICE_ORACLE_ABI;
    functionName: string;
    args?: readonly unknown[];
  }> = [
    {
      address: vault,
      abi: AGENT_VAULT_ABI,
      functionName: 'totalBaseAssets',
    },
    {
      address: addrs.emergencyShutdown,
      abi: EMERGENCY_SHUTDOWN_ABI,
      functionName: 'globalShutdown',
    },
  ];

  for (const { address } of stockAddresses) {
    if (!address) continue;
    calls.push({
      address: vault,
      abi: AGENT_VAULT_ABI,
      functionName: 'sideBalance',
      args: [address],
    });
    calls.push({
      address: addrs.priceOracle,
      abi: PRICE_ORACLE_ABI,
      functionName: 'getPrice',
      args: [address],
    });
  }

  type MultiResult = { status: 'success' | 'failure'; result?: unknown; error?: Error };
  let results: MultiResult[];
  try {
    results = (await publicClient.multicall({
      contracts: calls as Parameters<typeof publicClient.multicall>[0]['contracts'],
      allowFailure: true,
    })) as MultiResult[];
  } catch (err) {
    log.error(
      { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
      'multicall failed',
    );
    throw err;
  }

  const totalBaseAssets =
    results[0].status === 'success' ? (results[0].result as bigint) : 0n;
  const shutdown =
    results[1].status === 'success' ? (results[1].result as boolean) : false;

  // 4) Stylus margin engine; lib/marginEngine.ts handles its own caching.
  const netCollateral = await netCollateralUsdQ96(chainId, vault);

  // Build the on-chain position map.
  const onChain: Partial<Record<StockSymbol, MarketPosition>> = {};
  let cursor = 2;
  for (const { symbol, address } of stockAddresses) {
    if (!address) {
      // Symbol has no ERC-20 mapping configured on this chain.
      onChain[symbol] = { qty: 0n, markPriceQ96: 0n };
      continue;
    }
    const sideRes = results[cursor];
    const priceRes = results[cursor + 1];
    cursor += 2;

    const qty = sideRes && sideRes.status === 'success' ? (sideRes.result as bigint) : 0n;
    const markPriceQ96 =
      priceRes && priceRes.status === 'success' ? (priceRes.result as bigint) : 0n;
    onChain[symbol] = { qty, markPriceQ96 };
  }

  // Overlay RH Chain `RhChainSwap.getPosition(tokenId)` balances into the
  // on-chain map. The Arb Sepolia `AgentVault.sideBalance` reads above are
  // strictly the home-chain leg; the RH-Chain leg holds the post-swap stock
  // positions (e.g. TSLA after a USDG -> TSLA swap on chain 46630). For each
  // canonical token (USDG first, then the 5 tracked stocks), convert the
  // 18-decimal stock balance to Q96.48 via `(wei * Q96) / 1e18` and add it on
  // top of any vault-side qty. USDG is the margin token, not a tradeable
  // position; skip it. The mark price is reused from the Arb Sepolia
  // PriceOracle reads above (single price feed across both rails for the
  // demo). Failures are swallowed and logged; the snapshot stays valid.
  try {
    const rhPos = await getRhChainPosition(tokenId);
    if (rhPos) {
      // Map from RH Chain token address -> stock symbol via the canonical
      // RH_CHAIN_TOKENS table. Lowercased keys for case-insensitive lookup.
      const addrToSymbol = new Map<string, StockSymbol>();
      for (const symbol of STOCK_SYMBOLS) {
        const addr = RH_CHAIN_TOKENS[symbol];
        if (addr) addrToSymbol.set(addr.toLowerCase(), symbol);
      }
      const usdgAddr = RH_CHAIN_TOKENS.USDG.toLowerCase();
      const STOCK_TO_Q96_DIVISOR = 1_000_000_000_000_000_000n; // 1e18

      for (let i = 0; i < rhPos.tokens.length; i++) {
        const tokenAddr = (rhPos.tokens[i] ?? '').toLowerCase();
        if (!tokenAddr || tokenAddr === usdgAddr) continue;
        const symbol = addrToSymbol.get(tokenAddr);
        if (!symbol) continue;
        const wei = rhPos.balances[i] ?? 0n;
        if (wei === 0n) continue;
        const qtyQ96 = (wei * Q96) / STOCK_TO_Q96_DIVISOR;
        const existing = onChain[symbol] ?? { qty: 0n, markPriceQ96: 0n };
        onChain[symbol] = {
          qty: existing.qty + qtyQ96,
          markPriceQ96: existing.markPriceQ96,
          averageCostQ96: existing.averageCostQ96,
        };
      }
    }
  } catch (err) {
    log.warn(
      {
        tokenId: tokenId.toString(),
        err_class: (err as Error)?.name,
        data: { msg: (err as Error)?.message },
      },
      'rh-chain position read failed; on-chain map limited to Arb Sepolia leg',
    );
  }

  // Cash conversion: USDC has 6 decimals; convert to Q96.48 USD.
  // (cents = USDC / 1e4). We bypass the cents intermediate to save a div:
  // usdQ96 = totalBaseAssets * Q96 / 1e6.
  const cashUsdQ96 = (totalBaseAssets * Q96) / 1_000_000n;

  // Off-chain map. In stub mode we route through the attestor's getOffChainState
  // when the address is configured; otherwise fall back to the MCP fixture via
  // fetchAccountState. Live mode always calls fetchAccountState.
  let offChain: Partial<Record<StockSymbol, MarketPosition>> = {};
  let buyingPowerUsdQ96 = cashUsdQ96;

  try {
    if (!ROBINHOOD_USE_LIVE && addrs.attestor) {
      // Try the on-chain attested state. The contract returns Q96 amounts;
      // we trust those directly.
      try {
        const attested = (await publicClient.readContract({
          address: addrs.attestor,
          abi: ROBINHOOD_MCP_ATTESTOR_ABI,
          functionName: 'getOffChainState',
          args: [tokenId],
        })) as {
          accountValueQ96: bigint;
          buyingPowerQ96: bigint;
          notAfter: bigint;
          ts: bigint;
          lastAttestationHash: `0x${string}`;
        };
        buyingPowerUsdQ96 = cashUsdQ96 + (attested.buyingPowerQ96 ?? 0n);
        // The on-chain attestor does not break down per-symbol qty; populate
        // all symbols with zero qty and the on-chain markPrice for parity.
        for (const { symbol } of stockAddresses) {
          offChain[symbol] = {
            qty: 0n,
            markPriceQ96: onChain[symbol]?.markPriceQ96 ?? 0n,
          };
        }
      } catch {
        // attestor not configured or no attestation yet; fall through to MCP feed.
        const state = await fetchAccountState({ userId, accountId });
        offChain = mapMcpStateToPositions(state.positions);
        buyingPowerUsdQ96 = cashUsdQ96 + centsToUsdQ96(state.buying_power_cents);
      }
    } else {
      const state = await fetchAccountState({ userId, accountId });
      offChain = mapMcpStateToPositions(state.positions);
      buyingPowerUsdQ96 = cashUsdQ96 + centsToUsdQ96(state.buying_power_cents);
    }
  } catch (err) {
    log.warn(
      { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
      'off-chain state read failed; defaulting to empty positions',
    );
    for (const { symbol } of stockAddresses) {
      offChain[symbol] = { qty: 0n, markPriceQ96: 0n };
    }
  }

  // Ensure every symbol has an entry (even if zero) so strategies can index
  // without explicit existence checks.
  for (const symbol of STOCK_SYMBOLS) {
    if (!offChain[symbol]) {
      offChain[symbol] = { qty: 0n, markPriceQ96: onChain[symbol]?.markPriceQ96 ?? 0n };
    }
  }

  // Price divergence: RH MCP `get_equity_quotes` vs on-chain PriceOracle.
  const { priceDivergence, divergenceBps } = await checkPriceDivergence(
    userId,
    accountId,
    onChain,
  );

  // Pending orders: RH MCP `get_equity_orders`. Stub mode always returns [].
  const pendingOrders = await fetchPendingOrders(userId, accountId);

  return {
    tokenId,
    ts: Date.now(),
    cashUsdQ96,
    buyingPowerUsdQ96,
    netCollateralUsdQ96: netCollateral,
    onChain,
    offChain,
    paused: false,
    shutdown,
    priceDivergence,
    divergenceBps,
    pendingOrders,
  };
}

/**
 * Divergence threshold per Wave E1 brief: 50bps absolute. Anything above
 * this on any tracked symbol triggers the tick-skip gate in `loop.ts`.
 */
const DIVERGENCE_THRESHOLD_BPS = 50n;

/**
 * Compute the RH-MCP vs PriceOracle divergence for the tracked symbols.
 * Returns the per-symbol bps map only when at least one symbol breaches
 * the threshold. The `oracle` price for each symbol is taken from the
 * `onChain[symbol].markPriceQ96` slot populated above (that field IS the
 * `PriceOracle.getPrice(asset)` value per the multicall earlier).
 *
 * Failure posture: any tool error returns `priceDivergence: false`. We do
 * not want to skip a tick because the MCP feed timed out; the strategy
 * already has a 0n-price guard for missing data.
 */
async function checkPriceDivergence(
  userId: string,
  accountId: string,
  onChain: Partial<Record<StockSymbol, MarketPosition>>,
): Promise<{ priceDivergence: boolean; divergenceBps: Partial<Record<StockSymbol, number>> }> {
  try {
    const tools = await getRobinhoodLangchainTools(userId, accountId);
    const quoteTool = tools.find((t) => t.name === 'get_equity_quotes');
    if (!quoteTool) return { priceDivergence: false, divergenceBps: {} };

    const result = await quoteTool.invoke({ symbols: [...STOCK_SYMBOLS] });
    const parsed = JSON.parse(String(result)) as {
      quotes?: Array<{ symbol?: string; mark_price?: number }>;
    };
    const quoteMap = new Map<string, number>();
    for (const q of parsed.quotes ?? []) {
      if (typeof q.symbol === 'string' && typeof q.mark_price === 'number') {
        quoteMap.set(q.symbol, q.mark_price);
      }
    }

    const bpsMap: Partial<Record<StockSymbol, number>> = {};
    let anyOver = false;
    for (const symbol of STOCK_SYMBOLS) {
      const oracleQ96 = onChain[symbol]?.markPriceQ96 ?? 0n;
      // `oracleQ96 === 0n` means no on-chain price feed; skip (zero means
      // "no signal" by convention).
      if (oracleQ96 === 0n) continue;
      const rhUsd = quoteMap.get(symbol);
      if (typeof rhUsd !== 'number' || !Number.isFinite(rhUsd)) continue;

      const rhQ96 = usdToQ96(rhUsd);
      const diffQ96 = rhQ96 > oracleQ96 ? rhQ96 - oracleQ96 : oracleQ96 - rhQ96;
      const bps = (diffQ96 * 10_000n) / oracleQ96;
      if (bps > DIVERGENCE_THRESHOLD_BPS) {
        anyOver = true;
        bpsMap[symbol] = Number(bps);
        log.warn(
          {
            data: {
              symbol,
              oracle_q96: oracleQ96.toString(),
              rh_q96: rhQ96.toString(),
              divergence_bps: bps.toString(),
            },
          },
          'price divergence exceeds threshold',
        );
      }
    }

    return { priceDivergence: anyOver, divergenceBps: bpsMap };
  } catch (err) {
    log.warn(
      { err_class: (err as Error)?.name },
      `divergence check failed: ${(err as Error)?.message ?? String(err)}`,
    );
    return { priceDivergence: false, divergenceBps: {} };
  }
}

/**
 * Fetch the list of open equity orders via `get_equity_orders`. Filters
 * to `queued | unconfirmed | partially_filled` per the Robinhood schema.
 * Stub mode returns `[]`. The mapping to Q96.48 qty preserves negative
 * (sell) sides as positive `qtyOpenQ96` with `side: 'sell'`.
 */
async function fetchPendingOrders(
  userId: string,
  accountId: string,
): Promise<PendingOrder[]> {
  try {
    const tools = await getRobinhoodLangchainTools(userId, accountId);
    const ordersTool = tools.find((t) => t.name === 'get_equity_orders');
    if (!ordersTool) return [];

    const result = await ordersTool.invoke({ account_id: accountId });
    const parsed = JSON.parse(String(result)) as {
      orders?: Array<{
        symbol?: string;
        side?: string;
        state?: string;
        quantity_open?: number;
        order_id?: string;
        placed_at?: number;
      }>;
    };

    const OPEN_STATES = new Set(['queued', 'unconfirmed', 'partially_filled']);
    const out: PendingOrder[] = [];
    for (const o of parsed.orders ?? []) {
      if (!o.symbol || !o.side || !o.state) continue;
      if (!OPEN_STATES.has(o.state)) continue;
      const symbol = o.symbol as StockSymbol;
      if (!STOCK_SYMBOLS.includes(symbol)) continue;
      const side = o.side === 'buy' ? 'buy' : 'sell';
      const qty = typeof o.quantity_open === 'number' ? o.quantity_open : 0;
      out.push({
        symbol,
        side,
        qtyOpenQ96: BigInt(Math.max(0, Math.round(qty))) * Q96,
        placedAtSec: typeof o.placed_at === 'number' ? o.placed_at : Math.floor(Date.now() / 1000),
        orderId: typeof o.order_id === 'string' ? o.order_id : '',
      });
    }
    return out;
  } catch (err) {
    log.warn(
      { err_class: (err as Error)?.name },
      `get_equity_orders read failed: ${(err as Error)?.message ?? String(err)}`,
    );
    return [];
  }
}

function mapMcpStateToPositions(
  positions: Array<{ symbol: string; qty: number; mark_cents: bigint }>,
): Partial<Record<StockSymbol, MarketPosition>> {
  const out: Partial<Record<StockSymbol, MarketPosition>> = {};
  for (const p of positions) {
    const sym = p.symbol as StockSymbol;
    if (!STOCK_SYMBOLS.includes(sym)) continue;
    // qty in shares -> Q96.48 by multiplying. negative qty supported.
    const qty = BigInt(Math.round(p.qty)) * Q96;
    out[sym] = {
      qty,
      markPriceQ96: centsToUsdQ96(p.mark_cents),
    };
  }
  return out;
}

/**
 * Test-only override hook. Production callers MUST NOT set this.
 */
export const __internal = {
  setSnapshotOverride(
    fn: ((input: BuildSnapshotInput) => Promise<MarketSnapshot>) | null,
  ): void {
    snapshotOverride = fn;
  },
  mapMcpStateToPositions,
};
