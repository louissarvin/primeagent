import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Required env BEFORE main-config import.
process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

const EXPECTED_TOOLS = [
  'get_portfolio',
  'get_equity_positions',
  'place_equity_order',
  'get_accounts',
  'get_equity_quotes',
  'get_equity_orders',
  'get_equity_tradability',
  'review_equity_order',
  'cancel_equity_order',
  'search',
];

describe('getRobinhoodLangchainTools (stub mode, 10-tool surface)', () => {
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

  test('stub bridge returns at least 10 tools with all expected names', async () => {
    const { getRobinhoodLangchainTools } = await import('../robinhoodMcp.ts');
    const tools = await getRobinhoodLangchainTools('demo-user', 'demo-acct');
    expect(tools.length).toBeGreaterThanOrEqual(10);
    const names = tools.map((t) => t.name);
    for (const expected of EXPECTED_TOOLS) {
      expect(names).toContain(expected);
    }
  });

  test('get_accounts returns the demo individual account', async () => {
    const { getRobinhoodLangchainTools } = await import('../robinhoodMcp.ts');
    const tools = await getRobinhoodLangchainTools('u', 'a');
    const t = tools.find((x) => x.name === 'get_accounts');
    expect(t).toBeDefined();
    const out = await t!.invoke({});
    const parsed = JSON.parse(String(out)) as Array<{ id: string; type: string; state: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]?.id).toBe('demo-acc');
    expect(parsed[0]?.state).toBe('active');
  });

  test('get_equity_quotes returns a quote per symbol with mark_price', async () => {
    const { getRobinhoodLangchainTools } = await import('../robinhoodMcp.ts');
    const tools = await getRobinhoodLangchainTools('u', 'a');
    const t = tools.find((x) => x.name === 'get_equity_quotes');
    const out = await t!.invoke({ symbols: ['TSLA', 'AMZN', 'AMD'] });
    const parsed = JSON.parse(String(out)) as {
      quotes: Array<{ symbol: string; mark_price: number; ask_price: number; bid_price: number }>;
    };
    expect(parsed.quotes.length).toBe(3);
    for (const q of parsed.quotes) {
      expect(typeof q.symbol).toBe('string');
      expect(typeof q.mark_price).toBe('number');
      expect(q.ask_price).toBeGreaterThan(q.bid_price);
    }
  });

  test('get_equity_orders returns empty list in stub mode', async () => {
    const { getRobinhoodLangchainTools } = await import('../robinhoodMcp.ts');
    const tools = await getRobinhoodLangchainTools('u', 'a');
    const t = tools.find((x) => x.name === 'get_equity_orders');
    const out = await t!.invoke({});
    const parsed = JSON.parse(String(out)) as { orders: unknown[] };
    expect(parsed.orders).toEqual([]);
  });

  test('get_equity_tradability returns isTradeable: true', async () => {
    const { getRobinhoodLangchainTools } = await import('../robinhoodMcp.ts');
    const tools = await getRobinhoodLangchainTools('u', 'a');
    const t = tools.find((x) => x.name === 'get_equity_tradability');
    const out = await t!.invoke({ symbol: 'TSLA' });
    const parsed = JSON.parse(String(out)) as { symbol: string; isTradeable: boolean };
    expect(parsed.symbol).toBe('TSLA');
    expect(parsed.isTradeable).toBe(true);
  });

  test('review_equity_order returns preview_ id + totalCost', async () => {
    const { getRobinhoodLangchainTools } = await import('../robinhoodMcp.ts');
    const tools = await getRobinhoodLangchainTools('u', 'a');
    const t = tools.find((x) => x.name === 'review_equity_order');
    const out = await t!.invoke({ symbol: 'TSLA', side: 'buy', quantity: 2 });
    const parsed = JSON.parse(String(out)) as {
      orderId: string;
      totalCost: number;
      fees: number;
    };
    expect(parsed.orderId.startsWith('preview_')).toBe(true);
    expect(parsed.totalCost).toBeGreaterThan(0);
    expect(parsed.fees).toBe(0);
  });

  test('cancel_equity_order returns cancelled state', async () => {
    const { getRobinhoodLangchainTools } = await import('../robinhoodMcp.ts');
    const tools = await getRobinhoodLangchainTools('u', 'a');
    const t = tools.find((x) => x.name === 'cancel_equity_order');
    const out = await t!.invoke({ orderId: 'abc-123' });
    const parsed = JSON.parse(String(out)) as { orderId: string; state: string };
    expect(parsed.orderId).toBe('abc-123');
    expect(parsed.state).toBe('cancelled');
  });

  test('search uppercases the query and returns an instrument id', async () => {
    const { getRobinhoodLangchainTools } = await import('../robinhoodMcp.ts');
    const tools = await getRobinhoodLangchainTools('u', 'a');
    const t = tools.find((x) => x.name === 'search');
    const out = await t!.invoke({ query: 'amd' });
    const parsed = JSON.parse(String(out)) as { results: Array<{ symbol: string; instrumentId: string }> };
    expect(parsed.results[0]?.symbol).toBe('AMD');
    expect(parsed.results[0]?.instrumentId).toBe('demo_AMD');
  });
});
