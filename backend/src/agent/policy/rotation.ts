/**
 * Atomic policy rotation builder (Feature B).
 *
 * Constructs the Kernel `executeBatch` call data for a single userOp that
 * revokes the current ERC-7715 permission and installs the proposed one. The
 * backend NEVER broadcasts: the frontend signs via the Kernel client.
 *
 * Output shape mirrors what wagmi expects: an array of `{ to, data, value }`
 * tuples. The frontend feeds this directly into `kernelClient.encodeCalls`.
 *
 * Feature C / Option B: the on-chain `LibPolicy.Policy` struct now ends with
 * a trailing `bytes32 presetHash` field, raising the tuple arity from the
 * legacy 10 to 11. The facet exposes BOTH selectors:
 *
 *   - `installPermission(uint256, LibPolicy.LegacyPolicy)`    (10-field tuple)
 *   - `installPermissionV2(uint256, LibPolicy.Policy)`        (11-field tuple)
 *
 * The `BACKEND_POLICY_FACET_V2` config flag picks which selector this
 * builder encodes. When the Diamond cut is live on the target network the
 * flag is `true` (the default) and the V2 selector is used. While the cut
 * is still in its 48h timelock the operator can flip the flag to `false`
 * to keep producing legacy calldata; either path is rejected on chain if
 * the arity does not match the deployed facet, so a misconfigured flag
 * fails loudly rather than silently corrupting policy.
 */

import { encodeFunctionData, type Address, type Hex } from 'viem';

import { BACKEND_POLICY_FACET_V2 } from '../../config/main-config.ts';
import { ERC7715_POLICY_AUDIT_FACET_ABI } from '../../lib/contracts/abis.ts';
import type { AgentPolicyDraft } from './schemas.ts';

const ZERO_BYTES32: `0x${string}` = `0x${'0'.repeat(64)}`;

// Hand-written ABI fragments for the two write methods the rotation uses.
// The view methods live in the canonical export; the mutating selectors are
// listed here so a single import surface owns the rotation encoding.
//
// IMPORTANT: the `policy` tuple components MUST exactly mirror
// `LibPolicy.Policy` (V2) or `LibPolicy.LegacyPolicy` (V1) in
// `contracts/src/libraries/LibPolicy.sol`. Field order is load-bearing for
// ABI decoding; the on-chain facet reverts with `InvalidPresetHash` or
// generic decode failure on arity drift.
const POLICY_FACET_WRITE_ABI = [
  {
    type: 'function',
    name: 'revokePermission',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [],
  },
  {
    // V1 legacy selector. 10-field `LibPolicy.LegacyPolicy` tuple.
    type: 'function',
    name: 'installPermission',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      {
        name: 'policy',
        type: 'tuple',
        components: [
          { name: 'tokenId', type: 'uint256' },
          { name: 'permissionContextHash', type: 'bytes32' },
          { name: 'allowedContracts', type: 'address[]' },
          { name: 'allowedSelectors', type: 'bytes4[]' },
          { name: 'maxNotionalUsdQ96', type: 'uint256' },
          { name: 'dailyCapUsdQ96', type: 'uint256' },
          { name: 'expiresAt', type: 'uint64' },
          { name: 'issuedAt', type: 'uint64' },
          { name: 'dailySpentUsdQ96Slot', type: 'uint64' },
          { name: 'dailyWindowStart', type: 'uint64' },
        ],
      },
    ],
    outputs: [],
  },
  {
    // V2 selector (Feature C / Option B). 11-field `LibPolicy.Policy` tuple
    // ending with `bytes32 presetHash`.
    type: 'function',
    name: 'installPermissionV2',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      {
        name: 'policy',
        type: 'tuple',
        components: [
          { name: 'tokenId', type: 'uint256' },
          { name: 'permissionContextHash', type: 'bytes32' },
          { name: 'allowedContracts', type: 'address[]' },
          { name: 'allowedSelectors', type: 'bytes4[]' },
          { name: 'maxNotionalUsdQ96', type: 'uint256' },
          { name: 'dailyCapUsdQ96', type: 'uint256' },
          { name: 'expiresAt', type: 'uint64' },
          { name: 'issuedAt', type: 'uint64' },
          { name: 'dailySpentUsdQ96Slot', type: 'uint64' },
          { name: 'dailyWindowStart', type: 'uint64' },
          { name: 'presetHash', type: 'bytes32' },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export interface RotationCall {
  to: Address;
  data: Hex;
  value: string;
}

export interface BuildRotationInput {
  tokenId: bigint;
  diamondAddress: Address;
  proposed: AgentPolicyDraft;
  /** Computed permissionContextHash for the proposed policy (frontend supplies). */
  permissionContextHash: `0x${string}`;
  /**
   * Optional per-call override of the facet selector gating. Defaults to the
   * `BACKEND_POLICY_FACET_V2` config flag. Exposed so route handlers can
   * force legacy encoding for a single tokenId during the 48h cut window
   * without flipping the global flag.
   */
  useV2?: boolean;
}

const Q48 = 1n << 48n;

function usdToQ96(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('usdToQ96: invalid USD value');
  return BigInt(Math.floor(usd)) * Q48;
}

/**
 * Build the two-call userOp body for the atomic rotation. Returns the call
 * array; the frontend signs and submits via ZeroDev.
 *
 * Pure function. No I/O. No broadcasting.
 */
export function buildRotationCalls(input: BuildRotationInput): RotationCall[] {
  const { tokenId, diamondAddress, proposed, permissionContextHash } = input;
  const useV2 = input.useV2 ?? BACKEND_POLICY_FACET_V2;

  if (proposed.tokenId === null || proposed.tokenId !== tokenId) {
    throw new Error('buildRotationCalls: proposed.tokenId must equal input.tokenId');
  }

  const issuedAt = BigInt(proposed.draftedAt);
  const expiresAt = issuedAt + BigInt(proposed.durationDays) * 86_400n;

  // Daily window starts unset at install time; the facet rolls it forward
  // on first spend. Spent slot is zero for a fresh policy.
  const dailySpentUsdQ96Slot = 0n;
  const dailyWindowStart = 0n;

  const revokeData = encodeFunctionData({
    abi: POLICY_FACET_WRITE_ABI,
    functionName: 'revokePermission',
    args: [tokenId],
  });

  let installData: Hex;
  if (useV2) {
    const presetHash = (proposed.presetHash ?? ZERO_BYTES32) as `0x${string}`;
    const policyTupleV2 = {
      tokenId,
      permissionContextHash,
      allowedContracts: proposed.allowedContracts as readonly Address[],
      allowedSelectors: proposed.allowedSelectors as readonly Hex[],
      maxNotionalUsdQ96: usdToQ96(proposed.maxNotionalUsd),
      dailyCapUsdQ96: usdToQ96(proposed.dailyCapUsd),
      expiresAt,
      issuedAt,
      dailySpentUsdQ96Slot,
      dailyWindowStart,
      presetHash,
    };
    installData = encodeFunctionData({
      abi: POLICY_FACET_WRITE_ABI,
      functionName: 'installPermissionV2',
      args: [tokenId, policyTupleV2],
    });
  } else {
    const policyTupleLegacy = {
      tokenId,
      permissionContextHash,
      allowedContracts: proposed.allowedContracts as readonly Address[],
      allowedSelectors: proposed.allowedSelectors as readonly Hex[],
      maxNotionalUsdQ96: usdToQ96(proposed.maxNotionalUsd),
      dailyCapUsdQ96: usdToQ96(proposed.dailyCapUsd),
      expiresAt,
      issuedAt,
      dailySpentUsdQ96Slot,
      dailyWindowStart,
    };
    installData = encodeFunctionData({
      abi: POLICY_FACET_WRITE_ABI,
      functionName: 'installPermission',
      args: [tokenId, policyTupleLegacy],
    });
  }

  return [
    { to: diamondAddress, data: revokeData, value: '0' },
    { to: diamondAddress, data: installData, value: '0' },
  ];
}

/**
 * Re-export the view ABI so route handlers can `readContract({ abi: ... })`
 * for the current `getPolicy(tokenId)` snapshot without importing the broader
 * `abis.ts` module surface.
 */
export const POLICY_FACET_READ_ABI = ERC7715_POLICY_AUDIT_FACET_ABI;

/**
 * Test-only re-exports. Kept under an underscored namespace so consumers do
 * not import internals by accident.
 */
export const __internal = { POLICY_FACET_WRITE_ABI, ZERO_BYTES32 };
