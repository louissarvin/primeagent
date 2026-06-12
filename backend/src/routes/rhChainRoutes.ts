/**
 * RhChainSwap API routes.
 *
 * Mounted at `/api/rh-chain`. All endpoints are JWT-protected and rate-limited.
 *
 * POST /sign-price                 - sign a Price quote for the user's tokenId
 * POST /sign-owner-registration    - sign an OwnerRegistration after verifying
 *                                    on-chain NFT ownership on Arb Sepolia
 * GET  /position/:tokenId          - read-side view of the on-chain Position
 *
 * Security posture:
 *   - JWT auth on every route (preHandler: authMiddleware).
 *   - Zod validation at the boundary. Address fields are length-checked
 *     against the 0x-prefixed 20-byte hex pattern; numeric fields arrive as
 *     decimal strings and are parsed to bigint to avoid Number precision
 *     loss on tokenId / amounts.
 *   - 5 req/min/IP rate limit on the sign endpoints (matches the SIWE
 *     verify cadence already deployed).
 *   - Ownership verification on `/sign-owner-registration` is mandatory.
 *     Without it, an attacker holding a Bearer for ANY linked user could
 *     claim a tokenId they do not own on the home chain.
 *   - Bigints are serialised to decimal strings in responses (never as JSON
 *     numbers) to preserve precision in the frontend.
 *   - Pre-deploy: when `BACKEND_RH_CHAIN_SWAP_ADDRESS` is empty, sign routes
 *     return 503 SERVICE_UNAVAILABLE with code `RH_CHAIN_NOT_DEPLOYED`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAddress } from 'viem';

import { authMiddleware } from '../middlewares/authMiddleware.ts';
import { handleError } from '../utils/errorHandler.ts';
import {
  signPrice,
  signOwnerRegistration,
  DEFAULT_OWNER_REG_TTL_SECONDS,
} from '../lib/rhChainSigners.ts';
import {
  getRhChainPosition,
  verifyPositionNftOwnership,
} from '../lib/rhChainSwapClient.ts';
import { RH_CHAIN_SWAP_CONFIGURED } from '../config/main-config.ts';
import { forSvc } from '../lib/logger.ts';

const log = forSvc('rhChainRoutes');

const HEX_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const DECIMAL_UINT = /^[0-9]+$/;

const AddressSchema = z.string().regex(HEX_ADDRESS, 'must be 0x-prefixed 20-byte hex');

/** Parses a JSON value that is either a string of digits or a non-negative integer. */
const UintStringSchema = z
  .union([
    z.string().regex(DECIMAL_UINT, 'must be a non-negative decimal integer'),
    z.number().int().nonnegative(),
  ])
  .transform((v) => BigInt(v));

const SignPriceBody = z.object({
  tokenId: UintStringSchema,
  fromToken: AddressSchema,
  toToken: AddressSchema,
  amountIn: UintStringSchema,
  minAmountOut: UintStringSchema,
  maxPriceWad: UintStringSchema,
  priceWad: UintStringSchema,
});

const SignOwnerRegBody = z.object({
  tokenId: UintStringSchema,
  newOwner: AddressSchema,
});

/** Truncate a hex value for log lines. Never emit a full signature or key. */
function shortHex(s: string): string {
  return s.length > 10 ? `${s.slice(0, 10)}...` : s;
}

export async function rhChainRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/sign-price',
    {
      preHandler: [authMiddleware],
      config: {
        // Per backend/CLAUDE.md the global limiter caps at 100/min; this
        // tightens the sign endpoint to the same 5/min budget used by
        // /auth/siwe/verify (anti-brute-force on the signer key).
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      if (!RH_CHAIN_SWAP_CONFIGURED) {
        return handleError(
          reply,
          503,
          'RhChainSwap contract not yet deployed',
          'RH_CHAIN_NOT_DEPLOYED',
        );
      }

      const parsed = SignPriceBody.safeParse(request.body);
      if (!parsed.success) {
        return handleError(reply, 400, 'Invalid request body', 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }
      const body = parsed.data;

      // Sanity guards beyond the schema: from != to, non-zero amounts,
      // priceWad <= maxPriceWad (the contract reverts otherwise so we may
      // as well surface the 400 here and skip the signing work).
      if (body.fromToken.toLowerCase() === body.toToken.toLowerCase()) {
        return handleError(reply, 400, 'fromToken must differ from toToken', 'SAME_TOKEN');
      }
      if (body.amountIn === 0n) {
        return handleError(reply, 400, 'amountIn must be > 0', 'ZERO_AMOUNT_IN');
      }
      if (body.priceWad > body.maxPriceWad) {
        return handleError(
          reply,
          400,
          'priceWad above maxPriceWad ceiling',
          'PRICE_OUT_OF_BAND',
        );
      }

      // Ownership check: only the registered owner (or, pre-registration,
      // the verified NFT owner on Arb Sepolia) may request a signed price
      // for this tokenId. Without this an authenticated user could request
      // a quote on someone else's agent. We use the same Arb Sepolia NFT
      // check used by /sign-owner-registration; it is the canonical source
      // of ownership on the home chain.
      const claimant = request.user?.walletAddress as `0x${string}` | undefined;
      if (!claimant) {
        return handleError(reply, 401, 'Authenticated user has no wallet', 'NO_WALLET');
      }
      const ownership = await verifyPositionNftOwnership(body.tokenId, getAddress(claimant));
      if (!ownership.ok) {
        log.warn(
          {
            data: {
              tokenId: body.tokenId.toString(),
              claimant: shortHex(claimant),
              reason: ownership.reason,
            },
          },
          'sign-price rejected: ownership check failed',
        );
        return handleError(reply, 403, 'Not authorised for this tokenId', 'NOT_OWNER');
      }

      let signed;
      try {
        signed = await signPrice({
          tokenId: body.tokenId,
          fromToken: getAddress(body.fromToken),
          toToken: getAddress(body.toToken),
          amountIn: body.amountIn,
          minAmountOut: body.minAmountOut,
          priceWad: body.priceWad,
        });
      } catch (err) {
        return handleError(
          reply,
          500,
          'Failed to sign price',
          'SIGN_PRICE_FAILED',
          err as Error,
        );
      }

      log.info(
        {
          data: {
            tokenId: body.tokenId.toString(),
            nonce: signed.nonce.toString(),
            sig: shortHex(signed.signature),
          },
        },
        'price signed',
      );

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          priceWad: signed.priceWad.toString(),
          nonce: signed.nonce.toString(),
          validUntil: signed.validUntil.toString(),
          signature: signed.signature,
        },
      });
    },
  );

  app.post(
    '/sign-owner-registration',
    {
      preHandler: [authMiddleware],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!RH_CHAIN_SWAP_CONFIGURED) {
        return handleError(
          reply,
          503,
          'RhChainSwap contract not yet deployed',
          'RH_CHAIN_NOT_DEPLOYED',
        );
      }

      const parsed = SignOwnerRegBody.safeParse(request.body);
      if (!parsed.success) {
        return handleError(reply, 400, 'Invalid request body', 'VALIDATION_ERROR', null, {
          issues: parsed.error.issues,
        });
      }
      const { tokenId, newOwner } = parsed.data;

      // The claimant MUST own the NFT on Arb Sepolia. The Bearer token tells
      // us who the request came from (`walletAddress`); we cross-check
      // against the on-chain owner. `newOwner` is the address the user wants
      // bound on RH Chain - typically equal to claimant but may differ
      // (eg user delegating to a smart-account address). We still gate on
      // claimant ownership, which is the auditor-required race mitigation.
      const claimant = request.user?.walletAddress as `0x${string}` | undefined;
      if (!claimant) {
        return handleError(reply, 401, 'Authenticated user has no wallet', 'NO_WALLET');
      }
      const ownership = await verifyPositionNftOwnership(tokenId, getAddress(claimant));
      if (!ownership.ok) {
        log.warn(
          {
            data: {
              tokenId: tokenId.toString(),
              claimant: shortHex(claimant),
              reason: ownership.reason,
            },
          },
          'sign-owner-registration rejected: ownership check failed',
        );
        return handleError(
          reply,
          403,
          'Not authorised: PositionNFT ownership check failed on Arb Sepolia',
          'NOT_OWNER',
        );
      }

      let signed;
      try {
        signed = await signOwnerRegistration({
          tokenId,
          newOwner: getAddress(newOwner),
        });
      } catch (err) {
        return handleError(
          reply,
          500,
          'Failed to sign owner registration',
          'SIGN_OWNER_REG_FAILED',
          err as Error,
        );
      }

      log.info(
        {
          data: {
            tokenId: tokenId.toString(),
            newOwner: shortHex(newOwner),
            sig: shortHex(signed.signature),
            ttl: DEFAULT_OWNER_REG_TTL_SECONDS,
          },
        },
        'owner registration signed',
      );

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          validUntil: signed.validUntil.toString(),
          signature: signed.signature,
        },
      });
    },
  );

  app.get(
    '/position/:tokenId',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const params = z
        .object({ tokenId: z.string().regex(DECIMAL_UINT) })
        .safeParse(request.params);
      if (!params.success) {
        return handleError(reply, 400, 'Invalid tokenId', 'VALIDATION_ERROR', null, {
          issues: params.error.issues,
        });
      }
      const tokenId = BigInt(params.data.tokenId);

      let position;
      try {
        position = await getRhChainPosition(tokenId);
      } catch (err) {
        return handleError(
          reply,
          502,
          'Failed to read RH Chain position',
          'RH_CHAIN_READ_FAILED',
          err as Error,
        );
      }

      if (position === null) {
        // Pre-deploy: surface an empty position rather than 404 so the
        // dashboard can render a "not deployed" hint without branching
        // on an HTTP code.
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            deployed: false,
            tokens: [],
            balances: [],
            swapNonce: '0',
            withdrawNonce: '0',
            revokedAt: 0,
            paused: false,
            owner: '0x0000000000000000000000000000000000000000',
          },
        });
      }

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          deployed: true,
          tokens: position.tokens,
          balances: position.balances.map((b) => b.toString()),
          swapNonce: position.swapNonce.toString(),
          withdrawNonce: position.withdrawNonce.toString(),
          revokedAt: position.revokedAt,
          paused: position.paused,
          owner: position.owner,
        },
      });
    },
  );
}
