/**
 * Feature J: StrategyDecision schemas.
 *
 * Flat object with a discriminated `trigger` field. The decision itself is
 * NOT a top-level discriminated union because `providerStrategy` (LangChain
 * `providerStrategy(...)`) cannot serve a top-level union to Anthropic
 * native structured output; nesting the union one level down is the
 * supported workaround.
 *
 * Quantities are decimal strings (regex-validated) so the LLM never has to
 * round-trip large bigints through JSON numbers. Conversion to Q96.48
 * happens at the executor boundary.
 */

import { z } from 'zod';

export const STRATEGY_SYMBOL_SCHEMA = z.enum([
  'TSLA',
  'AMZN',
  'PLTR',
  'NFLX',
  'AMD',
]);
export type StrategySymbol = z.infer<typeof STRATEGY_SYMBOL_SCHEMA>;

export const STRATEGY_ACTION_KIND_SCHEMA = z.enum([
  'rh-chain-swap',
  'close-half',
  'write-put',
]);
export type StrategyActionKind = z.infer<typeof STRATEGY_ACTION_KIND_SCHEMA>;

export const StrategyActionSchema = z
  .object({
    kind: STRATEGY_ACTION_KIND_SCHEMA,
    symbol: STRATEGY_SYMBOL_SCHEMA,
    side: z.enum(['buy', 'sell']),
    quantity: z.string().regex(/^\d+(\.\d+)?$/, 'quantity must be a decimal string'),
    strikeUsd: z.number().positive().max(100_000).optional(),
    expiryIso: z.string().datetime().optional(),
  })
  .strict();
export type StrategyAction = z.infer<typeof StrategyActionSchema>;

export const StrategyTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('immediate') }).strict(),
  z
    .object({
      kind: z.literal('price_crosses'),
      symbol: STRATEGY_SYMBOL_SCHEMA,
      direction: z.enum(['above', 'below']),
      thresholdUsd: z.number().positive().max(100_000),
    })
    .strict(),
]);
export type StrategyTrigger = z.infer<typeof StrategyTriggerSchema>;

export const StrategyDecisionSchema = z
  .object({
    trigger: StrategyTriggerSchema,
    actions: z.array(StrategyActionSchema).min(1).max(3),
    rationale: z.string().min(1).max(500),
  })
  .strict();
export type StrategyDecision = z.infer<typeof StrategyDecisionSchema>;

/**
 * Result shape returned by the executor surface. `directiveId` is set only
 * when the decision was armed (status='armed'). `reasons` carries the hook
 * revert reasons (verbatim) when status='rejected'.
 */
export interface StrategyExecutionResult {
  status: 'armed' | 'executed' | 'rejected';
  decision: StrategyDecision;
  directiveId?: string;
  txHashes?: string[];
  reasons?: string[];
}
