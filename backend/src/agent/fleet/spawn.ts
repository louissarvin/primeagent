/**
 * Bot-builds-bot fleet orchestrator (Feature D).
 *
 * Returns a batched userOp call array; the frontend signs once via the
 * ZeroDev Kernel. The backend does NOT broadcast.
 *
 * Per spec section 1.5: `count` capped at 10. Per spec risk #9: each child
 * gets a unique `permissionContextHash` derived from
 * `keccak256(abi.encodePacked(basePolicyHash, uint16(childIndex)))` so
 * revocation can target individual fleet members.
 */

import { encodeFunctionData, keccak256, concat, numberToHex, type Address, type Hex } from 'viem';

import { hashAgentPolicyDraft } from '../policy/diff.ts';
import type { FleetMember, FleetResult, FleetSpec } from './schemas.ts';

// Factory ABI fragment for `deployAgent`. Mirrors the canonical signature
// `deployAgent(address user, address baseAsset, LibPolicy.Policy calldata policy, string agentURI)`.
//
// Feature C / Option B: the `LibPolicy.Policy` tuple now carries 11 fields
// (ending with `bytes32 presetHash`). The factory forwards the struct to
// `Erc7715PolicyAuditFacet.installPermissionV2`; passing the legacy
// 10-field shape reverts with `InvalidPresetHash` or decode failure.
// Field order MUST mirror `contracts/src/libraries/LibPolicy.sol` verbatim.
//
// Note: `tokenId` on the input tuple MUST be zero. The factory rejects
// non-zero values (`PolicyTokenIdMustBeZero`) and stamps the actual minted
// token id via `_stampPolicyTokenId` before forwarding to the facet.
const FACTORY_DEPLOY_AGENT_ABI = [
  {
    type: 'function',
    name: 'deployAgent',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'baseAsset', type: 'address' },
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
      { name: 'agentURI', type: 'string' },
    ],
    outputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'vault', type: 'address' },
      { name: 'tba', type: 'address' },
      { name: 'agentId', type: 'uint256' },
    ],
  },
] as const;

const Q48 = 1n << 48n;
function usdToQ96(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('usdToQ96: invalid USD value');
  return BigInt(Math.floor(usd)) * Q48;
}

export interface FleetSpawnCalls {
  to: Address;
  data: Hex;
  value: string;
}

export interface FleetSpawnPlan {
  clientId: string;
  calls: FleetSpawnCalls[];
  expectedMembers: Array<{
    index: number;
    name: string;
    permissionContextHash: `0x${string}`;
  }>;
}

export interface BuildFleetPlanInput {
  spec: FleetSpec;
  factoryAddress: Address;
  baseAsset: Address;
  /** EVM address that will own the deployed NFTs (operator wallet). */
  ownerAddress: Address;
  agentUriTemplate: string;
}

/**
 * Compute the per-child unique `permissionContextHash`. Pattern per spec
 * section 4 risk #9:
 *   `keccak256(abi.encodePacked(basePolicyHash, uint16(childIndex)))`.
 */
export function deriveChildContextHash(
  basePolicyHash: `0x${string}`,
  childIndex: number,
): `0x${string}` {
  if (childIndex < 0 || childIndex > 65_535) {
    throw new Error('deriveChildContextHash: childIndex must fit uint16');
  }
  const indexHex = numberToHex(childIndex, { size: 2 });
  return keccak256(concat([basePolicyHash, indexHex]));
}

/**
 * Build the bundled userOp body for N agent deployments. Pure function. No
 * I/O. No broadcasting.
 */
export function buildFleetPlan(input: BuildFleetPlanInput): FleetSpawnPlan {
  const { spec, factoryAddress, baseAsset, ownerAddress, agentUriTemplate } = input;
  if (spec.count < 1 || spec.count > 10) {
    throw new Error('buildFleetPlan: count must be 1..10');
  }

  const basePolicyHash = hashAgentPolicyDraft(spec.policy);
  const issuedAt = BigInt(spec.policy.draftedAt);
  const expiresAt = issuedAt + BigInt(spec.policy.durationDays) * 86_400n;

  // `presetHash` propagation. The on-chain facet (`isCanonicalPresetHash`)
  // accepts only one of the five canonical preset hashes OR `bytes32(0)`
  // for custom, so EVERY fleet member shares the basePolicy preset hash.
  // The per-child uniqueness lives on `permissionContextHash` (derived via
  // `keccak256(basePolicyHash || uint16(childIndex))` per architect plan
  // section 4 / risk #9) so the indexer can attribute fills to a specific
  // child while preserving the preset-family certification.
  const presetHash = (spec.policy.presetHash ?? ('0x' + '0'.repeat(64))) as `0x${string}`;

  const calls: FleetSpawnCalls[] = [];
  const expectedMembers: FleetSpawnPlan['expectedMembers'] = [];

  for (let i = 0; i < spec.count; i++) {
    const permissionContextHash = deriveChildContextHash(basePolicyHash, i);
    const name = spec.nameTemplate.replace('#{n}', String(i + 1));
    const agentUri = agentUriTemplate.replace('#{n}', String(i + 1));

    const data = encodeFunctionData({
      abi: FACTORY_DEPLOY_AGENT_ABI,
      functionName: 'deployAgent',
      args: [
        ownerAddress,
        baseAsset,
        {
          // tokenId is stamped by the factory; must be zero on input.
          tokenId: 0n,
          permissionContextHash,
          allowedContracts: spec.policy.allowedContracts as readonly Address[],
          allowedSelectors: spec.policy.allowedSelectors as readonly Hex[],
          maxNotionalUsdQ96: usdToQ96(spec.policy.maxNotionalUsd),
          dailyCapUsdQ96: usdToQ96(spec.policy.dailyCapUsd),
          expiresAt,
          issuedAt,
          dailySpentUsdQ96Slot: 0n,
          dailyWindowStart: 0n,
          presetHash,
        },
        agentUri,
      ],
    });

    calls.push({ to: factoryAddress, data, value: '0' });
    expectedMembers.push({ index: i, name, permissionContextHash });
  }

  return { clientId: spec.clientId, calls, expectedMembers };
}

// ----- Members from receipt -----
// After the frontend submits the userOp, it POSTs the txHash back; the
// indexer's existing `AgentDeployed` watcher writes the per-child
// `AgentPolicy` rows. We expose a typed `FleetMember` so the route handler
// can return the planned members synchronously.

export function planToProvisionalMembers(plan: FleetSpawnPlan): FleetMember[] {
  return plan.expectedMembers.map((m) => ({
    tokenId: 0n,
    vault: ('0x' + '0'.repeat(40)) as `0x${string}`,
    tba: ('0x' + '0'.repeat(40)) as `0x${string}`,
    agentId: 0n,
    txHash: ('0x' + '0'.repeat(64)) as `0x${string}`,
    name: m.name,
    permissionContextHash: m.permissionContextHash,
  }));
}

export function emptyFleetResult(spec: FleetSpec): FleetResult {
  return { clientId: spec.clientId, members: [], errors: [] };
}
