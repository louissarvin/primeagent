/**
 * Feature J: LLM Strategy Executor.
 *
 * Parses an operator directive into a `StrategyDecision` via Anthropic
 * Claude with `providerStrategy(StrategyDecisionSchema)`. If the decision
 * carries an `immediate` trigger, preflight-simulates each action against
 * `PrimeAgentPreExecHook.preCheck` and (on success) routes to
 * `executeApprovedAction`. If the decision carries a conditional trigger,
 * persists a `PendingDirective` row so the `triggerWatcher` worker can fire
 * it later.
 *
 * SECURITY:
 *   - Never combine `thinking` with `responseFormat`. LangChain #35539
 *     hardcodes `tool_choice="any"` for the structured-output tool, which
 *     breaks Anthropic thinking. The `assertNoThinking` guard below makes
 *     accidental future enablement a runtime crash, not a silent miscompile.
 *   - JSON parse failures retry once; second failure surfaces as a 422 with
 *     the verbatim Zod path so the operator can see what the LLM munged.
 *   - Process-restart resilience: armed directives survive in Postgres via
 *     `PendingDirective` (LangGraph thread state would also survive via
 *     `PostgresSaver` but the directive store is the source of truth for
 *     the watcher).
 */

import type { Address } from 'viem';
import { z } from 'zod';

import { forSvc } from '../../lib/logger.ts';
import {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL_DEFAULT,
} from '../../config/main-config.ts';
import { armDirective, markDirectiveFired } from './arm.ts';
import { simulateActions } from './preflight.ts';
import {
  StrategyDecisionSchema,
  type StrategyDecision,
  type StrategyAction,
  type StrategyExecutionResult,
} from './schemas.ts';
import { ARB_SEPOLIA_CHAIN_ID, type SupportedChainId } from '../../lib/viem.ts';
import { executeApprovedAction } from '../loop.ts';
import { getRuntimeState } from '../../lib/runtimeStore.ts';
import type { Action } from '../Strategy.ts';

const log = forSvc('strategyExecutor');

/**
 * Hard runtime guard against the LangChain #35539 combination. Caller MUST
 * pass the literal options bag it intends to feed to `ChatAnthropic`; we
 * inspect it here, NOT inside ChatAnthropic itself, so the assertion can
 * fire before any tokens are spent.
 */
export function assertNoThinkingWithResponseFormat(opts: {
  thinking?: unknown;
  responseFormat?: unknown;
}): void {
  if (opts.thinking !== undefined && opts.responseFormat !== undefined) {
    throw new Error(
      'STRATEGY_EXECUTOR_INVARIANT: providerStrategy/responseFormat cannot be combined with Anthropic `thinking` (LangChain #35539)',
    );
  }
}

export class StrategyExecutorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'StrategyExecutorError';
  }
}

const SYSTEM_PROMPT = [
  'You are PrimeAgent, an autonomous trading strategy executor.',
  'Parse the operator directive into a single StrategyDecision JSON object.',
  '',
  'Rules:',
  '- Output MUST validate against the provided schema; no commentary, no markdown fences.',
  '- `trigger.kind` is "immediate" for "do it now" directives, "price_crosses" for conditional.',
  '- `actions` carries 1..3 entries; use kind="rh-chain-swap" for default cash swaps.',
  '- `quantity` is a decimal string (e.g. "10" or "0.5"); never a number.',
  '- `rationale` is a one-sentence explanation under 500 chars.',
  '- No financial advice; describe intent only.',
].join('\n');

/**
 * Map a parsed `StrategyAction` to the `Action` shape used by
 * `executeApprovedAction`. Quantity is decimal -> Q96.48 bigint at the
 * boundary so the executor downstream stays in fixed-point. Limit prices
 * are not surfaced by the LLM today (the executor uses the on-chain
 * oracle price); a future revision can add them as optional fields.
 */
function toLoopAction(sa: StrategyAction): Action {
  const Q48 = 1n << 48n;
  let qtyQ96 = 0n;
  if (/^\d+$/.test(sa.quantity)) {
    qtyQ96 = BigInt(sa.quantity) * Q48;
  } else {
    // decimal: split on dot and shift
    const [intPart, fracPart = ''] = sa.quantity.split('.');
    const intQ = BigInt(intPart || '0') * Q48;
    const frac = fracPart.slice(0, 18); // cap fractional digits to avoid bigint pow blowups
    if (frac.length > 0) {
      const fracInt = BigInt(frac);
      const denom = 10n ** BigInt(frac.length);
      const fracQ = (fracInt * Q48) / denom;
      qtyQ96 = intQ + fracQ;
    } else {
      qtyQ96 = intQ;
    }
  }
  return {
    kind: 'rh-chain-swap',
    symbol: sa.symbol,
    side: sa.side,
    quantity: qtyQ96,
    reason: `executor:${sa.kind}`,
  };
}

/**
 * Lazy ChatAnthropic factory. Returns null when ANTHROPIC_API_KEY is unset;
 * the calling route surfaces a 503 in that case.
 */
async function getAnthropicAgent(): Promise<unknown | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const { ChatAnthropic } = await import('@langchain/anthropic');
  const { createAgent, providerStrategy } = (await import('langchain')) as unknown as {
    createAgent: (opts: unknown) => unknown;
    providerStrategy: (schema: unknown) => unknown;
  };

  // Build the model. NEVER pass `thinking` here.
  const model = new ChatAnthropic({
    model: ANTHROPIC_MODEL_DEFAULT,
    temperature: 0,
    apiKey: ANTHROPIC_API_KEY,
  });

  const agentOpts = {
    model,
    tools: [],
    responseFormat: providerStrategy(StrategyDecisionSchema),
  } as { thinking?: unknown; responseFormat?: unknown };
  assertNoThinkingWithResponseFormat(agentOpts);
  return createAgent(agentOpts);
}

interface InvokeResult {
  structuredResponse?: unknown;
  messages?: Array<{ content: unknown }>;
}

function extractDecision(out: InvokeResult): StrategyDecision {
  const raw = out.structuredResponse;
  if (!raw) throw new StrategyExecutorError('STRATEGY_LLM_INVALID_OUTPUT', 'no structured response');
  const parsed = StrategyDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first ? first.path.join('.') : '(root)';
    throw new StrategyExecutorError(
      'STRATEGY_LLM_INVALID_OUTPUT',
      `decision failed schema at ${path}: ${first?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

export interface RunStrategyExecutorParams {
  tokenId: bigint;
  directive: string;
  kernelAddress: Address;
  chainId?: SupportedChainId;
  threadId?: string;
  /**
   * Test seam: callers may inject a precomputed decision to skip the LLM
   * call. Used by the unit tests so they do not need an Anthropic key.
   */
  decisionOverride?: StrategyDecision;
}

/**
 * Main executor entry point. Returns a `StrategyExecutionResult` even on
 * the rejected path; throws only on infrastructure failures (LLM
 * unavailable, DB connection lost).
 */
export async function runStrategyExecutor(
  params: RunStrategyExecutorParams,
): Promise<StrategyExecutionResult> {
  const chainId = params.chainId ?? ARB_SEPOLIA_CHAIN_ID;
  const threadId = params.threadId ?? `executor:${params.tokenId.toString()}`;
  let decision: StrategyDecision;

  if (params.decisionOverride) {
    decision = params.decisionOverride;
  } else {
    const agent = await getAnthropicAgent();
    if (!agent) {
      throw new StrategyExecutorError(
        'STRATEGY_LLM_UNAVAILABLE',
        'ANTHROPIC_API_KEY is not configured',
      );
    }
    // Two attempts: a malformed first reply gets one retry with the same
    // directive. The schema diff between attempts is logged so we can tell
    // a flaky LLM from a structurally-bad prompt.
    let attempt = 0;
    let lastErr: unknown = null;
    while (attempt < 2) {
      try {
        const out = (await (agent as { invoke: (input: unknown, config?: unknown) => Promise<InvokeResult> }).invoke(
          {
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: params.directive },
            ],
          },
          { configurable: { thread_id: threadId } },
        )) as InvokeResult;
        decision = extractDecision(out);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        attempt += 1;
      }
    }
    if (lastErr) {
      throw lastErr;
    }
    decision = decision!;
  }

  // Armed path
  if (decision.trigger.kind !== 'immediate') {
    const armed = await armDirective({
      tokenId: params.tokenId,
      threadId,
      directive: params.directive,
      decision,
    });
    return { status: 'armed', decision, directiveId: armed.id };
  }

  // Immediate path: preflight then execute.
  const sim = await simulateActions(decision.actions, params.kernelAddress, chainId);
  if (!sim.ok) {
    log.info(
      { tokenId: params.tokenId.toString(), data: { reasons: sim.reasons } },
      'strategy preflight rejected',
    );
    return { status: 'rejected', decision, reasons: sim.reasons };
  }

  const txHashes: string[] = [];
  const reasons: string[] = [];
  const state = getRuntimeState(params.tokenId);
  for (const sa of decision.actions) {
    const loopAction = toLoopAction(sa);
    const result = await executeApprovedAction(params.tokenId, loopAction, chainId, state.seq);
    if (result.ok) {
      txHashes.push(result.txHash);
    } else {
      reasons.push(result.error);
    }
  }
  if (reasons.length > 0) {
    return { status: 'rejected', decision, reasons, txHashes };
  }
  return { status: 'executed', decision, txHashes };
}

/**
 * Wrapper used by `triggerWatcher`: a directive that was previously armed
 * fires here. Idempotency via `markDirectiveFired` (status update).
 */
export async function fireArmedDirective(params: {
  directiveId: string;
  tokenId: bigint;
  decision: StrategyDecision;
  kernelAddress: Address;
  chainId?: SupportedChainId;
}): Promise<StrategyExecutionResult> {
  const result = await runStrategyExecutor({
    tokenId: params.tokenId,
    directive: '(armed directive resume)',
    kernelAddress: params.kernelAddress,
    chainId: params.chainId,
    decisionOverride: {
      ...params.decision,
      // force immediate so the executor takes the execute branch
      trigger: { kind: 'immediate' },
    },
  });
  if (result.status === 'executed' && result.txHashes) {
    await markDirectiveFired(params.directiveId, result.txHashes);
  }
  return result;
}

// Re-export the Zod schema so tests can import it from one place.
export { StrategyDecisionSchema, type StrategyDecision };
// Test seam for the route layer.
export const __testHooks = { z };
