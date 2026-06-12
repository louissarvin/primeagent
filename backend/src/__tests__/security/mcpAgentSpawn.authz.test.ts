/**
 * F-03 [HIGH] MCP `agent.spawn` accepts arbitrary ownerAddress and baseAsset.
 *
 * BEFORE: the tool input schema included `ownerAddress` and `baseAsset` as
 * caller-controlled strings. A prompt-injected MCP client could set
 * `ownerAddress` to an attacker wallet and `baseAsset` to a malicious ERC-20.
 *
 * AFTER:
 *   - `ownerAddress` is REMOVED from the input schema. It is derived from
 *     the authenticated MCP session via the `authResolver` parameter passed
 *     into `registerOracleTools`.
 *   - `baseAsset` is REMOVED from the input schema. It is pinned to the
 *     `BACKEND_FLEET_BASE_ASSET_ADDRESS` env (canonical USDC-equivalent).
 *   - Unauthenticated callers (no sessionId in `extra`) get `unauthenticated`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

interface RegisteredTool {
  name: string;
  config: { description?: string; inputSchema?: Record<string, unknown> };
  handler: (
    args: Record<string, unknown>,
    extra?: { sessionId?: string },
  ) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

class FakeMcpServer {
  tools: RegisteredTool[] = [];
  resources: Array<{ name: string; uri: string }> = [];
  registerTool(
    name: string,
    config: RegisteredTool['config'],
    handler: RegisteredTool['handler'],
  ): void {
    this.tools.push({ name, config, handler });
  }
  registerResource(): void {}
  byName(name: string): RegisteredTool | undefined {
    return this.tools.find((t) => t.name === name);
  }
}

const AUTH_WALLET = '0x1111111111111111111111111111111111111111';
const ATTACKER_WALLET = '0x9999999999999999999999999999999999999999';
const CANONICAL_USDC = '0xcccccccccccccccccccccccccccccccccccccccc';
const ATTACKER_TOKEN = '0x6666666666666666666666666666666666666666';
const FACTORY = '0xfafafafafafafafafafafafafafafafafafafafa';

const FLEET_SPEC_JSON = JSON.stringify({
  clientId: 'cli_aaaaaaaaaaaaaaaa',
  count: 2,
  strategyName: 'pairs-tsla',
  nameTemplate: 'fleet#{n}',
  parentTokenId: null,
  policy: {
    tokenId: null,
    clientId: 'cli_aaaaaaaaaaaaaaaa',
    presetId: 'balanced',
    maxNotionalUsd: 1000,
    dailyCapUsd: 1000,
    durationDays: 1,
    allowedSymbols: ['TSLA'],
    allowedContracts: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    allowedSelectors: ['0xdeadbeef'],
    strategyName: 'pairs-tsla',
    presetHash: '0x' + 'a'.repeat(64),
    draftedAt: 1_700_000_000,
  },
});

describe('F-03 MCP agent.spawn authz', () => {
  beforeEach(() => {
    process.env.BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA = FACTORY;
    process.env.BACKEND_FLEET_BASE_ASSET_ADDRESS = CANONICAL_USDC;
  });

  afterEach(() => {
    delete process.env.BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA;
    delete process.env.BACKEND_FLEET_BASE_ASSET_ADDRESS;
  });

  test('AFTER fix: input schema no longer accepts ownerAddress or baseAsset', async () => {
    const mod = await import('../../mcp/tools.ts');
    const server = new FakeMcpServer();
    mod.registerOracleTools(server as unknown as Parameters<typeof mod.registerOracleTools>[0]);
    const tool = server.byName('agent.spawn');
    expect(tool).toBeDefined();
    const keys = Object.keys(tool!.config.inputSchema ?? {});
    expect(keys).toEqual(['fleetSpec']);
    expect(keys).not.toContain('ownerAddress');
    expect(keys).not.toContain('baseAsset');
  });

  test('AFTER fix: tool derives ownerAddress from session, ignores any attacker args', async () => {
    await mock.module('../../config/main-config.ts', () => ({
      BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA: FACTORY,
    }));
    const mod = await import('../../mcp/tools.ts');
    const server = new FakeMcpServer();
    const resolver = (sid: string | undefined): { userId: string; walletAddress: `0x${string}` } | null => {
      if (sid === 'authed-session') {
        return { userId: 'u-1', walletAddress: AUTH_WALLET as `0x${string}` };
      }
      return null;
    };
    mod.registerOracleTools(
      server as unknown as Parameters<typeof mod.registerOracleTools>[0],
      resolver,
    );
    const tool = server.byName('agent.spawn');
    // Attacker passes extra fields trying to override owner/base. Zod
    // strict mode at the SDK boundary would reject; here we hand-wave the
    // FakeMcpServer's permissive shape and call directly with extras.
    const result = await tool!.handler(
      {
        fleetSpec: FLEET_SPEC_JSON,
        ownerAddress: ATTACKER_WALLET,
        baseAsset: ATTACKER_TOKEN,
      },
      { sessionId: 'authed-session' },
    );
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as {
      calls?: Array<{ data: string }>;
      error?: string;
    };
    expect(payload.error).toBeUndefined();
    expect(payload.calls).toBeDefined();
    // Encoded calldata must contain the AUTH_WALLET (lowercase 40 hex) and
    // the canonical USDC, NEVER the attacker-supplied addresses.
    const blob = (payload.calls ?? []).map((c) => c.data).join('').toLowerCase();
    expect(blob).toContain(AUTH_WALLET.slice(2).toLowerCase());
    expect(blob).toContain(CANONICAL_USDC.slice(2).toLowerCase());
    expect(blob).not.toContain(ATTACKER_WALLET.slice(2).toLowerCase());
    expect(blob).not.toContain(ATTACKER_TOKEN.slice(2).toLowerCase());
  });

  test('AFTER fix: unauthenticated session returns error, no plan built', async () => {
    await mock.module('../../config/main-config.ts', () => ({
      BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA: FACTORY,
    }));
    const mod = await import('../../mcp/tools.ts');
    const server = new FakeMcpServer();
    mod.registerOracleTools(
      server as unknown as Parameters<typeof mod.registerOracleTools>[0],
      () => null,
    );
    const tool = server.byName('agent.spawn');
    const result = await tool!.handler(
      { fleetSpec: FLEET_SPEC_JSON },
      { sessionId: undefined },
    );
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as { error?: string };
    expect(payload.error).toBe('unauthenticated');
  });
});
