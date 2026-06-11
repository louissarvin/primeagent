/**
 * Liquidation drill DTO (Feature H / cross-cutting type 1.6).
 *
 * Drill events stream through the existing SSE channel via `runtimeStore`
 * (no new SSE endpoint).
 */

import { z } from 'zod';

import { AddressSchema, Bytes32Schema } from '../policy/schemas.ts';

export const LIQUIDATION_DRILL_PHASES = [
  'priceBump',
  'unhealthy',
  'liquidating',
  'bountyPaid',
  'refunded',
  'restored',
  'aborted',
  'error',
] as const;

export const LiquidationDrillPhaseSchema = z.enum(LIQUIDATION_DRILL_PHASES);
export type LiquidationDrillPhase = z.infer<typeof LiquidationDrillPhaseSchema>;

export const LiquidationDrillEventSchema = z
  .object({
    drillId: z.string().min(8).max(64),
    tokenId: z.bigint(),
    phase: LiquidationDrillPhaseSchema,
    asset: AddressSchema,
    priceBeforeQ96: z.bigint(),
    priceAfterQ96: z.union([z.bigint(), z.null()]),
    txHash: z.union([Bytes32Schema, z.null()]),
    collateralUsdQ96: z.union([z.bigint(), z.null()]),
    bountyAmountUsd: z.union([z.number().nonnegative(), z.null()]),
    message: z.string().min(1).max(200),
    ts: z.number().int().positive(),
  })
  .strict();

export type LiquidationDrillEvent = z.infer<typeof LiquidationDrillEventSchema>;
