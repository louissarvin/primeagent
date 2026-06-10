import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Ensure required env is present BEFORE main-config import.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.BACKEND_JWT_SECRET ??= 'test-secret-for-unit-tests-only';

describe('mcp/client.fetchAccountState (stub mode)', () => {
  beforeEach(async () => {
    await mock.module('../../config/main-config.ts', () => ({
      ROBINHOOD_USE_LIVE: false,
      ROBINHOOD_MCP_URL: 'https://example.test/mcp',
      ROBINHOOD_USE_DCR: false,
      ROBINHOOD_CLIENT_ID: 'unused',
      ROBINHOOD_AUTHORIZE_URL: 'https://example.test/authorize',
      ROBINHOOD_TOKEN_URL: 'https://example.test/token',
      ROBINHOOD_DCR_URL: 'https://example.test/register',
    }));
    await mock.module('../../lib/prisma.ts', () => ({ prismaQuery: {} }));
  });

  test('returns fixture-shaped OffChainState with bigint cents fields', async () => {
    const { fetchAccountState } = await import('../client.ts');
    const state = await fetchAccountState({ userId: 'demo-user', accountId: 'demo-acct' });

    expect(state.account_id).toBe('demo-acct');
    expect(typeof state.account_value_cents).toBe('bigint');
    expect(typeof state.buying_power_cents).toBe('bigint');
    expect(state.account_value_cents).toBe(2_750_000n);
    expect(state.buying_power_cents).toBe(1_200_000n);

    expect(Array.isArray(state.positions)).toBe(true);
    expect(state.positions.length).toBe(2);
    for (const p of state.positions) {
      expect(typeof p.symbol).toBe('string');
      expect(typeof p.qty).toBe('number');
      expect(typeof p.mark_cents).toBe('bigint');
    }

    expect(typeof state.ts).toBe('number');
  });
});
