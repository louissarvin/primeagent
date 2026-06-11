/**
 * LLM clients for the PrimeAgent tick loop.
 *
 * Provider: Groq. The deployment intentionally diverges from PrimeAgent.md
 * section 10.1.1 (which pins Claude). Faster inference and a free tier make
 * Groq the better fit for demo logistics. One provider, one code path; no
 * Anthropic fallback.
 *
 * MODEL_DEFAULT is consumed by BOTH the 60s tick path AND the previous
 * "margin-call escalation" slot. The model id is overridable via the
 * `GROQ_MODEL_DEFAULT` env var (defaults to `llama-3.3-70b-versatile`).
 *
 * Resilience: when GROQ_API_KEY is unset, the exports become null and the
 * runtime's LLM branch logs a warn and refuses to start. Deterministic
 * strategies are unaffected (they never touch this module beyond import).
 *
 * SECURITY: GROQ_API_KEY is loaded once from process env. Never log it.
 */

import Groq from 'groq-sdk';
import { ChatGroq } from '@langchain/groq';

import {
  GROQ_API_KEY,
  GROQ_MODEL_DEFAULT,
  LANGCHAIN_API_KEY,
  LANGCHAIN_PROJECT,
  LANGCHAIN_TRACING_V2,
} from '../config/main-config.ts';
import { forSvc } from '../lib/logger.ts';

const langsmithLog = forSvc('langsmith');

/**
 * Default Groq model id. Same model is used for both the tick loop and the
 * margin-call escalation slot. Operators override via `GROQ_MODEL_DEFAULT`.
 */
export const MODEL_DEFAULT: string = GROQ_MODEL_DEFAULT;

/**
 * Back-compat alias preserved so call sites that historically reached for
 * the "deeper" model do not break. With Groq we keep a single model id;
 * any future split should set `GROQ_MODEL_MARGIN_CALL` and read it here.
 */
export const MODEL_MARGIN_CALL: string = GROQ_MODEL_DEFAULT;

/**
 * LangSmith status surface (Wave F). LangChain's tracer reads the
 * `LANGCHAIN_*` env vars on first import so we do not call into the SDK
 * here; instead we surface the resolved state for the `/health` probe.
 * `enabled` is true only when BOTH `LANGCHAIN_TRACING_V2` is set AND an
 * API key is present (auto-instrumentation requires both).
 */
export interface LangSmithStatus {
  enabled: boolean;
  project: string | null;
}

export function getLangSmithStatus(): LangSmithStatus {
  const enabled = LANGCHAIN_TRACING_V2 && !!LANGCHAIN_API_KEY;
  return {
    enabled,
    project: enabled ? LANGCHAIN_PROJECT : null,
  };
}

// Boot-time log so operators see immediately whether tracing is hot. The
// API key itself is NEVER logged; only the boolean `langsmith_enabled` and
// the project slug.
langsmithLog.info(
  {
    data: {
      langsmith_enabled: LANGCHAIN_TRACING_V2 && !!LANGCHAIN_API_KEY,
      langsmith_project: LANGCHAIN_TRACING_V2 && LANGCHAIN_API_KEY ? LANGCHAIN_PROJECT : null,
    },
  },
  'LangSmith tracing status resolved',
);

/** True when GROQ_API_KEY is configured. Callers branch on this. */
export const llmAvailable: boolean = GROQ_API_KEY.length > 0;

/**
 * Direct Groq SDK client (raw `chat.completions.create`). Null when the API
 * key is missing. Used by paths that need fine-grained control over the
 * OpenAI-shaped completion API; the LangChain wrapper is preferred for the
 * tick loop.
 */
export const groq: Groq | null = llmAvailable ? new Groq({ apiKey: GROQ_API_KEY }) : null;

/**
 * Pre-bound ChatGroq instance for the default tick path. Null when the
 * API key is missing. ChatGroq reads `GROQ_API_KEY` from the environment
 * by default but we pass it explicitly to keep the boot signature local
 * and testable.
 */
export const chatGroqDefault: ChatGroq | null = llmAvailable
  ? new ChatGroq({
      model: MODEL_DEFAULT,
      apiKey: GROQ_API_KEY,
      temperature: 0,
    })
  : null;

/**
 * Factory for the margin-call path. We construct fresh per call so the
 * model is not held in memory by long-lived tick agents. With Groq the
 * default and margin-call slots share the same model id today; operators
 * can override via a future `GROQ_MODEL_MARGIN_CALL` env without changing
 * call sites.
 *
 * Returns null when the API key is missing; callers must branch.
 */
export function chatForMarginCall(): ChatGroq | null {
  if (!llmAvailable) return null;
  return new ChatGroq({
    model: MODEL_MARGIN_CALL,
    apiKey: GROQ_API_KEY,
    temperature: 0,
  });
}
