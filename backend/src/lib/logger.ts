/**
 * Structured logger for the PrimeAgent backend.
 *
 * Wave A: pino is the single source of truth for runtime logs across the
 * indexer, the cron workers, the tick loop, and the route handlers. The
 * field taxonomy is fixed (see `LogFields`) so downstream log shippers
 * (Loki / Datadog) can index on a stable schema. Adding a new field is a
 * conscious decision: extend the interface here first, then use it.
 *
 * Why pino: it is the fastest production-grade Node logger, has a clean
 * child-logger model (`logger.child({ svc })`), and pairs with
 * `pino-pretty` for human-friendly local output. Bun runs pino out of the
 * box; no shimming required.
 *
 * SECURITY: never log full bearer tokens, refresh tokens, OAuth code
 * verifiers, or private keys. Truncate sensitive values to 6 chars plus
 * `...` at the call site (consistent with the existing attestor.ts pattern).
 *
 * Resilience: if `pino` is not installed (operator forgot to run
 * `bun install` after Wave A bumped package.json) the module falls back to
 * a console-backed shim with the same shape. This guarantees the rest of
 * the surface still boots and the test suite still runs. The fallback is
 * loud about its presence in dev so it does not silently mask a missing
 * production install.
 */

// Read env directly (NOT via main-config) so the logger remains available
// even when main-config has been mocked out by a unit test or fails its
// fatal-exit guard. A misbehaving config module must never silence logs.
const LOG_LEVEL: string =
  process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
const IS_DEV: boolean = (process.env.NODE_ENV ?? 'development') !== 'production';

/**
 * Fixed taxonomy of structured fields. Every log line emits a subset of
 * these; values outside the taxonomy should be wrapped under a single
 * `data` field rather than added here ad-hoc. This is enforced by
 * TypeScript at call sites.
 *
 * Field naming follows snake_case for transport-level fields (`mcp_session_id`)
 * and camelCase for app-level identifiers (`tokenId`, `kernelAddr`) so the
 * shape lines up with on-chain and protocol conventions.
 */
export interface LogFields {
  // identity / routing
  svc?:
    | 'indexer'
    | 'attestPoster'
    | 'priceOraclePoster'
    | 'tickLoop'
    | 'agentRoute'
    | 'agentChat'
    | 'oauth'
    | 'siwe'
    | 'boot'
    | 'mcp'
    | 'tokenRefresher'
    | 'errorLogCleanup'
    | 'siweNonceCleanup'
    | 'marginEngine'
    | 'actionLog'
    | 'webhook'
    | 'circuitBreaker'
    | 'opsRoute'
    | 'arbSys'
    | 'stylusHealthCheck'
    | 'idempotency'
    | 'langsmith'
    | 'rhSwapPlanner'
    | 'rhChainSwapExecutor'
    | 'rhChainRoutes'
    | 'riskPresets'
    | 'policyPreview'
    | 'agentPolicy'
    | 'agentFleet'
    | 'varOnchain'
    | 'reputationFeedback'
    | 'drill'
    | 'strategyArm'
    | 'strategyExecutor'
    | 'strategyPreflight'
    | 'triggerWatcher'
    | 'fleetCoordination'
    | 'simulator'
    | 'pricePointIndexer'
    | 'fxProviders'
    | 'fxCache'
    | 'fxRoutes'
    | 'agentStrategy'
    | 'agentSimulator'
    | 'agentAudit'
    | 'auditPdf'
    | 'dssMemo';
  chainId?: number;
  tokenId?: string | bigint;
  agentId?: string | bigint;
  kernelAddr?: string;
  vaultAddr?: string;

  // tx / block
  txHash?: string;
  userOpHash?: string;
  blockNumber?: string | bigint;
  logIndex?: number;

  // MCP + Robinhood
  mcp_session_id?: string;
  rh_tool?: string;
  rh_status?: string;
  rh_latency_ms?: number;

  // attestation + oracle
  attestation_nullifier?: string;
  oracle_signers?: number;

  // paymaster + tick loop
  paymaster_policy_id?: string;
  tick_duration_ms?: number;

  // error envelope
  err_code?: string;
  err_class?: string;

  // generic structured payload (free-form)
  data?: Record<string, unknown>;
}

/**
 * Minimal logger shape we depend on. pino's actual Logger interface is a
 * strict superset of this, so callers using `logger.child({ svc }).info(...)`
 * stay source-compatible across the real library and the fallback shim.
 */
export interface Logger {
  level: string;
  trace: (objOrMsg: unknown, msg?: string) => void;
  debug: (objOrMsg: unknown, msg?: string) => void;
  info: (objOrMsg: unknown, msg?: string) => void;
  warn: (objOrMsg: unknown, msg?: string) => void;
  error: (objOrMsg: unknown, msg?: string) => void;
  fatal: (objOrMsg: unknown, msg?: string) => void;
  child: (bindings: Record<string, unknown>) => Logger;
}

const LEVELS: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function makeFallback(bindings: Record<string, unknown> = {}, level: string = LOG_LEVEL): Logger {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const stringify = (v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
  const flatten = (obj: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = stringify(v);
    return out;
  };

  const emit = (lvl: keyof typeof LEVELS, objOrMsg: unknown, msg?: string): void => {
    if ((LEVELS[lvl] ?? 0) < threshold) return;
    const ts = new Date().toISOString();
    let payload: Record<string, unknown>;
    let message: string | undefined;
    if (typeof objOrMsg === 'string') {
      payload = { ...bindings };
      message = objOrMsg;
    } else if (objOrMsg && typeof objOrMsg === 'object') {
      payload = { ...bindings, ...flatten(objOrMsg as Record<string, unknown>) };
      message = msg;
    } else {
      payload = { ...bindings };
      message = msg ?? String(objOrMsg);
    }
    const line = JSON.stringify({ level: lvl, ts, msg: message, ...flatten(payload) });
    if (lvl === 'error' || lvl === 'fatal') {
      console.error(line);
    } else {
      console.log(line);
    }
  };

  const logger: Logger = {
    level,
    trace: (o, m) => emit('trace', o, m),
    debug: (o, m) => emit('debug', o, m),
    info: (o, m) => emit('info', o, m),
    warn: (o, m) => emit('warn', o, m),
    error: (o, m) => emit('error', o, m),
    fatal: (o, m) => emit('fatal', o, m),
    child: (b) => makeFallback({ ...bindings, ...b }, level),
  };
  return logger;
}

/**
 * Resolve pino via Bun-native ESM `import()`. The previous `eval('require')`
 * trick returned `null` under Bun's ESM runtime (no global `require`), which
 * silently degraded the logger to the console shim even when pino was
 * installed. Top-level await on `import()` is the supported Bun + ESM
 * pattern; the wider codebase imports `./logger.ts` synchronously, and TLA
 * blocks the module graph at the import edge so consumers still see a fully
 * initialised `Logger`.
 */
async function tryDynamicImportPino(): Promise<Logger | null> {
  try {
    const pinoMod = (await import('pino')) as
      | { default?: (opts: unknown) => Logger }
      | ((opts: unknown) => Logger);
    const factory =
      (typeof pinoMod === 'function'
        ? pinoMod
        : (pinoMod as { default?: (opts: unknown) => Logger }).default) ??
      undefined;
    if (typeof factory !== 'function') return null;
    return factory({
      level: LOG_LEVEL,
      formatters: {
        log: (obj: Record<string, unknown>) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(obj)) {
            out[k] = typeof v === 'bigint' ? v.toString() : v;
          }
          return out;
        },
      },
      transport: IS_DEV
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
    });
  } catch {
    return null;
  }
}

const realPino = await tryDynamicImportPino();
const baseLogger: Logger = realPino ?? makeFallback();

if (!realPino && IS_DEV) {
  // Loud once so the operator notices the missing dep. The shim is fine for
  // tests but production should always use pino proper.
  console.error(
    '[logger] pino not installed; using console fallback. Run `bun install` to enable structured logging.',
  );
}

/**
 * Default logger. Prefer `forSvc(...)` over importing this directly so the
 * `svc` field is always present on the resulting line.
 */
export const logger: Logger = baseLogger;

/**
 * Returns a child logger with the `svc` field bound. Use one per worker /
 * route group so every log line is filterable by service in Loki / Datadog.
 */
export function forSvc(svc: NonNullable<LogFields['svc']>): Logger {
  return baseLogger.child({ svc });
}

/**
 * Convenience: build a typed log payload. TypeScript will reject unknown
 * fields, which is the whole point of the taxonomy.
 *
 * Usage:
 *   log.info(fields({ tokenId: 1n, txHash: '0x...' }), 'attestation posted');
 */
export function fields(f: LogFields): LogFields {
  return f;
}

export default logger;
