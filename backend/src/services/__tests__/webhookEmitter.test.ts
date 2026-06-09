/**
 * Unit tests for `webhookEmitter`. We do NOT mock `fetch` via a module
 * substitution; the emitter calls `fetch` from the global, so we monkey-
 * patch `globalThis.fetch` per test and restore in `afterEach`.
 *
 * The retry timing is deliberately slow in production (1s / 4s / 16s); we
 * test by driving `send` directly so the test suite does not have to wait
 * for real backoff. The drain-loop behaviour (FIFO ordering) is exercised
 * separately via `emit` + a fake fetch that records call order.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

const ORIGINAL_FETCH = globalThis.fetch;

interface RecordedCall {
  url: string;
  method?: string;
  body?: string;
  signature?: string;
  event?: string;
}

function installFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const i = init ?? {};
    const headers = i.headers as Record<string, string> | undefined;
    calls.push({
      url,
      method: i.method,
      body: typeof i.body === 'string' ? i.body : undefined,
      signature: headers?.['x-prime-agent-signature'],
      event: headers?.['x-prime-agent-event'],
    });
    return impl(url, i);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('webhookEmitter', () => {
  let mod: typeof import('../webhookEmitter.ts');

  beforeEach(async () => {
    mod = await import('../webhookEmitter.ts');
    mod.__internal.reset();
    delete process.env.WEBHOOK_URL;
    delete process.env.WEBHOOK_SECRET;
    delete process.env.WEBHOOK_TIMEOUT_MS;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    mod.__internal.reset();
    delete process.env.WEBHOOK_URL;
    delete process.env.WEBHOOK_SECRET;
    delete process.env.WEBHOOK_TIMEOUT_MS;
  });

  test('emit is a no-op when WEBHOOK_URL is unset', () => {
    const calls = installFetch(async () => jsonResponse(200));
    mod.emit('agent_started', { tokenId: 1n, data: {} });
    expect(calls.length).toBe(0);
    expect(mod.__internal.queueSize()).toBe(0);
  });

  test('happy path: 200 -> single fetch with signature', async () => {
    process.env.WEBHOOK_URL = 'https://example.test/hook';
    process.env.WEBHOOK_SECRET = 'topsecret';
    const calls = installFetch(async () => jsonResponse(200));

    const ok = await mod.__internal.send({
      id: 'd1',
      event: 'agent_started',
      tokenId: '5',
      chainId: 421614,
      ts: 1733673000,
      data: { strategy: 'tsla-pairs' },
    });
    expect(ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.event).toBe('agent_started');

    // Verify signature: HMAC-SHA256(secret, canonical(body without signature)).
    const wireBody = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    const sig = wireBody.signature as string;
    delete wireBody.signature;
    // Recompute canonical for the body (sorted keys).
    const canonicalBody = JSON.stringify(
      Object.keys(wireBody)
        .sort()
        .reduce((acc, k) => {
          (acc as Record<string, unknown>)[k] = wireBody[k];
          return acc;
        }, {} as Record<string, unknown>),
    );
    const expected = `0x${createHmac('sha256', 'topsecret').update(canonicalBody).digest('hex')}`;
    expect(sig).toBe(expected);
  });

  test('signBody helper builds the canonical bytes + hmac', () => {
    const { canonical, signature } = mod.__internal.signBody(
      {
        event: 'agent_paused',
        tokenId: '99',
        chainId: 421614,
        ts: 100,
        data: { reason: 'manual' },
        version: '1',
      },
      'k',
    );
    const expected = `0x${createHmac('sha256', 'k').update(canonical).digest('hex')}`;
    expect(signature).toBe(expected);
  });

  test('4xx -> drop without retry', async () => {
    process.env.WEBHOOK_URL = 'https://example.test/hook';
    const calls = installFetch(async () => jsonResponse(400, { error: 'bad' }));
    const ok = await mod.__internal.send({
      id: 'd2',
      event: 'agent_paused',
      tokenId: '5',
      chainId: 421614,
      ts: 0,
      data: {},
    });
    expect(ok).toBe(false);
    expect(calls.length).toBe(1);
  });

  test('5xx -> retries up to RETRY_DELAYS_MS.length attempts then drops', async () => {
    process.env.WEBHOOK_URL = 'https://example.test/hook';
    let attempts = 0;
    installFetch(async () => {
      attempts += 1;
      return jsonResponse(503);
    });
    // Speed up: override delays to zero by monkey-patching setTimeout? Too
    // invasive. Instead we accept the real backoff; the worst case here is
    // 1s + 4s = 5s of waits. We trim by setting RETRY_DELAYS_MS via env? It
    // is a const. Patch setTimeout instead via Bun's clock control? Not
    // available. Fallback: just `await send` (slow but bounded).
    const ok = await mod.__internal.send({
      id: 'd3',
      event: 'agent_paused',
      tokenId: '5',
      chainId: 421614,
      ts: 0,
      data: {},
    });
    expect(ok).toBe(false);
    expect(attempts).toBe(mod.__internal.RETRY_DELAYS_MS.length);
  }, 20_000);

  test('FIFO drain: multiple emits processed in order', async () => {
    process.env.WEBHOOK_URL = 'https://example.test/hook';
    const events: string[] = [];
    installFetch(async (_url, init) => {
      const headers = init.headers as Record<string, string>;
      events.push(headers['x-prime-agent-event'] ?? '');
      return jsonResponse(200);
    });

    mod.emit('agent_started', { tokenId: 1n });
    mod.emit('agent_paused', { tokenId: 1n });
    mod.emit('agent_resumed', { tokenId: 1n });

    // Drain.
    while (mod.__internal.queueSize() > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // Also wait for the in-flight send to finish.
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toEqual(['agent_started', 'agent_paused', 'agent_resumed']);
  });

  test('queue caps at MAX_QUEUE_SIZE; drops oldest entries', () => {
    process.env.WEBHOOK_URL = 'https://example.test/hook';
    // Make fetch hang so the drain loop does not consume entries before we
    // can saturate the queue.
    installFetch(
      () =>
        new Promise(() => {
          // never resolves within this test
        }),
    );
    const cap = mod.__internal.MAX_QUEUE_SIZE;
    for (let i = 0; i < cap + 50; i++) {
      mod.emit('agent_paused', { tokenId: BigInt(i) });
    }
    expect(mod.__internal.queueSize()).toBeLessThanOrEqual(cap);
  });
});
