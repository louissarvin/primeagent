/**
 * Feature K: fleet vote + thesis Zod schemas + EIP-712 typed-data shape.
 *
 * Domain intentionally omits `verifyingContract` (Snapshot pattern): the
 * vote envelope is off-chain, scoped only by `(name, version, chainId)`.
 * Children sign via wagmi `signTypedData`; backend verifies via viem
 * `verifyTypedData`.
 */

import { z } from 'zod';
import { keccak256, toBytes, encodeAbiParameters } from 'viem';

import { AddressSchema, Bytes32Schema } from '../policy/schemas.ts';
import { StrategyActionSchema, type StrategyAction } from '../strategy/schemas.ts';
import { ARB_SEPOLIA_CHAIN_ID } from '../../lib/viem.ts';

export const VOTE_DOMAIN = {
  name: 'PrimeAgent',
  version: '1',
  chainId: ARB_SEPOLIA_CHAIN_ID,
} as const;

export const VOTE_TYPES = {
  Vote: [
    { name: 'parentTokenId', type: 'uint256' },
    { name: 'childTokenId', type: 'uint256' },
    { name: 'thesisHash', type: 'bytes32' },
    { name: 'vote', type: 'uint8' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export const FleetThesisBodySchema = z
  .object({
    parentTokenId: z.bigint(),
    body: z.string().min(1).max(2000),
    proposedActions: z.array(StrategyActionSchema).min(1).max(3),
    nonce: z.bigint(),
    deadline: z.bigint(),
  })
  .strict();
export type FleetThesisBody = z.infer<typeof FleetThesisBodySchema>;

export const FleetBroadcastEnvelopeSchema = z
  .object({
    parentTokenId: z.bigint(),
    body: z.string().min(1).max(2000),
    proposedActions: z.array(StrategyActionSchema).min(1).max(3),
    nonce: z.bigint(),
    deadline: z.bigint(),
    childTokenIds: z.array(z.bigint()).min(1).max(10),
    signerAddress: AddressSchema,
  })
  .strict();
export type FleetBroadcastEnvelope = z.infer<typeof FleetBroadcastEnvelopeSchema>;

export const FleetVoteSchema = z
  .object({
    parentTokenId: z.bigint(),
    childTokenId: z.bigint(),
    thesisHash: Bytes32Schema,
    vote: z.union([z.literal(0), z.literal(1)]),
    deadline: z.bigint(),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    voterAddress: AddressSchema,
    signedAt: z.number().int().nonnegative(),
  })
  .strict();
export type FleetVote = z.infer<typeof FleetVoteSchema>;

/**
 * Canonical thesis hash per spec section 1.3.
 * `thesisHash = keccak256(abi.encode(parentTokenId, keccak256(body),
 *                                     proposedActionsHash, nonce, deadline))`.
 * Action hash is the keccak of the canonical-JSON-sorted action list.
 */
export function computeThesisHash(body: FleetThesisBody): `0x${string}` {
  const bodyHash = keccak256(toBytes(body.body));
  const actionsBlob = canonicalActionsBlob(body.proposedActions);
  const actionsHash = keccak256(toBytes(actionsBlob));
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint64' },
        { type: 'uint64' },
      ],
      [body.parentTokenId, bodyHash, actionsHash, body.nonce, body.deadline],
    ),
  );
}

function canonicalActionsBlob(actions: StrategyAction[]): string {
  return JSON.stringify(
    actions.map((a) => ({
      kind: a.kind,
      symbol: a.symbol,
      side: a.side,
      quantity: a.quantity,
      strikeUsd: a.strikeUsd ?? null,
      expiryIso: a.expiryIso ?? null,
    })),
  );
}
