/**
 * Feature N: FX rate schemas + types.
 */

import { z } from 'zod';

export const FxProviderSchema = z.enum(['frankfurter', 'coinbase', 'bank_of_england']);
export type FxProvider = z.infer<typeof FxProviderSchema>;

export const FxRateResponseSchema = z.object({
  pair: z.string(),
  rate: z.number().positive().finite(),
  rateBp: z.number().int().positive(),
  fetchedAt: z.number().int().positive(),
  provider: FxProviderSchema,
});
export type FxRateResponse = z.infer<typeof FxRateResponseSchema>;

export const FxRatePointSchema = z.object({
  id: z.string(),
  pair: z.string(),
  rateBp: z.number().int(),
  fetchedAt: z.string(),
  provider: FxProviderSchema,
});
