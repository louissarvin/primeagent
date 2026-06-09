/**
 * Robinhood OAuth 2.1 with PKCE per PrimeAgent.md section 9.5.
 *
 * Flow:
 *   1) startAuthorization() generates `state` + `code_verifier` + `code_challenge`,
 *      persists OAuthState (with encrypted verifier), and returns the authorize URL.
 *   2) The user is redirected to Robinhood, signs in, and gets bounced back to our
 *      callback with `code` + `state`.
 *   3) completeAuthorization() trades the `code` + `code_verifier` for access +
 *      refresh tokens, encrypts them, and upserts RobinhoodCredential.
 *
 * Security:
 *   - `code_verifier` is encrypted at rest (AES-256-GCM, per-user HKDF-derived sub-key).
 *   - access/refresh tokens are encrypted at rest under the same scheme.
 *   - OAuthState is single-use (consumedAt) with a 10-minute expiry.
 *   - Token endpoint auth method is `none` (PKCE-only), per RFC 7636 + the
 *     Robinhood spec; no Authorization header is sent.
 *   - Tokens are never logged in full. Truncate to 6 chars + ellipsis.
 *
 * `client_id` resolution:
 *   - `ROBINHOOD_USE_DCR=true` -> POST DCR endpoint (RFC 7591), cache for process lifetime.
 *   - `ROBINHOOD_USE_DCR=false` -> use hardcoded `ROBINHOOD_CLIENT_ID` from env.
 */

import { z } from 'zod';
import {
  ROBINHOOD_AUTHORIZE_URL,
  ROBINHOOD_CLIENT_ID,
  ROBINHOOD_DCR_URL,
  ROBINHOOD_REQUIRED_SCOPE,
  ROBINHOOD_TOKEN_URL,
  ROBINHOOD_USE_DCR,
} from '../config/main-config.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { forSvc } from '../lib/logger.ts';
import {
  decryptForUser,
  deserializeEnvelope,
  encryptForUser,
  getMasterKey,
  serializeEnvelope,
} from '../lib/crypto.ts';

const ENC_VERSION = 1;
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_SAFETY_SEC = 60;
const NEAR_EXPIRY_SEC = 30;

const log = forSvc('oauth');

// ----- Errors -----

export class RobinhoodOAuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RobinhoodOAuthError';
    this.code = code;
  }
}

export class RobinhoodCredentialMissing extends Error {
  code = 'RH_CRED_MISSING';
  constructor(userId: string) {
    super(`No active Robinhood credential for user ${userId}`);
    this.name = 'RobinhoodCredentialMissing';
  }
}

// ----- DCR client_id cache -----

let cachedClientId: string | null = null;

const DcrResponseSchema = z.object({
  client_id: z.string().min(1),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().optional().default(''),
  token_type: z.string().optional(),
});

/**
 * Resolves the OAuth client_id. Static when DCR is disabled, dynamic + cached
 * when enabled. Cache lives for the process lifetime; restart to re-register.
 */
export async function getClientId(): Promise<string> {
  if (!ROBINHOOD_USE_DCR) {
    if (!ROBINHOOD_CLIENT_ID) {
      throw new RobinhoodOAuthError(
        'RH_CLIENT_ID_MISSING',
        'ROBINHOOD_CLIENT_ID is required when ROBINHOOD_USE_DCR is false',
      );
    }
    return ROBINHOOD_CLIENT_ID;
  }

  if (cachedClientId) return cachedClientId;

  let res: Response;
  try {
    res = await fetch(ROBINHOOD_DCR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({}),
    });
  } catch (err) {
    throw new RobinhoodOAuthError(
      'RH_DCR_FETCH_FAILED',
      `DCR request failed: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    throw new RobinhoodOAuthError(
      'RH_DCR_HTTP_ERROR',
      `DCR endpoint returned ${res.status}`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new RobinhoodOAuthError('RH_DCR_PARSE_FAILED', 'DCR response is not JSON');
  }

  const parsed = DcrResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new RobinhoodOAuthError(
      'RH_DCR_SCHEMA_INVALID',
      'DCR response did not include client_id',
    );
  }

  cachedClientId = parsed.data.client_id;
  return cachedClientId;
}

// ----- PKCE helpers -----

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function generateRandom(bytes: number): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(input: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(buf);
}

function truncateSecret(s: string): string {
  if (!s) return '';
  return `${s.slice(0, 6)}...`;
}

// ----- Public surface -----

export interface StartAuthorizationInput {
  userId: string;
  redirectUri: string;
}
export interface StartAuthorizationOutput {
  authorizeUrl: string;
  state: string;
}

/**
 * Generates a fresh PKCE pair, persists encrypted state, and returns the
 * Robinhood authorize URL.
 */
export async function startAuthorization(
  opts: StartAuthorizationInput,
): Promise<StartAuthorizationOutput> {
  const { userId, redirectUri } = opts;
  if (!userId) throw new RobinhoodOAuthError('USER_ID_REQUIRED', 'userId is required');
  if (!redirectUri) throw new RobinhoodOAuthError('REDIRECT_URI_REQUIRED', 'redirectUri is required');

  const clientId = await getClientId();
  const state = generateRandom(32);
  const codeVerifier = generateRandom(32);
  const challengeBytes = await sha256(codeVerifier);
  const codeChallenge = base64UrlEncode(challengeBytes);

  const masterKey = getMasterKey(ENC_VERSION);
  const enc = await encryptForUser(masterKey, userId, new TextEncoder().encode(codeVerifier));
  const serialized = serializeEnvelope(enc);

  try {
    await prismaQuery.oAuthState.create({
      data: {
        userId,
        provider: 'robinhood',
        codeVerifier: Buffer.from(serialized),
        state,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
        encVersion: ENC_VERSION,
      },
    });
  } catch (err) {
    throw new RobinhoodOAuthError(
      'RH_STATE_PERSIST_FAILED',
      `failed to persist OAuthState: ${(err as Error).message}`,
    );
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'trading',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const authorizeUrl = `${ROBINHOOD_AUTHORIZE_URL}?${params.toString()}`;
  return { authorizeUrl, state };
}

export interface CompleteAuthorizationInput {
  state: string;
  code: string;
  redirectUri: string;
}
export interface CompleteAuthorizationOutput {
  userId: string;
  expiresAt: Date;
}

/**
 * Exchanges `code` for tokens, persists the encrypted credential, consumes
 * the OAuthState row. Returns the bound userId and the absolute expiry.
 */
export async function completeAuthorization(
  opts: CompleteAuthorizationInput,
): Promise<CompleteAuthorizationOutput> {
  const { state, code, redirectUri } = opts;
  if (!state || !code || !redirectUri) {
    throw new RobinhoodOAuthError('CALLBACK_FIELDS_REQUIRED', 'state, code, and redirectUri are required');
  }

  const row = await prismaQuery.oAuthState.findUnique({ where: { state } });
  if (!row) throw new RobinhoodOAuthError('RH_STATE_NOT_FOUND', 'state not found');
  if (row.consumedAt !== null) throw new RobinhoodOAuthError('RH_STATE_CONSUMED', 'state already consumed');
  if (row.expiresAt.getTime() < Date.now()) {
    throw new RobinhoodOAuthError('RH_STATE_EXPIRED', 'state expired');
  }
  if (!row.userId) {
    throw new RobinhoodOAuthError('RH_STATE_NO_USER', 'state has no bound userId');
  }
  const userId = row.userId;

  const masterKey = getMasterKey(row.encVersion);
  const envelope = deserializeEnvelope(new Uint8Array(row.codeVerifier), row.encVersion);
  const verifierBytes = await decryptForUser(masterKey, userId, envelope);
  const codeVerifier = new TextDecoder().decode(verifierBytes);

  const clientId = await getClientId();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  let res: Response;
  try {
    res = await fetch(ROBINHOOD_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new RobinhoodOAuthError(
      'RH_TOKEN_FETCH_FAILED',
      `token endpoint request failed: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    throw new RobinhoodOAuthError(
      'RH_TOKEN_HTTP_ERROR',
      `token endpoint returned ${res.status}`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new RobinhoodOAuthError('RH_TOKEN_PARSE_FAILED', 'token response is not JSON');
  }
  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new RobinhoodOAuthError('RH_TOKEN_SCHEMA_INVALID', 'token response shape invalid');
  }
  const tokens = parsed.data;

  // PrimeAgent.md 9.5: the agent-trading surface requires the `internal`
  // scope. Reject any token grant that did not return the expected scope
  // so we do not persist an underpowered credential. The required value
  // is overridable for tests via `ROBINHOOD_REQUIRED_SCOPE`.
  if (tokens.scope !== ROBINHOOD_REQUIRED_SCOPE) {
    throw new RobinhoodOAuthError(
      'INVALID_SCOPE',
      `unexpected scope ${tokens.scope || '(empty)'}; required ${ROBINHOOD_REQUIRED_SCOPE}`,
    );
  }

  const expiresAt = new Date(Date.now() + (tokens.expires_in - REFRESH_SAFETY_SEC) * 1000);

  const accessEnc = await encryptForUser(
    masterKey,
    userId,
    new TextEncoder().encode(tokens.access_token),
  );
  const refreshEnc = await encryptForUser(
    masterKey,
    userId,
    new TextEncoder().encode(tokens.refresh_token),
  );
  const noncePlaceholder = await encryptForUser(masterKey, userId, new Uint8Array(0));

  try {
    await prismaQuery.robinhoodCredential.upsert({
      where: { userId_provider: { userId, provider: 'robinhood' } },
      update: {
        accessTokenEnc: Buffer.from(serializeEnvelope(accessEnc)),
        refreshTokenEnc: Buffer.from(serializeEnvelope(refreshEnc)),
        nonceEnc: Buffer.from(serializeEnvelope(noncePlaceholder)),
        expiresAt,
        scope: tokens.scope,
        encVersion: ENC_VERSION,
        deletedAt: null,
      },
      create: {
        userId,
        provider: 'robinhood',
        accessTokenEnc: Buffer.from(serializeEnvelope(accessEnc)),
        refreshTokenEnc: Buffer.from(serializeEnvelope(refreshEnc)),
        nonceEnc: Buffer.from(serializeEnvelope(noncePlaceholder)),
        expiresAt,
        scope: tokens.scope,
        encVersion: ENC_VERSION,
      },
    });
  } catch (err) {
    throw new RobinhoodOAuthError(
      'RH_CRED_PERSIST_FAILED',
      `failed to upsert RobinhoodCredential: ${(err as Error).message}`,
    );
  }

  try {
    await prismaQuery.oAuthState.update({
      where: { state },
      data: { consumedAt: new Date() },
    });
  } catch (err) {
    // Non-fatal at this point; tokens are stored. Log truncated values.
    log.error(
      {
        err_class: (err as Error)?.name,
        data: {
          state: truncateSecret(state),
          msg: (err as Error)?.message,
        },
      },
      'failed to mark oauth state consumed',
    );
  }

  return { userId, expiresAt };
}

/**
 * Returns a decrypted bearer token for `userId`. Refreshes the token if it
 * is within `NEAR_EXPIRY_SEC` seconds of expiry. Throws RobinhoodCredentialMissing
 * if no row exists.
 */
export async function getRobinhoodBearer(userId: string): Promise<string> {
  const row = await prismaQuery.robinhoodCredential.findFirst({
    where: { userId, provider: 'robinhood', deletedAt: null },
  });
  if (!row) throw new RobinhoodCredentialMissing(userId);

  const masterKey = getMasterKey(row.encVersion);

  if (row.expiresAt.getTime() > Date.now() + NEAR_EXPIRY_SEC * 1000) {
    const env = deserializeEnvelope(new Uint8Array(row.accessTokenEnc), row.encVersion);
    const bytes = await decryptForUser(masterKey, userId, env);
    return new TextDecoder().decode(bytes);
  }

  // Refresh path.
  const refreshEnv = deserializeEnvelope(new Uint8Array(row.refreshTokenEnc), row.encVersion);
  const refreshBytes = await decryptForUser(masterKey, userId, refreshEnv);
  const refreshToken = new TextDecoder().decode(refreshBytes);

  const newTokens = await refreshTokens(userId, refreshToken);
  return newTokens.access_token;
}

/**
 * Public helper consumed by tokenRefresher worker. Refreshes the credential
 * if it expires within 5 minutes. Returns `{ refreshed: true }` only if a
 * refresh actually happened.
 */
export async function refreshIfNearExpiry(
  userId: string,
): Promise<{ refreshed: boolean }> {
  const row = await prismaQuery.robinhoodCredential.findFirst({
    where: { userId, provider: 'robinhood', deletedAt: null },
  });
  if (!row) return { refreshed: false };

  const threshold = Date.now() + 5 * 60 * 1000;
  if (row.expiresAt.getTime() > threshold) return { refreshed: false };

  const masterKey = getMasterKey(row.encVersion);
  const refreshEnv = deserializeEnvelope(new Uint8Array(row.refreshTokenEnc), row.encVersion);
  const refreshBytes = await decryptForUser(masterKey, userId, refreshEnv);
  const refreshToken = new TextDecoder().decode(refreshBytes);

  await refreshTokens(userId, refreshToken);
  return { refreshed: true };
}

async function refreshTokens(
  userId: string,
  refreshToken: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string }> {
  const clientId = await getClientId();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  let res: Response;
  try {
    res = await fetch(ROBINHOOD_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new RobinhoodOAuthError(
      'RH_REFRESH_FETCH_FAILED',
      `refresh request failed: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    throw new RobinhoodOAuthError(
      'RH_REFRESH_HTTP_ERROR',
      `refresh endpoint returned ${res.status}`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new RobinhoodOAuthError('RH_REFRESH_PARSE_FAILED', 'refresh response is not JSON');
  }
  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new RobinhoodOAuthError('RH_REFRESH_SCHEMA_INVALID', 'refresh response shape invalid');
  }
  const tokens = parsed.data;

  const masterKey = getMasterKey(ENC_VERSION);
  const accessEnc = await encryptForUser(
    masterKey,
    userId,
    new TextEncoder().encode(tokens.access_token),
  );
  const refreshEnc = await encryptForUser(
    masterKey,
    userId,
    new TextEncoder().encode(tokens.refresh_token),
  );
  const expiresAt = new Date(Date.now() + (tokens.expires_in - REFRESH_SAFETY_SEC) * 1000);

  await prismaQuery.robinhoodCredential.update({
    where: { userId_provider: { userId, provider: 'robinhood' } },
    data: {
      accessTokenEnc: Buffer.from(serializeEnvelope(accessEnc)),
      refreshTokenEnc: Buffer.from(serializeEnvelope(refreshEnc)),
      expiresAt,
      scope: tokens.scope,
      encVersion: ENC_VERSION,
    },
  });

  return tokens;
}

/**
 * Test-only helper to reset the cached client_id between tests. Not exported
 * via the main entrypoint; import directly when needed.
 */
export function __resetClientIdCache(): void {
  cachedClientId = null;
}
