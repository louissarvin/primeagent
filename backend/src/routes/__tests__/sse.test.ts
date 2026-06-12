/**
 * Unit tests for the SSE writer. Mocks `reply.hijack()` and the raw socket
 * with a writable PassThrough; verifies headers, heartbeat, formatting,
 * backpressure, and close lifecycle.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { bigintReplacer, openSseStream } from '../sse.ts';

interface MockSocket {
  raw: PassThrough & {
    writeHead: (status: number, headers: Record<string, string>) => void;
    headers?: { status: number; values: Record<string, string> };
    writableLength: number;
    writableEnded: boolean;
  };
  reply: FastifyReply;
  request: FastifyRequest;
}

function makeMockSocket(): MockSocket {
  // PassThrough's writableLength is a real getter; we override it with a
  // settable shadow so the test can force backpressure on demand.
  const raw = new PassThrough() as PassThrough & {
    writeHead: (status: number, headers: Record<string, string>) => void;
    headers?: { status: number; values: Record<string, string> };
    writableLength: number;
    writableEnded: boolean;
  };

  raw.writeHead = (status, headers) => {
    raw.headers = { status, values: headers };
  };

  // Shadow getter for writableLength. PassThrough's real one cannot be
  // inspected through a method call, so we just default to 0 (PassThrough
  // drains immediately into its internal queue, and we are reading via
  // .read() between assertions anyway). Tests can force a value to
  // simulate backpressure.
  let forced: number = 0;
  Object.defineProperty(raw, 'writableLength', {
    configurable: true,
    get(): number {
      return forced;
    },
    set(v: number) {
      forced = v;
    },
  });

  const reply = {
    hijack: () => {
      /* no-op for the test */
    },
    raw,
  } as unknown as FastifyReply;

  const request = { url: '/test' } as unknown as FastifyRequest;
  return { raw, reply, request };
}

function readAllBuffered(raw: PassThrough): string {
  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  // PassThrough holds the unread data; drain it now.
  while ((chunk = raw.read() as Buffer | null) !== null) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('bigintReplacer', () => {
  test('converts bigint to decimal string', () => {
    const json = JSON.stringify({ a: 42n, b: 'x' }, bigintReplacer);
    expect(json).toBe('{"a":"42","b":"x"}');
  });
});

describe('openSseStream', () => {
  let now = 0;
  const realDateNow = Date.now;

  beforeEach(() => {
    now = 1_700_000_000_000;
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  test('writes SSE headers and initial connected event', async () => {
    const { raw, reply, request } = makeMockSocket();
    const conn = await openSseStream(request, reply, { heartbeatMs: 1_000_000 });

    expect(raw.headers?.status).toBe(200);
    expect(raw.headers?.values['Content-Type']).toContain('text/event-stream');
    expect(raw.headers?.values['Cache-Control']).toBe('no-store');
    expect(raw.headers?.values['Connection']).toBe('keep-alive');
    expect(raw.headers?.values['X-Accel-Buffering']).toBe('no');

    const out = readAllBuffered(raw);
    expect(out).toContain('event: connected');
    expect(out).toContain('"ts":');

    conn.close('test-end');
  });

  test('write formats id + event + data with a blank-line terminator', async () => {
    const { raw, reply, request } = makeMockSocket();
    const conn = await openSseStream(request, reply, { heartbeatMs: 1_000_000 });
    readAllBuffered(raw); // drain the connected event

    const ok = conn.write('snapshot', { tokenId: 42n, ts: 1 }, 7);
    expect(ok).toBe(true);

    const out = readAllBuffered(raw);
    expect(out).toContain('id: 7');
    expect(out).toContain('event: snapshot');
    expect(out).toContain('"tokenId":"42"');
    expect(out.endsWith('\n\n')).toBe(true);

    conn.close('test-end');
  });

  test('heartbeat fires after heartbeatMs and writes a comment line', async () => {
    const { raw, reply, request } = makeMockSocket();
    const conn = await openSseStream(request, reply, { heartbeatMs: 30 });
    readAllBuffered(raw); // drain connected

    await new Promise((r) => setTimeout(r, 80));
    const out = readAllBuffered(raw);
    expect(out).toContain(': ping');

    conn.close('test-end');
  });

  test('backpressure: high writableLength queues events and emits summary', async () => {
    const { raw, reply, request } = makeMockSocket();
    const conn = await openSseStream(request, reply, { heartbeatMs: 1_000_000 });
    readAllBuffered(raw);

    // Force backpressure.
    (raw as unknown as { writableLength: number }).writableLength = 2_000_000;

    // Overrun the queue cap (50) plus a few so we generate a non-zero
    // dropped count.
    for (let i = 0; i < 60; i++) {
      conn.write('snapshot', { i }, i);
    }

    const out = readAllBuffered(raw);
    expect(out).toContain('event: backpressure');
    expect(out).toContain('"dropped":');

    conn.close('test-end');
  });

  test('onClose fires when the raw socket emits close', async () => {
    const { raw, reply, request } = makeMockSocket();
    const captured: { reason: string | null } = { reason: null };
    const conn = await openSseStream(request, reply, {
      heartbeatMs: 1_000_000,
      onClose: (r) => {
        captured.reason = r;
      },
    });
    readAllBuffered(raw);

    raw.emit('close');
    expect(captured.reason).toBe('client-closed');

    // Subsequent writes should no-op once closed.
    const second = conn.write('snapshot', { tokenId: 1n });
    expect(second).toBe(false);
  });
});
