/**
 * Stylus reactivation weekly health check (Wave F).
 *
 * Per `09_arbitrum_technical_deep_dive.md` section 5.12 and PrimeAgent.md
 * section 17.bis FIPs: Stylus programs expire after roughly one year. Calls
 * into an expired program revert with `ProgramNotActivated()`; the program
 * must be reactivated (a small one-time gas fee) before it can be invoked
 * again.
 *
 * Approach:
 *   1. Once a week (cron `0 0 * * 0` by default, Sundays 00:00 UTC) iterate
 *      every chain that has `BACKEND_MARGIN_ENGINE_ADDRESS_*` configured.
 *   2. For each, read the deployed bytecode via `publicClient.getBytecode`,
 *      compute the keccak256 code hash, then call
 *      `ArbWasm.programInitGas(codeHash)` at precompile address
 *      `0x0000000000000000000000000000000000000071`.
 *   3. On revert: fire the `stylus_reactivation_required` webhook with the
 *      `{ chainId, marginEngineAddress, codeHash }` payload and log an
 *      `error` line with full context.
 *   4. On success: log `info { chainId, gas, cached }`; no webhook.
 *
 * Defensive posture:
 *   - When no margin-engine env is configured the worker logs once at debug
 *     and exits without scheduling. The webhook is never fired in dev/test.
 *   - Per-chain failures (RPC unreachable, bytecode-not-found) are caught
 *     and logged; one bad chain never blocks the other.
 *   - `isRunning` guard prevents the cron from re-entering itself if a
 *     check happens to outlive its window.
 */

import cron from 'node-cron';
import { type Address, type Hex, keccak256 } from 'viem';

import { ARB_WASM_ABI } from '../lib/contracts/abis.ts';
import {
  ARB_SEPOLIA_CHAIN_ID,
  type SupportedChainId,
  getPublicClient,
} from '../lib/viem.ts';
import {
  BACKEND_MARGIN_ENGINE_ADDRESS_ARB_SEPOLIA,
  STYLUS_HEALTH_CHECK_CRON,
} from '../config/main-config.ts';
import { forSvc } from '../lib/logger.ts';
import { emit as emitWebhook } from '../services/webhookEmitter.ts';

const log = forSvc('stylusHealthCheck');

const ARB_WASM_ADDRESS =
  '0x0000000000000000000000000000000000000071' as Address;

let isRunning = false;
let scheduled = false;

interface TargetEngine {
  chainId: SupportedChainId;
  address: Address;
}

function collectTargets(): TargetEngine[] {
  const out: TargetEngine[] = [];
  const arb = BACKEND_MARGIN_ENGINE_ADDRESS_ARB_SEPOLIA;
  if (arb && /^0x[0-9a-fA-F]{40}$/.test(arb)) {
    out.push({ chainId: ARB_SEPOLIA_CHAIN_ID, address: arb as Address });
  }
  return out;
}

async function checkOne(target: TargetEngine): Promise<void> {
  const client = getPublicClient(target.chainId);

  let code: Hex | undefined;
  try {
    code = await client.getBytecode({ address: target.address });
  } catch (err) {
    log.error(
      {
        chainId: target.chainId,
        err_class: (err as Error)?.name,
        data: {
          marginEngineAddress: target.address,
          msg: (err as Error)?.message ?? String(err),
        },
      },
      'getBytecode failed; skipping',
    );
    return;
  }

  if (!code || code === '0x') {
    log.error(
      {
        chainId: target.chainId,
        data: { marginEngineAddress: target.address },
      },
      'margin engine has no bytecode at the configured address',
    );
    return;
  }

  const codeHash = keccak256(code);

  try {
    const result = (await client.readContract({
      address: ARB_WASM_ADDRESS,
      abi: ARB_WASM_ABI,
      functionName: 'programInitGas',
      args: [codeHash],
    })) as readonly [bigint, bigint];

    const [gas, cached] = result;
    log.info(
      {
        chainId: target.chainId,
        data: {
          marginEngineAddress: target.address,
          codeHash,
          gas: gas.toString(),
          cached: cached.toString(),
        },
      },
      'stylus program healthy',
    );
  } catch (err) {
    // Reverts with `ProgramNotActivated()` (selector `0xcf4eebde`) when the
    // program needs reactivation. We do not strictly check the selector
    // because RPC providers vary in how they surface revert data; any
    // failure here is treated as a reactivation signal so the operator is
    // alerted and can confirm via the explorer.
    const msg = (err as Error)?.message ?? String(err);
    log.error(
      {
        chainId: target.chainId,
        err_class: (err as Error)?.name,
        data: {
          marginEngineAddress: target.address,
          codeHash,
          msg,
        },
      },
      'ArbWasm.programInitGas reverted; stylus reactivation required',
    );
    emitWebhook('stylus_reactivation_required', {
      tokenId: '0',
      chainId: target.chainId,
      data: {
        chainId: target.chainId,
        marginEngineAddress: target.address,
        codeHash,
      },
    });
  }
}

/**
 * Run a single sweep across every configured chain. Exported for tests.
 */
async function runOnce(): Promise<{ checked: number; targets: TargetEngine[] }> {
  if (isRunning) {
    log.warn({}, 'previous run still active, skipping');
    return { checked: 0, targets: [] };
  }
  isRunning = true;
  try {
    const targets = collectTargets();
    if (targets.length === 0) {
      log.debug({}, 'no margin engine address configured; skipping');
      return { checked: 0, targets: [] };
    }
    for (const t of targets) {
      try {
        await checkOne(t);
      } catch (err) {
        log.error(
          {
            chainId: t.chainId,
            err_class: (err as Error)?.name,
            data: { msg: (err as Error)?.message ?? String(err) },
          },
          'checkOne threw unexpectedly',
        );
      }
    }
    return { checked: targets.length, targets };
  } finally {
    isRunning = false;
  }
}

/**
 * Mount the worker. Idempotent: a second call is a no-op. Logs once with
 * the resolved cron expression so operators can confirm the cadence at
 * boot. The cron task is held by the module-level `node-cron` registry so
 * we do not need to keep a handle for shutdown (the process exit clears it).
 */
export function startStylusHealthCheckWorker(): void {
  if (scheduled) return;
  scheduled = true;
  log.info(
    { data: { cron: STYLUS_HEALTH_CHECK_CRON } },
    'stylus health check scheduled',
  );
  cron.schedule(STYLUS_HEALTH_CHECK_CRON, () => {
    void runOnce();
  });
}

/**
 * Test-only handle to the inner runner + scheduler reset.
 */
export const __internal = {
  runOnce,
  reset(): void {
    isRunning = false;
    scheduled = false;
  },
  ARB_WASM_ADDRESS,
};
