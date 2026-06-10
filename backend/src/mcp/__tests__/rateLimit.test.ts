import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

// Required env BEFORE main-config import.
process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

/**
 * Minimal McpClient stub. Each test sets `mockCallTool` per case.
 */
function makeClient(callTool: (args: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>) {
  return { callTool } as unknown as import('@modelcontextprotocol/sdk/client/index.js').Client;
}

describe('callToolWithBackoff', () => {
  beforeEach(async () => {
    const mod = await import('../rateLimit.ts');
    // Speed up tests by collapsing sleeps to no-ops.
    mod.__setSleeper(async () => {});
    // Deterministic jitter.
    mod.__setJitterSource(() => 0);
  });

  afterEach(async () => {
    const mod = await import('../rateLimit.ts');
    mod.__setSleeper(null);
    mod.__setJitterSource(null);
  });

  test('happy path: returns the result on first call', async () => {
    const { callToolWithBackoff } = await import('../rateLimit.ts');
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const result = await callToolWithBackoff(client, 'noop', {}, {
      toolName: 'noop',
      userId: 'u',
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  test('429 once then succeeds; one retry', async () => {
    const { callToolWithBackoff } = await import('../rateLimit.ts');
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('Too Many Requests') as Error & { status: number };
        err.status = 429;
        throw err;
      }
      return { content: [{ type: 'text', text: 'second-ok' }] };
    });
    const result = await callToolWithBackoff(client, 'flaky', {}, {
      toolName: 'flaky',
      userId: 'u',
    });
    expect(calls).toBe(2);
    expect(result).toEqual({ content: [{ type: 'text', text: 'second-ok' }] });
  });

  test('429 exhausted: throws RateLimitExhausted after MAX_ATTEMPTS', async () => {
    const { callToolWithBackoff, RateLimitExhausted, __internal } = await import('../rateLimit.ts');
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      const err = new Error('Too Many Requests') as Error & { status: number };
      err.status = 429;
      throw err;
    });

    await expect(
      callToolWithBackoff(client, 'stuck', {}, { toolName: 'stuck', userId: 'u' }),
    ).rejects.toBeInstanceOf(RateLimitExhausted);
    expect(calls).toBe(__internal.MAX_ATTEMPTS);
  });

  test('non-429 error propagates immediately without retry', async () => {
    const { callToolWithBackoff } = await import('../rateLimit.ts');
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      throw new Error('boom');
    });
    await expect(
      callToolWithBackoff(client, 'boom', {}, { toolName: 'boom', userId: 'u' }),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  test('backoff is bounded by MAX_DELAY_MS', async () => {
    const { __internal } = await import('../rateLimit.ts');
    // attempt=20 would explode without the cap; verify clamping.
    const big = __internal.backoffMs(20);
    expect(big).toBeLessThanOrEqual(__internal.MAX_DELAY_MS);
    // attempt=0 base ~250 ms.
    const small = __internal.backoffMs(0);
    expect(small).toBeGreaterThanOrEqual(__internal.BASE_DELAY_MS);
  });

  test('captures mcpSessionId from response _meta.session_id', async () => {
    const { callToolWithBackoff } = await import('../rateLimit.ts');
    const client = makeClient(async () => ({
      _meta: { session_id: 'sess-abc-123' },
      content: [{ type: 'text', text: 'ok' }],
    }));
    const ctx = { toolName: 'sid', userId: 'u' } as { toolName: string; userId: string; mcpSessionId?: string };
    await callToolWithBackoff(client, 'sid', {}, ctx);
    expect(ctx.mcpSessionId).toBe('sess-abc-123');
  });

  test('isRateLimitError recognises status:429, code:429, and message text', async () => {
    const { __internal } = await import('../rateLimit.ts');
    expect(__internal.isRateLimitError({ status: 429 })).toBe(true);
    expect(__internal.isRateLimitError({ code: 429 })).toBe(true);
    expect(__internal.isRateLimitError({ message: '429 Too Many Requests' })).toBe(true);
    expect(__internal.isRateLimitError({ message: 'rate-limit exceeded' })).toBe(true);
    expect(__internal.isRateLimitError(new Error('boom'))).toBe(false);
    expect(__internal.isRateLimitError(null)).toBe(false);
  });
});
