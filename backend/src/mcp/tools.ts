/**
 * MCP tool registrations for the inbound oracle server.
 *
 * Split out from `server.ts` so the tool wiring is unit-testable in
 * isolation from the Fastify route plumbing.
 *
 * Tools (Wave 2):
 *   - oracle.get_off_chain_state   stub fixture for now; Wave 3 swaps to the live RH MCP client.
 *   - oracle.attest_state          EIP-712 sign + DB insert via attestor.ts.
 *   - oracle.compute_selectors     keccak256 first-4-bytes of canonical fn sigs.
 *
 * Resources:
 *   - oracle://schema              JSON schema for the AttestationPayload type.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { attestState, type OffChainState } from '../lib/attestor.ts';
import { buildAllowlist } from '../lib/selectors.ts';
import { centsToUsdQ96 } from '../lib/units.ts';
import { bigintReplacer } from '../lib/json.ts';
import {
  getRuntimeState,
  listActiveTokenIds,
} from '../lib/runtimeStore.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { FleetSpecSchema } from '../agent/fleet/schemas.ts';
import { buildFleetPlan } from '../agent/fleet/spawn.ts';
import {
  BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA,
} from '../config/main-config.ts';

/**
 * Per-session authentication context. Populated by the MCP route handler in
 * `mcp/server.ts` after the bearer token is verified. Tools look it up by
 * `extra.sessionId` (provided by the MCP SDK transport) to recover the
 * authenticated wallet for the current call.
 *
 * F-03: agent.spawn previously accepted a caller-controlled ownerAddress
 * which let a prompt-injected MCP client route NFTs to an attacker wallet.
 * The owner MUST be derived from this map, never from tool input.
 */
export type McpAuthContext = { userId: string; walletAddress: `0x${string}` };
export type McpAuthResolver = (sessionId: string | undefined) => McpAuthContext | null;

/**
 * Canonical base asset for fleet spawns. F-03: previously caller-controlled
 * via the `baseAsset` tool arg, which let a malicious client substitute a
 * rebasing / reentrant ERC-20. Resolved server-side from the env-pinned
 * USDC-equivalent address; falls through to `null` when unconfigured so the
 * tool surfaces a clear error.
 */
export function canonicalBaseAsset(): `0x${string}` | null {
  const raw = process.env.BACKEND_FLEET_BASE_ASSET_ADDRESS;
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw as `0x${string}`;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Loads a deterministic stub of the off-chain state for the given tokenId.
 * For Wave 2 we have a single fixture; later we'll key by `tokenId`. The
 * file is shaped to match the `OffChainState` interface, with bigint-valued
 * fields stored as strings (since JSON cannot represent bigint natively).
 */
function loadStubState(_tokenId: string): OffChainState {
  const file = join(__dirname, 'fixtures', 'state_token_default.json');
  const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
    account_id: string;
    account_value_cents: string;
    positions: Array<{ symbol: string; qty: number; mark_cents: string }>;
    buying_power_cents: string;
    ts: number;
  };

  return {
    account_id: raw.account_id,
    account_value_cents: BigInt(raw.account_value_cents),
    positions: raw.positions.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      mark_cents: BigInt(p.mark_cents),
    })),
    buying_power_cents: BigInt(raw.buying_power_cents),
    ts: raw.ts,
  };
}

function jsonText(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, bigintReplacer) }],
  };
}

export function registerOracleTools(
  server: McpServer,
  authResolver?: McpAuthResolver,
): void {
  server.registerTool(
    'oracle.get_off_chain_state',
    {
      description:
        'Return the off-chain account state for a PositionNFT tokenId. Wave 2 returns a deterministic stub; Wave 3 will swap in the live Robinhood MCP client.',
      inputSchema: { tokenId: z.string().min(1) },
    },
    async ({ tokenId }) => {
      const state = loadStubState(tokenId);
      return jsonText(state);
    },
  );

  server.registerTool(
    'oracle.attest_state',
    {
      description:
        'Sign an EIP-712 attestation for the off-chain state of a PositionNFT tokenId and append it to the Attestation log.',
      inputSchema: {
        tokenId: z.string().min(1),
        chainId: z.number().int().positive(),
      },
    },
    async ({ tokenId, chainId }) => {
      const state = loadStubState(tokenId);
      // Convert cents -> Q96.48 at the tool boundary. `attestor.ts` stays
      // unit-agnostic so the Wave 2 worker can pass Q96 values straight
      // through from the live oracle without re-deriving them.
      const accountValueQ96 = centsToUsdQ96(state.account_value_cents);
      const buyingPowerQ96 = centsToUsdQ96(state.buying_power_cents);
      const signed = await attestState(
        BigInt(tokenId),
        accountValueQ96,
        buyingPowerQ96,
        state,
        chainId,
      );
      return jsonText({
        tokenId: signed.tokenId.toString(),
        payloadHash: signed.payloadHash,
        notBefore: signed.notBefore,
        notAfter: signed.notAfter,
        nullifier: signed.nullifier,
        signature: signed.signature,
        signer: signed.signer,
        domainHash: signed.domainHash,
        digest: signed.digest,
        accountValueQ96: signed.accountValueQ96.toString(),
        buyingPowerQ96: signed.buyingPowerQ96.toString(),
      });
    },
  );

  server.registerTool(
    'oracle.compute_selectors',
    {
      description:
        'Compute the first-4-byte function selectors (keccak256) for a list of canonical Solidity function signatures. Used to build the ERC-7715 selector allowlist.',
      inputSchema: {
        abis: z.array(
          z.object({
            contract: z.string().min(1),
            fnSig: z.string().min(1),
          }),
        ),
      },
    },
    async ({ abis }) => {
      const selectors = buildAllowlist(abis.map((a: { contract: string; fnSig: string }) => a.fnSig));
      return jsonText({ selectors });
    },
  );

  // ----- Claude.ai connector tools (Wave E2) -------------------------------
  // These three reads expose the runtime state of the agent fleet to a
  // Claude.ai conversation via the same MCP server the dashboard speaks to.
  // None of them mutate state; the connector surface is intentionally
  // read-only so a misbehaving prompt cannot place trades.

  server.registerTool(
    'oracle.list_agents',
    {
      description:
        'List every tokenId currently known to the runtime store along with its status and last tick time. Optional chainId filter is accepted for forward compatibility; today the runtime is single-chain (Arbitrum Sepolia) so filtering returns the full set.',
      inputSchema: { chainId: z.number().int().positive().optional() },
    },
    async (_args) => {
      const ids = listActiveTokenIds();
      const agents = ids.map((id) => {
        const s = getRuntimeState(id);
        return {
          tokenId: s.tokenId.toString(),
          status: s.status,
          lastTickAt: s.lastTickAt ? s.lastTickAt.toISOString() : null,
        };
      });
      return jsonText({ agents });
    },
  );

  server.registerTool(
    'oracle.get_agent',
    {
      description:
        'Return the runtime state for a single tokenId: status, last tick time, the most recent snapshot, and the last ~100 runtime events held in the ring buffer.',
      inputSchema: { tokenId: z.string().min(1) },
    },
    async ({ tokenId }) => {
      let parsed: bigint;
      try {
        parsed = BigInt(tokenId);
      } catch {
        return jsonText({ error: 'invalid_token_id' });
      }
      const s = getRuntimeState(parsed);
      return jsonText({
        tokenId: s.tokenId.toString(),
        status: s.status,
        lastTickAt: s.lastTickAt ? s.lastTickAt.toISOString() : null,
        lastSnapshot: s.lastSnapshot,
        recent: s.recent,
        seq: s.seq,
      });
    },
  );

  server.registerTool(
    'oracle.get_actions',
    {
      description:
        'Return the most recent persisted AgentAction rows for a tokenId. Useful for replay or post-mortem. Returns an empty array gracefully when the audit table is not yet pushed (operator still needs `bun db:push`).',
      inputSchema: {
        tokenId: z.string().min(1),
        limit: z.number().int().positive().max(100).default(20),
      },
    },
    async ({ tokenId, limit }) => {
      let parsed: bigint;
      try {
        parsed = BigInt(tokenId);
      } catch {
        return jsonText({ error: 'invalid_token_id', actions: [] });
      }
      const capped = Math.min(Math.max(1, limit), 100);
      // Same cast workaround as actionLogger.ts and agentActionsRoutes.ts.
      type AgentActionDelegate = {
        findMany: (args: {
          where: Record<string, unknown>;
          orderBy: { id: 'asc' | 'desc' };
          take: number;
        }) => Promise<unknown[]>;
      };
      const tbl = (
        prismaQuery as unknown as { agentAction?: AgentActionDelegate }
      ).agentAction;
      if (!tbl) {
        return jsonText({ actions: [] });
      }
      try {
        const rows = await tbl.findMany({
          where: { tokenId: parsed },
          orderBy: { id: 'desc' },
          take: capped,
        });
        return jsonText({ actions: rows });
      } catch {
        // DB unavailable or schema not pushed: degrade to empty.
        return jsonText({ actions: [] });
      }
    },
  );

  // ----- agent.spawn (Feature D) ------------------------------------------
  // Returns the bundled-userOp call array. The MCP client (Claude.ai or
  // similar) MUST still surface the call payload to the operator who signs
  // via the Kernel; the backend never broadcasts.
  server.registerTool(
    'agent.spawn',
    {
      description:
        'Build the bundled userOp call array to deploy N PrimeAgent NFTs in one signature. Returns a plan; the caller signs and submits via their Kernel client. fleetSpec is the JSON-encoded FleetSpec struct. The owner address and base asset are derived server-side from the authenticated MCP session; they are NOT accepted as input to prevent prompt-injected callers from re-targeting the deployment.',
      inputSchema: {
        fleetSpec: z.string().min(1),
      },
    },
    async (args: { fleetSpec: string }, extra: { sessionId?: string }) => {
      // F-03: owner MUST come from the authenticated MCP session, not from
      // tool input. A prompt-injected Claude.ai connector could otherwise
      // route the spawned NFTs to an attacker-controlled wallet.
      const auth = authResolver ? authResolver(extra?.sessionId) : null;
      if (!auth) {
        return jsonText({ error: 'unauthenticated' });
      }
      let specJson: unknown;
      try {
        specJson = JSON.parse(args.fleetSpec);
      } catch {
        return jsonText({ error: 'invalid_fleet_spec_json' });
      }
      const parsed = FleetSpecSchema.safeParse(specJson);
      if (!parsed.success) {
        return jsonText({ error: 'invalid_fleet_spec', issues: parsed.error.issues });
      }
      const factory = BACKEND_FACTORY_ADDRESS_ARB_SEPOLIA;
      if (!factory || !/^0x[0-9a-fA-F]{40}$/.test(factory)) {
        return jsonText({ error: 'factory_unconfigured' });
      }
      // F-03: base asset is pinned to the env-configured USDC-equivalent.
      // Accepting baseAsset as a tool arg let a malicious client substitute
      // a rebasing or reentrant token; that vector is now closed.
      const baseAsset = canonicalBaseAsset();
      if (!baseAsset) {
        return jsonText({ error: 'base_asset_unconfigured' });
      }
      const ownerAddress = auth.walletAddress;
      const plan = buildFleetPlan({
        spec: parsed.data,
        factoryAddress: factory as `0x${string}`,
        baseAsset,
        ownerAddress,
        agentUriTemplate:
          process.env.BACKEND_FLEET_URI_TEMPLATE ||
          'ipfs://primeagent/fleet/#{n}.json',
      });
      return jsonText({
        clientId: plan.clientId,
        calls: plan.calls,
        expectedMembers: plan.expectedMembers,
      });
    },
  );

  server.registerResource(
    'oracle-schema',
    'oracle://schema',
    {
      description: 'JSON schema for AttestationPayload and OffChainState.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(ATTESTATION_SCHEMA, null, 2),
        },
      ],
    }),
  );
}

export const ATTESTATION_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'PrimeAgent Oracle Attestation',
  type: 'object',
  properties: {
    OffChainState: {
      type: 'object',
      required: [
        'account_id',
        'account_value_cents',
        'positions',
        'buying_power_cents',
        'ts',
      ],
      properties: {
        account_id: { type: 'string' },
        account_value_cents: {
          type: 'string',
          description: 'uint cents encoded as decimal string',
        },
        positions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['symbol', 'qty', 'mark_cents'],
            properties: {
              symbol: { type: 'string' },
              qty: { type: 'number' },
              mark_cents: { type: 'string' },
            },
          },
        },
        buying_power_cents: { type: 'string' },
        ts: { type: 'integer' },
      },
    },
    AttestationPayload: {
      type: 'object',
      required: ['tokenId', 'payloadHash', 'notBefore', 'notAfter', 'nullifier'],
      properties: {
        tokenId: { type: 'string' },
        payloadHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
        notBefore: { type: 'integer' },
        notAfter: { type: 'integer' },
        nullifier: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
      },
    },
  },
} as const;
