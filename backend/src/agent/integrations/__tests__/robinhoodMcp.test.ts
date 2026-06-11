import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Required env BEFORE main-config import.
process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

describe('getRobinhoodLangchainTools (stub mode)', () => {
  beforeEach(async () => {
    await mock.module('../../../config/main-config.ts', () => ({
      ROBINHOOD_USE_LIVE: false,
      ROBINHOOD_MCP_URL: 'https://example.test/mcp',
      ROBINHOOD_USE_DCR: false,
      ROBINHOOD_CLIENT_ID: 'unused',
      ROBINHOOD_AUTHORIZE_URL: 'https://example.test/authorize',
      ROBINHOOD_TOKEN_URL: 'https://example.test/token',
      ROBINHOOD_DCR_URL: 'https://example.test/register',
    }));
    await mock.module('../../../lib/prisma.ts', () => ({ prismaQuery: {} }));
  });

  test('returns at least the get_portfolio, get_equity_positions, place_equity_order tools', async () => {
    const { getRobinhoodLangchainTools } = await import('../robinhoodMcp.ts');
    const tools = await getRobinhoodLangchainTools('demo-user', 'demo-acct');
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_portfolio');
    expect(names).toContain('get_equity_positions');
    expect(names).toContain('place_equity_order');
    expect(tools.length).toBeGreaterThanOrEqual(3);
  });

  test('place_equity_order stub returns a deterministic order id', async () => {
    const { getRobinhoodLangchainTools } = await import('../robinhoodMcp.ts');
    const tools = await getRobinhoodLangchainTools('demo-user', 'demo-acct');
    const place = tools.find((t) => t.name === 'place_equity_order');
    expect(place).toBeDefined();
    const result = await place!.invoke({ symbol: 'TSLA', side: 'buy', quantity: 1 });
    const parsed = JSON.parse(String(result)) as { order_id: string; status: string };
    expect(parsed.order_id.startsWith('stub_ord_TSLA_buy_')).toBe(true);
    expect(parsed.status).toBe('queued');
  });

  test('get_portfolio stub returns bigint-stringified fields from the fixture', async () => {
    const { getRobinhoodLangchainTools } = await import('../robinhoodMcp.ts');
    const tools = await getRobinhoodLangchainTools('demo-user', 'demo-acct');
    const portfolio = tools.find((t) => t.name === 'get_portfolio');
    const result = await portfolio!.invoke({});
    const parsed = JSON.parse(String(result)) as {
      account_id: string;
      account_value_cents: string;
      buying_power_cents: string;
    };
    expect(parsed.account_id).toBe('demo-acct');
    // Fixture values; aligned with mcp/client.test.ts
    expect(parsed.account_value_cents).toBe('2750000');
    expect(parsed.buying_power_cents).toBe('1200000');
  });
});
