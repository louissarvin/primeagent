/**
 * RH Chain swap planner.
 *
 * Called from the agent tick after `strategy.tick` produces actions. For each
 * `rh-chain-swap` action the planner:
 *   1. Resolves fromToken / toToken from the symbol + side.
 *   2. Computes priceWad from the strategy's `limitPriceUsdQ96` and the token
 *      decimals (USDG = 6, stocks = 18).
 *   3. Requests an EIP-712-signed Price quote from `rhChainSigners.signPrice`.
 *   4. Returns a `PlannedRhSwap` containing the calldata-ready inputs the
 *      caller submits via `rhChainWalletClient.writeContract`.
 *
 * Pre-deploy mode: when `BACKEND_RH_CHAIN_SWAP_ADDRESS` is empty the planner
 * returns null without throwing. The agent loop logs a risk event ("rh swap
 * skipped: contract not deployed") and continues.
 *
 * This file does NOT submit transactions. Submission happens in the loop so
 * the tx-hash + payload land in the `AgentAction` audit row with the same
 * tick `seq` as the rest of the tick.
 */

import { type Address, type Hex, getAddress } from 'viem';

import type { Action, StockSymbol } from './Strategy.ts';
import {
  signPrice,
  type SignedPrice,
} from '../lib/rhChainSigners.ts';
import {
  RH_CHAIN_SWAP_CONFIGURED,
  BACKEND_RH_CHAIN_SWAP_ADDRESS,
} from '../config/main-config.ts';
import { forSvc } from '../lib/logger.ts';

const log = forSvc('rhSwapPlanner');

/**
 * Canonical RH Chain testnet token addresses (lifted from
 * `memory/rh_chain_testnet_facts_2026.md`). The contract's allowlist is the
 * authoritative source on-chain; this list is the off-chain shadow used to
 * resolve `symbol -> address` for swap planning.
 */
export const RH_CHAIN_TOKENS = {
  USDG: '0x7E955252E15c84f5768B83c41a71F9eba181802F' as Address,
  TSLA: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E' as Address,
  AMZN: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02' as Address,
  PLTR: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0' as Address,
  NFLX: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93' as Address,
  AMD: '0x71178BAc73cBeb415514eB542a8995b82669778d' as Address,
} as const;

const USDG_DECIMALS = 6;
const STOCK_DECIMALS = 18;

/** Default slippage bps applied to minAmountOut when strategy did not specify. */
const DEFAULT_SLIPPAGE_BPS = 50;

export interface PlannedRhSwap {
  tokenId: bigint;
  fromToken: Address;
  toToken: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  maxPriceWad: bigint;
  signed: SignedPrice;
}

/**
 * Convert a USD-per-share price expressed in Q96.48 to the on-chain `priceWad`
 * the contract consumes. The contract enforces
 *   amountOut = amountIn * priceWad / 1e18
 * regardless of which side has more decimals, so the priceWad formula must
 * normalise for the from/to decimal mismatch.
 *
 * For USDG (6 decimals) -> stock (18 decimals) at $P/share:
 *   stocksOut = usdgIn / P
 *   With decimals: stockWei = (usdgWei * 1e18 / P) * (1e18 / 1e6) / 1e18
 *                           = usdgWei * (1e18 / P) * 1e12 / 1e18
 *   So priceWad = (1e18 * 1e12) / P_usd = 1e30 / P_usd (P in USD units)
 *
 * For stock (18) -> USDG (6) at $P/share:
 *   usdgOut = stocksIn * P
 *   usdgWei = (stockWei * P) * 1e6 / 1e18
 *   priceWad = P_usd * 1e18 / 1e12 = P_usd * 1e6
 *
 * P is supplied as a Q96.48 USD value. Convert to integer USD with
 *   P_usd_micro = Math.mulDiv(P_q96, 1_000_000, 1 << 48)
 * (micros so the smallest stock priced under $1 still resolves; for the
 * five launch tickers all prices are >= $5 and the precision loss is well
 * inside the contract's slippage band.)
 */
export function priceWadForSwap(
  fromToken: Address,
  toToken: Address,
  pricePerShareQ96: bigint,
): bigint {
  const isFromUsdg = fromToken.toLowerCase() === RH_CHAIN_TOKENS.USDG.toLowerCase();
  const isToUsdg = toToken.toLowerCase() === RH_CHAIN_TOKENS.USDG.toLowerCase();

  if (isFromUsdg === isToUsdg) {
    throw new Error('priceWadForSwap: one side must be USDG');
  }

  // Convert Q96.48 to a fixed-point "micro-USD" integer (1e6 base).
  // pricePerShareQ96 = USD * (1n << 48n); micros = USD * 1e6.
  const ONE_Q48 = 1n << 48n;
  const microsPerShare = (pricePerShareQ96 * 1_000_000n) / ONE_Q48;
  if (microsPerShare === 0n) {
    throw new Error('priceWadForSwap: price truncated to zero');
  }

  if (isFromUsdg) {
    // priceWad = 1e30 / P_usd. P_usd = micros / 1e6, so 1e30 / (micros/1e6) = 1e36 / micros.
    return 10n ** 36n / microsPerShare;
  }
  // stock -> USDG: priceWad = P_usd * 1e6 = micros (already in 1e6 base).
  return microsPerShare;
}

/**
 * Resolve the (fromToken, toToken) pair for a swap action.
 * - side=buy   USDG -> symbol (open long via on-chain leg)
 * - side=sell  symbol -> USDG (close long)
 */
function resolveTokens(symbol: StockSymbol, side: 'buy' | 'sell'): {
  fromToken: Address;
  toToken: Address;
} {
  const stock = RH_CHAIN_TOKENS[symbol];
  if (side === 'buy') {
    return { fromToken: RH_CHAIN_TOKENS.USDG, toToken: stock };
  }
  return { fromToken: stock, toToken: RH_CHAIN_TOKENS.USDG };
}

/**
 * Build a planned swap from an `rh-chain-swap` action.
 *
 * Returns null when:
 *   - The swap address is not configured (pre-deploy).
 *   - The action does not carry the required (symbol, side, quantity, limitPrice).
 *
 * Errors thrown here are recoverable: the agent loop catches them and emits
 * a RiskEvent without halting the tick.
 */
export async function planRhSwap(
  tokenId: bigint,
  action: Action,
): Promise<PlannedRhSwap | null> {
  if (!RH_CHAIN_SWAP_CONFIGURED) {
    log.warn(
      { data: { tokenId: tokenId.toString() } },
      'rh-chain-swap planning skipped: BACKEND_RH_CHAIN_SWAP_ADDRESS unset',
    );
    return null;
  }

  if (action.kind !== 'rh-chain-swap') {
    throw new Error('planRhSwap: action.kind must be rh-chain-swap');
  }
  if (!action.symbol || !action.side || action.quantity === undefined) {
    throw new Error('planRhSwap: action missing symbol, side, or quantity');
  }
  if (action.limitPriceUsdQ96 === undefined || action.limitPriceUsdQ96 <= 0n) {
    throw new Error('planRhSwap: action missing positive limitPriceUsdQ96');
  }

  const { fromToken, toToken } = resolveTokens(action.symbol, action.side);
  const isBuy = action.side === 'buy';

  // Translate the strategy's Q96.48 share quantity into the on-chain
  // amountIn. For buys, amountIn is denominated in USDG (6 decimals) and
  // equals qty * price / 1e18 once we resolve the decimal mismatch. For
  // sells, amountIn is the stock quantity directly in 18 decimals.
  const ONE_Q48 = 1n << 48n;
  const qtySharesUnits = action.quantity; // Q96.48 share count
  const priceQ96 = action.limitPriceUsdQ96;

  let amountIn: bigint;
  if (isBuy) {
    // USDG amountIn = qtyShares * pricePerShare. Convert from Q96.48^2 to
    // USDG-micro: (qtyQ96 * priceQ96) / (1<<96) gives Q0 USD, * 1e6 -> USDG.
    const usdQ0 = (qtySharesUnits * priceQ96) / (ONE_Q48 * ONE_Q48);
    amountIn = usdQ0 * 10n ** BigInt(USDG_DECIMALS);
  } else {
    // Stock amountIn = qtyShares (Q96.48) -> 18-dec stock units.
    amountIn = (qtySharesUnits * 10n ** BigInt(STOCK_DECIMALS)) / ONE_Q48;
  }

  if (amountIn === 0n) {
    throw new Error('planRhSwap: amountIn truncated to zero');
  }

  const priceWad = priceWadForSwap(fromToken, toToken, priceQ96);
  // Slippage floor: minAmountOut = amountIn * priceWad / 1e18 * (1 - slippage).
  const ideal = (amountIn * priceWad) / 10n ** 18n;
  const minAmountOut = (ideal * BigInt(10000 - DEFAULT_SLIPPAGE_BPS)) / 10000n;
  // maxPriceWad ceiling at +100bps; protects the caller if the attestor
  // signs a higher price than expected.
  const maxPriceWad = (priceWad * 10100n) / 10000n;

  const signed = await signPrice({
    tokenId,
    fromToken,
    toToken,
    amountIn,
    minAmountOut,
    priceWad,
  });

  return {
    tokenId,
    fromToken: getAddress(fromToken),
    toToken: getAddress(toToken),
    amountIn,
    minAmountOut,
    maxPriceWad,
    signed,
  };
}

/**
 * Result of submitting a planned swap on-chain. We export a stable shape so
 * the agent loop can persist it in the AgentAction audit row.
 */
export interface RhSwapSubmission {
  txHash: Hex;
  swapAddress: Address;
  plan: PlannedRhSwap;
}

/**
 * Format a planned swap as a sanitised JSON payload safe to persist + emit
 * via SSE. Hides the signature beyond a 10-char prefix per backend logging
 * rules.
 */
export function sanitiseSwapForLog(plan: PlannedRhSwap): Record<string, unknown> {
  return {
    tokenId: plan.tokenId.toString(),
    fromToken: plan.fromToken,
    toToken: plan.toToken,
    amountIn: plan.amountIn.toString(),
    minAmountOut: plan.minAmountOut.toString(),
    maxPriceWad: plan.maxPriceWad.toString(),
    priceWad: plan.signed.priceWad.toString(),
    nonce: plan.signed.nonce.toString(),
    validUntil: plan.signed.validUntil.toString(),
    sig: `${plan.signed.signature.slice(0, 10)}...`,
    swapAddress: BACKEND_RH_CHAIN_SWAP_ADDRESS,
  };
}
