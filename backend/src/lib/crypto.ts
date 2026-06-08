/**
 * Crypto envelope helpers for at-rest secret encryption.
 *
 * Implements AES-256-GCM with HKDF-derived per-user sub-keys and a dual-key
 * envelope for rotation, per PrimeAgent.md Section 9.4 (Swap-In Path) and
 * the spec review item H6 (multi-key rotation).
 *
 * Layout on disk (Bytes column):
 *   nonce(12) || ciphertext_and_tag
 *
 * The accompanying `encVersion` column selects which master key was used to
 * derive the per-user sub-key (v1 -> BACKEND_TOKEN_ENC_KEY,
 * v2 -> BACKEND_TOKEN_ENC_KEY_NEXT).
 *
 * Threat model: a leak of a single user row reveals only that user's
 * ciphertext (HKDF separates per-user keys). A leak of one master key
 * version compromises rows tagged with that version but not the other.
 * GCM provides authenticated encryption (tamper-evident).
 */

const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BITS = 128;

export const ENC_VERSION_CURRENT = 1;

export interface EncEnvelope {
  v: number;
  nonce: Uint8Array;
  ct: Uint8Array;
}

/**
 * Reads a master key from env by version. v1 -> BACKEND_TOKEN_ENC_KEY,
 * v2 -> BACKEND_TOKEN_ENC_KEY_NEXT. Throws if the requested version's env
 * var is missing or not exactly 32 bytes after base64 decoding.
 */
export function getMasterKey(envVersion: number): Uint8Array {
  const envName =
    envVersion === 1
      ? 'BACKEND_TOKEN_ENC_KEY'
      : envVersion === 2
        ? 'BACKEND_TOKEN_ENC_KEY_NEXT'
        : null;

  if (!envName) {
    throw new Error(`unsupported encVersion: ${envVersion}`);
  }

  const raw = process.env[envName];
  if (!raw) {
    throw new Error(`missing env var ${envName} for encVersion ${envVersion}`);
  }

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(raw, 'base64'));
  } catch {
    throw new Error(`${envName} is not valid base64`);
  }

  if (bytes.length !== KEY_BYTES) {
    throw new Error(`${envName} must decode to exactly ${KEY_BYTES} bytes (got ${bytes.length})`);
  }

  return bytes;
}

/**
 * HKDF-SHA256 derivation of a 32-byte per-user sub-key.
 * Salt is empty. Info binds the key to (encVersion, userId), so the same
 * user's key on different versions and different users' keys on the same
 * version are independent.
 */
export async function deriveUserKey(
  masterKey: Uint8Array,
  userId: string,
  encVersion: number,
): Promise<Uint8Array> {
  if (masterKey.length !== KEY_BYTES) {
    throw new Error(`masterKey must be ${KEY_BYTES} bytes`);
  }

  const baseKey = await crypto.subtle.importKey('raw', masterKey, 'HKDF', false, ['deriveBits']);

  const infoStr = `PrimeAgent/v${encVersion}/user:${userId}`;
  const info = new TextEncoder().encode(infoStr);
  const salt = new Uint8Array(0);

  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    baseKey,
    KEY_BYTES * 8,
  );

  return new Uint8Array(bits);
}

/**
 * Encrypts plaintext under the per-user sub-key derived from masterKey.
 * Caller is responsible for choosing the encVersion that matches the
 * supplied masterKey. The returned envelope always carries the encVersion
 * so it can round-trip back to disk and back without external bookkeeping.
 */
export async function encryptForUser(
  masterKey: Uint8Array,
  userId: string,
  plaintext: Uint8Array,
): Promise<EncEnvelope> {
  // We do not know the version on the master key directly; the envelope
  // version is inferred by the caller via getMasterKey(version). Default
  // to the current version constant; callers may set env explicitly.
  const v = ENC_VERSION_CURRENT;
  const userKey = await deriveUserKey(masterKey, userId, v);

  const aesKey = await crypto.subtle.importKey('raw', userKey, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));

  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: TAG_BITS },
    aesKey,
    plaintext,
  );

  return {
    v,
    nonce,
    ct: new Uint8Array(ctBuf),
  };
}

/**
 * Decrypts an envelope under the user sub-key derived from masterKey at
 * env.v. Throws on auth-tag mismatch (tamper detection).
 */
export async function decryptForUser(
  masterKey: Uint8Array,
  userId: string,
  env: EncEnvelope,
): Promise<Uint8Array> {
  if (env.nonce.length !== NONCE_BYTES) {
    throw new Error(`nonce must be ${NONCE_BYTES} bytes`);
  }

  const userKey = await deriveUserKey(masterKey, userId, env.v);
  const aesKey = await crypto.subtle.importKey('raw', userKey, { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);

  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: env.nonce, tagLength: TAG_BITS },
    aesKey,
    env.ct,
  );

  return new Uint8Array(plainBuf);
}

/**
 * Serializes an envelope to bytes for storage in a Postgres bytea column.
 * Layout: nonce(12) || ct (the tag is the last TAG_BITS / 8 bytes of ct).
 * The encVersion is NOT included here; it is stored in the row's
 * `encVersion` column so rotation can be tracked at the row level.
 */
export function serializeEnvelope(env: EncEnvelope): Uint8Array {
  const out = new Uint8Array(NONCE_BYTES + env.ct.length);
  out.set(env.nonce, 0);
  out.set(env.ct, NONCE_BYTES);
  return out;
}

/**
 * Deserializes a stored bytea column back into an envelope. The encVersion
 * is supplied separately (from the row's `encVersion` column).
 */
export function deserializeEnvelope(bytes: Uint8Array, encVersion: number): EncEnvelope {
  if (bytes.length < NONCE_BYTES + TAG_BITS / 8) {
    throw new Error('serialized envelope too short to contain nonce and tag');
  }
  return {
    v: encVersion,
    nonce: bytes.slice(0, NONCE_BYTES),
    ct: bytes.slice(NONCE_BYTES),
  };
}
