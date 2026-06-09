import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  ENC_VERSION_CURRENT,
  decryptForUser,
  deriveUserKey,
  deserializeEnvelope,
  encryptForUser,
  getMasterKey,
  serializeEnvelope,
} from '../crypto.ts';

const VALID_KEY_B64_V1 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const VALID_KEY_B64_V2 = Buffer.from(new Uint8Array(32).fill(13)).toString('base64');

const saved: Record<string, string | undefined> = {};

const setEnv = (k: string, v: string | undefined): void => {
  saved[k] = process.env[k];
  if (v === undefined) {
    delete process.env[k];
  } else {
    process.env[k] = v;
  }
};

const restoreEnv = (): void => {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
};

describe('crypto envelope', () => {
  beforeEach(() => {
    setEnv('BACKEND_TOKEN_ENC_KEY', VALID_KEY_B64_V1);
    setEnv('BACKEND_TOKEN_ENC_KEY_NEXT', VALID_KEY_B64_V2);
  });

  afterEach(() => {
    restoreEnv();
  });

  test('getMasterKey returns 32 bytes for v1', () => {
    const k = getMasterKey(1);
    expect(k).toBeInstanceOf(Uint8Array);
    expect(k.length).toBe(32);
  });

  test('getMasterKey returns a different value for v2', () => {
    const k1 = getMasterKey(1);
    const k2 = getMasterKey(2);
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(false);
  });

  test('getMasterKey throws when env missing', () => {
    setEnv('BACKEND_TOKEN_ENC_KEY', undefined);
    expect(() => getMasterKey(1)).toThrow(/missing env var/);
  });

  test('getMasterKey throws on wrong-size key', () => {
    setEnv('BACKEND_TOKEN_ENC_KEY', Buffer.from(new Uint8Array(16).fill(1)).toString('base64'));
    expect(() => getMasterKey(1)).toThrow(/32 bytes/);
  });

  test('getMasterKey throws on unsupported version', () => {
    expect(() => getMasterKey(99)).toThrow(/unsupported encVersion/);
  });

  test('deriveUserKey is deterministic and 32 bytes', async () => {
    const m = getMasterKey(1);
    const a = await deriveUserKey(m, 'user-1', 1);
    const b = await deriveUserKey(m, 'user-1', 1);
    expect(a.length).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test('deriveUserKey is different per user', async () => {
    const m = getMasterKey(1);
    const a = await deriveUserKey(m, 'user-1', 1);
    const b = await deriveUserKey(m, 'user-2', 1);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test('deriveUserKey is different per encVersion', async () => {
    const m = getMasterKey(1);
    const a = await deriveUserKey(m, 'user-1', 1);
    const b = await deriveUserKey(m, 'user-1', 2);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test('encrypt/decrypt roundtrip', async () => {
    const m = getMasterKey(1);
    const userId = 'user-roundtrip';
    const plaintext = new TextEncoder().encode('hello-secret-token-abc123');

    const env = await encryptForUser(m, userId, plaintext);
    expect(env.v).toBe(ENC_VERSION_CURRENT);
    expect(env.nonce.length).toBe(12);

    const out = await decryptForUser(m, userId, env);
    expect(new TextDecoder().decode(out)).toBe('hello-secret-token-abc123');
  });

  test('decrypt with wrong user fails', async () => {
    const m = getMasterKey(1);
    const env = await encryptForUser(m, 'alice', new TextEncoder().encode('secret'));
    await expect(decryptForUser(m, 'bob', env)).rejects.toThrow();
  });

  test('tampered ciphertext fails auth tag', async () => {
    const m = getMasterKey(1);
    const userId = 'tamper-user';
    const env = await encryptForUser(m, userId, new TextEncoder().encode('secret'));

    const tampered = new Uint8Array(env.ct);
    tampered[0] = tampered[0] === 0 ? 1 : tampered[0] ^ 0x01;
    const evilEnv = { v: env.v, nonce: env.nonce, ct: tampered };

    await expect(decryptForUser(m, userId, evilEnv)).rejects.toThrow();
  });

  test('serialize/deserialize roundtrip', async () => {
    const m = getMasterKey(1);
    const userId = 'serialize-user';
    const plaintext = new TextEncoder().encode('payload-1234');

    const env = await encryptForUser(m, userId, plaintext);
    const bytes = serializeEnvelope(env);
    expect(bytes.length).toBe(12 + env.ct.length);

    const restored = deserializeEnvelope(bytes, env.v);
    expect(Buffer.from(restored.nonce).equals(Buffer.from(env.nonce))).toBe(true);
    expect(Buffer.from(restored.ct).equals(Buffer.from(env.ct))).toBe(true);

    const out = await decryptForUser(m, userId, restored);
    expect(new TextDecoder().decode(out)).toBe('payload-1234');
  });

  test('deserializeEnvelope rejects too-short input', () => {
    expect(() => deserializeEnvelope(new Uint8Array(10), 1)).toThrow(/too short/);
  });
});
