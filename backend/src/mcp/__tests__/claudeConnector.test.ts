/**
 * Tests for the three Claude.ai connector MCP tools registered in
 * `src/mcp/tools.ts`: `oracle.list_agents`, `oracle.get_agent`, and
 * `oracle.get_actions`.
 *
 * We do NOT bring up a full StreamableHTTPServerTransport here; we
 * exercise the tool handlers directly via a tiny `McpServer` instance and
 * its `registerTool` accumulator behaviour, then call the recorded handler
 * function in-process. This keeps the test independent of the SDK
 * transport plumbing.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

interface RegisteredTool {
  name: string;
  config: { description?: string; inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
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

  registerResource(
    name: string,
    uri: string,
    _meta: unknown,
    _handler: unknown,
  ): void {
    this.resources.push({ name, uri });
  }

  byName(name: string): RegisteredTool | undefined {
    return this.tools.find((t) => t.name === name);
  }
}

async function loadToolsWithPrisma(
  agentAction: { findMany?: (args: unknown) => Promise<unknown[]> } | null,
): Promise<typeof import('../tools.ts')> {
  await mock.module('../../lib/prisma.ts', () => ({
    prismaQuery: agentAction ? { agentAction } : {},
  }));
  return import('../tools.ts');
}

describe('Claude connector MCP tools', () => {
  let server: FakeMcpServer;
  let rs: typeof import('../../lib/runtimeStore.ts');

  beforeEach(async () => {
    server = new FakeMcpServer();
    rs = await import('../../lib/runtimeStore.ts');
    rs.__internal.reset();
  });

  afterEach(() => {
    rs.__internal.reset();
  });

  test('registers all three Claude.ai connector tools', async () => {
    const mod = await loadToolsWithPrisma(null);
    mod.registerOracleTools(server as unknown as Parameters<typeof mod.registerOracleTools>[0]);
    expect(server.byName('oracle.list_agents')).toBeDefined();
    expect(server.byName('oracle.get_agent')).toBeDefined();
    expect(server.byName('oracle.get_actions')).toBeDefined();
  });

  test('oracle.list_agents returns runtime store contents', async () => {
    rs.updateStatus(1n, 'running');
    rs.updateStatus(2n, 'paused');
    const mod = await loadToolsWithPrisma(null);
    mod.registerOracleTools(server as unknown as Parameters<typeof mod.registerOracleTools>[0]);
    const tool = server.byName('oracle.list_agents');
    expect(tool).toBeDefined();
    const result = await tool!.handler({});
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      agents: Array<{ tokenId: string; status: string }>;
    };
    expect(parsed.agents.map((a) => a.tokenId).sort()).toEqual(['1', '2']);
  });

  test('oracle.get_agent returns the state for one tokenId', async () => {
    rs.updateStatus(42n, 'running');
    const mod = await loadToolsWithPrisma(null);
    mod.registerOracleTools(server as unknown as Parameters<typeof mod.registerOracleTools>[0]);
    const tool = server.byName('oracle.get_agent');
    expect(tool).toBeDefined();
    const result = await tool!.handler({ tokenId: '42' });
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      tokenId: string;
      status: string;
    };
    expect(parsed.tokenId).toBe('42');
    expect(parsed.status).toBe('running');
  });

  test('oracle.get_agent surfaces an error envelope on invalid tokenId', async () => {
    const mod = await loadToolsWithPrisma(null);
    mod.registerOracleTools(server as unknown as Parameters<typeof mod.registerOracleTools>[0]);
    const tool = server.byName('oracle.get_agent');
    const result = await tool!.handler({ tokenId: 'not-a-bigint' });
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { error: string };
    expect(parsed.error).toBe('invalid_token_id');
  });

  test('oracle.get_actions returns rows from prisma', async () => {
    const rows = [
      { id: 'b', tokenId: 1n, tick: 2, type: 'snapshot', payload: { x: 1 } },
      { id: 'a', tokenId: 1n, tick: 1, type: 'snapshot', payload: { x: 0 } },
    ];
    const mod = await loadToolsWithPrisma({
      findMany: async () => rows,
    });
    mod.registerOracleTools(server as unknown as Parameters<typeof mod.registerOracleTools>[0]);
    const tool = server.byName('oracle.get_actions');
    const result = await tool!.handler({ tokenId: '1', limit: 10 });
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      actions: Array<{ id: string }>;
    };
    expect(parsed.actions).toHaveLength(2);
    expect(parsed.actions[0]?.id).toBe('b');
  });

  test('oracle.get_actions returns empty array when prisma throws', async () => {
    const mod = await loadToolsWithPrisma({
      findMany: async () => {
        throw new Error('db unavailable');
      },
    });
    mod.registerOracleTools(server as unknown as Parameters<typeof mod.registerOracleTools>[0]);
    const tool = server.byName('oracle.get_actions');
    const result = await tool!.handler({ tokenId: '1', limit: 20 });
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      actions: unknown[];
    };
    expect(parsed.actions).toEqual([]);
  });

  test('oracle.get_actions returns empty array when prisma.agentAction is absent', async () => {
    const mod = await loadToolsWithPrisma(null);
    mod.registerOracleTools(server as unknown as Parameters<typeof mod.registerOracleTools>[0]);
    const tool = server.byName('oracle.get_actions');
    const result = await tool!.handler({ tokenId: '1', limit: 20 });
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      actions: unknown[];
    };
    expect(parsed.actions).toEqual([]);
  });
});
