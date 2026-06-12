/**
 * Mints a SIWE-backed session JWT for the deployer EOA against the local
 * backend (defaults to http://localhost:3700). Used by the runtime smoke
 * test in the quick-fixes wave to exercise `/api/agent/0/*` without a
 * wallet UI.
 *
 * SECURITY: never log the full DEPLOYER_PRIVATE_KEY. The key is read from
 * `contracts/.env` (the canonical project source) and is only passed to
 * viem's `privateKeyToAccount` in-memory. The script prints the resulting
 * JWT to stdout so the caller can capture it into a shell variable.
 *
 * Usage:
 *   bun run scripts/get-deployer-jwt.ts
 *
 * Env knobs:
 *   BACKEND_URL   (default: http://localhost:3700)
 *   SIWE_DOMAIN   (default: localhost)
 *   SIWE_CHAIN_ID (default: 421614 — Arbitrum Sepolia)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

const BACKEND_URL =
  process.env.BACKEND_URL?.replace(/\/$/, '') ?? 'http://localhost:3700';
const SIWE_DOMAIN = process.env.SIWE_DOMAIN ?? 'localhost';
const SIWE_CHAIN_ID = Number(process.env.SIWE_CHAIN_ID ?? '421614');

function readDeployerKey(): `0x${string}` {
  if (process.env.DEPLOYER_PRIVATE_KEY) {
    return normaliseHex(process.env.DEPLOYER_PRIVATE_KEY);
  }
  // Fallback: parse contracts/.env directly (no dotenv coupling).
  const envPath = resolve(
    import.meta.dir,
    '..',
    '..',
    'contracts',
    '.env',
  );
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    if (k !== 'DEPLOYER_PRIVATE_KEY') continue;
    const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    return normaliseHex(v);
  }
  throw new Error('DEPLOYER_PRIVATE_KEY not found in env or contracts/.env');
}

function normaliseHex(v: string): `0x${string}` {
  const stripped = v.startsWith('0x') ? v.slice(2) : v;
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new Error('DEPLOYER_PRIVATE_KEY is not a valid 32-byte hex string');
  }
  return `0x${stripped}` as `0x${string}`;
}

async function main(): Promise<void> {
  const pk = readDeployerKey();
  const account = privateKeyToAccount(pk);
  const address = account.address;

  // Step 1: request a SIWE nonce + EIP-4361 message from the backend.
  const nonceRes = await fetch(`${BACKEND_URL}/auth/siwe/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address,
      chainId: SIWE_CHAIN_ID,
      domain: SIWE_DOMAIN,
      uri: `http://${SIWE_DOMAIN}:3700`,
    }),
  });
  if (!nonceRes.ok) {
    throw new Error(
      `siwe/nonce ${nonceRes.status}: ${await nonceRes.text()}`,
    );
  }
  const nonceJson = (await nonceRes.json()) as {
    data: { message: string; nonce: string; expiresAt: string };
  };
  const message = nonceJson.data.message;

  // Step 2: sign the message with the deployer key (personal_sign / EIP-191).
  const signature = await account.signMessage({ message });

  // Step 3: present message + signature to /verify and capture the JWT.
  const verifyRes = await fetch(`${BACKEND_URL}/auth/siwe/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });
  if (!verifyRes.ok) {
    throw new Error(
      `siwe/verify ${verifyRes.status}: ${await verifyRes.text()}`,
    );
  }
  const verifyJson = (await verifyRes.json()) as {
    data: { token: string };
  };
  // Stdout: only the bare token so callers can capture cleanly.
  process.stdout.write(verifyJson.data.token + '\n');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
