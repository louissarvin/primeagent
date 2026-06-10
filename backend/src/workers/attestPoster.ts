/**
 * AttestPoster worker. Per PrimeAgent.md section 6.5 step 6 / section 9.
 *
 * Every 60 seconds:
 *   1) Find every live `AgentPolicy` row (deletedAt = null, expiresAt > now).
 *   2) Fetch the off-chain state for the tokenId via mcp/client.ts.
 *   3) Sign an EIP-712 attestation (lib/attestor.ts).
 *   4) Submit `RobinhoodMcpAttestor.attest(payload, sig)` with a
 *      Timeboost-aware `maxPriorityFeePerGas` so the attestation lands ahead
 *      of competing same-block transactions.
 *
 * Wave A scope: iterates real AgentPolicy rows but still derives
 * `userId` / `accountId` from demo envs. Wave B replaces this with a lookup
 * from `kernelAddress` -> `PositionNFT.ownerOf(tokenId)` -> User row. See
 * `TODO(Wave B)` markers below.
 *
 * Defensive posture:
 *   - Missing env (attestor key, contract address) -> log once, no-op forever.
 *   - Per-row RPC errors caught and logged; the loop continues to the next row.
 *   - Structured logging via `forSvc('attestPoster')`; no `console.*`.
 */

import cron from 'node-cron';
import type { Hex } from 'viem';

import { attestState, type OffChainState, type RhChainPositionSnapshot } from '../lib/attestor.ts';
import { fetchAccountState } from '../mcp/client.ts';
import {
  ARB_SEPOLIA_CHAIN_ID,
  type SupportedChainId,
  getAttestorWalletClient,
  getPublicClient,
} from '../lib/viem.ts';
import { POSITION_NFT_ABI, ROBINHOOD_MCP_ATTESTOR_ABI } from '../lib/contracts/abis.ts';
import { getContractAddress } from '../lib/contracts/addresses.ts';
import { BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA } from '../config/main-config.ts';
import { centsToUsdQ96 } from '../lib/units.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { currentPriorityTipWei } from '../services/arbGasInfo.ts';
import { forSvc } from '../lib/logger.ts';
import { getRhChainPosition } from '../lib/rhChainSwapClient.ts';
import {
  BACKEND_RH_CHAIN_SWAP_ADDRESS,
  RH_CHAIN_SWAP_CONFIGURED,
} from '../config/main-config.ts';
import { publishEvent } from '../lib/runtimeStore.ts';
import type { Address } from 'viem';

const log = forSvc('attestPoster');

const SCHEDULE = '*/1 * * * *';

let isRunning = false;
let disabledLogged = false;

function envString(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function envChainId(name: string, fallback: SupportedChainId): SupportedChainId {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (n === 421614 || n === 46630) return n as SupportedChainId;
  return fallback;
}

function truncateStack(err: unknown): string {
  const e = err as Error;
  const msg = e?.message ?? String(err);
  return msg.length > 400 ? `${msg.slice(0, 400)}...` : msg;
}

/**
 * Read the RH Chain swap position for `tokenId` and shape it into the
 * `RhChainPositionSnapshot` audit field. Returns `undefined` when:
 *   - RH Chain swap wiring is disabled (env empty); `getRhChainPosition`
 *     returns null without issuing any RPC traffic in that case (the
 *     wiring check lives inside the client per its existing contract).
 *   - The RPC read fails or returns malformed data. The tick continues so
 *     a single bad block on RH Chain never starves the audit log.
 *
 * Logging:
 *   - INFO when a snapshot is included (with token count + nonces; no PII).
 *   - DEBUG when skipped or failed (graceful degradation path).
 *
 * Never throws.
 */
async function readRhChainSnapshot(
  tokenId: bigint,
): Promise<RhChainPositionSnapshot | undefined> {
  // Fast-path: when wiring is unset at boot we skip the call entirely so
  // no `getRhChainPosition` symbol resolution / RPC client construction
  // happens pre-deploy. The client itself also guards on this flag.
  if (!RH_CHAIN_SWAP_CONFIGURED) {
    log.debug(
      { tokenId: tokenId.toString() },
      'attestation without RH Chain position (wiring disabled)',
    );
    return undefined;
  }
  try {
    const position = await getRhChainPosition(tokenId);
    if (!position) {
      log.debug(
        { tokenId: tokenId.toString() },
        'attestation without RH Chain position (RPC returned null)',
      );
      return undefined;
    }
    // Shape into the audit type. Bigints stringified here so the canonical
    // JSON encoder (in lib/attestor.ts) does not need any new branches.
    const snapshot: RhChainPositionSnapshot = {
      swapAddress: BACKEND_RH_CHAIN_SWAP_ADDRESS as Address,
      tokens: position.tokens,
      balances: position.balances.map((b) => b.toString()),
      swapNonce: position.swapNonce.toString(),
      withdrawNonce: position.withdrawNonce.toString(),
      revokedAt: position.revokedAt,
      paused: position.paused,
      owner: position.owner,
    };
    log.info(
      {
        tokenId: tokenId.toString(),
        data: {
          tokens_count: position.tokens.length,
          swap_nonce: snapshot.swapNonce,
          withdraw_nonce: snapshot.withdrawNonce,
          paused: snapshot.paused,
        },
      },
      'attestation includes RH Chain position',
    );
    return snapshot;
  } catch (err) {
    // Graceful degradation: log a warning, return undefined, let the tick
    // proceed. We do NOT propagate so a flaky RH Chain RPC cannot stall the
    // 60s audit cadence on the home chain.
    log.warn(
      {
        tokenId: tokenId.toString(),
        err_class: (err as Error)?.name,
      },
      `attestation without RH Chain position (RPC failed): ${truncateStack(err)}`,
    );
    return undefined;
  }
}

/**
 * Wave C2: resolve `(userId, accountId)` for a given tokenId by walking the
 * NFT-owner -> User -> RobinhoodCredential chain. Falls back to demo envs
 * when:
 *   - PositionNFT address is unconfigured (dev posture),
 *   - the NFT owner does not match any User row, or
 *   - the User has no RobinhoodCredential (unlinked account).
 *
 * Never throws; returns demo envs as the safety net so the cron does not
 * stall on a single unlinked agent.
 */
async function resolveTokenIdentity(
  tokenId: bigint,
  chainId: SupportedChainId,
): Promise<{ userId: string; accountId: string; source: 'real' | 'fallback' }> {
  const fallback = {
    userId: envString('BACKEND_DEMO_USER_ID', 'demo-user'),
    accountId: envString('BACKEND_DEMO_ACCOUNT_ID', 'demo'),
    source: 'fallback' as const,
  };

  const nftAddress = BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA;
  if (!nftAddress || !/^0x[0-9a-fA-F]{40}$/.test(nftAddress)) {
    return fallback;
  }

  let owner: `0x${string}`;
  try {
    const publicClient = getPublicClient(chainId);
    owner = (await publicClient.readContract({
      address: nftAddress as `0x${string}`,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    })) as `0x${string}`;
  } catch (err) {
    log.debug(
      { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
      'ownerOf failed; using demo identity',
    );
    return fallback;
  }

  const user = await prismaQuery.user.findFirst({
    where: { walletAddress: owner.toLowerCase() },
    select: { id: true },
  });
  if (!user) return fallback;

  const credential = await prismaQuery.robinhoodCredential.findFirst({
    where: { userId: user.id, deletedAt: null },
    select: { userId: true },
  });
  if (!credential) {
    // User exists but has not linked Robinhood; demo identity is still
    // appropriate (the off-chain leg is just empty for this agent).
    return { ...fallback, userId: user.id };
  }

  // Real user + linked credential. accountId is implicit in the credential
  // row; we use the userId as the account discriminator since this app is
  // single-credential-per-user per `RobinhoodCredential.@@unique([userId, provider])`.
  return { userId: user.id, accountId: user.id, source: 'real' };
}

async function attestOneTokenId(
  tokenId: bigint,
  chainId: SupportedChainId,
): Promise<void> {
  const identity = await resolveTokenIdentity(tokenId, chainId);
  const { userId, accountId } = identity;
  if (identity.source === 'fallback') {
    log.debug(
      { tokenId: tokenId.toString(), data: { reason: 'identity_fallback' } },
      'attesting with demo identity',
    );
  }

  const walletClient = getAttestorWalletClient(chainId);
  const contractAddress = getContractAddress(chainId, 'attestor');

  const state = await fetchAccountState({ userId, accountId });
  const accountValueQ96 = centsToUsdQ96(state.account_value_cents);
  const buyingPowerQ96 = centsToUsdQ96(state.buying_power_cents);

  // Wave RhChainAudit: enrich the audit payload with the on-chain RH Chain
  // swap position. Graceful-skip when wiring is unset (pre-deploy) or the
  // read fails (RPC outage); never fail the tick over this read.
  const rhChain = await readRhChainSnapshot(tokenId);
  const auditState: OffChainState = rhChain ? { ...state, rhChain } : state;

  const signed = await attestState(
    tokenId,
    accountValueQ96,
    buyingPowerQ96,
    auditState,
    chainId,
  );

  const payload = {
    tokenId,
    accountValueQ96,
    buyingPowerQ96,
    notBefore: BigInt(signed.notBefore),
    notAfter: BigInt(signed.notAfter),
    nullifier: signed.nullifier as Hex,
  };

  const publicClient = getPublicClient(chainId);
  const senderAccount = walletClient.account;
  if (!senderAccount) {
    log.warn({ chainId, tokenId: tokenId.toString() }, 'wallet client has no account; skipping');
    return;
  }

  try {
    const { request } = await publicClient.simulateContract({
      address: contractAddress,
      abi: ROBINHOOD_MCP_ATTESTOR_ABI,
      functionName: 'attest',
      args: [payload, signed.signature as Hex],
      account: senderAccount,
    });

    // Timeboost-aware priority tip. Pass through `maxPriorityFeePerGas` on
    // every write; the wallet client surfaces it to the RPC. The cast is
    // needed because simulateContract types its output as a `legacy` tx,
    // but viem accepts the eip1559 fee fields at write time on Arbitrum.
    // Wave E1: tip is sourced dynamically from ArbGasInfo (with a floor
    // env fallback) so demo runs and burst windows both behave correctly.
    const tip = await currentPriorityTipWei(chainId);
    const writeArgs =
      tip > 0n
        ? ({ ...request, type: 'eip1559', maxPriorityFeePerGas: tip } as unknown as typeof request)
        : request;

    const txHash = await walletClient.writeContract(writeArgs);
    log.info(
      {
        chainId,
        tokenId: tokenId.toString(),
        txHash,
        attestation_nullifier: signed.nullifier,
      },
      'attestation submitted',
    );

    // Broadcast a `state_update` event so dashboard SSE consumers can
    // refresh without polling. Best-effort: publishEvent is in-process
    // and non-throwing, but we still wrap defensively because we hold
    // no contract with the rest of the worker on event-bus errors.
    try {
      publishEvent(tokenId, {
        kind: 'state_update',
        tokenId,
        ts: Date.now(),
        data: {
          accountValueQ96: accountValueQ96.toString(),
          buyingPowerQ96: buyingPowerQ96.toString(),
          rhChain: rhChain
            ? {
                swapAddress: rhChain.swapAddress,
                chainId: 46630,
                tokens: rhChain.tokens,
                balances: rhChain.balances,
                swapNonce: rhChain.swapNonce,
                withdrawNonce: rhChain.withdrawNonce,
                revokedAt: rhChain.revokedAt,
                paused: rhChain.paused,
                owner: rhChain.owner,
              }
            : null,
        },
      });
    } catch (pubErr) {
      log.warn(
        { tokenId: tokenId.toString(), err_class: (pubErr as Error)?.name },
        `state_update publish failed: ${truncateStack(pubErr)}`,
      );
    }
  } catch (err) {
    log.error(
      {
        chainId,
        tokenId: tokenId.toString(),
        err_class: (err as Error)?.name,
      },
      `tx submission failed: ${truncateStack(err)}`,
    );
  }
}

async function tick(): Promise<void> {
  if (isRunning) {
    log.debug('previous run still active, skipping');
    return;
  }
  isRunning = true;
  try {
    const chainId = envChainId('ATTEST_CHAIN_ID', ARB_SEPOLIA_CHAIN_ID);

    // Surface env-missing once; the cron remains scheduled but every tick
    // returns early until the operator sets the address + key.
    try {
      getAttestorWalletClient(chainId);
      getContractAddress(chainId, 'attestor');
    } catch (err) {
      if (!disabledLogged) {
        log.info(
          { chainId, err_class: (err as Error)?.name },
          `disabled (missing env): ${truncateStack(err)}`,
        );
        disabledLogged = true;
      }
      return;
    }

    const policies = await prismaQuery.agentPolicy.findMany({
      where: {
        deletedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { tokenId: true },
    });

    if (policies.length === 0) {
      log.debug({ chainId }, 'no live policies to attest');
      return;
    }

    for (const row of policies) {
      try {
        await attestOneTokenId(row.tokenId, chainId);
      } catch (err) {
        log.error(
          {
            chainId,
            tokenId: row.tokenId.toString(),
            err_class: (err as Error)?.name,
          },
          `per-row attest failed: ${truncateStack(err)}`,
        );
      }
    }
  } catch (err) {
    log.error({ err_class: (err as Error)?.name }, `tick error: ${truncateStack(err)}`);
  } finally {
    isRunning = false;
  }
}

export function startAttestPosterWorker(): void {
  log.info('attestPoster scheduled');
  cron.schedule(SCHEDULE, tick);
}

/**
 * Test-only surface. Exposes the per-tokenId helper and the RH Chain
 * reader so the worker test can exercise the graceful-skip and
 * happy-path branches without simulating a viem transaction.
 *
 * `readRhChainSnapshotWith` is parametrised over the swap-client read so
 * tests can stub the RPC seam via dependency injection instead of
 * `mock.module`, which persists across test files in Bun and would leak
 * into the `rhChainRoutes` test suite.
 */
export const __internal = {
  attestOneTokenId,
  readRhChainSnapshot,
  /**
   * Test-only variant of `readRhChainSnapshot` that takes the
   * `getPositionFn` as a dependency. Mirrors the production helper's
   * graceful-skip semantics exactly; only the RPC seam is swappable.
   */
  async readRhChainSnapshotWith(
    tokenId: bigint,
    configured: boolean,
    getPositionFn: typeof getRhChainPosition,
  ): Promise<RhChainPositionSnapshot | undefined> {
    if (!configured) return undefined;
    try {
      const position = await getPositionFn(tokenId);
      if (!position) return undefined;
      return {
        swapAddress: BACKEND_RH_CHAIN_SWAP_ADDRESS as Address,
        tokens: position.tokens,
        balances: position.balances.map((b) => b.toString()),
        swapNonce: position.swapNonce.toString(),
        withdrawNonce: position.withdrawNonce.toString(),
        revokedAt: position.revokedAt,
        paused: position.paused,
        owner: position.owner,
      };
    } catch {
      return undefined;
    }
  },
};
