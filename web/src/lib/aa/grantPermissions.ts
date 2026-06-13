/**
 * grantPermissions — ERC-7715 `wallet_grantPermissions` helper.
 *
 * EIP-7715 (Draft, 2025) defines `wallet_grantPermissions` so a dApp can ask
 * the wallet to mint a session key (the "signer") with scoped permissions.
 * Today only MetaMask Smart Accounts Kit (Flask 13.5+) implements the RPC;
 * other wallets return `-32601 Method not found`. We feature-detect and let
 * callers skip gracefully.
 *
 * Two-stage policy model (PrimeAgent.md §7.7):
 *   1. On-chain audit policy: stored by `Erc7715PolicyAuditFacet` at mint.
 *      `permissionContextHash` is keccak256(permissionsContext) and acts as a
 *      verifiable pointer to the wallet-side grant.
 *   2. Kernel-side enforcement: `PrimeAgentCallPolicyValidator` (Kernel
 *      module) checks the userOp signer against the granted permissions at
 *      runtime. Out of scope for B4; B4 only wires the grant + hash.
 *
 * When the wallet does not support the RPC, we still mint the agent but the
 * audit `permissionContextHash` stays at zero. The dashboard surfaces this
 * as a degraded state.
 */

import { keccak256, toHex } from 'viem'
import type { WalletClient, Chain, Transport, Account } from 'viem'

type ConnectedWalletClient = WalletClient<Transport, Chain | undefined, Account>

export interface GrantPermissionsArgs {
  walletClient: ConnectedWalletClient
  chainId: number
  /** Address that will use the session key. For PrimeAgent, the agent runtime delegate. */
  signerAddress: `0x${string}`
  /** Contract addresses the session key can call. */
  allowedContracts: Array<`0x${string}`>
  /** Hard expiry (unix seconds). */
  expirySec: number
  /** Hard cap on USD-denominated activity. Not enforced by the wallet, only echoed. */
  maxNotionalUsd: number
}

export interface GrantPermissionsResult {
  /** Hex-encoded ERC-7715 permissionsContext. Hash it for the audit policy. */
  permissionsContext: `0x${string}`
  /** keccak256(permissionsContext). Goes into Policy.permissionContextHash. */
  permissionContextHash: `0x${string}`
  /** Raw wallet response. Useful for debugging; do not log. */
  raw: unknown
}

export class GrantPermissionsUnsupportedError extends Error {
  constructor() {
    super('Wallet does not implement wallet_grantPermissions (ERC-7715).')
    this.name = 'GrantPermissionsUnsupportedError'
  }
}

/**
 * Returns true when the wallet supports `wallet_grantPermissions`.
 *
 * Detection strategy: call with a deliberately-minimal payload and inspect
 * the error code. -32601 means the method is unknown. Other errors mean the
 * method exists but rejected the payload, which still counts as supported.
 *
 * In practice we just call `grantPermissions` and catch
 * `GrantPermissionsUnsupportedError`; this helper is exported for callers
 * that want to gate UI affordances upfront.
 */
export async function isGrantPermissionsSupported(
  walletClient: ConnectedWalletClient,
): Promise<boolean> {
  try {
    // Minimal probe. Any wallet that knows the method will reject this
    // payload (missing required fields) instead of returning -32601.
    await walletClient.request({
      method: 'wallet_grantPermissions' as unknown as 'wallet_grantPermissions',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: [{}] as any,
    })
    return true
  } catch (err) {
    if (isMethodNotFound(err)) return false
    return true
  }
}

/**
 * Request a permission grant. Throws `GrantPermissionsUnsupportedError`
 * (caller-handleable) when the wallet does not implement the RPC.
 */
export async function grantPermissions(
  args: GrantPermissionsArgs,
): Promise<GrantPermissionsResult> {
  const request = {
    chainId: toHex(args.chainId),
    expiry: args.expirySec,
    signer: {
      type: 'account',
      data: { address: args.signerAddress },
    },
    permissions: args.allowedContracts.map((contract) => ({
      type: 'contract-call',
      data: { address: contract },
      // `policies` is required per EIP-7715 even if empty.
      policies: [],
      required: true,
    })),
    // Off-spec extra hint the wallet may surface in the consent screen.
    meta: {
      maxNotionalUsd: args.maxNotionalUsd,
      app: 'PrimeAgent',
    },
  }

  let raw: unknown
  try {
    raw = await args.walletClient.request({
      method: 'wallet_grantPermissions' as unknown as 'wallet_grantPermissions',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: [request] as any,
    })
  } catch (err) {
    if (isMethodNotFound(err)) throw new GrantPermissionsUnsupportedError()
    throw err
  }

  // EIP-7715 response shape (draft): `{ permissionsContext: '0x...', ... }`.
  // Some wallets return an array of contexts (one per requested permission);
  // the audit hash should cover the canonical string. We accept either.
  const permissionsContext = extractPermissionsContext(raw)
  if (!permissionsContext) {
    throw new Error('wallet_grantPermissions returned no permissionsContext')
  }

  const permissionContextHash = keccak256(permissionsContext)

  return { permissionsContext, permissionContextHash, raw }
}

function extractPermissionsContext(raw: unknown): `0x${string}` | null {
  if (!raw) return null
  // Array response: hash the concatenation of all contexts (stable order).
  if (Array.isArray(raw)) {
    const parts: string[] = []
    for (const item of raw) {
      const c = readContext(item)
      if (c) parts.push(c)
    }
    if (parts.length === 0) return null
    return ('0x' + parts.map((p) => p.replace(/^0x/, '')).join('')) as `0x${string}`
  }
  return readContext(raw)
}

function readContext(item: unknown): `0x${string}` | null {
  if (typeof item !== 'object' || item === null) return null
  const obj = item as Record<string, unknown>
  const v = obj.permissionsContext ?? obj.context ?? obj.signerMeta
  if (typeof v === 'string' && v.startsWith('0x')) return v as `0x${string}`
  return null
}

function isMethodNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: number; message?: string; cause?: { code?: number } }
  if (e.code === -32601) return true
  if (e.cause?.code === -32601) return true
  const msg = (e.message ?? '').toLowerCase()
  return msg.includes('method not found') || msg.includes('unsupported method')
}
