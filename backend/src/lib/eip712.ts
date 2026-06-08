/**
 * Thin wrapper around viem's `signTypedData` so the price-oracle poster and
 * the Robinhood MCP attestation paths share one helper. Exists to keep the
 * call shape consistent and to make future codepaths (e.g. ZeroDev Kernel
 * payload signing) trivially swap-in.
 *
 * Intentionally thin: do not add validation or domain-defaulting here. The
 * callers are responsible for assembling the typed-data, since the EIP-712
 * type definitions vary per call site.
 */

import type { Hex, LocalAccount, TypedDataDomain } from 'viem';

export type EIP712Types = Record<string, ReadonlyArray<{ name: string; type: string }>>;

/**
 * Signs an EIP-712 typed-data payload with the given `LocalAccount`. Returns
 * the 65-byte ECDSA signature as 0x-prefixed hex. Delegates entirely to
 * viem's `signTypedData`; this wrapper exists for call-site uniformity.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function signTypedDataWith(
  account: LocalAccount,
  domain: TypedDataDomain,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  types: any,
  primaryType: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: Record<string, any>,
): Promise<Hex> {
  return account.signTypedData({
    domain,
    types,
    primaryType,
    message,
  });
}
