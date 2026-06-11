/**
 * Conversational policy draft generator (Feature A).
 *
 * `composeDraft` issues a single Groq chat completion call in strict JSON
 * mode (`response_format: { type: 'json_object' }`). The model emits a JSON
 * object matching the `set_policy` shape; we parse + Zod-validate the result
 * against `AgentPolicyDraftSchema`. The route handler retries once on Zod
 * failure before responding 422.
 *
 * Model pin: `MODEL_DEFAULT` (Groq; see `llm.ts`).
 *
 * Idempotency is the caller's responsibility (see the `clientId`-keyed LRU in
 * `agentPolicyRoutes.ts`).
 *
 * Why not tool-strict mode: ChatGroq supports tool calls but the proposal
 * builder is single-shot JSON; raw JSON mode is the documented, lowest-
 * variance path for Llama models. The schema below is enforced server-side.
 */

import { groq, MODEL_DEFAULT } from '../llm.ts';
import {
  AgentPolicyDraftSchema,
  type AgentPolicyDraft,
  firstIssueMessage,
} from './schemas.ts';
import {
  RISK_PRESET_IDS,
  RISK_PRESETS,
  listRiskPresets,
  type RiskPreset,
  type RiskPresetId,
} from '../risk/presets.ts';
import { selectorsForPreset } from '../../lib/selectors.ts';

const ALLOWED_SYMBOLS = ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD'] as const;

const SET_POLICY_SHAPE_DESCRIPTION = [
  'You MUST emit a single JSON object with EXACTLY these keys and no others:',
  '{',
  `  "presetId": one of ${JSON.stringify([...RISK_PRESET_IDS])} or null,`,
  '  "maxNotionalUsd": integer in [1, 10000000],',
  '  "dailyCapUsd": integer in [1, 50000000],',
  '  "durationDays": integer in [1, 90],',
  `  "allowedSymbols": non-empty subset of ${JSON.stringify([...ALLOWED_SYMBOLS])} (max 5 items),`,
  '  "strategyName": string of length 1..64',
  '}',
  'Pick the preset that best matches the operator ask, then refine caps within the preset bounds.',
  'Never exceed maxNotionalUsd=10000000 or dailyCapUsd=50000000. Duration must be 1..90 days.',
  'allowedSymbols MUST be a subset of the chosen preset symbols.',
  'presetId may be one of the five preset ids OR null when the operator explicitly asked for something custom.',
].join('\n');

const SYSTEM = [
  'You are the PrimeAgent policy builder. Your only output is a single JSON object as specified.',
  'Do NOT wrap the JSON in Markdown code fences. Do NOT add any prose before or after.',
  'Choose the preset whose label and blurb most closely matches the operator ask.',
  'When the operator gives explicit caps, prefer those caps over the preset defaults (within the preset bounds).',
  'Never invent caps higher than the absolute schema limits (10M / 50M USD).',
  'Always pick a strategy that exists. Defaults: conservative -> mean-reversion, balanced -> tsla-pairs, aggressive -> momentum-breakout, market-maker -> mean-reversion, delta-neutral -> tsla-pairs.',
  'allowedSymbols must be a subset of the chosen preset\'s allowedSymbols.',
  'Be deterministic. Never ask a clarifying question.',
  '',
  SET_POLICY_SHAPE_DESCRIPTION,
].join('\n');

function presetSummary(p: RiskPreset): string {
  return `- ${p.id}: "${p.label}". ${p.blurb} caps=$${p.maxNotionalUsd.toLocaleString()}/$${p.dailyCapUsd.toLocaleString()} duration=${p.durationDays}d strategy=${p.defaultStrategy} symbols=${p.allowedSymbols.join(',')}`;
}

export interface ComposeDraftInput {
  operatorAsk: string;
  presetIdHint?: RiskPresetId;
  /**
   * Optional client-supplied context. The LLM sees this verbatim; callers
   * MUST avoid putting secrets here. Limited to 4kB after JSON.stringify to
   * keep prompt cost bounded.
   */
  contextSnapshot?: Record<string, unknown>;
  clientId: string;
  tokenId: bigint | null;
  /**
   * Allowed contracts that the policy will install. Provided by the caller
   * (frontend already knows the venue addresses). Capped at 16.
   */
  allowedContracts: `0x${string}`[];
}

export class ComposeDraftError extends Error {
  constructor(
    public code:
      | 'LLM_UNAVAILABLE'
      | 'LLM_TIMEOUT'
      | 'LLM_BAD_OUTPUT'
      | 'SCHEMA_FAILED'
      | 'LLM_UPSTREAM',
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = 'ComposeDraftError';
  }
}

/**
 * Strip optional Markdown code fences before parsing. Llama models
 * occasionally wrap JSON in ```json ... ``` even when explicitly forbidden;
 * we tolerate the fence rather than re-prompt.
 */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  let s = raw.trim();
  if (s.startsWith('```')) {
    const newlineIdx = s.indexOf('\n');
    if (newlineIdx >= 0) s = s.slice(newlineIdx + 1);
    if (s.endsWith('```')) s = s.slice(0, -3);
    s = s.trim();
  }
  try {
    const parsed = JSON.parse(s) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Compose an `AgentPolicyDraft` from the operator's natural-language ask.
 *
 * Side-effect free other than the Groq call.
 */
export async function composeDraft(input: ComposeDraftInput): Promise<AgentPolicyDraft> {
  if (!groq) {
    throw new ComposeDraftError('LLM_UNAVAILABLE', 'Groq API key is not configured');
  }

  if (input.allowedContracts.length === 0) {
    throw new ComposeDraftError(
      'SCHEMA_FAILED',
      'composeDraft requires at least one allowed contract',
    );
  }

  const presetsBlock = listRiskPresets().map(presetSummary).join('\n');
  const ctxBlock = input.contextSnapshot
    ? JSON.stringify(input.contextSnapshot).slice(0, 4_000)
    : 'none';
  const hintLine = input.presetIdHint
    ? `Operator hint: prefer preset "${input.presetIdHint}" unless the ask clearly contradicts.`
    : '';

  const userText = [
    'Operator ask:',
    input.operatorAsk,
    '',
    hintLine,
    '',
    'Available presets:',
    presetsBlock,
    '',
    'Context snapshot:',
    ctxBlock,
    '',
    'Emit the JSON object now. No prose, no code fences.',
  ]
    .filter((s) => s.length > 0)
    .join('\n');

  let rawText: string;
  try {
    const completion = await groq.chat.completions.create({
      model: MODEL_DEFAULT,
      max_tokens: 800,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userText },
      ],
      user: `policy_draft_${input.clientId}`.slice(0, 50),
    });
    rawText = completion.choices[0]?.message?.content ?? '';
  } catch (err) {
    throw new ComposeDraftError(
      'LLM_UPSTREAM',
      'Groq API call failed',
      (err as Error)?.message,
    );
  }

  const partial = parseJsonObject(rawText);
  if (!partial) {
    throw new ComposeDraftError(
      'LLM_BAD_OUTPUT',
      'Model did not return a valid JSON object',
    );
  }

  const presetIdRaw = partial.presetId;
  const presetId: RiskPresetId | null =
    typeof presetIdRaw === 'string' && (RISK_PRESET_IDS as readonly string[]).includes(presetIdRaw)
      ? (presetIdRaw as RiskPresetId)
      : null;
  const preset = presetId ? RISK_PRESETS[presetId] : null;

  // Derive selectors + presetHash from the preset (custom policies require
  // the caller to supply selectors out-of-band; in v1 we route custom asks
  // through the balanced selector list).
  const selectorPresetId: RiskPresetId = presetId ?? 'balanced';
  const allowedSelectors = selectorsForPreset(selectorPresetId);

  const candidate: AgentPolicyDraft = {
    tokenId: input.tokenId,
    clientId: input.clientId,
    presetId,
    maxNotionalUsd: Number(partial.maxNotionalUsd),
    dailyCapUsd: Number(partial.dailyCapUsd),
    durationDays: Number(partial.durationDays),
    allowedSymbols: (partial.allowedSymbols as AgentPolicyDraft['allowedSymbols']) ?? [],
    allowedContracts: input.allowedContracts.slice(0, 16),
    allowedSelectors,
    strategyName:
      typeof partial.strategyName === 'string' && partial.strategyName.length > 0
        ? partial.strategyName
        : (preset?.defaultStrategy ?? 'tsla-pairs'),
    presetHash: preset?.presetHash ?? null,
    draftedAt: Math.floor(Date.now() / 1000),
  };

  const parsed = AgentPolicyDraftSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ComposeDraftError(
      'SCHEMA_FAILED',
      firstIssueMessage(parsed.error),
      JSON.stringify(parsed.error.issues),
    );
  }

  return parsed.data;
}
