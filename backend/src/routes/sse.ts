/**
 * Server-Sent Events writer used by `/api/agent/:tokenId/stream` and any
 * future SSE endpoint.
 *
 * Per backend/CLAUDE.md and PrimeAgent.md 11.3.bis:
 *   - Call `reply.hijack()` so Fastify stops trying to buffer the body.
 *   - Set the SSE headers on `reply.raw` directly.
 *   - Heartbeat every 15s with a comment line (`: ping`) so reverse proxies
 *     and load balancers do not idle-kill the connection (typical idle is
 *     30-60s, so 15s sits comfortably under).
 *   - Emit `id: <seq>` so the browser can resume via `Last-Event-ID` after a
 *     reconnect.
 *   - Apply backpressure: if `writableLength` exceeds ~1 MB, do not pile
 *     more events into the kernel buffer; collapse them into a single
 *     `backpressure` summary so the client knows it missed events.
 *
 * Errors after `hijack` cannot send a Fastify reply; the only options are
 * `reply.raw.end()` and a log line. The writer surfaces both via `close`.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { forSvc } from '../lib/logger.ts';
import { bigintReplacer as sharedBigintReplacer } from '../lib/json.ts';

const log = forSvc('agentRoute');

const DEFAULT_HEARTBEAT_MS = 15_000;
const HIGH_WATERMARK_BYTES = 1_000_000;
const BACKPRESSURE_QUEUE_CAP = 50;
const BACKPRESSURE_SUMMARY_MS = 5_000;

/**
 * Stable bigint JSON encoder. Fastify's default serializer throws on bigint
 * values; converting to a decimal string preserves precision for tokenIds
 * and Q96 values that exceed `Number.MAX_SAFE_INTEGER`.
 *
 * Wave E2: the canonical implementation moved to `src/lib/json.ts` so
 * non-route modules (action logger, webhook emitter) share the same
 * encoder. Preserved as a re-export here so existing callers compile.
 */
export const bigintReplacer = sharedBigintReplacer;

export interface SseConnection {
  /**
   * Write a named event with a structured payload. Returns `true` when the
   * event was written immediately, `false` when it was deferred to the
   * backpressure queue.
   */
  write(event: string, data: unknown, id?: number): boolean;
  /** Force-close the underlying socket and tear down timers. */
  close(reason: string): void;
}

export interface OpenSseStreamOpts {
  /** Called once when the underlying socket closes for any reason. */
  onClose?: (reason: string) => void;
  /** Heartbeat cadence in ms. Defaults to 15_000. */
  heartbeatMs?: number;
  /** Identifier surfaced in structured logs (defaults to the URL). */
  logContext?: Record<string, unknown>;
}

/**
 * Opens an SSE stream on the given Fastify reply. Hijacks the underlying
 * socket; the caller MUST NOT use `reply` for anything else after this
 * returns.
 */
export async function openSseStream(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: OpenSseStreamOpts = {},
): Promise<SseConnection> {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const logCtx = opts.logContext ?? { url: request.url };

  reply.hijack();
  const raw = reply.raw;

  // CORS headers must be set manually because `reply.hijack()` bypasses
  // Fastify's CORS plugin. Mirror the global plugin's allowlist:
  // `Access-Control-Allow-Origin: *` for dev; tighten to the frontend
  // origin allowlist for production.
  const origin = request.headers.origin;
  const allowOrigin = typeof origin === 'string' && origin.length > 0 ? origin : '*';

  // Headers per W3C EventSource and OWASP recommendation. `X-Accel-Buffering`
  // defeats nginx's default proxy buffering; `Cache-Control: no-store`
  // prevents intermediary caches from snapshotting the stream.
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, token, Last-Event-ID',
    Vary: 'Origin',
  });

  // Initial event so the client knows headers were flushed.
  raw.write(`event: connected\ndata: ${JSON.stringify({ ts: Math.floor(Date.now() / 1000) })}\n\n`);

  let closed = false;
  let droppedSinceLastSummary = 0;
  let lastSummaryAt = 0;
  const queue: Array<{ event: string; payload: string }> = [];

  const heartbeatTimer = setInterval(() => {
    if (closed) return;
    try {
      raw.write(': ping\n\n');
    } catch (err) {
      // raw.write can throw if the socket has been destroyed between events.
      log.warn(
        { ...logCtx, err_class: (err as Error)?.name },
        'sse heartbeat write failed; closing',
      );
      cleanup('heartbeat-write-failed');
    }
  }, heartbeatMs);

  // Defensive: prevent the timer from holding the event loop open during
  // graceful shutdown. The raw socket close handler will tear everything
  // else down.
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }

  function cleanup(reason: string): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatTimer);
    try {
      opts.onClose?.(reason);
    } catch (err) {
      log.error(
        { ...logCtx, err_class: (err as Error)?.name },
        'sse onClose handler threw',
      );
    }
    log.info({ ...logCtx, data: { reason } }, 'sse connection closed');
  }

  raw.on('close', () => cleanup('client-closed'));
  raw.on('error', (err) => {
    log.warn(
      { ...logCtx, err_class: (err as Error)?.name },
      'sse socket error',
    );
    cleanup('socket-error');
  });

  function format(event: string, data: unknown, id?: number): string {
    const lines: string[] = [];
    if (typeof id === 'number' && Number.isFinite(id)) {
      lines.push(`id: ${id}`);
    }
    lines.push(`event: ${event}`);
    lines.push(`data: ${JSON.stringify(data, bigintReplacer)}`);
    return `${lines.join('\n')}\n\n`;
  }

  function emitBackpressureSummary(): void {
    if (droppedSinceLastSummary === 0) return;
    const now = Date.now();
    if (now - lastSummaryAt < BACKPRESSURE_SUMMARY_MS) return;
    lastSummaryAt = now;
    try {
      raw.write(`event: backpressure\ndata: ${JSON.stringify({ dropped: droppedSinceLastSummary })}\n\n`);
      droppedSinceLastSummary = 0;
    } catch {
      // Socket is dying; let the close handler do its job.
    }
  }

  const connection: SseConnection = {
    write(event, data, id): boolean {
      if (closed) return false;

      // Backpressure: when the kernel buffer is large, drop the oldest
      // queued event and merge the count into a coalesced summary so we do
      // not OOM on a slow consumer. This keeps memory bounded under
      // sustained head-of-line blocking.
      if (raw.writableLength > HIGH_WATERMARK_BYTES) {
        queue.push({ event, payload: format(event, data, id) });
        if (queue.length > BACKPRESSURE_QUEUE_CAP) {
          queue.shift();
          droppedSinceLastSummary += 1;
        }
        emitBackpressureSummary();
        return false;
      }

      // Drain any queued events first so client ordering matches publish
      // order. We stop draining the moment the buffer climbs back over the
      // high watermark to avoid runaway writes.
      while (queue.length > 0 && raw.writableLength <= HIGH_WATERMARK_BYTES) {
        const next = queue.shift();
        if (!next) break;
        try {
          raw.write(next.payload);
        } catch {
          cleanup('drain-write-failed');
          return false;
        }
      }

      try {
        raw.write(format(event, data, id));
        return true;
      } catch (err) {
        log.warn(
          { ...logCtx, err_class: (err as Error)?.name },
          'sse write failed; closing',
        );
        cleanup('write-failed');
        return false;
      }
    },
    close(reason): void {
      cleanup(reason);
      try {
        if (!raw.writableEnded) raw.end();
      } catch {
        // already torn down
      }
    },
  };

  return connection;
}
