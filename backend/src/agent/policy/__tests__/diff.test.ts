import { describe, expect, test } from 'bun:test';

import { diffPolicies, hashAgentPolicyDraft } from '../diff.ts';
import type { AgentPolicyDraft, AgentPolicyOnChain } from '../schemas.ts';

const ZERO_HASH = ('0x' + '0'.repeat(64)) as `0x${string}`;
const SAMPLE_CONTEXT_HASH = ('0x' + '11'.repeat(32)) as `0x${string}`;

function makeOnChain(over: Partial<AgentPolicyOnChain> = {}): AgentPolicyOnChain {
  return {
    tokenId: 1n,
    clientId: 'on-chain-tk-00000001',
    presetId: 'balanced',
    maxNotionalUsd: 50_000,
    dailyCapUsd: 200_000,
    durationDays: 30,
    allowedSymbols: ['TSLA', 'AMZN'],
    allowedContracts: ['0x' + 'a'.repeat(40) as `0x${string}`],
    allowedSelectors: ['0xdeadbeef' as `0x${string}`],
    strategyName: 'tsla-pairs',
    presetHash: ZERO_HASH,
    draftedAt: 1_700_000_000,
    permissionContextHash: SAMPLE_CONTEXT_HASH,
    expiresAt: 1_700_000_000n + 30n * 86_400n,
    issuedAt: 1_700_000_000n,
    grantTxHash: ZERO_HASH,
    kernelAddress: ('0x' + 'b'.repeat(40)) as `0x${string}`,
    ...over,
  };
}

function makeDraft(over: Partial<AgentPolicyDraft> = {}): AgentPolicyDraft {
  return {
    tokenId: 1n,
    clientId: 'draft-client-id-aaaaaaaa',
    presetId: 'balanced',
    maxNotionalUsd: 50_000,
    dailyCapUsd: 200_000,
    durationDays: 30,
    allowedSymbols: ['TSLA', 'AMZN'],
    allowedContracts: ['0x' + 'a'.repeat(40) as `0x${string}`],
    allowedSelectors: ['0xdeadbeef' as `0x${string}`],
    strategyName: 'tsla-pairs',
    presetHash: ZERO_HASH,
    draftedAt: 1_700_000_000,
    ...over,
  };
}

describe('diffPolicies', () => {
  test('empty diff when policies match', () => {
    const d = diffPolicies(makeOnChain(), makeDraft());
    expect(d.ops).toEqual([]);
    expect(d.blockers).toEqual([]);
    expect(d.fromHash).toBe(SAMPLE_CONTEXT_HASH);
  });

  test('captures maxNotionalUsd change', () => {
    const d = diffPolicies(makeOnChain(), makeDraft({ maxNotionalUsd: 25_000 }));
    expect(d.ops).toEqual([
      { kind: 'set', field: 'maxNotionalUsd', before: 50_000, after: 25_000 },
    ]);
  });

  test('warns on >50% daily cap reduction', () => {
    const d = diffPolicies(makeOnChain(), makeDraft({ dailyCapUsd: 50_000 }));
    expect(d.ops.some((o) => o.kind === 'set' && o.field === 'dailyCapUsd')).toBe(true);
    expect(d.warnings.length).toBeGreaterThan(0);
  });

  test('add + remove symbols', () => {
    const d = diffPolicies(
      makeOnChain(),
      makeDraft({ allowedSymbols: ['TSLA', 'PLTR'] }),
    );
    const adds = d.ops.filter((o) => o.kind === 'add');
    const removes = d.ops.filter((o) => o.kind === 'remove');
    expect(adds.length).toBe(1);
    expect(removes.length).toBe(1);
  });

  test('blocker on durationDays > 90 (bypassing zod)', () => {
    const d = diffPolicies(makeOnChain(), makeDraft({ durationDays: 120 }));
    expect(d.blockers.some((b) => b.includes('90'))).toBe(true);
  });

  test('hashAgentPolicyDraft is deterministic', () => {
    const a = makeDraft();
    const b = makeDraft();
    expect(hashAgentPolicyDraft(a)).toBe(hashAgentPolicyDraft(b));
  });

  test('hashAgentPolicyDraft differs on cap change', () => {
    const a = makeDraft();
    const b = makeDraft({ maxNotionalUsd: 25_000 });
    expect(hashAgentPolicyDraft(a)).not.toBe(hashAgentPolicyDraft(b));
  });

  test('case-insensitive contract diff', () => {
    const d = diffPolicies(
      makeOnChain({
        allowedContracts: [('0x' + 'A'.repeat(40)) as `0x${string}`],
      }),
      makeDraft({
        allowedContracts: [('0x' + 'a'.repeat(40)) as `0x${string}`],
      }),
    );
    const sym = d.ops.find(
      (o) => (o.kind === 'add' || o.kind === 'remove') && o.field === 'allowedContracts',
    );
    expect(sym).toBeUndefined();
  });

  test('strategyName change captured', () => {
    const d = diffPolicies(makeOnChain(), makeDraft({ strategyName: 'momentum-breakout' }));
    expect(d.ops.find((o) => o.kind === 'set' && o.field === 'strategyName')).toBeDefined();
  });

  test('preset id change captured', () => {
    const d = diffPolicies(makeOnChain(), makeDraft({ presetId: 'aggressive' }));
    expect(d.ops.find((o) => o.kind === 'set' && o.field === 'presetId')).toBeDefined();
  });
});
