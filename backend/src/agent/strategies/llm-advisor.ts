/**
 * LLM-advisor strategy (Feature 4).
 *
 * Unlike the deterministic strategies, this one does NOT execute orders. It
 * inspects the current `MarketSnapshot`, recent actions, and active policy
 * headroom, then asks Claude to produce a list of operator-approvable
 * proposals. The tick loop publishes each proposal as a `ProposalEvent`;
 * the operator decides via `/api/agent/:tokenId/proposals/:id/approve`.
 *
 * This file is metadata + prompt + schema only. The `compiled.invoke` call
 * itself lives in `loop.ts` so the strategy can stay a pure value (no
 * LangChain dependency at module load) and so the loop can share its
 * per-tokenId checkpointer cache across ticks.
 *
 * Why a separate strategy: deterministic strategies (`tsla-pairs`,
 * `mean-reversion`, `momentum-breakout`) already fire trades autonomously.
 * The advisor is a deliberately weaker surface: it can SUGGEST trades but
 * cannot SUBMIT them. This matches the "human in the loop" posture the
 * dashboard exposes.
 *
 * Safety:
 *   - The candidate schema rejects unknown action kinds and unknown stock
 *     symbols. A malformed LLM response drops the tick without emitting
 *     any proposals.
 *   - `confidence` is bounded 0..1 in the schema and re-clamped by the
 *     loop into the 0.50..0.95 band before publishing.
 *   - Quantity is a stringified non-negative Q96.48 integer; the loop
 *     parses to bigint and rejects negative or non-numeric strings.
 */

import { z } from 'zod';

import type { Action, MarketSnapshot, Strategy, StockSymbol } from '../Strategy.ts';
import { STOCK_SYMBOLS } from '../Strategy.ts';

/**
 * The set of `ActionKind` values the LLM is allowed to propose. Mirror of
 * `ActionKind` in `Strategy.ts` minus `no-op` (advisor never proposes nothing
 * by emitting a candidate; it just returns an empty proposals array).
 *
 * Per the spec we accept the same kinds deterministic strategies emit, so
 * the operator-approve path can call `executeApprovedAction` against the
 * existing per-kind executors without a translation layer.
 */
const ALLOWED_ACTION_KINDS = [
  'rh-mcp-order',
  'rh-chain-swap',
  'arb-one-perp',
  'flatten-all',
] as const;

const StockSymbolSchema = z.enum(STOCK_SYMBOLS as readonly string[] as [StockSymbol, ...StockSymbol[]]);

const Q96NumericString = z
  .string()
  .regex(/^[0-9]+$/, 'expected a non-negative integer in decimal Q96.48 form');

/**
 * Action shape accepted from the LLM. Strict: unknown keys are rejected so
 * a hallucinated field cannot smuggle in a non-validated executor input.
 * Quantities are sent as decimal strings (LLMs are unreliable with bigints).
 */
const ProposalActionSchema = z
  .object({
    kind: z.enum(ALLOWED_ACTION_KINDS),
    symbol: StockSymbolSchema.optional(),
    side: z.enum(['buy', 'sell']).optional(),
    quantity: Q96NumericString.optional(),
    limitPriceUsdQ96: Q96NumericString.optional(),
    deadlineSec: z.number().int().positive().optional(),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type ProposalActionCandidate = z.infer<typeof ProposalActionSchema>;

/**
 * Optional `suggestedPolicyDelta`. When present the dashboard prefills its
 * `/policy compose` form with the `ask` string. We require a `reason` so the
 * UI can render the rationale alongside the ask without an extra LLM call.
 */
const SuggestedPolicyDeltaSchema = z
  .object({
    reason: z.string().min(1).max(300),
    ask: z.string().min(1).max(300),
  })
  .strict();

export const ProposalCandidateSchema = z
  .object({
    action: ProposalActionSchema,
    rationale: z.string().min(1).max(1_500),
    confidence: z.number().min(0).max(1),
    suggestedPolicyDelta: SuggestedPolicyDeltaSchema.optional().nullable(),
  })
  .strict();

export type ProposalCandidate = z.infer<typeof ProposalCandidateSchema>;

/**
 * Top-level wrapper the LLM is expected to return. Wrapping `proposals` in
 * an outer object makes prompt-engineering and JSON-extraction reliable
 * (LangChain's structured-output helpers expect an object, not a bare array).
 */
export const ProposalEnvelopeSchema = z
  .object({
    proposals: z.array(ProposalCandidateSchema).max(5),
  })
  .strict();

export type ProposalEnvelope = z.infer<typeof ProposalEnvelopeSchema>;

/**
 * Convert a parsed `ProposalCandidate.action` into the canonical `Action`
 * shape consumed by the executor. Pure: throws on parse error rather than
 * silently dropping fields. Caller decides on a per-candidate try/catch.
 */
export function candidateActionToAction(
  candidate: ProposalActionCandidate,
): Action {
  const out: Action = {
    kind: candidate.kind,
    reason: candidate.reason,
  };
  if (candidate.symbol) out.symbol = candidate.symbol;
  if (candidate.side) out.side = candidate.side;
  if (candidate.quantity) out.quantity = BigInt(candidate.quantity);
  if (candidate.limitPriceUsdQ96) out.limitPriceUsdQ96 = BigInt(candidate.limitPriceUsdQ96);
  if (candidate.deadlineSec) out.deadlineSec = candidate.deadlineSec;
  return out;
}

/**
 * Render the LLM prompt for one tick. The format is plain text; we keep
 * the schema definition adjacent so an upstream prompt drift cannot
 * desynchronise from the validator.
 *
 * `recentActionsJson` is a short JSON dump of the last few executed actions
 * and `headroom` carries the daily-cap usage so the LLM does not invent
 * caps. Both come from the loop, not the strategy.
 */
export function buildAdvisorPrompt(input: {
  snapshotJson: string;
  recentActionsJson: string;
  headroomBlock: string;
}): string {
  return [
    'You are a senior portfolio risk advisor for an autonomous trading',
    'agent on the PrimeAgent platform. The agent owns positions on two',
    'venues: an on-chain swap contract and a Robinhood brokerage account.',
    '',
    'Your job is to inspect the current state and PROPOSE up to 3 trades.',
    'You do NOT execute orders. A human operator reviews each proposal and',
    'either approves or skips it. Be conservative: if no action is clearly',
    'warranted, return an object with an empty `proposals` array.',
    '',
    'OUTPUT FORMAT: Return a single JSON object. The ENTIRE response must be',
    'valid JSON parseable by JSON.parse with no surrounding text.',
    'DO NOT wrap the JSON in Markdown code fences (no ``` or ```json).',
    'DO NOT add any prose, commentary, or explanation outside the JSON object.',
    'DO NOT emit multiple JSON objects. Emit exactly one.',
    '',
    'The JSON object MUST match this exact shape:',
    '{',
    '  "proposals": [',
    '    {',
    '      "action": {',
    '        "kind": "rh-chain-swap" | "rh-mcp-order" | "arb-one-perp" | "flatten-all",',
    '        "symbol": "TSLA" | "AMZN" | "PLTR" | "NFLX" | "AMD",',
    '        "side": "buy" | "sell",',
    '        "quantity": "<Q96.48 decimal string>",',
    '        "limitPriceUsdQ96": "<Q96.48 decimal string, optional>",',
    '        "deadlineSec": <unix seconds, optional>,',
    '        "reason": "<one sentence>"',
    '      },',
    '      "rationale": "<one short paragraph>",',
    '      "confidence": <number 0..1>,',
    '      "suggestedPolicyDelta": {',
    '        "reason": "<why headroom should change, optional>",',
    '        "ask": "<prefilled /policy compose prompt, optional>"',
    '      }',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- One share is 2^48 in the Q96.48 fixed-point form. A 10-share buy is',
    '  the decimal string "2814749767106560000".',
    '- Quantities must be NON-NEGATIVE. Direction is in `side`.',
    '- Never propose more than 3 candidates per tick.',
    '- If the daily-cap headroom is fully consumed, propose at most one',
    '  `suggestedPolicyDelta` rather than a trade.',
    '- Reason fields must be plain English, no emojis, no em-dashes.',
    '',
    '## Current snapshot',
    input.snapshotJson,
    '',
    '## Recent actions',
    input.recentActionsJson,
    '',
    '## Policy headroom',
    input.headroomBlock,
  ].join('\n');
}

/**
 * Marker interface attached to the llm-advisor strategy so the loop can
 * detect "this is an LLM-kind strategy that exposes a prompt + schema".
 * We do NOT modify the canonical `Strategy` interface; instead the loop
 * does a structural narrowing on `kind === 'llm'` plus the presence of
 * `getPrompt` / `getSchema`.
 */
export interface LlmAdvisorStrategy extends Strategy {
  kind: 'llm';
  getPrompt: typeof buildAdvisorPrompt;
  getSchema: typeof ProposalEnvelopeSchema;
}

export const llmAdvisor: LlmAdvisorStrategy = {
  name: 'llm-advisor',
  kind: 'llm',
  /**
   * `tick` is a no-op for LLM strategies. The loop invokes the LangGraph
   * agent itself and routes the result into the proposal store. We keep
   * the method present so the `Strategy` shape is satisfied without a
   * cast.
   */
  async tick(_snapshot: MarketSnapshot): Promise<Action[]> {
    return [];
  },
  getPrompt: buildAdvisorPrompt,
  getSchema: ProposalEnvelopeSchema,
};

/**
 * Type guard used by the loop to detect the advisor extension without an
 * `instanceof` (the loop imports this strategy purely for the type, but
 * lives in a different module).
 */
export function isLlmAdvisorStrategy(s: Strategy): s is LlmAdvisorStrategy {
  if (s.kind !== 'llm') return false;
  const candidate = s as Partial<LlmAdvisorStrategy>;
  return typeof candidate.getPrompt === 'function' && candidate.getSchema instanceof z.ZodType;
}
