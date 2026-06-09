/**
 * Outbound webhook emitter (Wave E2).
 *
 * Per the spec section 10 risk callbacks pattern: every critical agent
 * lifecycle and risk event is POSTed to an operator-configured webhook
 * URL with an HMAC-SHA256 signature so the recipient can authenticate
 * the call without a per-recipient secret exchange.
 *
 * Surface:
 *   - `emit(event, payload)`        - queue a webhook delivery; non-blocking.
 *   - `startWebhookEmitter()`       - mount; idempotent.
 *   - `stopWebhookEmitter()`        - graceful shutdown; flush in-flight.
 *
 * Body shape (canonical):
 *   {
 *     event: string,
 *     tokenId: string,
 *     chainId: number,
 *     ts: number,         // unix seconds
 *     data: unknown,
 *     version: '1',
 *     signature: '0x...'  // HMAC-SHA256(secret, canonical(body \ signature))
 *   }
 *
 * Retry policy: 3 attempts with backoff `1s, 4s, 16s`. 4xx => give up
 * (the recipient considers the payload bad and another retry will not
 * help). 5xx / network error => retry. Each attempt logs structured
 * `{ webhook_event, webhook_status, attempt, duration_ms }`.
 *
 * Concurrency: a single FIFO queue is drained serially via `setImmediate`
 * so a slow recipient never stalls the runtime tick. The queue is bounded
 * at `MAX_QUEUE_SIZE` (1_000). Past that, the OLDEST entry is dropped
 * with a `webhook_queue_drop_total` metric.
 *
 * When `WEBHOOK_URL` is unset, `emit` is a no-op (graceful boot in dev).
 * When `WEBHOOK_SECRET` is unset we still POST but mark the signature
 * as `0x` and log a warn-once. The recipient should reject unsigned
 * payloads in production deployments.
 */

import { createHmac, randomUUID } from 'node:crypto';

import { canonicalize } from '../lib/json.ts';
import { forSvc } from '../lib/logger.ts';
import { increment, observe } from '../lib/metrics.ts';

const log = forSvc('webhook');

export type WebhookEventName =
  | 'agent_started'
  | 'agent_paused'
  | 'agent_resumed'
  | 'agent_stopped'
  | 'margin_call_triggered'
  | 'liquidation_detected'
  | 'policy_revoked'
  | 'circuit_breaker_tripped'
  | 'stylus_reactivation_required';

interface QueuedDelivery {
  id: string;
  event: WebhookEventName;
  tokenId: string;
  chainId: number;
  ts: number;
  data: unknown;
}

const MAX_QUEUE_SIZE = 1_000;
const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];
const VERSION = '1';

const queue: QueuedDelivery[] = [];
let draining = false;
let started = false;
let warnedMissingUrl = false;
let warnedMissingSecret = false;

function readEnv(): { url: string | undefined; secret: string | undefined; timeoutMs: number } {
  const url = process.env.WEBHOOK_URL?.trim() || undefined;
  const secret = process.env.WEBHOOK_SECRET?.trim() || undefined;
  const raw = process.env.WEBHOOK_TIMEOUT_MS;
  let timeoutMs = 5_000;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) timeoutMs = Math.floor(n);
  }
  return { url, secret, timeoutMs };
}

/**
 * Build the canonical body and append the HMAC signature.
 */
function signBody(
  body: {
    event: WebhookEventName;
    tokenId: string;
    chainId: number;
    ts: number;
    data: unknown;
    version: string;
  },
  secret: string | undefined,
): { canonical: string; signature: string } {
  const canonical = canonicalize(body);
  if (!secret) {
    return { canonical, signature: '0x' };
  }
  const hex = createHmac('sha256', secret).update(canonical).digest('hex');
  return { canonical, signature: `0x${hex}` };
}

/**
 * Send a single delivery with retries. Returns true on success, false on
 * permanent failure. Never throws.
 */
async function send(delivery: QueuedDelivery): Promise<boolean> {
  const { url, secret, timeoutMs } = readEnv();
  if (!url) return false;
  if (!secret && !warnedMissingSecret) {
    warnedMissingSecret = true;
    log.warn(
      { data: { webhook_event: delivery.event } },
      'WEBHOOK_SECRET unset; sending unsigned webhook (recipients should reject in production)',
    );
  }

  const body = {
    event: delivery.event,
    tokenId: delivery.tokenId,
    chainId: delivery.chainId,
    ts: delivery.ts,
    data: delivery.data,
    version: VERSION,
  };
  const { canonical, signature } = signBody(body, secret);

  // The wire body is canonical + signature appended. We post the canonical
  // bytes (not Object.assign-ed) so the recipient can recompute the HMAC
  // by stripping the `signature` field from the parsed JSON.
  const parsed = JSON.parse(canonical) as Record<string, unknown>;
  parsed.signature = signature;
  const wireBody = JSON.stringify(parsed);

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    const start = Date.now();
    let status: number | string = 'network';
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-prime-agent-signature': signature,
            'x-prime-agent-event': delivery.event,
            'x-prime-agent-id': delivery.id,
          },
          body: wireBody,
          signal: controller.signal,
        });
        status = res.status;
        const duration = Date.now() - start;
        observe('webhook_duration_ms', duration);

        if (res.status >= 200 && res.status < 300) {
          increment('webhook_sent_total');
          log.info(
            {
              data: {
                webhook_event: delivery.event,
                webhook_status: res.status,
                attempt: attempt + 1,
                duration_ms: duration,
              },
            },
            'webhook delivered',
          );
          return true;
        }
        if (res.status >= 400 && res.status < 500) {
          // Permanent failure: do not retry on a 4xx.
          increment('webhook_failed_total');
          log.warn(
            {
              data: {
                webhook_event: delivery.event,
                webhook_status: res.status,
                attempt: attempt + 1,
                duration_ms: duration,
              },
            },
            'webhook 4xx; dropping',
          );
          return false;
        }
        // 5xx: retry
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      status = (err as Error)?.name ?? 'error';
      const duration = Date.now() - start;
      observe('webhook_duration_ms', duration);
      log.warn(
        {
          err_class: (err as Error)?.name,
          data: {
            webhook_event: delivery.event,
            webhook_status: status,
            attempt: attempt + 1,
            duration_ms: duration,
            msg: (err as Error)?.message,
          },
        },
        'webhook delivery threw',
      );
    }

    // Backoff before the next attempt.
    if (attempt < RETRY_DELAYS_MS.length - 1) {
      const delay = RETRY_DELAYS_MS[attempt] ?? 1_000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  increment('webhook_failed_total');
  log.error(
    { data: { webhook_event: delivery.event, attempts: RETRY_DELAYS_MS.length } },
    'webhook delivery exhausted retries',
  );
  return false;
}

function scheduleDrain(): void {
  if (draining) return;
  if (queue.length === 0) return;
  draining = true;
  setImmediate(async () => {
    try {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        await send(next);
      }
    } finally {
      draining = false;
    }
  });
}

/**
 * Enqueue a webhook delivery. Non-blocking. When `WEBHOOK_URL` is unset
 * this is a no-op (counter still bumped so dashboards see the call).
 */
export function emit(
  event: WebhookEventName,
  payload: { tokenId: bigint | string; chainId?: number; data?: unknown },
): void {
  const { url } = readEnv();
  if (!url) {
    if (!warnedMissingUrl) {
      warnedMissingUrl = true;
      log.info(
        { data: { webhook_event: event } },
        'WEBHOOK_URL unset; webhook emitter in no-op mode',
      );
    }
    increment('webhook_skipped_total');
    return;
  }

  const tokenIdStr =
    typeof payload.tokenId === 'bigint'
      ? payload.tokenId.toString()
      : String(payload.tokenId);

  const delivery: QueuedDelivery = {
    id: randomUUID(),
    event,
    tokenId: tokenIdStr,
    chainId: payload.chainId ?? 421614,
    ts: Math.floor(Date.now() / 1000),
    data: payload.data ?? {},
  };

  queue.push(delivery);
  increment('webhook_enqueued_total');
  if (queue.length > MAX_QUEUE_SIZE) {
    const dropped = queue.length - MAX_QUEUE_SIZE;
    queue.splice(0, dropped);
    increment('webhook_queue_drop_total', dropped);
    log.warn(
      { data: { dropped, queue_size: queue.length } },
      'webhook queue full; dropping oldest entries',
    );
  }
  scheduleDrain();
}

/**
 * Mount the emitter. Today this is a no-op (the queue drains on `emit`);
 * we keep the start/stop surface so the index.ts boot order matches
 * other workers.
 */
export function startWebhookEmitter(): void {
  if (started) return;
  started = true;
  const { url, secret } = readEnv();
  log.info(
    {
      data: {
        webhook_url_configured: Boolean(url),
        webhook_secret_configured: Boolean(secret),
      },
    },
    'webhook emitter started',
  );
}

export async function stopWebhookEmitter(): Promise<void> {
  // Drain anything currently queued. The fetch calls inside `send` honour
  // their own timeouts so this won't hang indefinitely.
  while (queue.length > 0 || draining) {
    if (!draining) scheduleDrain();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  started = false;
}

/**
 * Test-only inspection. Production code MUST NOT use this.
 */
export const __internal = {
  queueSize(): number {
    return queue.length;
  },
  reset(): void {
    queue.length = 0;
    draining = false;
    started = false;
    warnedMissingUrl = false;
    warnedMissingSecret = false;
  },
  send,
  signBody,
  RETRY_DELAYS_MS,
  MAX_QUEUE_SIZE,
};
