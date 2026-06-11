/**
 * Pure policy diff. Compares an `AgentPolicyOnChain` (current state read from
 * the audit facet) against an `AgentPolicyDraft` (the operator's proposed
 * change) and returns a structured `PolicyDiff`.
 *
 * Pure function. No I/O. Used by `POST /api/agent/:tokenId/policy/diff` and
 * by `rotation.ts` to populate the human-readable summary in the dual-sign UI.
 *
 * Hard rule from spec section 1.4: `blockers` MUST be non-empty when the
 * proposed policy violates an invariant the on-chain validator would also
 * reject (duration > 90d, empty allowlists, etc.). The Zod schema already
 * enforces most of these at parse time; `blockers` here covers
 * relationship-level invariants (e.g. lowering dailyCap below today's spent).
 */

import { keccak256, toBytes } from 'viem';
import type { AgentPolicyDraft, AgentPolicyOnChain } from './schemas.ts';

export type PolicyDiffOp =
  | {
      kind: 'set';
      field:
        | 'maxNotionalUsd'
        | 'dailyCapUsd'
        | 'durationDays'
        | 'strategyName'
        | 'presetId';
      before: unknown;
      after: unknown;
    }
  | {
      kind: 'add';
      field: 'allowedSymbols' | 'allowedContracts' | 'allowedSelectors';
      values: string[];
    }
  | {
      kind: 'remove';
      field: 'allowedSymbols' | 'allowedContracts' | 'allowedSelectors';
      values: string[];
    };

export interface PolicyDiff {
  tokenId: bigint;
  fromHash: `0x${string}`;
  toHash: `0x${string}`;
  ops: PolicyDiffOp[];
  warnings: string[];
  blockers: string[];
}

/**
 * Canonical hash of an `AgentPolicyDraft` used as the `toHash` field. The
 * hash domain is keccak256 over a stable JSON serialization with bigint
 * stringification. Field ordering is alphabetical so the hash is
 * implementation-independent.
 *
 * IMPORTANT: this hash is for the diff view only. The on-chain
 * `permissionContextHash` is computed by the Diamond's audit facet using a
 * different domain; never substitute one for the other.
 */
export function hashAgentPolicyDraft(draft: AgentPolicyDraft): `0x${string}` {
  const obj = {
    allowedContracts: [...draft.allowedContracts].map((s) => s.toLowerCase()),
    allowedSelectors: [...draft.allowedSelectors].map((s) => s.toLowerCase()),
    allowedSymbols: [...draft.allowedSymbols],
    clientId: draft.clientId,
    dailyCapUsd: draft.dailyCapUsd,
    draftedAt: draft.draftedAt,
    durationDays: draft.durationDays,
    maxNotionalUsd: draft.maxNotionalUsd,
    presetHash: draft.presetHash,
    presetId: draft.presetId,
    strategyName: draft.strategyName,
    tokenId: draft.tokenId === null ? null : draft.tokenId.toString(),
  };
  // Sort keys deterministically (object literal above is already alphabetical
  // but we re-sort defensively).
  const sortedKeys = Object.keys(obj).sort();
  const canonical =
    '{' +
    sortedKeys
      .map((k) => JSON.stringify(k) + ':' + JSON.stringify((obj as Record<string, unknown>)[k]))
      .join(',') +
    '}';
  return keccak256(toBytes(canonical));
}

function diffSets(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before.map((s) => s.toLowerCase()));
  const afterSet = new Set(after.map((s) => s.toLowerCase()));
  const added: string[] = [];
  const removed: string[] = [];
  for (const v of afterSet) if (!beforeSet.has(v)) added.push(v);
  for (const v of beforeSet) if (!afterSet.has(v)) removed.push(v);
  return { added, removed };
}

/**
 * Compute the structured diff between the live on-chain policy and the
 * operator's proposed draft.
 *
 * `current` MUST be freshly read from the chain (per Risk #4 in the
 * IMPLEMENTATION_PLAN); never trust a local cache.
 */
export function diffPolicies(
  current: AgentPolicyOnChain,
  proposed: AgentPolicyDraft,
): PolicyDiff {
  const ops: PolicyDiffOp[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  if (current.maxNotionalUsd !== proposed.maxNotionalUsd) {
    ops.push({
      kind: 'set',
      field: 'maxNotionalUsd',
      before: current.maxNotionalUsd,
      after: proposed.maxNotionalUsd,
    });
  }
  if (current.dailyCapUsd !== proposed.dailyCapUsd) {
    ops.push({
      kind: 'set',
      field: 'dailyCapUsd',
      before: current.dailyCapUsd,
      after: proposed.dailyCapUsd,
    });
    if (proposed.dailyCapUsd < current.dailyCapUsd / 2) {
      warnings.push(
        `Lowering daily cap from $${current.dailyCapUsd.toLocaleString()} to $${proposed.dailyCapUsd.toLocaleString()} (more than 50% reduction).`,
      );
    }
  }
  if (current.durationDays !== proposed.durationDays) {
    ops.push({
      kind: 'set',
      field: 'durationDays',
      before: current.durationDays,
      after: proposed.durationDays,
    });
  }
  if (current.strategyName !== proposed.strategyName) {
    ops.push({
      kind: 'set',
      field: 'strategyName',
      before: current.strategyName,
      after: proposed.strategyName,
    });
  }
  if (current.presetId !== proposed.presetId) {
    ops.push({
      kind: 'set',
      field: 'presetId',
      before: current.presetId,
      after: proposed.presetId,
    });
  }

  // Set-valued fields
  const sym = diffSets(current.allowedSymbols, proposed.allowedSymbols);
  if (sym.added.length > 0) {
    ops.push({ kind: 'add', field: 'allowedSymbols', values: sym.added });
  }
  if (sym.removed.length > 0) {
    ops.push({ kind: 'remove', field: 'allowedSymbols', values: sym.removed });
  }

  const con = diffSets(current.allowedContracts, proposed.allowedContracts);
  if (con.added.length > 0) {
    ops.push({ kind: 'add', field: 'allowedContracts', values: con.added });
  }
  if (con.removed.length > 0) {
    ops.push({ kind: 'remove', field: 'allowedContracts', values: con.removed });
  }

  const sel = diffSets(current.allowedSelectors, proposed.allowedSelectors);
  if (sel.added.length > 0) {
    ops.push({ kind: 'add', field: 'allowedSelectors', values: sel.added });
  }
  if (sel.removed.length > 0) {
    ops.push({ kind: 'remove', field: 'allowedSelectors', values: sel.removed });
  }

  // Hard invariants the on-chain validator also enforces. The Zod schema
  // catches most of these at the boundary, but we re-check to surface
  // human-readable reasons on the diff response.
  if (proposed.durationDays > 90) {
    blockers.push('Duration must be 90 days or less (ERC-7715 hygiene).');
  }
  if (proposed.durationDays < 1) {
    blockers.push('Duration must be at least 1 day.');
  }
  if (proposed.allowedSelectors.length === 0) {
    blockers.push('At least one allowed selector is required.');
  }
  if (proposed.allowedContracts.length === 0) {
    blockers.push('At least one allowed contract is required.');
  }
  if (proposed.allowedSymbols.length === 0) {
    blockers.push('At least one allowed symbol is required.');
  }

  return {
    tokenId: current.tokenId,
    fromHash: current.permissionContextHash as `0x${string}`,
    toHash: hashAgentPolicyDraft(proposed),
    ops,
    warnings,
    blockers,
  };
}
