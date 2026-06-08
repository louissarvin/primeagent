/**
 * Centralized configuration for the application
 * All commonly used environment variables should be defined here
 */

import { logger } from '../lib/logger.ts';

// JWT secret precedence: BACKEND_JWT_SECRET (new canonical name per spec
// section 11.1.bis) -> JWT_SECRET (legacy alias preserved for the existing
// dev .env files until the migration completes).
const rawJwtSecret = process.env.BACKEND_JWT_SECRET || process.env.JWT_SECRET || '';

// Validate required environment variables on startup
const requiredChecks: Array<{ name: string; value: string | undefined }> = [
  { name: 'DATABASE_URL', value: process.env.DATABASE_URL },
  { name: 'BACKEND_JWT_SECRET (or JWT_SECRET)', value: rawJwtSecret || undefined },
];

for (const check of requiredChecks) {
  if (!check.value) {
    logger.fatal(
      { svc: 'boot', data: { missing_env: check.name } },
      `FATAL: Missing required environment variable: ${check.name}`,
    );
    process.exit(1);
  }
}

// ----- App Configuration -----
export const APP_PORT: number = Number(process.env.APP_PORT) || 3700;
export const NODE_ENV: string = process.env.NODE_ENV || 'development';
export const IS_DEV: boolean = NODE_ENV === 'development';
export const IS_PROD: boolean = NODE_ENV === 'production';

// ----- Logging -----
// Default level: info in prod, debug in dev. Overridable via LOG_LEVEL env.
export const LOG_LEVEL: string =
  process.env.LOG_LEVEL || (NODE_ENV === 'production' ? 'info' : 'debug');

// ----- Database -----
export const DATABASE_URL: string = process.env.DATABASE_URL as string;

// ----- Authentication -----
export const JWT_SECRET: string = rawJwtSecret;
export const JWT_EXPIRES_IN: string = process.env.JWT_EXPIRES_IN || '1d';

// ----- MCP server -----
export const PUBLIC_ORIGIN: string = process.env.PUBLIC_ORIGIN || 'http://localhost:3200';
export const MCP_PROTOCOL_VERSION: string = process.env.MCP_PROTOCOL_VERSION || '2025-11-25';

// ----- Groq / LLM -----
// Lazy: consumed by src/agent/llm.ts. Empty string is acceptable in dev so
// deterministic strategies and the rest of the surface still boot for local
// testing. The LLM branch in the tick loop logs a warn and refuses when
// unset; deterministic strategies are unaffected.
//
// Provider migration note: this deployment intentionally diverges from
// PrimeAgent.md section 10.1.1 (which pins Claude). Groq's OpenAI-shaped
// REST surface plus a free tier was preferred for demo logistics. No
// Anthropic fallback exists; one provider, one code path.
export const GROQ_API_KEY: string = process.env.GROQ_API_KEY || '';

// Default Groq chat model. Operators can override via env without a deploy.
// `llama-3.3-70b-versatile` is the current general-purpose pick; it serves
// BOTH the 60s tick loop AND the previous "margin-call escalation" slot.
export const GROQ_MODEL_DEFAULT: string =
  process.env.GROQ_MODEL_DEFAULT || 'llama-3.3-70b-versatile';

// ----- EVM RPC endpoints -----
export const ARB_SEPOLIA_RPC: string =
  process.env.ARB_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
export const RH_CHAIN_RPC: string =
  process.env.RH_CHAIN_RPC || 'https://rpc.testnet.chain.robinhood.com';

// ----- Attestor (EIP-712 signer; lazy enforcement at the lib/attestor.ts layer) -----
// We deliberately do NOT fatal at import time so dev paths that never
// sign on-chain attestations can still boot. The lazy getter inside
// `lib/attestor.ts` enforces presence at the moment of use.
export const BACKEND_ATTESTOR_PRIVATE_KEY: string | undefined =
  process.env.BACKEND_ATTESTOR_PRIVATE_KEY;
export const BACKEND_ATTESTOR_ADDRESS_ARB_SEPOLIA: string | undefined =
  process.env.BACKEND_ATTESTOR_ADDRESS_ARB_SEPOLIA;
export const BACKEND_ATTESTOR_ADDRESS_RH_CHAIN: string | undefined =
  process.env.BACKEND_ATTESTOR_ADDRESS_RH_CHAIN;

// ----- Contract addresses on Arbitrum Sepolia (chain id 421614) -----
// Robinhood Chain Testnet deployments are not surfaced here yet; add when
// the cross-chain wiring lands.
export const BACKEND_PRICE_ORACLE_ADDRESS_ARB_SEPOLIA: string | undefined =
  process.env.BACKEND_PRICE_ORACLE_ADDRESS_ARB_SEPOLIA;
export const BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA: string | undefined =
  process.env.BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA;
export const BACKEND_DIAMOND_ADDRESS_ARB_SEPOLIA: string | undefined =
  process.env.BACKEND_DIAMOND_ADDRESS_ARB_SEPOLIA;
export const BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA: string | undefined =
  process.env.BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA;
export const BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA: string | undefined =
  process.env.BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA;
export const BACKEND_EMERGENCY_SHUTDOWN_ADDRESS_ARB_SEPOLIA: string | undefined =
  process.env.BACKEND_EMERGENCY_SHUTDOWN_ADDRESS_ARB_SEPOLIA;

// PrimeAgentCallPolicyValidator (PrimeAgent.md 7.7.bis). The ZeroDev Kernel
// defers per-call enforcement to this contract; the backend reads its
// `dailySpentOf(permissionContextHash, day)` slot to surface daily-cap
// headroom in `/ask` responses and the LLM advisor's proposal headroom.
//
// Optional in dev: when unset the chat / proposals telemetry surfaces null
// for `dailySpentUsd` and the LLM is told the field is unavailable. Per
// `backend/CLAUDE.md` we never fall back to a hardcoded address.
export const BACKEND_CALL_POLICY_VALIDATOR_ADDRESS_ARB_SEPOLIA: string | undefined =
  process.env.BACKEND_CALL_POLICY_VALIDATOR_ADDRESS_ARB_SEPOLIA;

// ----- Wave J-Q additions ---------------------------------------------------

// Feature J: PrimeAgentPreExecHook is the on-chain enforcement gate the
// strategy executor simulates against via viem `simulateContract`. Optional
// in dev (the executor logs a warn and falls through to direct execution
// when unset, mirroring the existing telemetry posture in agentChatRoutes).
export const BACKEND_PREEXEC_HOOK_ADDRESS_ARB_SEPOLIA: string | undefined =
  process.env.BACKEND_PREEXEC_HOOK_ADDRESS_ARB_SEPOLIA;

// Feature J: Anthropic key for the strategy executor only. The legacy Groq
// path (chat advisor, observation tick) keeps using GROQ_API_KEY. Empty
// string is acceptable in dev so deterministic flows boot.
export const ANTHROPIC_API_KEY: string = process.env.ANTHROPIC_API_KEY || '';
export const ANTHROPIC_MODEL_DEFAULT: string =
  process.env.ANTHROPIC_MODEL_DEFAULT || 'claude-sonnet-4-6';
export const ANTHROPIC_MODEL_MARGIN_CALL: string =
  process.env.ANTHROPIC_MODEL_MARGIN_CALL || 'claude-opus-4-7';

// Feature J: PostgresSaver thread-state URL. Defaults to DATABASE_URL if
// unset (single-DB deployments); separate values supported for the
// scale-out story where the LangGraph checkpoints live in their own DB.
export const LANGGRAPH_PG_URL: string =
  process.env.LANGGRAPH_PG_URL || process.env.DATABASE_URL || '';

// Feature J runtime flag: when false the executor short-circuits to the
// legacy advice path. Default true so Wave-J ships hot; flip to false for
// emergency rollback without a redeploy.
export const BACKEND_LLM_EXECUTOR_ENABLED: boolean = (() => {
  const raw = (process.env.BACKEND_LLM_EXECUTOR_ENABLED || 'true').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
})();

// Feature N: FX provider override. When set to `bank_of_england` the FX
// service skips Frankfurter/Coinbase and parses the BoE daily CSV; useful
// for the London judge demo so the rate on screen is provably the BoE fix.
export const FX_PROVIDER_OVERRIDE: string | undefined =
  process.env.FX_PROVIDER_OVERRIDE;

// Feature O: audit PDF content-addressed object store. When unset the
// renderer keeps PDFs in-memory only (acceptable in dev); production must
// supply an S3 bucket name or a local FS path (file:///path).
export const BACKEND_AUDIT_STORE_BUCKET: string | undefined =
  process.env.BACKEND_AUDIT_STORE_BUCKET;

// Feature Q: firm identity used by the DSS memo header. Both required when
// the route is invoked; absence returns DSS_FIRM_METADATA_MISSING.
export const FIRM_NAME: string | undefined = process.env.FIRM_NAME;
export const FIRM_LEI: string | undefined = process.env.FIRM_LEI;

// ----- Price oracle signer keys -----
// CSV of 0x-prefixed 32-byte hex private keys. Empty array in dev is
// acceptable; the Wave 2 priceOraclePoster worker branches on length.
// SECURITY: never log these values; never echo them back in responses.
export const BACKEND_PRICE_SIGNER_KEYS: string[] = (() => {
  const raw = process.env.BACKEND_PRICE_SIGNER_KEYS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
})();

// ----- At-rest token encryption (consumed by lib/crypto.ts) -----
// Surfaced here for visibility; the helpers in lib/crypto.ts still read
// process.env directly so the rotation flow (v1 -> v2) stays decoupled
// from this config module.
export const BACKEND_TOKEN_ENC_KEY: string | undefined = process.env.BACKEND_TOKEN_ENC_KEY;
export const BACKEND_TOKEN_ENC_KEY_NEXT: string | undefined =
  process.env.BACKEND_TOKEN_ENC_KEY_NEXT;

// ----- Robinhood MCP client (outbound, Wave 2) -----
// `ROBINHOOD_USE_LIVE` gates the outbound MCP client to either hit the
// real Robinhood MCP endpoint or fall through to the deterministic stub.
// `ROBINHOOD_USE_DCR` controls whether the OAuth bootstrap uses Dynamic
// Client Registration (RFC 7591) or a hardcoded `client_id` per spec
// section 9.5 / 16.bis.
function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'no') return false;
  return fallback;
}

export const ROBINHOOD_USE_LIVE: boolean = parseBool(process.env.ROBINHOOD_USE_LIVE, false);
export const ROBINHOOD_USE_DCR: boolean = parseBool(process.env.ROBINHOOD_USE_DCR, true);
export const ROBINHOOD_CLIENT_ID: string | undefined = process.env.ROBINHOOD_CLIENT_ID;
export const ROBINHOOD_CLIENT_SECRET: string | undefined = process.env.ROBINHOOD_CLIENT_SECRET;
export const ROBINHOOD_MCP_URL: string =
  process.env.ROBINHOOD_MCP_URL || 'https://agent.robinhood.com/mcp/trading';
export const ROBINHOOD_AUTHORIZE_URL: string =
  process.env.ROBINHOOD_AUTHORIZE_URL || 'https://robinhood.com/oauth';
export const ROBINHOOD_TOKEN_URL: string =
  process.env.ROBINHOOD_TOKEN_URL || 'https://api.robinhood.com/oauth2/token/';
export const ROBINHOOD_DCR_URL: string =
  process.env.ROBINHOOD_DCR_URL || 'https://agent.robinhood.com/oauth/trading/register';

// ----- Policy facet selector gating (Feature C / Option B) -----
// The Diamond facet upgrade (`Erc7715PolicyAuditFacet.installPermissionV2`)
// ships behind a 48h timelocked cut. Until the cut executes on a given
// network the backend must keep encoding the legacy `installPermission`
// selector against the 10-field `LibPolicy.LegacyPolicy` shape so atomic
// rotations still apply.
//
// After the cut executes, flip this flag to `true` (the default) and the
// rotation builder encodes the V2 selector against the 11-field
// `LibPolicy.Policy` shape (including the trailing `presetHash`). Both
// paths reject calldata with the wrong arity; we never fall back silently.
//
// Fleet spawn always encodes the full 11-field shape because the on-chain
// `PrimeAgentFactory.deployAgent` signature has been updated atomically
// with the facet cut and exposes only the new shape.
export const BACKEND_POLICY_FACET_V2: boolean = parseBool(
  process.env.BACKEND_POLICY_FACET_V2,
  true,
);

// ----- Pimlico Alto fallback for RH Chain (chain 46630). See PrimeAgent.md 7.11.bis -----
export const BACKEND_PIMLICO_RH_CHAIN_URL: string | undefined =
  process.env.BACKEND_PIMLICO_RH_CHAIN_URL;

// ----- Robinhood Chain Testnet (chain 46630) RhChainSwap wiring -----
// Per ADR `memory/adr_rh_chain_swap_2026.md`. The swap address is empty
// until the deploy script writes it back into `memory/rh_chain_swap_deployed.json`.
// All consumers MUST tolerate an empty value and disable the RH Chain leg
// gracefully (boot logs a warning; agent loop skips RH swap planning).
export const RH_CHAIN_TESTNET_CHAIN_ID: number = 46630;

const ALCHEMY_RH_PATTERN = /^https:\/\/robinhood-testnet\.g\.alchemy\.com\/v2\/.+/;
const HEX_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export const BACKEND_RH_CHAIN_ALCHEMY_URL: string | undefined = (() => {
  const v = process.env.BACKEND_RH_CHAIN_ALCHEMY_URL;
  if (!v) return undefined;
  if (!ALCHEMY_RH_PATTERN.test(v)) {
    logger.fatal(
      { svc: 'boot', data: { env: 'BACKEND_RH_CHAIN_ALCHEMY_URL' } },
      'BACKEND_RH_CHAIN_ALCHEMY_URL set but does not match https://robinhood-testnet.g.alchemy.com/v2/<key>',
    );
    process.exit(1);
  }
  return v;
})();

export const BACKEND_RH_CHAIN_FALLBACK_RPC: string =
  process.env.BACKEND_RH_CHAIN_FALLBACK_RPC || 'https://rpc.testnet.chain.robinhood.com';

export const BACKEND_RH_CHAIN_SWAP_ADDRESS: string = (() => {
  const v = process.env.BACKEND_RH_CHAIN_SWAP_ADDRESS;
  if (v === undefined || v === '') return '';
  if (!HEX_ADDRESS.test(v)) {
    logger.fatal(
      { svc: 'boot', data: { env: 'BACKEND_RH_CHAIN_SWAP_ADDRESS' } },
      'BACKEND_RH_CHAIN_SWAP_ADDRESS must be empty (pre-deploy) or a 0x-prefixed 20-byte hex address',
    );
    process.exit(1);
  }
  return v;
})();

// Per ADR Section 5 + Open Question 3: testnet shares the existing attestor
// key; mainnet MUST separate. We surface a distinct env var so the future
// rotation is a config-only change.
export const BACKEND_RH_CHAIN_SWAP_SIGNER_PRIVATE_KEY: string | undefined = (() => {
  const v =
    process.env.BACKEND_RH_CHAIN_SWAP_SIGNER_PRIVATE_KEY ||
    process.env.BACKEND_ATTESTOR_PRIVATE_KEY;
  if (!v) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    logger.fatal(
      { svc: 'boot', data: { env: 'BACKEND_RH_CHAIN_SWAP_SIGNER_PRIVATE_KEY' } },
      'BACKEND_RH_CHAIN_SWAP_SIGNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex',
    );
    process.exit(1);
  }
  return v;
})();

/** True when the swap address has been configured. Consumers gate on this. */
export const RH_CHAIN_SWAP_CONFIGURED: boolean = BACKEND_RH_CHAIN_SWAP_ADDRESS !== '';

// ----- Agent demo-mode (recording aid; not production behaviour) -----
// When `BACKEND_AGENT_DEMO_MODE=true` the tsla-pairs strategy fires a
// deterministic sequence of small swaps on the first three ticks so a
// screen recording captures the on-chain effect without waiting for the
// natural spread signal. Default off. This is a DEMO HELPER ONLY: leave
// disabled for any real trading or production environment.
export const BACKEND_AGENT_DEMO_MODE: boolean = parseBool(
  process.env.BACKEND_AGENT_DEMO_MODE,
  false,
);

// ----- Backend PaymasterRelay (Wave E1, PrimeAgent.md 7.11) -----
// Address of the deployed PaymasterRelay on Arbitrum Sepolia. When set the
// `/paymaster/sponsor` route returns a populated `paymasterAndData` shape;
// otherwise the route degrades gracefully with `signedByBackend: false`.
export const BACKEND_PAYMASTER_RELAY_ADDRESS_ARB_SEPOLIA: string | undefined =
  process.env.BACKEND_PAYMASTER_RELAY_ADDRESS_ARB_SEPOLIA;

// Optional: when present, the paymaster route signs the validUntil/validAfter
// window with this key. When unset, the route returns the unsigned shape and
// the response carries `signedByBackend: false` so callers can route the op
// through their own bundler signer. SECURITY: 32-byte hex private key; never
// log; never echo in responses.
export const BACKEND_PAYMASTER_PRIVATE_KEY: string | undefined =
  process.env.BACKEND_PAYMASTER_PRIVATE_KEY;

// ----- Robinhood OAuth scope enforcement (Wave E1) -----
// PrimeAgent.md 9.5 mandates `scope === "internal"` for the demo trading
// surface. Tests can override; production must leave the default.
export const ROBINHOOD_REQUIRED_SCOPE: string =
  process.env.ROBINHOOD_REQUIRED_SCOPE || 'internal';

// ----- Timeboost-aware priority tip (Wave A; dynamic floor in Wave E1) -----
// Arbitrum's Timeboost auction lets a higher `maxPriorityFeePerGas` win
// ordering when blocks compete for sequencer slots. Wave E1 replaces the
// static read with a dynamic reader against the ArbGasInfo precompile at
// 0x6C (see `services/arbGasInfo.ts`). This env stays as a back-compat
// alias for `ATTEST_PRIORITY_TIP_WEI_FLOOR`: any value here is interpreted
// as the floor applied on top of the dynamic reading.
export const ATTEST_PRIORITY_TIP_WEI: bigint = (() => {
  const raw = process.env.ATTEST_PRIORITY_TIP_WEI;
  if (!raw) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
})();

// ----- ArbGasInfo dynamic priority tip floor (Wave E1) -----
// Floor applied on top of the `currentPriorityTipWei` reading. When the
// dynamic reader fails (RPC unreachable, precompile not deployed on this
// chain) the floor is returned instead so writes still proceed. Default 0n
// preserves the Wave A behaviour where the static env value drives the tip.
export const ATTEST_PRIORITY_TIP_WEI_FLOOR: bigint = (() => {
  const raw = process.env.ATTEST_PRIORITY_TIP_WEI_FLOOR;
  if (raw) {
    try {
      return BigInt(raw);
    } catch {
      // Fall through to the alias.
    }
  }
  // Back-compat: when only the legacy env is set, treat it as a floor.
  return ATTEST_PRIORITY_TIP_WEI;
})();

// ----- Stylus margin engine reader (Wave A) -----
// Address of the Stylus `IMarginEngine` deployment that exposes
// `netCollateralUsdQ96(address vault)`. Optional; when unset, the in-process
// `lib/marginEngine.ts` helper returns 0n so SSE paths still function.
export const BACKEND_MARGIN_ENGINE_ADDRESS_ARB_SEPOLIA: string | undefined =
  process.env.BACKEND_MARGIN_ENGINE_ADDRESS_ARB_SEPOLIA;

// ----- On-chain indexer (Wave A) -----
// `fromBlock` is a string because viem accepts both `'latest'` and decimal
// block numbers. Indexer parses to bigint when a numeric value is supplied.
export const BACKEND_INDEXER_FROM_BLOCK_ARB_SEPOLIA: string | undefined =
  process.env.BACKEND_INDEXER_FROM_BLOCK_ARB_SEPOLIA;
export const BACKEND_INDEXER_FROM_BLOCK_RH_CHAIN: string | undefined =
  process.env.BACKEND_INDEXER_FROM_BLOCK_RH_CHAIN;

// Optional websocket RPC URLs. When set, indexer subscribes via
// `webSocket()` transport. When unset, falls back to http polling at
// `pollingInterval: 2000`. Arbitrum 250ms blocks make ws strongly preferred.
export const BACKEND_WS_RPC_ARB_SEPOLIA: string | undefined =
  process.env.BACKEND_WS_RPC_ARB_SEPOLIA;
export const BACKEND_WS_RPC_RH_CHAIN: string | undefined =
  process.env.BACKEND_WS_RPC_RH_CHAIN;

// ----- Robinhood multi-tenant gating (Customer Agreement Section 29) -----
// `false` is the demo-account default: only the operator's RH account is
// used. Set to `true` only when formal API Licensee approval is in place.
export const ROBINHOOD_MULTI_TENANT: boolean = parseBool(process.env.ROBINHOOD_MULTI_TENANT, false);

// Default 30s; the Wave B agent loop reads market state on this cadence.
export const ROBINHOOD_POLL_INTERVAL_MS: number = (() => {
  const raw = process.env.ROBINHOOD_POLL_INTERVAL_MS;
  if (!raw) return 30000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 30000;
})();

// ----- MCP client pool (Wave B) -----
// Upper bound on the in-process LRU cache of per-user Robinhood MCP
// connections. Each entry holds a connected StreamableHTTPClientTransport;
// the bearer is refreshed transparently by `services/robinhoodOAuth.ts`.
export const MCP_POOL_MAX: number = (() => {
  const raw = process.env.MCP_POOL_MAX;
  if (!raw) return 100;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
})();

// ----- Circuit breaker (Wave E2) -----
// Trips an agent into `paused` when one of three rules fires (see
// `src/workers/circuitBreaker.ts`). The defaults are deliberately
// conservative; operators tune via env. `ENABLED=false` short-circuits the
// worker completely so a chaotic dev environment does not auto-pause.
export const CIRCUIT_BREAKER_ENABLED: boolean = parseBool(
  process.env.CIRCUIT_BREAKER_ENABLED,
  true,
);
export const CIRCUIT_BREAKER_DRAWDOWN_BPS: number = (() => {
  const raw = process.env.CIRCUIT_BREAKER_DRAWDOWN_BPS;
  if (!raw) return 500;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
})();
export const CIRCUIT_BREAKER_TICK_ERROR_THRESHOLD: number = (() => {
  const raw = process.env.CIRCUIT_BREAKER_TICK_ERROR_THRESHOLD;
  if (!raw) return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
})();
export const CIRCUIT_BREAKER_ACTION_RATE_THRESHOLD: number = (() => {
  const raw = process.env.CIRCUIT_BREAKER_ACTION_RATE_THRESHOLD;
  if (!raw) return 20;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
})();

// ----- Webhook emitter (Wave E2) -----
// HMAC-SHA256 signed POSTs go out via `src/services/webhookEmitter.ts`. When
// `WEBHOOK_URL` is unset the emitter is a no-op; when `WEBHOOK_SECRET` is
// unset we still POST but warn loudly (recipients should reject unsigned).
// The values are read directly from `process.env` inside the emitter so the
// tests can mutate them without reloading the config module.
export const WEBHOOK_URL: string | undefined = process.env.WEBHOOK_URL;
export const WEBHOOK_SECRET: string | undefined = process.env.WEBHOOK_SECRET;
export const WEBHOOK_TIMEOUT_MS: number = (() => {
  const raw = process.env.WEBHOOK_TIMEOUT_MS;
  if (!raw) return 5_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5_000;
})();

// ----- Stylus health check (Wave F) -----
// Per `09_arbitrum_technical_deep_dive.md` section 5.12 Stylus programs
// expire after ~1 year and revert with `ProgramNotActivated()` until
// reactivated. The weekly cron in `src/workers/stylusHealthCheck.ts` reads
// `ArbWasm.programInitGas` against the configured margin engine address;
// on revert it fires the `stylus_reactivation_required` webhook. Operators
// can lower the cadence in test environments via the env override.
export const STYLUS_HEALTH_CHECK_CRON: string =
  process.env.STYLUS_HEALTH_CHECK_CRON || '0 0 * * 0';

// ----- LangSmith tracing (Wave F) -----
// LangChain auto-instruments when `LANGCHAIN_TRACING_V2=true` and an API
// key are present. We surface the values here so `getLangSmithStatus()` can
// answer the `/health` probe without re-reading `process.env` per request.
// SECURITY: never log `LANGCHAIN_API_KEY` directly; the status helper only
// reports `enabled: boolean` + `project` (the project slug is non-sensitive).
export const LANGCHAIN_TRACING_V2: boolean = parseBool(
  process.env.LANGCHAIN_TRACING_V2,
  false,
);
export const LANGCHAIN_API_KEY: string | undefined = process.env.LANGCHAIN_API_KEY;
export const LANGCHAIN_PROJECT: string = process.env.LANGCHAIN_PROJECT || 'primeagent';

// ----- Error Log Configuration -----
export const ERROR_LOG_MAX_RECORDS: number = 10000;
export const ERROR_LOG_CLEANUP_INTERVAL: string = '0 * * * *'; // Every hour

// Export all as default object for convenience
export default {
  APP_PORT,
  NODE_ENV,
  IS_DEV,
  IS_PROD,
  DATABASE_URL,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  PUBLIC_ORIGIN,
  MCP_PROTOCOL_VERSION,
  GROQ_API_KEY,
  GROQ_MODEL_DEFAULT,
  ARB_SEPOLIA_RPC,
  RH_CHAIN_RPC,
  BACKEND_ATTESTOR_PRIVATE_KEY,
  BACKEND_ATTESTOR_ADDRESS_ARB_SEPOLIA,
  BACKEND_ATTESTOR_ADDRESS_RH_CHAIN,
  BACKEND_PRICE_ORACLE_ADDRESS_ARB_SEPOLIA,
  BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA,
  BACKEND_DIAMOND_ADDRESS_ARB_SEPOLIA,
  BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA,
  BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA,
  BACKEND_EMERGENCY_SHUTDOWN_ADDRESS_ARB_SEPOLIA,
  BACKEND_CALL_POLICY_VALIDATOR_ADDRESS_ARB_SEPOLIA,
  BACKEND_PRICE_SIGNER_KEYS,
  BACKEND_TOKEN_ENC_KEY,
  BACKEND_TOKEN_ENC_KEY_NEXT,
  ROBINHOOD_USE_LIVE,
  ROBINHOOD_USE_DCR,
  ROBINHOOD_CLIENT_ID,
  ROBINHOOD_CLIENT_SECRET,
  ROBINHOOD_MCP_URL,
  ROBINHOOD_AUTHORIZE_URL,
  ROBINHOOD_TOKEN_URL,
  ROBINHOOD_DCR_URL,
  BACKEND_PIMLICO_RH_CHAIN_URL,
  BACKEND_PAYMASTER_RELAY_ADDRESS_ARB_SEPOLIA,
  BACKEND_PAYMASTER_PRIVATE_KEY,
  ROBINHOOD_REQUIRED_SCOPE,
  LOG_LEVEL,
  ATTEST_PRIORITY_TIP_WEI,
  ATTEST_PRIORITY_TIP_WEI_FLOOR,
  BACKEND_MARGIN_ENGINE_ADDRESS_ARB_SEPOLIA,
  BACKEND_INDEXER_FROM_BLOCK_ARB_SEPOLIA,
  BACKEND_INDEXER_FROM_BLOCK_RH_CHAIN,
  BACKEND_WS_RPC_ARB_SEPOLIA,
  BACKEND_WS_RPC_RH_CHAIN,
  ROBINHOOD_MULTI_TENANT,
  ROBINHOOD_POLL_INTERVAL_MS,
  MCP_POOL_MAX,
  CIRCUIT_BREAKER_ENABLED,
  CIRCUIT_BREAKER_DRAWDOWN_BPS,
  CIRCUIT_BREAKER_TICK_ERROR_THRESHOLD,
  CIRCUIT_BREAKER_ACTION_RATE_THRESHOLD,
  WEBHOOK_URL,
  WEBHOOK_SECRET,
  WEBHOOK_TIMEOUT_MS,
  STYLUS_HEALTH_CHECK_CRON,
  LANGCHAIN_TRACING_V2,
  LANGCHAIN_API_KEY,
  LANGCHAIN_PROJECT,
  ERROR_LOG_MAX_RECORDS,
  ERROR_LOG_CLEANUP_INTERVAL,
};
