/**
 * Fleet spawn DTO (Feature D / cross-cutting type 1.5).
 *
 * `count` is capped at 10 to keep the bundled userOp under the Arb Sepolia
 * 32M gas limit (per-NFT gas ~250k * 10 = 2.5M).
 */

import { z } from 'zod';

import { AddressSchema, AgentPolicyDraftSchema, Bytes32Schema } from '../policy/schemas.ts';

const TokenIdNullable = z.union([z.bigint(), z.null()]);

export const FleetSpecSchema = z
  .object({
    clientId: z.string().min(16).max(64),
    count: z.number().int().min(1).max(10),
    strategyName: z.string().min(1).max(64),
    policy: AgentPolicyDraftSchema,
    nameTemplate: z.string().min(1).max(64),
    parentTokenId: TokenIdNullable,
  })
  .strict();

export type FleetSpec = z.infer<typeof FleetSpecSchema>;

export const FleetMemberSchema = z
  .object({
    tokenId: z.bigint(),
    vault: AddressSchema,
    tba: AddressSchema,
    agentId: z.bigint(),
    txHash: Bytes32Schema,
    name: z.string().min(1).max(64),
    permissionContextHash: Bytes32Schema,
  })
  .strict();

export type FleetMember = z.infer<typeof FleetMemberSchema>;

export const FleetResultSchema = z
  .object({
    clientId: z.string(),
    members: z.array(FleetMemberSchema),
    errors: z.array(
      z
        .object({
          index: z.number().int().min(0),
          reason: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type FleetResult = z.infer<typeof FleetResultSchema>;
