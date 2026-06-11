import { describe, expect, test } from 'bun:test';

import { buildFleetPlan, deriveChildContextHash } from '../spawn.ts';
import type { FleetSpec } from '../schemas.ts';

const FACTORY = ('0x' + 'f'.repeat(40)) as `0x${string}`;
const OWNER = ('0x' + 'b'.repeat(40)) as `0x${string}`;
const BASE_ASSET = ('0x' + 'c'.repeat(40)) as `0x${string}`;

function spec(over: Partial<FleetSpec> = {}): FleetSpec {
  return {
    clientId: 'fleet-client-aaaaaaaaaa',
    count: 3,
    strategyName: 'tsla-pairs',
    policy: {
      tokenId: null,
      clientId: 'draft-client-id-aaaaaaaa',
      presetId: 'balanced',
      maxNotionalUsd: 25_000,
      dailyCapUsd: 100_000,
      durationDays: 30,
      allowedSymbols: ['TSLA', 'AMZN'],
      allowedContracts: ['0x' + 'a'.repeat(40) as `0x${string}`],
      allowedSelectors: ['0xdeadbeef' as `0x${string}`],
      strategyName: 'tsla-pairs',
      presetHash: null,
      draftedAt: 1_700_000_000,
    },
    nameTemplate: 'Alpha-#{n}',
    parentTokenId: null,
    ...over,
  };
}

describe('buildFleetPlan', () => {
  test('produces N calls with distinct child context hashes', () => {
    const plan = buildFleetPlan({
      spec: spec(),
      factoryAddress: FACTORY,
      baseAsset: BASE_ASSET,
      ownerAddress: OWNER,
      agentUriTemplate: 'ipfs://uri/#{n}.json',
    });
    expect(plan.calls.length).toBe(3);
    expect(plan.expectedMembers.length).toBe(3);
    const hashes = plan.expectedMembers.map((m) => m.permissionContextHash);
    expect(new Set(hashes).size).toBe(3);
    expect(plan.expectedMembers[0].name).toBe('Alpha-1');
    expect(plan.expectedMembers[2].name).toBe('Alpha-3');
  });

  test('rejects count out of 1..10 bounds', () => {
    expect(() =>
      buildFleetPlan({
        spec: spec({ count: 0 }),
        factoryAddress: FACTORY,
        baseAsset: BASE_ASSET,
        ownerAddress: OWNER,
        agentUriTemplate: 'x',
      }),
    ).toThrow();
    expect(() =>
      buildFleetPlan({
        spec: spec({ count: 11 }),
        factoryAddress: FACTORY,
        baseAsset: BASE_ASSET,
        ownerAddress: OWNER,
        agentUriTemplate: 'x',
      }),
    ).toThrow();
  });

  test('deriveChildContextHash is deterministic and child-distinct', () => {
    const base = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
    const h0 = deriveChildContextHash(base, 0);
    const h1 = deriveChildContextHash(base, 1);
    expect(h0).not.toBe(h1);
    expect(deriveChildContextHash(base, 0)).toBe(h0);
  });
});
