/**
 * Per-tick agent loop.
 *
 * `runTick(agent)` is dispatched by `runtime.ts` every 60s.
 *
 * Pipeline:
 *   1. Build the snapshot (snapshotBuilder.buildSnapshot).
 *   2. Branch on `agent.strategy.kind`:
 *      - deterministic: call `strategy.tick(snapshot)` directly.
 *      - llm: assemble a LangChain `createAgent`, invoke with the snapshot,
 *        and route validated candidates into the proposal store. Proposals
 *        are NOT executed automatically; the operator approves via
 *        `/api/agent/:tokenId/proposals/:id/approve`.
 *   3. Publish each deterministic action as an `ActionEvent` to the runtime
 *      store. LLM proposals are published as `ProposalEvent` instead.
 *   4. Publish the snapshot last so SSE consumers see post-action state.
 *
 * Defensive posture:
 *   - Every error inside the tick is caught and published as a RiskEvent;
 *     we never throw out of the cron callback.
 *   - `tick_duration_ms` is logged on every run.
 *   - shutdown / paused snapshots immediately stop the agent.
 *   - After any LLM invoke we re-check `getRuntimeState(tokenId).status` so a
 *     stop / pause that landed mid-call is honoured.
 *
 * The LangChain branch is built behind `createAgentForToken` which caches
 * per-tokenId so repeated ticks reuse the same `MemorySaver` checkpointer
 * (ephemeral, in-process; documented as such).
 */

import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';

import { type SupportedChainId } from '../lib/viem.ts';
import { forSvc } from '../lib/logger.ts';
import { observe } from '../lib/metrics.ts';
import { persistAction } from '../lib/actionLogger.ts';
import {
  addProposal,
  publishEvent,
  updateStatus,
  getRuntimeState,
  type ActionEvent,
  type ProposalEvent,
} from '../lib/runtimeStore.ts';
import { getArbBlockNumber } from '../services/arbSys.ts';

import type { Action, MarketSnapshot } from './Strategy.ts';
import { buildSnapshot } from './snapshotBuilder.ts';
import { planRhSwap, sanitiseSwapForLog } from './rhSwapPlanner.ts';
import {
  executeRhChainSwap,
  RhSwapExecutorError,
} from './rhChainSwapExecutor.ts';
import { chatGroqDefault, llmAvailable } from './llm.ts';
import { getRobinhoodLangchainTools } from './integrations/robinhoodMcp.ts';
import { emitPnlPoint } from './pnl.ts';
import {
  type ActiveAgent,
  registerTickHandler,
  stopAgent,
} from './runtime.ts';
import {
  ProposalEnvelopeSchema,
  candidateActionToAction,
  isLlmAdvisorStrategy,
  type ProposalCandidate,
} from './strategies/llm-advisor.ts';

const log = forSvc('tickLoop');

/**
 * Default proposal TTL: 2 minutes. Operator has 2 minutes to approve or skip
 * before the proposal store marks the row as expired and the approve route
 * starts returning 410.
 */
const PROPOSAL_TTL_MS = 120_000;

/**
 * Maximum candidates accepted from a single LLM tick. The schema already caps
 * the array at 5; we additionally trim to 3 to stay polite on the SSE feed.
 */
const MAX_PROPOSALS_PER_TICK = 3;

/**
 * JSON replacer that converts bigint to string. Used when serialising the
 * snapshot into the LLM's HumanMessage payload.
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * Convert an `Action[]` into ActionEvent payloads and publish them. Returns
 * the published count for logging. `chainId` is read by `getArbBlockNumber`
 * so the persisted `AgentAction.arbBlock` column carries the canonical L2
 * block number (not the L1 value `block.number` would return on Arbitrum).
 */
async function publishActions(
  tokenId: bigint,
  actions: Action[],
  chainId: SupportedChainId,
): Promise<number> {
  // Read the L2 block once per tick (the ArbSys helper caches for 1s anyway)
  // so a tick that emits N actions hits the precompile at most once.
  const arbBlock = await getArbBlockNumber(chainId);
  for (const a of actions) {
    const ev: ActionEvent = {
      kind: 'action',
      tokenId,
      ts: Date.now(),
      data: {
        type: a.kind,
        symbol: a.symbol,
        side: a.side,
        qty: a.quantity?.toString(),
        reason: a.reason,
      },
    };
    const { seq } = publishEvent(tokenId, ev);
    // Persist the order intent to the audit log. Non-blocking; the action
    // logger buffers and flushes on its own cadence.
    persistAction({
      tokenId,
      tick: seq,
      type: 'order_intent',
      symbol: a.symbol,
      side: a.side,
      qtyQ96: a.quantity,
      reason: a.reason,
      payload: {
        kind: a.kind,
        symbol: a.symbol,
        side: a.side,
        qty: a.quantity?.toString(),
        reason: a.reason,
      },
      arbBlock: arbBlock ?? undefined,
      chainId,
    });
    log.info(
      {
        tokenId: tokenId.toString(),
        data: {
          kind: a.kind,
          symbol: a.symbol,
          side: a.side,
          qty: a.quantity?.toString(),
          reason: a.reason,
        },
      },
      'action emitted',
    );
  }
  return actions.length;
}

/**
 * Pure simulate stub. Real simulation would re-run the strategy against a
 * mutated snapshot; that lives in a later wave. For now we return the
 * unchanged snapshot plus a "not-implemented" note so the LLM gets a
 * deterministic response.
 */
function buildSimulateActionTool(getSnapshot: () => MarketSnapshot | null): StructuredToolInterface {
  return tool(
    async (input: { action: string }): Promise<string> => {
      const snap = getSnapshot();
      return JSON.stringify({
        note: 'simulate_action not yet implemented; snapshot returned unchanged',
        action: input.action,
        snapshot: snap ? JSON.parse(JSON.stringify(snap, jsonReplacer)) : null,
      });
    },
    {
      name: 'simulate_action',
      description: 'Predict the post-state effect of an Action against the current snapshot.',
      schema: z.object({
        action: z.string().describe('JSON-encoded Action to simulate'),
      }),
    },
  ) as StructuredToolInterface;
}

function buildReadSnapshotTool(getSnapshot: () => MarketSnapshot | null): StructuredToolInterface {
  return tool(
    async (): Promise<string> => {
      const snap = getSnapshot();
      return snap ? JSON.stringify(snap, jsonReplacer) : 'null';
    },
    {
      name: 'read_position_snapshot',
      description: 'Returns the current MarketSnapshot for this tokenId.',
      schema: z.object({}),
    },
  ) as StructuredToolInterface;
}

function buildRecentActionsTool(tokenId: bigint): StructuredToolInterface {
  return tool(
    async (): Promise<string> => {
      const state = getRuntimeState(tokenId);
      const actions = state.recent
        .filter((e) => e.kind === 'action')
        .slice(-20);
      return JSON.stringify(actions);
    },
    {
      name: 'read_recent_actions',
      description: 'Returns the last 20 actions emitted by this agent.',
      schema: z.object({}),
    },
  ) as StructuredToolInterface;
}

/**
 * Per-tokenId cache of `createAgent` instances. The instances reuse a shared
 * `MemorySaver` checkpointer so the LangGraph thread state is preserved
 * across ticks. Cleared on `stopAgent` via `evictAgentCacheEntry` so a
 * restart does not leak the compiled agent + its tool closures.
 */
const agentCache = new Map<bigint, unknown>();

/**
 * Evict a tokenId's compiled LangGraph agent from the cache. Called by
 * `runtime.stopAgent` so the closures over `currentSnapshot` and the
 * Robinhood MCP tools do not outlive the agent. Safe to call when no
 * entry exists; returns true when something was removed.
 */
export function evictAgentCacheEntry(tokenId: bigint): boolean {
  return agentCache.delete(tokenId);
}

async function createAgentForToken(
  agent: ActiveAgent,
  currentSnapshot: MarketSnapshot,
): Promise<unknown> {
  const cached = agentCache.get(agent.tokenId);
  if (cached) return cached;

  if (!llmAvailable || !chatGroqDefault) {
    log.warn(
      { tokenId: agent.tokenId.toString() },
      'LLM strategy requested but GROQ_API_KEY is unset; refusing',
    );
    return null;
  }

  // Dynamic import keeps the heavy LangChain stack out of the cold path for
  // deterministic strategies. Wave-J: switched from `MemorySaver` to
  // `PostgresSaver` so armed conditional directives survive a process
  // restart. The DB URL falls back to DATABASE_URL when LANGGRAPH_PG_URL
  // is unset; tests still use MemorySaver via the `__internal` test seam
  // because they spin up no Postgres.
  const { createAgent } = await import('langchain');
  const { LANGGRAPH_PG_URL } = await import('../config/main-config.ts');
  let checkpointer: unknown;
  if (LANGGRAPH_PG_URL) {
    try {
      // The module name is constructed dynamically so `tsc` does not bail
      // when the package is not yet installed; the runtime fallback below
      // covers the dev path. Operators install via `bun add` in Wave-J.
      const modName = '@langchain/langgraph-checkpoint-postgres';
      const { PostgresSaver } = (await import(modName)) as { PostgresSaver: { fromConnString: (s: string) => unknown } };
      checkpointer = PostgresSaver.fromConnString(LANGGRAPH_PG_URL);
      // PostgresSaver requires a one-time setup call to create tables.
      // Idempotent; safe to call on every boot.
      await (checkpointer as { setup?: () => Promise<void> }).setup?.();
    } catch (err) {
      log.warn(
        { err_class: (err as Error)?.name },
        'PostgresSaver import failed; falling back to in-memory checkpointer',
      );
      const { MemorySaver } = await import('@langchain/langgraph');
      checkpointer = new MemorySaver();
    }
  } else {
    log.warn({}, 'LANGGRAPH_PG_URL unset; using MemorySaver (no restart durability)');
    const { MemorySaver } = await import('@langchain/langgraph');
    checkpointer = new MemorySaver();
  }

  const localTools: StructuredToolInterface[] = [
    buildReadSnapshotTool(() => currentSnapshot),
    buildRecentActionsTool(agent.tokenId),
    buildSimulateActionTool(() => currentSnapshot),
  ];
  const rhTools = await getRobinhoodLangchainTools(
    agent.userId,
    agent.accountId,
    agent.tokenId,
  );

  // Llama models are less reliable at strict JSON than Claude. We attach
  // raw JSON mode (`response_format: { type: 'json_object' }`) to the model
  // via `.withConfig` so every advisor invocation is forced to emit a JSON
  // object; the parse step in `runLlmAdvisorTick` then Zod-validates against
  // `ProposalEnvelopeSchema`. `withConfig` is the documented ChatGroq path
  // for per-instance call options; `response_format` is one of the
  // `CREATE_PARAMS_BASE_CALL_KEYS` ChatGroq forwards to the upstream API.
  // Note: JSON mode is incompatible with streaming, which we never use here.
  const jsonModel = chatGroqDefault.withConfig({
    response_format: { type: 'json_object' },
  });

  const compiled = createAgent({
    model: jsonModel,
    tools: [...rhTools, ...localTools],
    checkpointer: checkpointer as never,
  });

  agentCache.set(agent.tokenId, compiled);
  return compiled;
}

/**
 * Narrow runtime shape of a LangGraph compiled agent. We only call `invoke`
 * and read back the final assistant message text; we never poke the graph
 * internals. Defined locally so the loop is not tied to the LangChain
 * version's exported types (which change between minor releases).
 */
interface CompiledLangGraphAgent {
  invoke(
    state: { messages: Array<{ role: string; content: string }> },
    config?: { configurable?: { thread_id?: string } },
  ): Promise<{ messages: Array<{ content: unknown; getType?: () => string }> }>;
}

function isCompiledLangGraphAgent(v: unknown): v is CompiledLangGraphAgent {
  if (!v || typeof v !== 'object') return false;
  return typeof (v as { invoke?: unknown }).invoke === 'function';
}

/**
 * Extract a plain text answer from the LangGraph result's final message.
 * Handles both the BaseMessage object form (`{ content: string | Block[] }`)
 * and the older string-content form. Returns the concatenated text blocks
 * stripped of leading / trailing whitespace.
 */
function extractFinalText(result: {
  messages: Array<{ content: unknown }>;
}): string {
  const last = result.messages[result.messages.length - 1];
  if (!last) return '';
  const c = last.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((block) => {
        if (block && typeof block === 'object' && 'text' in block) {
          const t = (block as { text?: unknown }).text;
          return typeof t === 'string' ? t : '';
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

/**
 * Strip optional markdown code fences and parse a JSON object from the LLM
 * response. Returns `null` on parse failure (the caller publishes a `warn`
 * risk event and drops the tick).
 */
function parseProposalEnvelope(raw: string): unknown | null {
  let s = raw.trim();
  if (s.startsWith('```')) {
    // Tolerate ```json ... ``` fences even though the prompt forbids them.
    const fenceEnd = s.indexOf('\n');
    if (fenceEnd >= 0) s = s.slice(fenceEnd + 1);
    if (s.endsWith('```')) s = s.slice(0, -3);
    s = s.trim();
  }
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

/**
 * Render the policy-headroom block fed into the LLM prompt. The on-chain
 * validator address is not configured in dev so we always report "unknown"
 * there; the dashboard's `/ask` route does a richer lookup with the daily
 * spend RPC read, but the LLM advisor does not need the cents.
 */
function renderHeadroomBlock(snapshot: MarketSnapshot): string {
  const cashUsd = snapshot.cashUsdQ96.toString();
  const bpUsd = snapshot.buyingPowerUsdQ96.toString();
  return [
    'dailyCapUsd: unknown (validator telemetry deferred to operator confirmation)',
    'dailySpentUsd: unknown',
    'remainingUsd: unknown',
    `cashUsdQ96: ${cashUsd}`,
    `buyingPowerUsdQ96: ${bpUsd}`,
  ].join('\n');
}

/**
 * Render the headroom payload that ships with each `ProposalEvent`. Mirrors
 * what the dashboard renders; for now we cannot resolve real daily-cap
 * values without an RPC read, so the fields are `null`. A future wave can
 * lift the `/ask` validator read in here.
 */
function buildProposalHeadroom(): {
  dailyCapUsd: string | null;
  dailySpentUsd: string | null;
  remainingUsd: string | null;
} {
  return { dailyCapUsd: null, dailySpentUsd: null, remainingUsd: null };
}

/**
 * Clamp the LLM's self-reported confidence into the 0.50..0.95 band. Below
 * 0.50 we floor: the LLM should not propose at all rather than mark a low
 * confidence. Above 0.95 we cap: nothing the advisor proposes deserves a
 * 99% confidence stamp. The schema already restricts to [0, 1].
 */
function clampConfidence(raw: number): number {
  if (!Number.isFinite(raw)) return 0.5;
  if (raw < 0.5) return 0.5;
  if (raw > 0.95) return 0.95;
  return raw;
}

/**
 * Result shape returned by `executeApprovedAction`. We tag success / failure
 * so the approve route can map to HTTP statuses without inspecting error
 * messages.
 */
export type ExecuteApprovedActionResult =
  | { ok: true; txHash: `0x${string}` }
  | { ok: false; error: string };

/**
 * Submit an action that the operator approved out-of-band (LLM advisor
 * proposal). The deterministic strategies route through here too so the
 * audit trail is identical regardless of who decided to act.
 *
 * Supported `Action.kind` values:
 *   - rh-chain-swap: plan via `planRhSwap`, submit via `executeRhChainSwap`.
 *
 * Other kinds (rh-mcp-order, arb-one-perp, flatten-all) are recognised but
 * not executable from this surface today; the function returns
 * `{ ok: false, error: ... }` with a clear reason so the caller can 502.
 * The deterministic strategies that emit those kinds still run via their
 * own paths in the loop.
 *
 * Concurrency: the per-tokenId mutex inside `executeRhChainSwap` serialises
 * concurrent ticks. The approve route additionally guards via
 * `markProposalConsumed` so a double-click cannot fire two submits.
 */
export async function executeApprovedAction(
  tokenId: bigint,
  action: Action,
  chainId: SupportedChainId,
  tick: number,
): Promise<ExecuteApprovedActionResult> {
  if (action.kind !== 'rh-chain-swap') {
    return {
      ok: false,
      error: `executeApprovedAction does not handle action.kind=${action.kind}`,
    };
  }

  let plan: Awaited<ReturnType<typeof planRhSwap>> = null;
  try {
    plan = await planRhSwap(tokenId, action);
  } catch (err) {
    const errorMessage = (err as Error).message ?? String(err);
    const { seq } = publishEvent(tokenId, {
      kind: 'risk',
      tokenId,
      ts: Date.now(),
      severity: 'warn',
      message: `rh-chain-swap plan failed: ${errorMessage}`,
    });
    persistAction({
      tokenId,
      tick: seq,
      type: 'tool_call',
      toolName: 'rhChainSwap.plan',
      payload: { error: errorMessage },
    });
    log.warn(
      { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
      'rh-chain-swap planning threw',
    );
    return { ok: false, error: errorMessage };
  }
  if (!plan) {
    return { ok: false, error: 'rh-chain-swap is not configured on this deployment' };
  }

  const sanitised = sanitiseSwapForLog(plan);
  try {
    const result = await executeRhChainSwap({
      tokenId: plan.tokenId,
      fromToken: plan.fromToken,
      toToken: plan.toToken,
      amountIn: plan.amountIn,
      minAmountOut: plan.minAmountOut,
      maxPriceWad: plan.maxPriceWad,
      priceWad: plan.signed.priceWad,
      tick,
    });

    log.info(
      {
        tokenId: tokenId.toString(),
        data: {
          txHash: result.txHash,
          blockNumber: result.blockNumber.toString(),
          nonce: result.nonce.toString(),
        },
      },
      'emitting rh_swap_executed SSE event',
    );
    const { seq } = publishEvent(tokenId, {
      kind: 'rh_swap_executed',
      tokenId,
      ts: Date.now(),
      data: {
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        fromToken: plan.fromToken,
        toToken: plan.toToken,
        amountIn: plan.amountIn,
        amountOut: result.effectiveAmountOut,
        priceWad: result.priceWad,
        nonce: result.nonce,
        gasUsed: result.gasUsed,
      },
    });
    persistAction({
      tokenId,
      tick: seq,
      type: 'tool_call',
      toolName: 'rhChainSwap.swap',
      payload: {
        ...sanitised,
        txHash: result.txHash,
        blockNumber: result.blockNumber.toString(),
        gasUsed: result.gasUsed.toString(),
        effectiveAmountOut: result.effectiveAmountOut.toString(),
      },
      chainId,
    });
    log.info(
      {
        tokenId: tokenId.toString(),
        data: {
          symbol: action.symbol,
          side: action.side,
          nonce: result.nonce.toString(),
          txHash: result.txHash,
          amountOut: result.effectiveAmountOut.toString(),
          gasUsed: result.gasUsed.toString(),
        },
      },
      'rh-chain-swap executed on-chain',
    );
    return { ok: true, txHash: result.txHash };
  } catch (err) {
    const errCode = err instanceof RhSwapExecutorError ? err.code : 'UNKNOWN';
    const errorMessage = (err as Error).message ?? String(err);
    const { seq } = publishEvent(tokenId, {
      kind: 'rh_swap_failed',
      tokenId,
      ts: Date.now(),
      data: {
        fromToken: plan.fromToken,
        toToken: plan.toToken,
        amountIn: plan.amountIn,
        error: errorMessage,
      },
    });
    persistAction({
      tokenId,
      tick: seq,
      type: 'tool_call',
      toolName: 'rhChainSwap.swap',
      payload: {
        ...sanitised,
        code: errCode,
        error: errorMessage,
      },
      chainId,
    });
    log.warn(
      {
        tokenId: tokenId.toString(),
        err_class: (err as Error)?.name,
        data: { code: errCode, msg: errorMessage },
      },
      'rh-chain-swap execution failed',
    );
    return { ok: false, error: errorMessage };
  }
}

/**
 * Run the LLM advisor for one tick. Returns the candidate envelope (already
 * schema-validated) or `null` when the model was unavailable, the invoke
 * threw, the response failed to parse, or the agent was stopped mid-call.
 *
 * The caller turns each candidate into a `ProposalEvent` and inserts it
 * into the proposal store; the loop itself never executes the candidate.
 */
async function runLlmAdvisorTick(
  agent: ActiveAgent,
  snapshot: MarketSnapshot,
): Promise<ProposalCandidate[] | null> {
  if (!isLlmAdvisorStrategy(agent.strategy)) {
    log.warn(
      { tokenId: agent.tokenId.toString() },
      'llm tick requested but strategy is not an llm-advisor; skipping',
    );
    return null;
  }

  const compiled = await createAgentForToken(agent, snapshot);
  if (!compiled || !isCompiledLangGraphAgent(compiled)) {
    return null;
  }

  const snapshotJson = JSON.stringify(snapshot, jsonReplacer);
  const recentActionsJson = JSON.stringify(
    getRuntimeState(agent.tokenId)
      .recent.filter((e) => e.kind === 'action')
      .slice(-10)
      .map((e) => (e.kind === 'action' ? e.data : null))
      .filter(Boolean),
    jsonReplacer,
  );
  const headroomBlock = renderHeadroomBlock(snapshot);

  const prompt = agent.strategy.getPrompt({
    snapshotJson,
    recentActionsJson,
    headroomBlock,
  });

  let result: { messages: Array<{ content: unknown }> };
  try {
    result = await compiled.invoke(
      {
        messages: [{ role: 'user', content: prompt }],
      },
      { configurable: { thread_id: agent.tokenId.toString() } },
    );
  } catch (err) {
    publishEvent(agent.tokenId, {
      kind: 'risk',
      tokenId: agent.tokenId,
      ts: Date.now(),
      severity: 'warn',
      message: `llm-advisor invoke failed: ${(err as Error)?.name ?? 'UnknownError'}`,
    });
    log.warn(
      { tokenId: agent.tokenId.toString(), err_class: (err as Error)?.name },
      'llm-advisor invoke threw',
    );
    return null;
  }

  // Re-check status: a stop / pause that landed mid-invoke MUST drop the
  // result on the floor. The compiled.invoke is the longest blocking call
  // in the tick; this guard prevents a posthumous proposal from a stopped
  // agent.
  if (getRuntimeState(agent.tokenId).status !== 'running') {
    log.info(
      { tokenId: agent.tokenId.toString() },
      'agent no longer running after llm invoke; dropping result',
    );
    return null;
  }

  const text = extractFinalText(result);
  if (!text) {
    publishEvent(agent.tokenId, {
      kind: 'risk',
      tokenId: agent.tokenId,
      ts: Date.now(),
      severity: 'warn',
      message: 'llm-advisor returned an empty response',
    });
    return null;
  }

  const parsed = parseProposalEnvelope(text);
  if (parsed === null) {
    publishEvent(agent.tokenId, {
      kind: 'risk',
      tokenId: agent.tokenId,
      ts: Date.now(),
      severity: 'warn',
      message: 'llm-advisor response was not valid JSON',
    });
    return null;
  }

  const validated = ProposalEnvelopeSchema.safeParse(parsed);
  if (!validated.success) {
    publishEvent(agent.tokenId, {
      kind: 'risk',
      tokenId: agent.tokenId,
      ts: Date.now(),
      severity: 'warn',
      message: `llm-advisor response failed schema: ${validated.error.issues.length} issues`,
    });
    log.warn(
      {
        tokenId: agent.tokenId.toString(),
        data: { issues: validated.error.issues.slice(0, 3) },
      },
      'llm-advisor schema validation failed',
    );
    return null;
  }

  return validated.data.proposals.slice(0, MAX_PROPOSALS_PER_TICK);
}

/**
 * Main tick. Returns silently; all errors are logged + published.
 */
export async function runTick(agent: ActiveAgent): Promise<void> {
  if (agent.status !== 'running') return;

  const tickStart = Date.now();
  let snapshot: MarketSnapshot | null = null;

  try {
    snapshot = await buildSnapshot({
      tokenId: agent.tokenId,
      chainId: agent.chainId as SupportedChainId,
      userId: agent.userId,
      accountId: agent.accountId,
    });
  } catch (err) {
    const { seq } = publishEvent(agent.tokenId, {
      kind: 'risk',
      tokenId: agent.tokenId,
      ts: Date.now(),
      severity: 'warn',
      message: `snapshot build failed: ${(err as Error).message}`,
    });
    persistAction({
      tokenId: agent.tokenId,
      tick: seq,
      type: 'tool_call',
      toolName: 'snapshotBuilder.buildSnapshot',
      payload: { error: (err as Error).message ?? String(err) },
    });
    log.error(
      { tokenId: agent.tokenId.toString(), err_class: (err as Error)?.name },
      'snapshot build failed',
    );
    return;
  }

  if (snapshot.shutdown || snapshot.paused) {
    publishEvent(agent.tokenId, {
      kind: 'risk',
      tokenId: agent.tokenId,
      ts: Date.now(),
      severity: 'critical',
      message: snapshot.shutdown ? 'global shutdown detected' : 'vault paused',
    });
    updateStatus(agent.tokenId, 'halted_shutdown');
    await stopAgent(agent.tokenId);
    return;
  }

  // Wave E1 B5: refuse to act on a tick whose Robinhood feed disagrees
  // with the on-chain PriceOracle by more than 50bps on any tracked
  // symbol. The strategy is not given a chance to read the snapshot in
  // this case; we publish a risk event and exit. The next tick will
  // re-check and recover automatically if the feeds reconverge.
  if (snapshot.priceDivergence) {
    publishEvent(agent.tokenId, {
      kind: 'risk',
      tokenId: agent.tokenId,
      ts: Math.floor(Date.now() / 1000),
      severity: 'warn',
      message: 'price_divergence_skip_tick',
    });
    log.warn(
      {
        tokenId: agent.tokenId.toString(),
        data: { divergence_bps: snapshot.divergenceBps },
      },
      'skipping tick due to price divergence',
    );
    publishEvent(agent.tokenId, {
      kind: 'snapshot',
      tokenId: agent.tokenId,
      ts: snapshot.ts,
      data: snapshot,
    });
    return;
  }

  let actions: Action[] = [];
  let proposalsEmitted = 0;
  try {
    if (agent.strategy.kind === 'deterministic') {
      actions = await agent.strategy.tick(snapshot);
    } else if (agent.strategy.kind === 'llm') {
      const candidates = await runLlmAdvisorTick(agent, snapshot);
      if (candidates && candidates.length > 0) {
        const now = Date.now();
        for (const candidate of candidates) {
          let action: Action;
          try {
            action = candidateActionToAction(candidate.action);
          } catch (err) {
            log.warn(
              { tokenId: agent.tokenId.toString(), err_class: (err as Error)?.name },
              'llm candidate action conversion failed; skipping',
            );
            continue;
          }
          const event: ProposalEvent = {
            kind: 'proposal',
            tokenId: agent.tokenId,
            ts: now,
            data: {
              id: crypto.randomUUID(),
              expiresAt: now + PROPOSAL_TTL_MS,
              action,
              rationale: candidate.rationale,
              confidence: clampConfidence(candidate.confidence),
              headroom: buildProposalHeadroom(),
              suggestedPolicyDelta: candidate.suggestedPolicyDelta ?? null,
            },
          };
          addProposal(agent.tokenId, event);
          proposalsEmitted += 1;
          log.info(
            {
              tokenId: agent.tokenId.toString(),
              data: {
                proposalId: event.data.id,
                kind: action.kind,
                symbol: action.symbol,
                side: action.side,
                confidence: event.data.confidence,
              },
            },
            'llm-advisor proposal emitted',
          );
        }
      }
    }
  } catch (err) {
    const { seq } = publishEvent(agent.tokenId, {
      kind: 'risk',
      tokenId: agent.tokenId,
      ts: Date.now(),
      severity: 'warn',
      message: `strategy.tick threw: ${(err as Error).message}`,
    });
    persistAction({
      tokenId: agent.tokenId,
      tick: seq,
      type: 'tool_call',
      toolName: 'strategy.tick',
      payload: { error: (err as Error).message ?? String(err) },
    });
    log.error(
      {
        tokenId: agent.tokenId.toString(),
        err_class: (err as Error)?.name,
      },
      'strategy.tick threw',
    );
  }

  const emitted = await publishActions(
    agent.tokenId,
    actions,
    agent.chainId as SupportedChainId,
  );

  // Submit any rh-chain-swap actions the deterministic strategies emitted.
  // LLM proposals are NEVER executed here; they wait for an operator
  // approval via `/api/agent/:tokenId/proposals/:id/approve`.
  for (const action of actions) {
    if (action.kind !== 'rh-chain-swap') continue;
    await executeApprovedAction(
      agent.tokenId,
      action,
      agent.chainId as SupportedChainId,
      getRuntimeState(agent.tokenId).seq,
    );
  }

  const { seq: snapSeq } = publishEvent(agent.tokenId, {
    kind: 'snapshot',
    tokenId: agent.tokenId,
    ts: snapshot.ts,
    data: snapshot,
  });
  persistAction({
    tokenId: agent.tokenId,
    tick: snapSeq,
    type: 'snapshot',
    payload: snapshot,
  });

  // PnL point write + SSE publish. Wrapped so a compute / persist error
  // never bubbles into the tick loop; `emitPnlPoint` swallows internally
  // but we double-guard for the case of an import-time misconfiguration.
  try {
    await emitPnlPoint(agent.tokenId, snapSeq, snapshot);
  } catch (err) {
    log.warn(
      { tokenId: agent.tokenId.toString(), err_class: (err as Error)?.name },
      'pnl emit threw; continuing',
    );
  }

  const duration = Date.now() - tickStart;
  observe('tick_duration_ms', duration);
  log.info(
    {
      tokenId: agent.tokenId.toString(),
      tick_duration_ms: duration,
      data: {
        actions_emitted: emitted,
        proposals_emitted: proposalsEmitted,
        kind: agent.strategy.kind,
      },
    },
    'tick complete',
  );
}

// Wire the tick handler into runtime so `startAgent` can dispatch via cron.
registerTickHandler(runTick);

/**
 * Test-only inspection of the LangChain agent cache. Production callers
 * MUST NOT use this.
 */
export const __internal = {
  agentCache,
  createAgentForToken,
  jsonReplacer,
  extractFinalText,
  parseProposalEnvelope,
  clampConfidence,
  PROPOSAL_TTL_MS,
  MAX_PROPOSALS_PER_TICK,
  reset(): void {
    agentCache.clear();
  },
};
