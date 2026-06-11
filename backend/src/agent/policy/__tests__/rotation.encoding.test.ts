/**
 * Encoding-level regression test for the Feature C / Option B policy struct
 * arity fix.
 *
 * The Diamond facet (`Erc7715PolicyAuditFacet`) now exposes:
 *   - `installPermission(uint256, LegacyPolicy)`    (10-field tuple, V1)
 *   - `installPermissionV2(uint256, Policy)`        (11-field tuple, V2)
 *
 * Before the fix `rotation.ts` encoded a hand-rolled 7-field tuple at the V1
 * selector, which the facet rejected with a decode error. This test pins:
 *   1. With `useV2: true`, calldata starts with the V2 selector
 *      `installPermissionV2(uint256,(uint256,bytes32,address[],bytes4[],uint256,uint256,uint64,uint64,uint64,uint64,bytes32))`
 *      = `0x02b7b6f3` and the decoded policy tuple has all 11 fields.
 *   2. With `useV2: false`, calldata starts with the V1 selector and the
 *      decoded tuple has 10 fields (the `presetHash` is absent).
 *   3. The selector and field count do NOT drift if the encoder is ever
 *      changed in a way that produces a different on-chain selector.
 */

import { describe, expect, test } from 'bun:test';
import { decodeFunctionData, slice } from 'viem';

import { buildRotationCalls, __internal } from '../rotation.ts';
import type { AgentPolicyDraft } from '../schemas.ts';

const DIAMOND = ('0x' + 'd'.repeat(40)) as `0x${string}`;
const CONTEXT = ('0x' + '22'.repeat(32)) as `0x${string}`;
const PRESET_HASH = ('0x' + '33'.repeat(32)) as `0x${string}`;

// Canonical V2 selector for
// `installPermissionV2(uint256,(uint256,bytes32,address[],bytes4[],uint256,uint256,uint64,uint64,uint64,uint64,bytes32))`.
const INSTALL_PERMISSION_V2_SELECTOR = '0x02b7b6f3' as `0x${string}`;
// Canonical V1 selector for
// `installPermission(uint256,(uint256,bytes32,address[],bytes4[],uint256,uint256,uint64,uint64,uint64,uint64))`.
const INSTALL_PERMISSION_V1_SELECTOR = '0x5f8e9843' as `0x${string}`;

function draft(over: Partial<AgentPolicyDraft> = {}): AgentPolicyDraft {
  return {
    tokenId: 7n,
    clientId: 'draft-client-id-bbbbbbbb',
    presetId: 'balanced',
    maxNotionalUsd: 50_000,
    dailyCapUsd: 200_000,
    durationDays: 30,
    allowedSymbols: ['TSLA'],
    allowedContracts: ['0x' + 'a'.repeat(40) as `0x${string}`],
    allowedSelectors: ['0xdeadbeef' as `0x${string}`],
    strategyName: 'tsla-pairs',
    presetHash: PRESET_HASH,
    draftedAt: 1_700_000_000,
    ...over,
  };
}

describe('buildRotationCalls encoding (Feature C / Option B)', () => {
  test('V2 path: calldata starts with installPermissionV2 selector', () => {
    const calls = buildRotationCalls({
      tokenId: 7n,
      diamondAddress: DIAMOND,
      proposed: draft(),
      permissionContextHash: CONTEXT,
      useV2: true,
    });
    expect(calls.length).toBe(2);
    const installCall = calls[1];
    const selector = slice(installCall.data, 0, 4);
    expect(selector).toBe(INSTALL_PERMISSION_V2_SELECTOR);
  });

  test('V2 path: decoded policy tuple has all 11 fields including presetHash', () => {
    const calls = buildRotationCalls({
      tokenId: 7n,
      diamondAddress: DIAMOND,
      proposed: draft(),
      permissionContextHash: CONTEXT,
      useV2: true,
    });
    const decoded = decodeFunctionData({
      abi: __internal.POLICY_FACET_WRITE_ABI,
      data: calls[1].data,
    });
    expect(decoded.functionName).toBe('installPermissionV2');
    // args[0] = tokenId (uint256), args[1] = policy tuple
    const args = decoded.args as readonly [bigint, Record<string, unknown>];
    expect(args[0]).toBe(7n);
    const policy = args[1];

    // The 11 canonical fields, verbatim per LibPolicy.Policy.
    const expectedFields = [
      'tokenId',
      'permissionContextHash',
      'allowedContracts',
      'allowedSelectors',
      'maxNotionalUsdQ96',
      'dailyCapUsdQ96',
      'expiresAt',
      'issuedAt',
      'dailySpentUsdQ96Slot',
      'dailyWindowStart',
      'presetHash',
    ];
    for (const f of expectedFields) {
      expect(policy).toHaveProperty(f);
    }
    expect(Object.keys(policy).length).toBe(11);

    // Sanity: presetHash round-trips, tokenId is stamped on the tuple,
    // issuedAt = draftedAt, expiresAt = draftedAt + 30 days.
    expect(policy.presetHash).toBe(PRESET_HASH);
    expect(policy.tokenId).toBe(7n);
    expect(policy.permissionContextHash).toBe(CONTEXT);
    expect(policy.issuedAt).toBe(1_700_000_000n);
    expect(policy.expiresAt).toBe(1_700_000_000n + 30n * 86_400n);
    expect(policy.dailySpentUsdQ96Slot).toBe(0n);
    expect(policy.dailyWindowStart).toBe(0n);
  });

  test('V2 path: null presetHash defaults to bytes32(0) (custom preset)', () => {
    const calls = buildRotationCalls({
      tokenId: 7n,
      diamondAddress: DIAMOND,
      proposed: draft({ presetHash: null }),
      permissionContextHash: CONTEXT,
      useV2: true,
    });
    const decoded = decodeFunctionData({
      abi: __internal.POLICY_FACET_WRITE_ABI,
      data: calls[1].data,
    });
    const args = decoded.args as readonly [bigint, Record<string, unknown>];
    expect(args[1].presetHash).toBe(__internal.ZERO_BYTES32);
  });

  test('V1 legacy path: calldata starts with installPermission selector and tuple has 10 fields', () => {
    const calls = buildRotationCalls({
      tokenId: 7n,
      diamondAddress: DIAMOND,
      proposed: draft(),
      permissionContextHash: CONTEXT,
      useV2: false,
    });
    const installCall = calls[1];
    const selector = slice(installCall.data, 0, 4);
    expect(selector).toBe(INSTALL_PERMISSION_V1_SELECTOR);

    const decoded = decodeFunctionData({
      abi: __internal.POLICY_FACET_WRITE_ABI,
      data: installCall.data,
    });
    expect(decoded.functionName).toBe('installPermission');
    const args = decoded.args as readonly [bigint, Record<string, unknown>];
    const policy = args[1];
    expect(Object.keys(policy).length).toBe(10);
    expect(policy).not.toHaveProperty('presetHash');
  });

  test('revoke leg is the same in both paths', () => {
    const v2 = buildRotationCalls({
      tokenId: 7n,
      diamondAddress: DIAMOND,
      proposed: draft(),
      permissionContextHash: CONTEXT,
      useV2: true,
    });
    const v1 = buildRotationCalls({
      tokenId: 7n,
      diamondAddress: DIAMOND,
      proposed: draft(),
      permissionContextHash: CONTEXT,
      useV2: false,
    });
    expect(v2[0].data).toBe(v1[0].data);
    expect(slice(v2[0].data, 0, 4)).toBe('0xf55e822d');
  });
});
