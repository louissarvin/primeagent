/**
 * EIP-712 attestation signer for the Robinhood MCP attestor contract.
 *
 * Per PrimeAgent.md Section 9.2 (Attestation Schema) and Section 7.8
 * (RobinhoodMcpAttestor). The backend holds a single ECDSA key
 * (BACKEND_ATTESTOR_PRIVATE_KEY) and signs typed-data attestations that
 * the on-chain verifier accepts via `recover(...)`.
 *
 * IMPORTANT: the on-chain `payloadHash` is `keccak256(abi.encode(uint256
 * tokenId, uint256 accountValueQ96, uint256 buyingPowerQ96))`. It is NOT a
 * hash of the full off-chain JSON payload. We keep the full state JSON in
 * the `Attestation.payloadJson` column purely as an audit log; only the
 * three Q96 numbers feed into the hash that the contract recovers from.
 *
 * This module ONLY handles the signing primitive plus a DB write of the
 * attestation row. The cron worker (`src/workers/attestPoster.ts`, Wave 2)
 * is the caller that batches state fetches and submits the signed payload
 * on-chain. We keep that boundary tight: this file does NOT call any
 * Robinhood APIs and does NOT broadcast transactions.
 *
 * Per-chain wiring (verifyingContract):
 *   - chainId 421614  -> BACKEND_ATTESTOR_ADDRESS_ARB_SEPOLIA  (Arbitrum Sepolia)
 *   - chainId 46630   -> BACKEND_ATTESTOR_ADDRESS_RH_CHAIN     (Robinhood Chain testnet)
 */

import {
  type Address,
  type Hex,
  encodeAbiParameters,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { prismaQuery } from './prisma.ts';

export interface OffChainPosition {
  symbol: string;
  qty: number;
  mark_cents: bigint;
}

/**
 * Off-chain account snapshot delivered by the MCP oracle. Stored in the
 * Attestation row as JSON for audit; not used for hashing.
 *
 * Wave RhChainAudit: the optional `rhChain` field carries the on-chain
 * RhChainSwap position snapshot (chain id 46630). Adding it changes the
 * canonicalised JSON bytes and therefore the value stored in
 * `Attestation.payloadJson`, but does NOT alter the EIP-712 typed-data
 * definition or the on-chain `payloadHash` (which still derives from
 * `(tokenId, accountValueQ96, buyingPowerQ96)`). See
 * `memory/stylus_compat_check_2026.md` for the engine-impact analysis.
 */
export interface OffChainState {
  account_id: string;
  account_value_cents: bigint;
  positions: OffChainPosition[];
  buying_power_cents: bigint;
  ts: number;
  /** Backwards-compatible v1 add-on; see RhChainPositionSnapshot. */
  rhChain?: RhChainPositionSnapshot;
}

export interface AttestationPayload {
  tokenId: bigint;
  /** keccak256(abi.encode(uint256 tokenId, uint256 accountValueQ96, uint256 buyingPowerQ96)) */
  payloadHash: Hex;
  notBefore: number;
  notAfter: number;
  nullifier: Hex;
}

export interface SignedAttestation extends AttestationPayload {
  signature: Hex;
  signer: Address;
  domainHash: Hex;
  /** EIP-712 digest: keccak256(0x1901 || domainSeparator || structHash). */
  digest: Hex;
  /** Pass-through of the two Q96 numbers the on-chain `attest` call requires. */
  accountValueQ96: bigint;
  buyingPowerQ96: bigint;
}

/**
 * Per-tokenId snapshot of the RhChainSwap position. The attestor combines
 * this with the Arb Sepolia vault balance + Robinhood off-chain state into
 * the audit payload so the Stylus margin engine sees the full cross-domain
 * picture in one read.
 *
 * Backwards-compatible v1 add-on: payloadHash is unchanged (still derived
 * from `(tokenId, accountValueQ96, buyingPowerQ96)`). v2 payloadHash will
 * incorporate the RH Chain leg when the protocol upgrades.
 */
export interface RhChainPositionSnapshot {
  swapAddress: Address;
  tokens: Address[];
  /** Per-token balances in the native decimals. */
  balances: string[];
  swapNonce: string;
  withdrawNonce: string;
  revokedAt: number;
  paused: boolean;
  owner: Address;
}

const DOMAIN_NAME = 'PrimeAgent.RobinhoodMcpAttestor';
const DOMAIN_VERSION = '1';

const TYPES = {
  Attestation: [
    { name: 'tokenId', type: 'uint256' },
    { name: 'payloadHash', type: 'bytes32' },
    { name: 'notBefore', type: 'uint64' },
    { name: 'notAfter', type: 'uint64' },
    { name: 'nullifier', type: 'bytes32' },
  ],
} as const;

const PAYLOAD_HASH_PARAMS = [
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint256' },
] as const;

const NULLIFIER_SALT_BYTES = 16;

function verifyingContractFor(chainId: number): Address {
  const envName =
    chainId === 421614
      ? 'BACKEND_ATTESTOR_ADDRESS_ARB_SEPOLIA'
      : chainId === 46630
        ? 'BACKEND_ATTESTOR_ADDRESS_RH_CHAIN'
        : null;

  if (!envName) {
    throw new Error(`no attestor address mapping for chainId ${chainId}`);
  }

  // Lazy env read intentionally; `main-config.ts` surfaces the names for
  // visibility but the production path still reads them here so that test
  // suites can mutate `process.env` per-test without re-importing.
  const value = process.env[envName];
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`env var ${envName} missing or not a 0x-prefixed address`);
  }
  return value as Address;
}

function getAttestorAccount() {
  const pk = process.env.BACKEND_ATTESTOR_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error('BACKEND_ATTESTOR_PRIVATE_KEY missing or not a 0x-prefixed 32-byte hex');
  }
  return privateKeyToAccount(pk as Hex);
}

function buildDomain(chainId: number) {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract: verifyingContractFor(chainId),
  } as const;
}

/**
 * Canonical JSON serializer used ONLY for the audit-log `payloadJson` field.
 * Keys are sorted recursively; bigints become decimal strings. This was
 * previously used to derive `payloadHash` as well; that was wrong because
 * the on-chain contract hashes three abi-encoded uint256 values rather
 * than a JSON blob. Do NOT call this from any hashing path.
 */
function canonicalize(value: unknown): string {
  const replacer = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map(replacer);
    if (v !== null && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      const sortedKeys = Object.keys(obj).sort();
      const out: Record<string, unknown> = {};
      for (const k of sortedKeys) {
        out[k] = replacer(obj[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(replacer(value));
}

/**
 * Derive `payloadHash` exactly as the on-chain contract does:
 *   keccak256(abi.encode(uint256 tokenId, uint256 accountValueQ96, uint256 buyingPowerQ96))
 * Match `RobinhoodMcpAttestor.attest` line 58.
 */
function payloadHashOf(
  tokenId: bigint,
  accountValueQ96: bigint,
  buyingPowerQ96: bigint,
): Hex {
  const encoded = encodeAbiParameters(PAYLOAD_HASH_PARAMS, [
    tokenId,
    accountValueQ96,
    buyingPowerQ96,
  ]);
  return keccak256(encoded);
}

function nullifierFor(tokenId: bigint, notBefore: number, salt: Uint8Array): Hex {
  // abi.encodePacked(uint256, uint64, bytes16) layout:
  //   32 bytes (tokenId, big-endian) || 8 bytes (notBefore, big-endian) || 16 bytes salt
  const buf = new Uint8Array(32 + 8 + salt.length);

  const tokenHex = tokenId.toString(16).padStart(64, '0');
  for (let i = 0; i < 32; i++) {
    buf[i] = parseInt(tokenHex.slice(i * 2, i * 2 + 2), 16);
  }

  const nbHex = BigInt(notBefore).toString(16).padStart(16, '0');
  for (let i = 0; i < 8; i++) {
    buf[32 + i] = parseInt(nbHex.slice(i * 2, i * 2 + 2), 16);
  }

  buf.set(salt, 40);
  return keccak256(buf);
}

/**
 * domainSeparator(EIP712Domain). Standard layout per EIP-712:
 *   keccak256(abi.encode(
 *     keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
 *     keccak256(bytes(name)),
 *     keccak256(bytes(version)),
 *     chainId,
 *     verifyingContract
 *   ))
 */
function domainSeparatorOf(chainId: number, verifyingContract: Address): Hex {
  const eip712TypeHash = keccak256(
    toBytes(
      'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
    ),
  );
  const nameHash = keccak256(toBytes(DOMAIN_NAME));
  const versionHash = keccak256(toBytes(DOMAIN_VERSION));

  const buf = new Uint8Array(32 * 5);
  buf.set(toBytes(eip712TypeHash), 0);
  buf.set(toBytes(nameHash), 32);
  buf.set(toBytes(versionHash), 64);

  const chainHex = BigInt(chainId).toString(16).padStart(64, '0');
  for (let i = 0; i < 32; i++) {
    buf[96 + i] = parseInt(chainHex.slice(i * 2, i * 2 + 2), 16);
  }

  const addrBytes = toBytes(verifyingContract);
  // address is 20 bytes; left-pad to 32
  buf.set(addrBytes, 128 + 12);

  return keccak256(buf);
}

/**
 * Signs an attestation for the given (tokenId, Q96 amounts, chainId) and
 * inserts a row into the Attestation table. The DB write enforces nullifier
 * uniqueness as a defence-in-depth on top of the on-chain replay check.
 *
 * The full off-chain state (cents-denominated) is passed through verbatim
 * as `payloadJson` for audit purposes only. It is NOT involved in the hash
 * or signature.
 */
export async function attestState(
  tokenId: bigint,
  accountValueQ96: bigint,
  buyingPowerQ96: bigint,
  payloadJson: unknown,
  chainId: number,
): Promise<SignedAttestation> {
  const account = getAttestorAccount();
  const verifyingContract = verifyingContractFor(chainId);
  const domain = buildDomain(chainId);

  const now = Math.floor(Date.now() / 1000);
  // 60s past-buffer: even small sequencer clock skew (block.timestamp lag of
  // 1-2s vs the off-chain wall clock) triggers AttestationFresh() in the
  // attestor contract. The contract accepts notBefore <= block.timestamp;
  // backing notBefore off by a minute is well within the 5-minute notAfter
  // window and aligns with the 30s future-skew rule in spec section 7.8.
  const notBefore = now - 60;
  const notAfter = now + 5 * 60;

  const salt = crypto.getRandomValues(new Uint8Array(NULLIFIER_SALT_BYTES));
  const nullifier = nullifierFor(tokenId, notBefore, salt);
  const payloadHash = payloadHashOf(tokenId, accountValueQ96, buyingPowerQ96);

  const message = {
    tokenId,
    payloadHash,
    notBefore: BigInt(notBefore),
    notAfter: BigInt(notAfter),
    nullifier,
  };

  const signature = await account.signTypedData({
    domain,
    types: TYPES,
    primaryType: 'Attestation',
    message,
  });

  const domainHash = domainSeparatorOf(chainId, verifyingContract);

  // EIP-712 digest = keccak256(0x1901 || domainSeparator || structHash).
  // Stored as `attestationHash` so the DB unique constraint matches the
  // index an external verifier would use.
  const structHash = computeStructHash(message);
  const digest = keccak256(
    concatBytes([new Uint8Array([0x19, 0x01]), toBytes(domainHash), toBytes(structHash)]),
  );

  // Canonical-JSON the audit payload so identical inputs yield identical
  // bytea (deterministic round-trip for support tooling). The hash above
  // does not depend on this representation.
  const auditJson = JSON.parse(canonicalize(payloadJson));

  await prismaQuery.attestation.create({
    data: {
      attestationHash: Buffer.from(toBytes(digest)),
      tokenId,
      payloadJson: auditJson as never,
      eip712DomainHash: Buffer.from(toBytes(domainHash)),
      signature: Buffer.from(toBytes(signature)),
      signer: account.address,
      notBefore: new Date(notBefore * 1000),
      notAfter: new Date(notAfter * 1000),
      nullifier: Buffer.from(toBytes(nullifier)),
    },
  });

  return {
    tokenId,
    payloadHash,
    notBefore,
    notAfter,
    nullifier,
    signature,
    signer: account.address,
    domainHash,
    digest,
    accountValueQ96,
    buyingPowerQ96,
  };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function computeStructHash(msg: {
  tokenId: bigint;
  payloadHash: Hex;
  notBefore: bigint;
  notAfter: bigint;
  nullifier: Hex;
}): Hex {
  const typeHash = keccak256(
    toBytes(
      'Attestation(uint256 tokenId,bytes32 payloadHash,uint64 notBefore,uint64 notAfter,bytes32 nullifier)',
    ),
  );
  const buf = new Uint8Array(32 * 6);
  buf.set(toBytes(typeHash), 0);

  // tokenId uint256
  const tokenHex = msg.tokenId.toString(16).padStart(64, '0');
  for (let i = 0; i < 32; i++) buf[32 + i] = parseInt(tokenHex.slice(i * 2, i * 2 + 2), 16);

  buf.set(toBytes(msg.payloadHash), 64);

  // notBefore uint64 padded to 32 bytes
  const nbHex = msg.notBefore.toString(16).padStart(64, '0');
  for (let i = 0; i < 32; i++) buf[96 + i] = parseInt(nbHex.slice(i * 2, i * 2 + 2), 16);

  // notAfter uint64 padded to 32 bytes
  const naHex = msg.notAfter.toString(16).padStart(64, '0');
  for (let i = 0; i < 32; i++) buf[128 + i] = parseInt(naHex.slice(i * 2, i * 2 + 2), 16);

  buf.set(toBytes(msg.nullifier), 160);
  return keccak256(buf);
}

/**
 * Verifies a signed attestation by recovering the signer from the EIP-712
 * typed-data signature and comparing to `expectedSigner` (case-insensitive
 * hex compare). Re-derives `payloadHash` from `(tokenId, accountValueQ96,
 * buyingPowerQ96)` and refuses the attestation if it does not match the
 * value carried in `a.payloadHash` (defence against a caller swapping the
 * hash post-signing).
 *
 * Returns false on any structural or signature mismatch rather than
 * throwing, so callers can branch cleanly.
 */
export async function verifyAttestation(
  a: SignedAttestation,
  chainId: number,
  expectedSigner: Address,
): Promise<boolean> {
  try {
    const expectedHash = payloadHashOf(a.tokenId, a.accountValueQ96, a.buyingPowerQ96);
    if (expectedHash.toLowerCase() !== a.payloadHash.toLowerCase()) {
      return false;
    }

    const domain = buildDomain(chainId);
    const message = {
      tokenId: a.tokenId,
      payloadHash: a.payloadHash,
      notBefore: BigInt(a.notBefore),
      notAfter: BigInt(a.notAfter),
      nullifier: a.nullifier,
    };

    const recovered = await recoverTypedDataAddress({
      domain,
      types: TYPES,
      primaryType: 'Attestation',
      message,
      signature: a.signature,
    });

    return recovered.toLowerCase() === expectedSigner.toLowerCase();
  } catch {
    return false;
  }
}

// Re-export internal helpers for tests only. Not part of the stable API.
export const __internal = {
  payloadHashOf,
  domainSeparatorOf,
  computeStructHash,
  nullifierFor,
  buildDomain,
  toHex,
};
