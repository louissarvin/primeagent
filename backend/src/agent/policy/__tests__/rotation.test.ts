import { describe, expect, test } from 'bun:test';

import { buildRotationCalls } from '../rotation.ts';
import type { AgentPolicyDraft } from '../schemas.ts';

const DIAMOND = ('0x' + 'd'.repeat(40)) as `0x${string}`;
const CONTEXT = ('0x' + '22'.repeat(32)) as `0x${string}`;

function draft(): AgentPolicyDraft {
  return {
    tokenId: 5n,
    clientId: 'draft-client-id-aaaaaaaa',
    presetId: 'balanced',
    maxNotionalUsd: 50_000,
    dailyCapUsd: 200_000,
    durationDays: 30,
    allowedSymbols: ['TSLA'],
    allowedContracts: ['0x' + 'a'.repeat(40) as `0x${string}`],
    allowedSelectors: ['0xdeadbeef' as `0x${string}`],
    strategyName: 'tsla-pairs',
    presetHash: null,
    draftedAt: 1_700_000_000,
  };
}

describe('buildRotationCalls', () => {
  test('returns two calls (revoke then install) to the diamond', () => {
    const calls = buildRotationCalls({
      tokenId: 5n,
      diamondAddress: DIAMOND,
      proposed: draft(),
      permissionContextHash: CONTEXT,
    });
    expect(calls.length).toBe(2);
    expect(calls[0].to).toBe(DIAMOND);
    expect(calls[1].to).toBe(DIAMOND);
    // Selector check: revokePermission(uint256) selector is the first 8 hex
    // chars after `0x`. install... is second.
    expect(calls[0].data.length).toBeGreaterThan(8);
    expect(calls[0].data).not.toBe(calls[1].data);
    expect(calls[0].value).toBe('0');
  });

  test('refuses to build when tokenId mismatches proposed.tokenId', () => {
    expect(() =>
      buildRotationCalls({
        tokenId: 6n,
        diamondAddress: DIAMOND,
        proposed: draft(),
        permissionContextHash: CONTEXT,
      }),
    ).toThrow();
  });
});
