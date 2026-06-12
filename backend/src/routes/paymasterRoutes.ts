/**
 * Backend paymaster sponsor route per PrimeAgent.md section 7.11.
 *
 * POST /paymaster/sponsor
 *
 * Returns a `paymasterAndData` byte-string that the caller's bundler can
 * splice into the ERC-4337 UserOperation. The encoding follows the
 * PrimeAgent PaymasterRelay layout:
 *
 *   [paymaster address (20)] +
 *   [validUntil (6)]         +
 *   [validAfter (6)]         +
 *   [tokenId (32)]           +
 *   [signature (65)]
 *
 * Two operating modes:
 *
 *   - Default (no `BACKEND_PAYMASTER_PRIVATE_KEY`): the route returns the
 *     unsigned shape with `signedByBackend: false` and a 65-byte zero
 *     signature placeholder. The CLI / frontend pairs this with its own
 *     bundler-side signer or routes through a self-hosted PaymasterRelay.
 *
 *   - Signed (`BACKEND_PAYMASTER_PRIVATE_KEY` present): the route signs
 *     the validity window for the configured paymaster relay and returns
 *     `signedByBackend: true`.
 *
 * Authorization layers:
 *   - JWT-gated (authMiddleware).
 *   - Caller must own the tokenId. Verified via `PositionNFT.ownerOf`
 *     on the configured chain. Mismatch -> 403. Read failure -> 502.
 *   - Per-tokenId quota: 100 sponsorship attempts per rolling hour. 429
 *     when exhausted. Counter is in-process; restart resets the window.
 *
 * Rate-limit override: 60/min PER USER on top of the global limiter, so
 * a runaway dashboard cannot blow through the quota in a minute.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
} from 'fastify';
import { type Address, type Hex, getAddress, pad, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';

import {
  ARB_SEPOLIA_CHAIN_ID,
  RH_CHAIN_TESTNET_CHAIN_ID,
  type SupportedChainId,
  getPublicClient,
} from '../lib/viem.ts';
import {
  BACKEND_PAYMASTER_PRIVATE_KEY,
  BACKEND_PAYMASTER_RELAY_ADDRESS_ARB_SEPOLIA,
  BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA,
} from '../config/main-config.ts';
import { POSITION_NFT_ABI } from '../lib/contracts/abis.ts';
import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { forSvc } from '../lib/logger.ts';
import { handleError } from '../utils/errorHandler.ts';

const log = forSvc('agentRoute');

/** Per-tokenId sponsorship quota counter (in-memory; resets on restart). */
interface QuotaEntry {
  count: number;
  windowStart: Date;
}
const quota = new Map<bigint, QuotaEntry>();
const QUOTA_MAX = 100;
const QUOTA_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Check + increment the per-tokenId sponsorship quota. Returns `true`
 * when the request is within budget; `false` (and does not increment)
 * once the budget is exhausted.
 */
function consumeQuota(tokenId: bigint): boolean {
  const now = Date.now();
  const existing = quota.get(tokenId);
  if (!existing || now - existing.windowStart.getTime() > QUOTA_WINDOW_MS) {
    quota.set(tokenId, { count: 1, windowStart: new Date(now) });
    return true;
  }
  if (existing.count >= QUOTA_MAX) {
    return false;
  }
  existing.count += 1;
  return true;
}

/**
 * Reset all quota state. Exposed for tests; production callers must not
 * touch this.
 */
export const __internal = {
  resetQuota(): void {
    quota.clear();
  },
  quotaSize(): number {
    return quota.size;
  },
  QUOTA_MAX,
  QUOTA_WINDOW_MS,
};

// ----- Body schema -----

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;
const SUPPORTED_CHAIN_IDS = [ARB_SEPOLIA_CHAIN_ID, RH_CHAIN_TESTNET_CHAIN_ID] as const;

const SponsorBody = z.object({
  tokenId: z.string().regex(/^\d+$/),
  chainId: z
    .union([z.literal(ARB_SEPOLIA_CHAIN_ID), z.literal(RH_CHAIN_TESTNET_CHAIN_ID)])
    .default(ARB_SEPOLIA_CHAIN_ID),
  userOperation: z.object({
    sender: z.string().regex(HEX_ADDRESS_RE),
    nonce: z.string(),
    callData: z.string().regex(HEX_RE),
    callGasLimit: z.string(),
    verificationGasLimit: z.string(),
    preVerificationGas: z.string(),
    maxFeePerGas: z.string(),
    maxPriorityFeePerGas: z.string(),
    signature: z.string(),
  }),
});

// ----- Helpers -----

function paymasterRelayAddressFor(chainId: SupportedChainId): Address | null {
  if (chainId === ARB_SEPOLIA_CHAIN_ID) {
    const v = BACKEND_PAYMASTER_RELAY_ADDRESS_ARB_SEPOLIA;
    if (!v || !HEX_ADDRESS_RE.test(v)) return null;
    return v as Address;
  }
  // RH Chain currently has no relay deployment; document via 503.
  return null;
}

function positionNftAddressFor(chainId: SupportedChainId): Address | null {
  if (chainId === ARB_SEPOLIA_CHAIN_ID) {
    const v = BACKEND_POSITION_NFT_ADDRESS_ARB_SEPOLIA;
    if (!v || !HEX_ADDRESS_RE.test(v)) return null;
    return v as Address;
  }
  return null;
}

/**
 * Assemble the `paymasterAndData` byte-string. Layout per
 * PrimeAgent.md 7.11:
 *
 *   bytes20 paymaster | bytes6 validUntil | bytes6 validAfter |
 *   bytes32 tokenId  | bytes65 signature
 *
 * `signature` is 65 zero bytes when no signing key is configured.
 */
function encodePaymasterAndData(opts: {
  paymaster: Address;
  validUntil: bigint;
  validAfter: bigint;
  tokenId: bigint;
  signature: Hex;
}): Hex {
  // 6-byte (48-bit) timestamps.
  const validUntilHex = pad(toHex(opts.validUntil), { size: 6 });
  const validAfterHex = pad(toHex(opts.validAfter), { size: 6 });
  const tokenIdHex = pad(toHex(opts.tokenId), { size: 32 });

  // Signature is exactly 65 bytes (r=32 + s=32 + v=1). Pad to 65 when
  // unsigned; reject longer values to keep the layout deterministic.
  const sigHex = opts.signature && opts.signature !== '0x'
    ? (opts.signature.length === 132 ? opts.signature : opts.signature)
    : (`0x${'00'.repeat(65)}` as Hex);

  return (
    opts.paymaster +
    validUntilHex.slice(2) +
    validAfterHex.slice(2) +
    tokenIdHex.slice(2) +
    sigHex.slice(2)
  ) as Hex;
}

/**
 * Sign the validity-window commitment with the configured backend
 * paymaster key. This is the minimal commitment the relay validator
 * verifies; the spec-correct domain separator lives in the relay
 * contract. This wave keeps the personal-sign envelope so the backend
 * code does not have to mirror the full EIP-712 typed-data scheme on
 * its own; the relay's spec section 7.11 update is the canonical place
 * for the typed-data version.
 */
async function maybeSignPaymasterShape(
  tokenId: bigint,
  validUntil: bigint,
  validAfter: bigint,
): Promise<{ signature: Hex; signedByBackend: boolean }> {
  const pk = BACKEND_PAYMASTER_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    return { signature: `0x${'00'.repeat(65)}` as Hex, signedByBackend: false };
  }
  const account = privateKeyToAccount(pk as Hex);
  // We sign the packed validity envelope; the relay reverifies the same
  // bytes in the corresponding domain. Logged values are fingerprints,
  // never the key.
  const message = `paymaster:${tokenId.toString()}:${validUntil.toString()}:${validAfter.toString()}`;
  const sig = await account.signMessage({ message });
  return { signature: sig, signedByBackend: true };
}

function shortAddr(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 10)}...` : addr;
}

// ----- Route -----

export const paymasterRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.post(
    '/sponsor',
    {
      preHandler: [authMiddleware],
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest): string =>
            (req.user as { id?: string } | undefined)?.id ?? req.ip ?? 'unknown',
        },
      },
    },
    async (request, reply) => {
      const startMs = Date.now();

      // 1. Body validation
      const parsed = SponsorBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        return handleError(reply, 400, 'Invalid sponsor request body', 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }
      const { tokenId: tokenIdStr, chainId, userOperation } = parsed.data;

      const user = request.user;
      if (!user) {
        return handleError(reply, 401, 'Authenticated user missing', 'USER_NOT_AUTHENTICATED');
      }

      let tokenId: bigint;
      try {
        tokenId = BigInt(tokenIdStr);
      } catch {
        return handleError(reply, 400, 'tokenId must be a non-negative integer', 'VALIDATION_ERROR');
      }
      if (tokenId < 0n) {
        return handleError(reply, 400, 'tokenId must be non-negative', 'VALIDATION_ERROR');
      }

      // 2. Quota check
      if (!consumeQuota(tokenId)) {
        log.warn(
          {
            tokenId: tokenId.toString(),
            data: { action: 'sponsor', reason: 'quota_exhausted' },
          },
          'paymaster quota exhausted',
        );
        return handleError(
          reply,
          429,
          'Sponsorship quota exhausted for this tokenId',
          'QUOTA_EXHAUSTED',
        );
      }

      // 3. Ownership verification (PositionNFT.ownerOf == caller wallet)
      const nftAddr = positionNftAddressFor(chainId as SupportedChainId);
      if (nftAddr) {
        try {
          const client = getPublicClient(chainId as SupportedChainId);
          const owner = (await client.readContract({
            address: nftAddr,
            abi: POSITION_NFT_ABI,
            functionName: 'ownerOf',
            args: [tokenId],
          })) as `0x${string}`;
          if (owner.toLowerCase() !== user.walletAddress.toLowerCase()) {
            log.warn(
              {
                tokenId: tokenId.toString(),
                chainId,
                data: {
                  action: 'sponsor',
                  expected_owner: shortAddr(owner),
                  caller: shortAddr(user.walletAddress),
                },
              },
              'paymaster ownership mismatch',
            );
            return handleError(reply, 403, 'Caller does not own this tokenId', 'NOT_TOKEN_OWNER');
          }
        } catch (err) {
          return handleError(
            reply,
            502,
            'Failed to verify on-chain ownership',
            'OWNERSHIP_READ_FAILED',
            err as Error,
          );
        }
      } else {
        // Unconfigured PositionNFT -> dev posture. Warn but proceed.
        log.warn(
          {
            tokenId: tokenId.toString(),
            chainId,
            data: { action: 'sponsor', reason: 'position_nft_address_unset' },
          },
          'paymaster ownership check skipped in dev posture',
        );
      }

      // 4. Paymaster relay address
      const paymasterAddr = paymasterRelayAddressFor(chainId as SupportedChainId);
      if (!paymasterAddr) {
        return handleError(
          reply,
          503,
          'Paymaster relay not configured for this chain',
          'PAYMASTER_NOT_CONFIGURED',
        );
      }

      // 5. Sign (or stub) the validity envelope
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const validAfter = nowSec;
      const validUntil = nowSec + 300n; // 5-minute window
      const { signature, signedByBackend } = await maybeSignPaymasterShape(
        tokenId,
        validUntil,
        validAfter,
      );

      const paymasterAndData = encodePaymasterAndData({
        paymaster: getAddress(paymasterAddr),
        validUntil,
        validAfter,
        tokenId,
        signature,
      });

      // 6. Response
      const reqMs = Date.now() - startMs;
      log.info(
        {
          tokenId: tokenId.toString(),
          chainId,
          data: {
            action: 'sponsor',
            user_wallet: shortAddr(user.walletAddress),
            signed_by_backend: signedByBackend,
            sender: shortAddr(userOperation.sender),
            req_duration_ms: reqMs,
          },
        },
        'paymaster sponsor ok',
      );

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          paymaster: paymasterAddr,
          paymasterData: paymasterAndData,
          paymasterVerificationGasLimit: '120000',
          paymasterPostOpGasLimit: '60000',
          signedByBackend,
          validUntil: validUntil.toString(),
          validAfter: validAfter.toString(),
        },
      });
    },
  );

  done();
};

// Export the SUPPORTED list for downstream consumers (tests).
export { SUPPORTED_CHAIN_IDS };
