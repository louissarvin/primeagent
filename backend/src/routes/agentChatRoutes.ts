/**
 * Agent chat + strategies route plugin.
 *
 * Two read-side surfaces consumed by the dashboard:
 *
 *   GET  /strategies                  - list registered strategies (no auth)
 *   POST /:tokenId/ask                - ask the Groq LLM about the current agent
 *
 * Mounted under `/api/agent` from `index.ts`, so the public paths are:
 *
 *   GET  /api/strategies              (also exposed via `/api/agent/strategies`)
 *   POST /api/agent/:tokenId/ask
 *
 * The `/ask` endpoint reads the per-tokenId in-process snapshot + recent
 * events + AgentPolicy mirror and feeds them to the Groq chat completion API
 * as system context. The reply is a single text block; we do not stream over
 * SSE in v1 to keep the surface dead simple. Rate-limited hard because each
 * call is paid.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { z } from 'zod';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import { forSvc } from '../lib/logger.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { getRuntimeState } from '../lib/runtimeStore.ts';
import { listStrategies, strategyRegistry } from '../agent/strategies/index.ts';
import { groq, llmAvailable, MODEL_DEFAULT } from '../agent/llm.ts';
import { computeVar, getVarOnChain } from '../agent/var.ts';
import {
  ARB_SEPOLIA_CHAIN_ID,
  RH_CHAIN_TESTNET_CHAIN_ID,
  getPublicClient,
  type SupportedChainId,
} from '../lib/viem.ts';
import { POSITION_NFT_ABI } from '../lib/contracts/abis.ts';
import { RISK_PRESETS, type RiskPreset, type RiskPresetId } from '../agent/risk/presets.ts';
import {
  BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA,
  IS_PROD,
} from '../config/main-config.ts';

const log = forSvc('agentChat');

/**
 * Minimal inline ABI fragment for the on-chain daily-spend telemetry.
 *
 * TODO(spec 7.7.C / 7.7.bis): replace this inline fragment with the canonical
 * `PRIME_AGENT_CALL_POLICY_VALIDATOR_ABI` export from `lib/contracts/abis.ts`
 * once the validator contract is finalized and its full ABI lands in that
 * module. The signature is intentionally narrow: the `/ask` LLM context only
 * needs the per-(contextHash, day) running notional to compute headroom; it
 * does NOT need the validator's mutating surface. Keeping this inline avoids
 * blocking F-02 chat shipping on the shared ABI module update.
 *
 * `dailySpentOf(bytes32 permissionContextHash, uint64 day) view returns (uint256)`
 * returns the USD notional spent in the calling day, in Q96.48 fixed-point.
 */
const PRIME_AGENT_CALL_POLICY_VALIDATOR_DAILY_SPENT_ABI = [
  {
    type: 'function',
    name: 'dailySpentOf',
    stateMutability: 'view',
    inputs: [
      { name: 'permissionContextHash', type: 'bytes32' },
      { name: 'day', type: 'uint64' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/**
 * Q96.48 -> integer USD. Matches the helper in `agentPolicyRoutes.ts` so the
 * `/ask` context surfaces caps in the same units as `/risk/presets` and the
 * dashboard. Truncates fractional cents (presentation only).
 */
const Q48 = 1n << 48n;
function q96ToUsdInt(q: bigint): number {
  return Number(q / Q48);
}

function formatUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

const AskBody = z.object({
  question: z.string().min(2).max(1_000),
});

/**
 * F-02 / F-15: ownership gate shared across per-tokenId read endpoints.
 * Compares `PositionNFT.ownerOf(tokenId)` to `callerWallet` case-insensitively.
 * In production a missing PositionNFT address is a hard 503; in dev it is a
 * warn-and-allow so local stacks without contracts can still iterate.
 */
async function requireOwnerIfConfigured(
  reply: FastifyReply,
  tokenId: bigint,
  callerWallet: string,
  action: string,
): Promise<boolean> {
  const addr = BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    if (IS_PROD) {
      log.error(
        { tokenId: tokenId.toString(), data: { action } },
        'PositionNFT address unset in production; refusing request',
      );
      await handleError(
        reply,
        503,
        'Ownership check is unavailable',
        'OWNERSHIP_CHECK_UNCONFIGURED',
      );
      return false;
    }
    log.warn(
      { tokenId: tokenId.toString(), data: { action } },
      'PositionNFT address unset; ownership check skipped (dev posture)',
    );
    return true;
  }
  try {
    const client = getPublicClient(ARB_SEPOLIA_CHAIN_ID);
    const owner = (await client.readContract({
      address: addr as `0x${string}`,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    })) as `0x${string}`;
    if (owner.toLowerCase() !== callerWallet.toLowerCase()) {
      await handleError(reply, 403, 'Caller does not own this tokenId', 'NOT_TOKEN_OWNER');
      return false;
    }
    return true;
  } catch (err) {
    log.warn(
      { tokenId: tokenId.toString(), data: { action, err: (err as Error).message } },
      'ownership read failed; rejecting',
    );
    await handleError(reply, 502, 'Failed to verify on-chain ownership', 'OWNERSHIP_READ_FAILED');
    return false;
  }
}

async function parseTokenIdParam(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<bigint | null> {
  const raw = (request.params as { tokenId?: string }).tokenId;
  if (!raw || !/^[0-9]+$/.test(raw)) {
    await handleError(reply, 400, 'tokenId must be a non-negative integer', 'INVALID_TOKEN_ID');
    return null;
  }
  try {
    const v = BigInt(raw);
    if (v < 0n) {
      await handleError(reply, 400, 'tokenId must be non-negative', 'INVALID_TOKEN_ID');
      return null;
    }
    return v;
  } catch {
    await handleError(reply, 400, 'tokenId must be a non-negative integer', 'INVALID_TOKEN_ID');
    return null;
  }
}

/**
 * Narrow shape we read from the AgentPolicy Prisma row for risk-profile
 * context. We intentionally type each field individually rather than
 * importing the generated Prisma type because the row may be partial during
 * migrations. `presetId` is nullable in the schema (null on custom
 * policies); `chainId` is non-null in the schema and defaults to Arbitrum
 * Sepolia, so we narrow to `number | undefined` (undefined only on a row
 * fetched before `bun db:push` ran).
 */
interface PolicyRowReadShape {
  permissionContextHash?: unknown;
  maxNotionalUsdQ96?: unknown;
  dailyCapUsdQ96?: unknown;
  expiresAt?: unknown;
  presetId?: string | null;
  chainId?: number;
}

function toBigInt(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && /^-?[0-9]+$/.test(v)) return BigInt(v);
  // Prisma `Decimal` exposes `.toString()`.
  if (v && typeof (v as { toString?: unknown }).toString === 'function') {
    const s = (v as { toString: () => string }).toString();
    if (/^-?[0-9]+$/.test(s)) {
      try {
        return BigInt(s);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function toHex32(v: unknown): `0x${string}` | null {
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)) {
    return v as `0x${string}`;
  }
  // Prisma `Bytes` may surface as a `Uint8Array` / `Buffer`.
  if (v instanceof Uint8Array && v.length === 32) {
    const hex = Array.from(v)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return ('0x' + hex) as `0x${string}`;
  }
  return null;
}

function isRiskPresetId(v: unknown): v is RiskPresetId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(RISK_PRESETS, v);
}

function relativeFromNow(targetMs: number, nowMs: number): string {
  const deltaSec = Math.round((targetMs - nowMs) / 1000);
  const abs = Math.abs(deltaSec);
  const future = deltaSec >= 0;
  const pick = (n: number, unit: string): string => {
    const v = Math.round(n);
    const u = v === 1 ? unit : `${unit}s`;
    return future ? `in ${v} ${u}` : `expired ${v} ${u} ago`;
  };
  if (abs < 60) return pick(abs, 'second');
  if (abs < 3600) return pick(abs / 60, 'minute');
  if (abs < 86_400) return pick(abs / 3600, 'hour');
  return pick(abs / 86_400, 'day');
}

/**
 * Compute today's UTC day index used by `dailySpentOf(_, day)`. The validator
 * scopes daily caps to a fixed UTC day boundary; calling with the wrong
 * "day" returns a stale slot and would produce wrong headroom.
 */
function currentUtcDay(nowMs: number): bigint {
  return BigInt(Math.floor(nowMs / 1000 / 86_400));
}

/**
 * Telemetry result for the risk profile context block. `daily_spent_usd =
 * null` means the validator was unreachable / unconfigured; the LLM context
 * surfaces that explicitly instead of inventing a number.
 */
interface RiskPostureTelemetry {
  dailySpentUsd: number | null;
  reason?: string;
}

/**
 * Read `PrimeAgentCallPolicyValidator.dailySpentOf(contextHash, day)` for a
 * given (chainId, permissionContextHash). All failures are swallowed and
 * surfaced as `dailySpentUsd: null` plus a one-line reason; never let this
 * read break the `/ask` route.
 *
 * Address discovery: the validator contract address is not in the shared
 * `addresses.ts` module today (the validator is the ZeroDev Kernel-side
 * enforcement gate, addressed via env var only). We read it directly from
 * `process.env.BACKEND_CALL_POLICY_VALIDATOR_ADDRESS_<CHAIN>` to avoid
 * extending the shared module from this PR. When unset we return the
 * "unavailable on this chain" reason without throwing.
 */
async function readDailySpent(
  tokenId: bigint,
  chainId: SupportedChainId,
  permissionContextHash: `0x${string}`,
  nowMs: number,
): Promise<RiskPostureTelemetry> {
  const envKey =
    chainId === ARB_SEPOLIA_CHAIN_ID
      ? 'BACKEND_CALL_POLICY_VALIDATOR_ADDRESS_ARB_SEPOLIA'
      : `BACKEND_CALL_POLICY_VALIDATOR_ADDRESS_${chainId}`;
  const rawAddr = process.env[envKey];
  if (!rawAddr || !/^0x[0-9a-fA-F]{40}$/.test(rawAddr)) {
    return { dailySpentUsd: null, reason: 'daily spend telemetry unavailable on this chain' };
  }
  try {
    const client = getPublicClient(chainId);
    const day = currentUtcDay(nowMs);
    const spentQ96 = (await client.readContract({
      address: rawAddr as `0x${string}`,
      abi: PRIME_AGENT_CALL_POLICY_VALIDATOR_DAILY_SPENT_ABI,
      functionName: 'dailySpentOf',
      args: [permissionContextHash, day],
    })) as bigint;
    return { dailySpentUsd: q96ToUsdInt(spentQ96) };
  } catch (err) {
    log.warn(
      {
        tokenId: tokenId.toString(),
        err_class: (err as Error)?.name,
      },
      'dailySpentOf read failed; falling back to null',
    );
    return { dailySpentUsd: null, reason: 'daily spend telemetry unavailable on this chain' };
  }
}

/**
 * Derive the risk-profile + spend posture block from a (policyRow, telemetry)
 * pair. Pure function; safe to unit-test. Returns the rendered block lines
 * (no leading title) so the caller can splice it into the larger context.
 */
function renderRiskProfileBlock(
  policy: PolicyRowReadShape | null,
  telemetry: RiskPostureTelemetry,
  nowMs: number,
): string {
  if (!policy) {
    return 'No persisted policy mirror; risk profile + headroom unavailable.';
  }
  const lines: string[] = [];

  // `presetId` is a nullable column on AgentPolicy: null encodes a custom
  // (non-preset) policy, otherwise it names one of the five frozen
  // `RiskPresetId` entries. The indexer normalises unknown on-chain hashes
  // to null before write, so the `unknown to registry` branch is a
  // belt-and-braces fallback for forward-compatible new presets.
  if (policy.presetId === null || policy.presetId === undefined) {
    lines.push('presetId: custom (no preset)');
  } else if (isRiskPresetId(policy.presetId)) {
    const preset: RiskPreset = RISK_PRESETS[policy.presetId];
    lines.push(`presetId: ${preset.id}`);
    lines.push(`preset.label: ${preset.label}`);
    lines.push(`preset.summary: ${preset.blurb}`);
  } else {
    lines.push(`presetId: ${String(policy.presetId)} (unknown to registry)`);
  }

  const maxQ = toBigInt(policy.maxNotionalUsdQ96);
  const capQ = toBigInt(policy.dailyCapUsdQ96);
  const maxUsd = maxQ !== null ? q96ToUsdInt(maxQ) : null;
  const capUsd = capQ !== null ? q96ToUsdInt(capQ) : null;
  lines.push(`maxNotionalUsd: ${maxUsd !== null ? formatUsd(maxUsd) : 'unknown'}`);
  lines.push(`dailyCapUsd: ${capUsd !== null ? formatUsd(capUsd) : 'unknown'}`);

  if (telemetry.dailySpentUsd === null) {
    lines.push(`dailySpentUsd: ${telemetry.reason ?? 'unavailable'}`);
    lines.push('dailyHeadroomUsd: unavailable (no daily spend telemetry)');
  } else {
    lines.push(`dailySpentUsd: ${formatUsd(telemetry.dailySpentUsd)}`);
    if (capUsd !== null) {
      const headroom = Math.max(0, capUsd - telemetry.dailySpentUsd);
      lines.push(`dailyHeadroomUsd: ${formatUsd(headroom)}`);
    } else {
      lines.push('dailyHeadroomUsd: unknown (dailyCapUsd missing)');
    }
  }

  const exp = policy.expiresAt;
  if (exp instanceof Date) {
    const iso = exp.toISOString();
    lines.push(`expiresAt: ${iso} (${relativeFromNow(exp.getTime(), nowMs)})`);
  } else if (typeof exp === 'string') {
    const ms = Date.parse(exp);
    if (Number.isFinite(ms)) {
      lines.push(`expiresAt: ${new Date(ms).toISOString()} (${relativeFromNow(ms, nowMs)})`);
    } else {
      lines.push(`expiresAt: ${exp}`);
    }
  } else {
    lines.push('expiresAt: unknown');
  }

  return lines.join('\n');
}

/**
 * Render a compact context block for the LLM. Keeps it under ~2k tokens by
 * trimming arrays. We deliberately do NOT include credential or PII values.
 */
async function buildContext(tokenId: bigint, policy: unknown): Promise<string> {
  const state = getRuntimeState(tokenId);
  const snap = state.lastSnapshot;
  const reEncode = (v: unknown): string =>
    JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val), 2);

  const recentActions = state.recent
    .filter((e) => e.kind === 'action')
    .slice(-15)
    .map((e) => {
      if (e.kind !== 'action') return null;
      return {
        ts: new Date(e.ts).toISOString(),
        type: e.data.type,
        symbol: e.data.symbol,
        side: e.data.side,
        qty: e.data.qty,
      };
    })
    .filter(Boolean);

  const recentRisks = state.recent
    .filter((e) => e.kind === 'risk')
    .slice(-5)
    .map((e) => {
      if (e.kind !== 'risk') return null;
      return { ts: new Date(e.ts).toISOString(), severity: e.severity, message: e.message };
    })
    .filter(Boolean);

  const policyBlock = policy
    ? reEncode(policy)
    : 'No persisted policy mirror; on-chain audit row may still exist.';

  // Risk profile + spend posture block. `policy` is the same Prisma row used
  // above; we narrow it through `PolicyRowReadShape` before reading. The
  // validator telemetry read is best-effort and never throws.
  const nowMs = Date.now();
  const narrowPolicy: PolicyRowReadShape | null =
    policy && typeof policy === 'object' ? (policy as PolicyRowReadShape) : null;

  // `chainId` is now a non-null column on AgentPolicy (defaults to Arbitrum
  // Sepolia at the database level for back-compat). We narrow the row value
  // to the supported chain set; anything outside the set (or a row written
  // before the schema patch ran) falls back to Arbitrum Sepolia rather than
  // throwing.
  const rawChainId = narrowPolicy?.chainId;
  const chainId: SupportedChainId =
    rawChainId === RH_CHAIN_TESTNET_CHAIN_ID
      ? RH_CHAIN_TESTNET_CHAIN_ID
      : ARB_SEPOLIA_CHAIN_ID;

  let telemetry: RiskPostureTelemetry = {
    dailySpentUsd: null,
    reason: 'daily spend telemetry unavailable on this chain',
  };
  const ctxHash = narrowPolicy ? toHex32(narrowPolicy.permissionContextHash) : null;
  if (ctxHash) {
    telemetry = await readDailySpent(tokenId, chainId, ctxHash, nowMs);
  }
  const riskProfileBlock = renderRiskProfileBlock(narrowPolicy, telemetry, nowMs);

  return [
    `Agent tokenId: ${tokenId.toString()}`,
    `Status: ${state.status}`,
    `Last tick: ${state.lastTickAt?.toISOString() ?? 'never'}`,
    '',
    'Latest snapshot (Q96.48 amounts where noted):',
    snap ? reEncode(snap) : 'null',
    '',
    'Recent actions (last 15):',
    JSON.stringify(recentActions, null, 2),
    '',
    'Recent risk events (last 5):',
    JSON.stringify(recentRisks, null, 2),
    '',
    'AgentPolicy mirror:',
    policyBlock,
    '',
    'Risk profile + spend posture:',
    riskProfileBlock,
  ].join('\n');
}

const SYSTEM_PROMPT = [
  'You are the explainer for a PrimeAgent autonomous trading agent.',
  'You answer the operator\'s questions about positions, risk, the active policy,',
  'and recent actions, grounded ONLY in the context provided.',
  '',
  'The context contains a "Risk profile + spend posture:" block carrying the',
  'operator\'s chosen risk preset (presetId, label, summary) and today\'s',
  'on-chain daily-cap usage (dailySpentUsd, dailyHeadroomUsd) derived from the',
  'PrimeAgentCallPolicyValidator. When the operator asks about "overexposure",',
  '"headroom", "how aggressive is my profile", or "how much can I still spend',
  'today", reason strictly from those values. Do not invent or estimate them.',
  'If a field reads "unavailable", say so plainly instead of guessing.',
  '',
  'Rules:',
  '- Never give financial advice. Describe state and behaviour, not recommendations.',
  '- Reason from the context block; do not invent positions, prices, or caps.',
  '- Quantities are Q96.48 fixed point: 1 share = 2^48. USD amounts are Q96.48 too,',
  '  except in the "Risk profile + spend posture:" block where USD is already',
  '  decoded to integer dollars.',
  '- Be concise. Two short paragraphs maximum.',
  '- If the context lacks the answer, say so explicitly.',
  '- No emojis. No em-dashes.',
].join('\n');

export const agentChatRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  /**
   * GET /:tokenId/var
   * Returns the parametric 99% one-day VaR for the agent's current snapshot.
   * Unauthenticated (read of public position state).
   */
  app.get('/:tokenId/var', async (request, reply) => {
    const tokenId = await parseTokenIdParam(request, reply);
    if (tokenId === null) return;
    const state = getRuntimeState(tokenId);
    if (!state.lastSnapshot) {
      return reply.code(200).send({
        success: true,
        error: null,
        data: null,
      });
    }
    const result = computeVar(state.lastSnapshot.data);
    return reply.code(200).send({ success: true, error: null, data: result });
  });

  /**
   * GET /:tokenId/var/onchain (Feature F)
   * Returns the Stylus risk_engine VaR with off-chain fallback when the
   * engine is unconfigured or reverts. Picks the symbol with the largest
   * absolute notional from the runtime snapshot to populate the on-chain
   * `var99Q96(asset, notional, horizonDays)` call.
   */
  app.get(
    '/:tokenId/var/onchain',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;
      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }
      // F-02: ownership gate. Runtime snapshot (positions, marks, PnL) is
      // per-tokenId sensitive state and must not leak to non-owners.
      const ok = await requireOwnerIfConfigured(reply, tokenId, user.walletAddress, 'var:onchain');
      if (!ok) return;
      const state = getRuntimeState(tokenId);
      if (!state.lastSnapshot) {
        return reply.code(200).send({ success: true, error: null, data: null });
      }
      // Pick the largest notional symbol; default to first allowed if all zero.
      const snap = state.lastSnapshot.data;
      const fallback = computeVar(snap);
      const top = fallback.perSymbol
        .map((p) => ({ symbol: p.symbol, abs: Math.abs(p.netNotionalUsd) }))
        .sort((a, b) => b.abs - a.abs)[0];
      if (!top || top.abs === 0) {
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            valueUsdQ96: '0',
            source: 'fallback',
            oneDay99Usd: fallback.oneDay99Usd,
            perSymbol: fallback.perSymbol,
            computedAt: Date.now(),
          },
        });
      }
      // The risk engine expects an asset ADDRESS; we use a deterministic
      // mapping via env vars when present. The map is intentionally narrow
      // (5 demo symbols). Missing addresses fall back to off-chain.
      const symbolToAddrEnv = `BACKEND_DEMO_ASSET_${top.symbol}`;
      const rawAddr = process.env[symbolToAddrEnv];
      const asset: `0x${string}` = rawAddr && /^0x[0-9a-fA-F]{40}$/.test(rawAddr)
        ? (rawAddr as `0x${string}`)
        : ('0x0000000000000000000000000000000000000000' as `0x${string}`);

      const result = await getVarOnChain(tokenId, asset, top.abs, 1, snap);
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          valueUsdQ96: result.valueUsdQ96.toString(),
          source: result.source,
          oneDay99Usd: fallback.oneDay99Usd,
          perSymbol: result.fallbackPerSymbol ?? fallback.perSymbol,
          computedAt: Date.now(),
        },
      });
    },
  );

  /**
   * GET /strategies (no auth required; pure read).
   */
  app.get('/strategies', async (_request, reply) => {
    const names = listStrategies();
    const data = names.map((name) => {
      const s = strategyRegistry[name];
      return {
        name,
        kind: s?.kind ?? 'deterministic',
      };
    });
    return reply.code(200).send({ success: true, error: null, data });
  });

  /**
   * POST /:tokenId/ask
   * Body: { question: string }
   * Reply: { success, data: { reply: string, model: string } }
   */
  app.post(
    '/:tokenId/ask',
    {
      preHandler: [authMiddleware],
      config: {
        // Hard cap: 10 questions per minute per user. Groq has a free tier
        // but is still rate-limited upstream; this prevents both runaway
        // costs and abuse.
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string =>
            (req.user as { id?: string } | undefined)?.id ?? req.ip ?? 'unknown',
        },
      },
    },
    async (request, reply) => {
      const startMs = Date.now();
      const tokenId = await parseTokenIdParam(request, reply);
      if (tokenId === null) return;

      const parsed = AskBody.safeParse(request.body);
      if (!parsed.success) {
        return handleError(reply, 400, 'Invalid request body', 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }

      if (!llmAvailable || !groq) {
        return handleError(
          reply,
          503,
          'Groq API key is not configured on this deployment',
          'LLM_UNAVAILABLE',
        );
      }

      // Read the AgentPolicy mirror (optional; may not exist yet for new agents).
      let policyRow: unknown = null;
      try {
        const tbl = (
          prismaQuery as unknown as {
            agentPolicy?: {
              findUnique: (args: { where: { tokenId: bigint } }) => Promise<unknown>;
            };
          }
        ).agentPolicy;
        if (tbl) {
          policyRow = await tbl.findUnique({ where: { tokenId } });
        }
      } catch (err) {
        log.warn(
          { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
          'agentPolicy lookup failed; proceeding without policy context',
        );
      }

      const context = await buildContext(tokenId, policyRow);

      try {
        // Groq exposes an OpenAI-shaped REST surface: the system message is
        // the first entry in `messages` (not a top-level param like the
        // Anthropic SDK). `user` is a free-form per-account string used for
        // upstream abuse tracking; we cap to 50 chars to match the legacy
        // Anthropic metadata.user_id limit.
        const completion = await groq.chat.completions.create({
          model: MODEL_DEFAULT,
          max_tokens: 600,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                '<context>',
                context,
                '</context>',
                '',
                'Question:',
                parsed.data.question,
              ].join('\n'),
            },
          ],
          user: `agent_${tokenId.toString()}`.slice(0, 50),
        });

        const reply_text = completion.choices[0]?.message?.content?.trim() ?? '';

        const reqMs = Date.now() - startMs;
        log.info(
          {
            tokenId: tokenId.toString(),
            data: {
              action: 'ask',
              question_len: parsed.data.question.length,
              reply_len: reply_text.length,
              model: MODEL_DEFAULT,
              req_duration_ms: reqMs,
              prompt_tokens: completion.usage?.prompt_tokens,
              completion_tokens: completion.usage?.completion_tokens,
            },
          },
          'agent ask ok',
        );

        return reply.code(200).send({
          success: true,
          error: null,
          data: { reply: reply_text, model: MODEL_DEFAULT },
        });
      } catch (err) {
        log.error(
          { tokenId: tokenId.toString(), err_class: (err as Error)?.name },
          `agent ask failed: ${(err as Error)?.message ?? String(err)}`,
        );
        return handleError(
          reply,
          502,
          'Groq API call failed',
          'LLM_UPSTREAM_ERROR',
          err as Error,
        );
      }
    },
  );

  done();
};

export const __internal = { requireOwnerIfConfigured };
