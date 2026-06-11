/**
 * RH Chain swap executor (chain 46630).
 *
 * The piece that closes the gap between "agent signs a Price quote" and
 * "agent submits the swap on-chain". The planner (`rhSwapPlanner.ts`)
 * computes amountIn / minAmountOut / maxPriceWad and obtains an EIP-712
 * signature; this module wraps the submit-and-wait flow so the tick loop
 * can hand off a fully resolved `ExecuteSwapResult` and persist it.
 *
 * Flow per call:
 *   1. Re-sign a fresh Price quote (so nonce + validUntil are current at
 *      submit time even if the planner ran several seconds earlier).
 *   2. `estimateContractGas` against the swap call. A failed estimate
 *      surfaces the same revert reason the tx would, without burning gas.
 *   3. `writeContract` on the configured wallet client.
 *   4. `waitForTransactionReceipt`.
 *   5. If `status === 'reverted'`, decode the revert reason against the
 *      contract's custom-error ABI and throw.
 *   6. Otherwise parse the `Swap` event from the receipt logs and return
 *      the materialised result.
 *
 * Concurrency: there is a per-tokenId in-process mutex. The contract's
 * `_swapNonces[tokenId]` is incremented per successful swap; if two ticks
 * raced and both built a Price at the same nonce, only one would land. The
 * mutex prevents the wasted RPC round-trip + failed-tx noise. Implemented
 * as a Map<tokenId-string, Promise> so callers .await the in-flight promise
 * instead of submitting a parallel write. The keying is on the bigint's
 * string form because Map uses SameValueZero and 1n !== 1n in some
 * polyfills (avoid surprises).
 *
 * Idempotency: a separate guard against double-submission from a buggy
 * strategy that emits two `rh-chain-swap` actions for the same tick. The
 * planner-output content (tokenId, fromToken, toToken, amountIn, tick) is
 * hashed; the same hash within 5 minutes is refused with a typed error.
 *
 * Security notes:
 *   - NEVER logs the signature or the wallet private key. Any payload
 *     containing the signature is filtered via the planner's
 *     `sanitiseSwapForLog` helper.
 *   - Refuses to construct the wallet client when env vars are missing;
 *     the gating happens at the top of `executeRhChainSwap`.
 *   - The wallet client is the configured RH Chain swap signer (the same
 *     attestor key per ADR Section 5). For mainnet this MUST move to a
 *     user-granted ERC-7715 session key per ADR Section 12.
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  decodeErrorResult,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  keccak256,
  toHex,
} from 'viem';

import {
  BACKEND_RH_CHAIN_SWAP_ADDRESS,
  BACKEND_RH_CHAIN_SWAP_SIGNER_PRIVATE_KEY,
  RH_CHAIN_SWAP_CONFIGURED,
} from '../config/main-config.ts';
import { RH_CHAIN_SWAP_ABI } from '../lib/contracts/abis.ts';
import { forSvc } from '../lib/logger.ts';
import { increment, observe } from '../lib/metrics.ts';
import { rhChainPublicClient, rhChainWalletClient } from '../lib/rhChainViem.ts';
import { signPrice } from '../lib/rhChainSigners.ts';

const log = forSvc('rhChainSwapExecutor');

/** Idempotency guard window. Brief sets 5 minutes; matches contract MAX_PRICE_TTL semantics. */
const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1_000;

/** Hard cap on validUntil. Mirrors the planner's `DEFAULT_PRICE_TTL_SECONDS=120`. */
const SWAP_TTL_SECONDS = 120;

/** Contract MAX_PRICE_TTL guard (mirror of `RhChainSwap.MAX_PRICE_TTL`). */
const MAX_PRICE_TTL_SECONDS = 300;

export interface ExecuteSwapInput {
  tokenId: bigint;
  fromToken: Address;
  toToken: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  maxPriceWad: bigint;
  /**
   * Off-chain priceWad already chosen by the planner; the executor re-signs
   * the Price quote using THIS price (and a fresh nonce + validUntil). The
   * caller can compute fresh market data and pass it in, or pass through
   * the same value the planner used.
   */
  priceWad: bigint;
  /**
   * Optional tick number; combined with the swap content to form the
   * idempotency key. When omitted, the key is content-only (still de-dupes
   * within 5 minutes).
   */
  tick?: number;
}

export interface ExecuteSwapResult {
  txHash: Hex;
  blockNumber: bigint;
  priceWad: bigint;
  nonce: bigint;
  validUntil: bigint;
  /** `amountOut` parsed from the `Swap` event logs. */
  effectiveAmountOut: bigint;
  gasUsed: bigint;
}

/**
 * Typed error thrown when the executor refuses to submit because a guard
 * tripped. Surfacing a discrete class keeps the caller's logging tidy.
 */
export class RhSwapExecutorError extends Error {
  readonly code:
    | 'NOT_CONFIGURED'
    | 'NO_SIGNER'
    | 'DUPLICATE_SUBMISSION'
    | 'GAS_ESTIMATION_REVERTED'
    | 'TX_REVERTED'
    | 'SWAP_EVENT_MISSING';
  readonly reason?: string;

  constructor(
    code: RhSwapExecutorError['code'],
    message: string,
    reason?: string,
  ) {
    super(message);
    this.name = 'RhSwapExecutorError';
    this.code = code;
    this.reason = reason;
  }
}

// ----- Per-tokenId serialisation -----
// Map<tokenIdString, Promise<unknown>>. The promise reference is the
// in-flight execution; subsequent callers .await it then race for the next
// slot. The string-keying avoids any bigint identity confusion across
// realm boundaries (test mocks, dynamic imports).
const inFlight = new Map<string, Promise<ExecuteSwapResult>>();

// ----- Idempotency -----
// Map<keyHex, expiresAtMs>. A successful submission marks the key as used
// for `IDEMPOTENCY_WINDOW_MS`. Entries are pruned lazily on insert.
const idempotencyLog = new Map<Hex, number>();

function computeIdempotencyKey(input: ExecuteSwapInput): Hex {
  const tick = input.tick ?? 0;
  const preimage =
    `${input.tokenId.toString()}|` +
    `${input.fromToken.toLowerCase()}|` +
    `${input.toToken.toLowerCase()}|` +
    `${input.amountIn.toString()}|` +
    `${tick}`;
  return keccak256(toHex(preimage));
}

function pruneIdempotency(now: number): void {
  for (const [key, expiresAt] of idempotencyLog.entries()) {
    if (expiresAt < now) idempotencyLog.delete(key);
  }
}

/**
 * Decode an unknown error against the RH Chain swap ABI. Returns a short,
 * sanitised reason string suitable for user-facing logs / SSE events. We
 * deliberately do NOT include the full hex calldata; the explorer linkout
 * carries that already.
 */
export function decodeRhSwapRevert(err: unknown): string {
  const e = err as { cause?: { data?: Hex }; data?: Hex; shortMessage?: string; message?: string };
  // viem nests revert data in `cause.data` for contract reads, top-level
  // `data` for some transports. Try both.
  const data: Hex | undefined =
    (e?.cause?.data as Hex | undefined) ?? (e?.data as Hex | undefined);
  if (data && data.length >= 10) {
    try {
      const decoded = decodeErrorResult({
        abi: RH_CHAIN_SWAP_ABI,
        data,
      });
      const argSummary = (decoded.args ?? [])
        .map((a) => (typeof a === 'bigint' ? a.toString() : String(a)))
        .join(',');
      return argSummary ? `${decoded.errorName}(${argSummary})` : decoded.errorName;
    } catch {
      // Fall through to shortMessage.
    }
  }
  return e?.shortMessage ?? e?.message ?? 'unknown revert';
}

/**
 * Internal worker: the unguarded submit-and-wait. Run inside the mutex.
 */
async function runExecution(input: ExecuteSwapInput): Promise<ExecuteSwapResult> {
  if (!RH_CHAIN_SWAP_CONFIGURED || !BACKEND_RH_CHAIN_SWAP_ADDRESS) {
    throw new RhSwapExecutorError(
      'NOT_CONFIGURED',
      'BACKEND_RH_CHAIN_SWAP_ADDRESS is unset; refusing to submit RH Chain swap to address(0)',
    );
  }
  if (!BACKEND_RH_CHAIN_SWAP_SIGNER_PRIVATE_KEY) {
    throw new RhSwapExecutorError(
      'NO_SIGNER',
      'BACKEND_RH_CHAIN_SWAP_SIGNER_PRIVATE_KEY is unset; refusing to construct the RH Chain wallet client',
    );
  }

  // ----- Sign a fresh Price quote at submit time. -----
  // The planner already signed once; re-signing now guarantees the
  // contract sees the latest on-chain swapNonce + a fresh validUntil
  // window. This matters when the planner ran more than a few seconds
  // before the executor (queueing, mutex wait, etc.).
  const signed = await signPrice({
    tokenId: input.tokenId,
    fromToken: input.fromToken,
    toToken: input.toToken,
    amountIn: input.amountIn,
    minAmountOut: input.minAmountOut,
    priceWad: input.priceWad,
  });

  // Defensive: enforce the contract's MAX_PRICE_TTL on the off-chain side
  // too, so any future drift in `clampValidUntil` cannot let a quote with
  // a too-long TTL reach the chain (the contract would revert
  // `TTLTooLong`, but failing fast off-chain is cleaner).
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (signed.validUntil > nowSec + BigInt(MAX_PRICE_TTL_SECONDS)) {
    throw new RhSwapExecutorError(
      'GAS_ESTIMATION_REVERTED',
      'validUntil exceeds MAX_PRICE_TTL; refusing to submit',
    );
  }

  const swapAddress = getAddress(BACKEND_RH_CHAIN_SWAP_ADDRESS);
  const publicClient: PublicClient = rhChainPublicClient();
  const walletClient: WalletClient = rhChainWalletClient();
  const account = walletClient.account;
  if (!account) {
    throw new RhSwapExecutorError(
      'NO_SIGNER',
      'rhChainWalletClient returned a client without an account; check BACKEND_RH_CHAIN_SWAP_SIGNER_PRIVATE_KEY',
    );
  }

  const args = [
    input.tokenId,
    input.fromToken,
    input.toToken,
    input.amountIn,
    input.minAmountOut,
    input.maxPriceWad,
    input.priceWad,
    signed.nonce,
    signed.validUntil,
    signed.signature,
  ] as const;

  // Sanity log (NO signature, NO private material).
  log.info(
    {
      data: {
        tokenId: input.tokenId.toString(),
        fromToken: input.fromToken,
        toToken: input.toToken,
        amountIn: input.amountIn.toString(),
        minAmountOut: input.minAmountOut.toString(),
        priceWad: input.priceWad.toString(),
        nonce: signed.nonce.toString(),
      },
    },
    'rh-chain-swap: estimating gas',
  );

  // ----- Gas estimation (short-circuit on simulated revert). -----
  // estimateContractGas runs an eth_estimateGas under the hood, which
  // performs a full simulation against pending state. A simulated revert
  // throws and we surface the decoded reason WITHOUT burning gas. This is
  // the cheaper alternative to `simulateContract`: we do not need the
  // return value (`amountOut`) here because we get it from the event.
  let gasEstimate: bigint;
  try {
    gasEstimate = await publicClient.estimateContractGas({
      account,
      address: swapAddress,
      abi: RH_CHAIN_SWAP_ABI,
      functionName: 'swap',
      args,
    });
  } catch (err) {
    const reason = decodeRhSwapRevert(err);
    log.warn(
      {
        data: {
          tokenId: input.tokenId.toString(),
          reason,
        },
      },
      'rh-chain-swap: gas estimation reverted; refusing to submit',
    );
    increment('rh_swap_gas_estimation_reverted_total', 1);
    throw new RhSwapExecutorError(
      'GAS_ESTIMATION_REVERTED',
      `gas estimation reverted: ${reason}`,
      reason,
    );
  }

  // 25% safety margin on the gas limit. The contract is not gas-greedy
  // (a single SafeERC20 transfer plus two SSTOREs) but Arbitrum Orbit
  // chains charge for L1 calldata posting too; the buffer absorbs the
  // estimator's typical underestimate without ever exceeding the
  // sequencer's per-tx cap.
  const gasLimit = (gasEstimate * 125n) / 100n;

  // ----- Build calldata + submit. -----
  // We use writeContract (typed args) rather than sendRawTransaction so
  // viem manages nonce + chain selection. encodeFunctionData is computed
  // only for the audit log entry; the actual submission uses the typed
  // path.
  const calldata = encodeFunctionData({
    abi: RH_CHAIN_SWAP_ABI,
    functionName: 'swap',
    args,
  });
  log.info(
    {
      data: {
        tokenId: input.tokenId.toString(),
        gasLimit: gasLimit.toString(),
        // Truncate calldata to 6 chars + ellipsis per global logging rules.
        calldataPrefix: `${calldata.slice(0, 10)}...`,
      },
    },
    'rh-chain-swap: submitting tx',
  );

  const start = Date.now();
  let txHash: Hex;
  try {
    txHash = await walletClient.writeContract({
      account,
      address: swapAddress,
      abi: RH_CHAIN_SWAP_ABI,
      functionName: 'swap',
      args,
      gas: gasLimit,
      chain: walletClient.chain,
    });
  } catch (err) {
    // writeContract can throw before broadcasting (e.g. RPC down).
    const reason = decodeRhSwapRevert(err);
    increment('rh_swap_submit_failed_total', 1);
    throw new RhSwapExecutorError(
      'TX_REVERTED',
      `swap submission failed: ${reason}`,
      reason,
    );
  }

  // ----- Wait for receipt. -----
  // The transport is the fallback() set up in `rhChainViem.ts`; viem
  // handles the polling against whichever endpoint is healthy.
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    // 60s ~ 5 blocks on Arbitrum Orbit at 12s blocktimes; comfortable.
    timeout: 60_000,
    confirmations: 1,
  });

  observe('rh_swap_submit_duration_ms', Date.now() - start);

  if (receipt.status === 'reverted') {
    // Decode by re-running the call as a static call (`callContract`)
    // against the receipt's block; this reproduces the revert and gives
    // viem something to decode against the ABI errors.
    let reason = 'tx reverted';
    try {
      await publicClient.simulateContract({
        account,
        address: swapAddress,
        abi: RH_CHAIN_SWAP_ABI,
        functionName: 'swap',
        args,
        blockNumber: receipt.blockNumber,
      });
    } catch (err) {
      reason = decodeRhSwapRevert(err);
    }
    increment('rh_swap_tx_reverted_total', 1);
    throw new RhSwapExecutorError(
      'TX_REVERTED',
      `swap tx reverted on-chain: ${reason}`,
      reason,
    );
  }

  // ----- Parse the Swap event from the receipt logs. -----
  // The contract emits exactly one Swap per call; we filter on address +
  // event name. viem's `decodeEventLog` throws on a topic mismatch, so we
  // catch and skip any unrelated logs.
  let effectiveAmountOut: bigint | null = null;
  for (const lg of receipt.logs) {
    if (lg.address.toLowerCase() !== swapAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: RH_CHAIN_SWAP_ABI,
        data: lg.data,
        topics: lg.topics,
        eventName: 'Swap',
      });
      // decodeEventLog's args are typed by the ABI; runtime check is safe.
      const args = decoded.args as unknown as { amountOut: bigint };
      if (typeof args.amountOut === 'bigint') {
        effectiveAmountOut = args.amountOut;
        break;
      }
    } catch {
      // Not the Swap event; skip.
    }
  }

  if (effectiveAmountOut === null) {
    increment('rh_swap_event_missing_total', 1);
    throw new RhSwapExecutorError(
      'SWAP_EVENT_MISSING',
      'tx confirmed but no Swap event found in logs; receipt may be from an unrelated contract',
    );
  }

  increment('rh_swap_submitted_total', 1);

  return {
    txHash,
    blockNumber: receipt.blockNumber,
    priceWad: input.priceWad,
    nonce: signed.nonce,
    validUntil: signed.validUntil,
    effectiveAmountOut,
    gasUsed: receipt.gasUsed,
  };
}

/**
 * Execute a planned RH Chain swap end-to-end. Serialised per-tokenId by an
 * in-process Map<string,Promise> so two concurrent calls for the same
 * tokenId run sequentially.
 *
 * Errors thrown by this function are of class `RhSwapExecutorError`; the
 * caller should publish a `rh_swap_failed` event and a failed-action audit
 * row, NOT crash the tick loop.
 */
export async function executeRhChainSwap(
  input: ExecuteSwapInput,
): Promise<ExecuteSwapResult> {
  // Cheap idempotency check BEFORE we take the per-tokenId mutex, so a
  // duplicate intent (eg. strategy emitted twice in the same tick) fails
  // fast without serialising behind a long-running submit.
  const now = Date.now();
  pruneIdempotency(now);
  const idemKey = computeIdempotencyKey(input);
  if (idempotencyLog.has(idemKey)) {
    throw new RhSwapExecutorError(
      'DUPLICATE_SUBMISSION',
      `duplicate rh-chain-swap rejected: key=${idemKey.slice(0, 10)}... seen within ${Math.floor(IDEMPOTENCY_WINDOW_MS / 1000)}s`,
    );
  }

  const mutexKey = input.tokenId.toString();
  const prior = inFlight.get(mutexKey);
  if (prior) {
    // Wait for the in-flight call to finish (success or fail) then race
    // for the next slot. We intentionally do NOT inherit the prior's
    // result; this is a serialisation barrier, not a promise broker.
    try {
      await prior;
    } catch {
      // The prior's caller already handled its error; we are free to
      // attempt a fresh submission.
    }
  }

  // Build the worker promise first, capture it locally, then install in the
  // map. We compare-against the captured reference inside `finally` so the
  // cleanup is safe even if a later caller has overwritten the slot.
  let work!: Promise<ExecuteSwapResult>;
  work = (async (): Promise<ExecuteSwapResult> => {
    try {
      const result = await runExecution(input);
      // Mark the idempotency key only AFTER a successful execution. A
      // failed attempt should not block the strategy from re-trying.
      idempotencyLog.set(idemKey, Date.now() + IDEMPOTENCY_WINDOW_MS);
      return result;
    } finally {
      // Always clear the slot before resolving so the next caller can
      // proceed without waiting for GC.
      if (inFlight.get(mutexKey) === work) {
        inFlight.delete(mutexKey);
      }
    }
  })();
  inFlight.set(mutexKey, work);
  return work;
}

/**
 * Test-only inspection / reset hooks. Production callers MUST NOT use this.
 */
export const __internal = {
  computeIdempotencyKey,
  decodeRhSwapRevert,
  inFlight,
  idempotencyLog,
  IDEMPOTENCY_WINDOW_MS,
  SWAP_TTL_SECONDS,
  reset(): void {
    inFlight.clear();
    idempotencyLog.clear();
  },
};
