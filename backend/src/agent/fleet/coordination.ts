/**
 * Feature K: broadcast / vote-verify / tally / execute-if-quorum.
 *
 * Tally formula (mirrors research J-K section 3.2):
 *
 *   MIN_FEEDBACK     = 5
 *   QUORUM_BPS       = 6_000   // 60%
 *   MIN_TOTAL_WEIGHT = 5_000   // 50bp average across at least 5 reputable children
 *
 * For each vote v:
 *   read (total, avg, decimals) = AgentRegistry.getReputationSummaryFor(v.childTokenId, [v.voterAddress])
 *   if total < MIN_FEEDBACK: silenced (weight 0; do not invert)
 *   scaled = max(0, avg / 10**decimals)  // clamp negative -> 0
 *   weight = min(scaled, 100) * 100      // bps, 0..10000
 *   totalWeight += weight
 *   if vote == 1: yesWeight += weight
 *
 * execute iff yesBps >= QUORUM_BPS AND totalWeight >= MIN_TOTAL_WEIGHT.
 */

import { verifyTypedData, type Address } from 'viem';

import { prismaExt as prismaQuery } from '../../lib/prismaExtensions.ts';
import { forSvc } from '../../lib/logger.ts';
import { publishEvent } from '../../lib/runtimeStore.ts';
import { getPublicClient, ARB_SEPOLIA_CHAIN_ID, type SupportedChainId } from '../../lib/viem.ts';
import { AGENT_REGISTRY_REPUTATION_ABI } from '../../lib/contracts/abis.ts';
import { BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA } from '../../config/main-config.ts';
import {
  VOTE_DOMAIN,
  VOTE_TYPES,
  type FleetBroadcastEnvelope,
  type FleetVote,
  computeThesisHash,
} from './voteSchemas.ts';

const log = forSvc('fleetCoordination');

export const MIN_FEEDBACK = 5n;
export const QUORUM_BPS = 6_000n;
export const MIN_TOTAL_WEIGHT = 5_000n;

export interface BroadcastResult {
  thesisHash: `0x${string}`;
  broadcastedTo: number;
  expiresAt: number;
}

/**
 * Persist a fleet thesis and publish one runtime event per child. Returns
 * the canonical thesis hash so the parent UI can poll for tally.
 */
export async function broadcastThesis(
  envelope: FleetBroadcastEnvelope,
): Promise<BroadcastResult> {
  const thesisHash = computeThesisHash({
    parentTokenId: envelope.parentTokenId,
    body: envelope.body,
    proposedActions: envelope.proposedActions,
    nonce: envelope.nonce,
    deadline: envelope.deadline,
  });
  const deadlineDate = new Date(Number(envelope.deadline) * 1000);
  if (deadlineDate.getTime() <= Date.now()) {
    throw new BroadcastError('FLEET_THESIS_DEADLINE_PASSED', 'thesis deadline already past');
  }

  // Idempotency via `(parentTokenId, nonce)` unique: re-broadcast with the
  // same nonce returns the existing row's hash. We swallow P2002 and read
  // back so the caller is naturally idempotent.
  try {
    await prismaQuery.fleetThesis.create({
      data: {
        parentTokenId: envelope.parentTokenId,
        thesisHash: Buffer.from(thesisHash.slice(2), 'hex'),
        body: envelope.body,
        proposedActions: envelope.proposedActions as object,
        nonce: envelope.nonce,
        deadline: deadlineDate,
        childTokenIds: envelope.childTokenIds.map((c) => c.toString()),
        signerAddress: envelope.signerAddress,
      },
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'P2002') throw err;
  }

  for (const childTokenId of envelope.childTokenIds) {
    publishEvent(childTokenId, {
      kind: 'chain',
      tokenId: childTokenId,
      ts: Date.now(),
      event: 'fleet_thesis',
      data: {
        parentTokenId: envelope.parentTokenId.toString(),
        thesisHash,
        body: envelope.body,
        proposedActions: envelope.proposedActions as unknown as Record<string, unknown>,
        deadline: envelope.deadline.toString(),
      },
    });
  }
  log.info(
    {
      tokenId: envelope.parentTokenId.toString(),
      data: { thesisHash, broadcastedTo: envelope.childTokenIds.length },
    },
    'fleet thesis broadcast',
  );
  return {
    thesisHash,
    broadcastedTo: envelope.childTokenIds.length,
    expiresAt: Number(envelope.deadline),
  };
}

export class BroadcastError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BroadcastError';
  }
}

export class VoteError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'VoteError';
  }
}

/**
 * Verify a child's typed-data signature and persist the vote. Throws
 * VoteError on signature mismatch / deadline expiry / replay.
 */
export async function recordVote(vote: FleetVote): Promise<void> {
  // Deadline gate first; cheaper than the verify call.
  if (Number(vote.deadline) * 1000 <= Date.now()) {
    throw new VoteError('VOTE_DEADLINE_PASSED', 'vote deadline already past');
  }
  const ok = await verifyTypedData({
    address: vote.voterAddress as Address,
    domain: { ...VOTE_DOMAIN } as { name: string; version: string; chainId: number },
    types: VOTE_TYPES,
    primaryType: 'Vote',
    message: {
      parentTokenId: vote.parentTokenId,
      childTokenId: vote.childTokenId,
      thesisHash: vote.thesisHash as `0x${string}`,
      vote: vote.vote,
      deadline: vote.deadline,
    },
    signature: vote.signature as `0x${string}`,
  });
  if (!ok) {
    throw new VoteError('VOTE_SIGNATURE_INVALID', 'signature did not recover to voterAddress');
  }

  try {
    await prismaQuery.fleetVote.create({
      data: {
        parentTokenId: vote.parentTokenId,
        childTokenId: vote.childTokenId,
        thesisHash: Buffer.from(vote.thesisHash.slice(2), 'hex'),
        vote: vote.vote,
        deadline: new Date(Number(vote.deadline) * 1000),
        signature: Buffer.from(vote.signature.slice(2), 'hex'),
        voterAddress: vote.voterAddress,
        signedAt: new Date(vote.signedAt),
      },
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'P2002') {
      throw new VoteError('VOTE_DUPLICATE', 'child has already voted on this thesis');
    }
    throw err;
  }
}

export interface PerChildTally {
  childTokenId: string;
  vote: 0 | 1;
  weightBps: number;
  silenced: boolean;
}

export interface TallyResult {
  execute: boolean;
  yesBps: number;
  totalWeight: number;
  perChild: PerChildTally[];
}

/**
 * Read reputation per child and compute the tally. `vaultCounterparties`
 * is the list of client addresses ERC-8004 weights against; for v1 we
 * pass the voter address itself (the registry filters internally).
 */
export async function tallyVotes(
  thesisHash: `0x${string}`,
  chainId: SupportedChainId = ARB_SEPOLIA_CHAIN_ID,
): Promise<TallyResult> {
  const hashBuf = Buffer.from(thesisHash.slice(2), 'hex');
  const rows = await prismaQuery.fleetVote.findMany({
    where: { thesisHash: hashBuf },
  });
  const registryAddr =
    chainId === ARB_SEPOLIA_CHAIN_ID
      ? BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA
      : undefined;

  let yesWeight = 0n;
  let totalWeight = 0n;
  const perChild: PerChildTally[] = [];
  const client = registryAddr ? getPublicClient(chainId) : null;
  for (const r of rows) {
    let totalFeedback = 0n;
    let avg = 0n;
    let decimals = 0;
    if (client && registryAddr && /^0x[0-9a-fA-F]{40}$/.test(registryAddr)) {
      try {
        const out = (await client.readContract({
          address: registryAddr as `0x${string}`,
          abi: AGENT_REGISTRY_REPUTATION_ABI,
          functionName: 'getReputationSummaryFor',
          args: [r.childTokenId, [r.voterAddress as `0x${string}`]],
        })) as readonly [bigint, bigint, number];
        totalFeedback = out[0];
        avg = out[1];
        decimals = Number(out[2]);
      } catch (err) {
        log.warn(
          { tokenId: r.childTokenId.toString(), err_class: (err as Error)?.name },
          'reputation read failed, treating child as silenced',
        );
      }
    }
    const silenced = totalFeedback < MIN_FEEDBACK;
    let weight = 0n;
    if (!silenced) {
      // clamp negative -> 0
      const decBase = 10n ** BigInt(decimals);
      const scaled = avg <= 0n ? 0n : avg / decBase; // 0..100 range
      const capped = scaled > 100n ? 100n : scaled;
      weight = capped * 100n; // bps 0..10000
    }
    if (weight > 0n) {
      totalWeight += weight;
      if (r.vote === 1) yesWeight += weight;
    }
    perChild.push({
      childTokenId: r.childTokenId.toString(),
      vote: (r.vote === 1 ? 1 : 0) as 0 | 1,
      weightBps: Number(weight),
      silenced,
    });
    // Persist for audit; ignore failures since the tally itself is the
    // authoritative read.
    await prismaQuery.fleetVote.update({
      where: { id: r.id },
      data: { weightBps: Number(weight) },
    }).catch(() => undefined);
  }
  const yesBps = totalWeight === 0n ? 0n : (yesWeight * 10_000n) / totalWeight;
  const execute = yesBps >= QUORUM_BPS && totalWeight >= MIN_TOTAL_WEIGHT;
  return {
    execute,
    yesBps: Number(yesBps),
    totalWeight: Number(totalWeight),
    perChild,
  };
}

/**
 * Pure helper used by unit tests; the real tally reads reputation from
 * chain. Inputs: per-child (totalFeedback, avg, decimals, vote). Output
 * matches the production `TallyResult`.
 */
export function computeTallyPure(
  votes: ReadonlyArray<{
    childTokenId: bigint;
    vote: 0 | 1;
    totalFeedback: bigint;
    avg: bigint;
    decimals: number;
  }>,
): TallyResult {
  let yesWeight = 0n;
  let totalWeight = 0n;
  const perChild: PerChildTally[] = [];
  for (const v of votes) {
    const silenced = v.totalFeedback < MIN_FEEDBACK;
    let weight = 0n;
    if (!silenced) {
      const decBase = 10n ** BigInt(v.decimals);
      const scaled = v.avg <= 0n ? 0n : v.avg / decBase;
      const capped = scaled > 100n ? 100n : scaled;
      weight = capped * 100n;
    }
    if (weight > 0n) {
      totalWeight += weight;
      if (v.vote === 1) yesWeight += weight;
    }
    perChild.push({
      childTokenId: v.childTokenId.toString(),
      vote: v.vote,
      weightBps: Number(weight),
      silenced,
    });
  }
  const yesBps = totalWeight === 0n ? 0n : (yesWeight * 10_000n) / totalWeight;
  const execute = yesBps >= QUORUM_BPS && totalWeight >= MIN_TOTAL_WEIGHT;
  return {
    execute,
    yesBps: Number(yesBps),
    totalWeight: Number(totalWeight),
    perChild,
  };
}
