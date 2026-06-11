/**
 * Cross-cutting Zod schemas for the agent policy layer (Phase 1 / sections
 * 1.1, 1.2, 1.3 of the IMPLEMENTATION_PLAN).
 *
 * These types are shared between web, backend, and the on-chain encoder.
 * Drift is detected by a shared JSON-schema snapshot test (Feature C v2).
 */

import { z } from 'zod';
import { RISK_PRESET_IDS, type RiskPresetId, type StockSymbol } from '../risk/presets.ts';

// ----- Primitive shapes -----
export const Bytes4Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/, 'expected 4-byte hex (0x + 8 hex chars)');

export const Bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'expected 32-byte hex (0x + 64 hex chars)');

export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected EVM address (0x + 40 hex chars)');

// ----- Presets -----
export const RiskPresetIdSchema = z.enum(
  RISK_PRESET_IDS as readonly RiskPresetId[] as [RiskPresetId, ...RiskPresetId[]],
);

export const StockSymbolSchema = z.enum([
  'TSLA',
  'AMZN',
  'PLTR',
  'NFLX',
  'AMD',
] as const satisfies readonly StockSymbol[]);

export const RiskPresetSchema = z
  .object({
    id: RiskPresetIdSchema,
    label: z.string().min(1).max(40),
    blurb: z.string().min(1).max(90),
    maxNotionalUsd: z.number().int().positive().max(10_000_000),
    dailyCapUsd: z.number().int().positive().max(50_000_000),
    durationDays: z.number().int().min(1).max(90),
    defaultStrategy: z.string().min(1).max(64),
    leverageDisplay: z.string().min(1).max(8),
    allowedSymbols: z.array(StockSymbolSchema).min(1).max(5),
    presetHash: Bytes32Schema,
  })
  .strict();

export type RiskPresetT = z.infer<typeof RiskPresetSchema>;

// ----- AgentPolicy DTO (1.3) -----
const TokenIdNullable = z.union([z.bigint(), z.null()]);

export const AgentPolicyDraftSchema = z
  .object({
    tokenId: TokenIdNullable,
    clientId: z.string().min(16).max(64),
    presetId: z.union([RiskPresetIdSchema, z.null()]),
    maxNotionalUsd: z.number().int().positive().max(10_000_000),
    dailyCapUsd: z.number().int().positive().max(50_000_000),
    durationDays: z.number().int().min(1).max(90),
    allowedSymbols: z.array(StockSymbolSchema).min(1).max(5),
    allowedContracts: z.array(AddressSchema).min(1).max(16),
    allowedSelectors: z.array(Bytes4Schema).min(1).max(64),
    strategyName: z.string().min(1).max(64),
    presetHash: z.union([Bytes32Schema, z.null()]),
    draftedAt: z.number().int().positive(),
  })
  .strict();

export type AgentPolicyDraft = z.infer<typeof AgentPolicyDraftSchema>;

export const AgentPolicyOnChainSchema = AgentPolicyDraftSchema.extend({
  tokenId: z.bigint(),
  permissionContextHash: Bytes32Schema,
  expiresAt: z.bigint(),
  issuedAt: z.bigint(),
  grantTxHash: Bytes32Schema,
  kernelAddress: AddressSchema,
}).strict();

export type AgentPolicyOnChain = z.infer<typeof AgentPolicyOnChainSchema>;

// ----- LLM input shape used by Feature A. The Anthropic tool schema is
// derived from this object via a thin transformer in `draft.ts` (we do not
// import a runtime dep like `zod-to-json-schema` because the policy shape is
// small enough to hand-author the JSON schema).

/**
 * Compatibility helper: a stricter superset of `safeParse` that returns the
 * first Zod issue path as a flat string. Used by route handlers to put a
 * single human-readable explanation on the 422 response.
 */
export function firstIssueMessage(err: z.ZodError): string {
  const first = err.issues[0];
  if (!first) return 'invalid payload';
  const path = first.path.length > 0 ? first.path.join('.') : '<root>';
  return `${path}: ${first.message}`;
}
