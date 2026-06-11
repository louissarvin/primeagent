/**
 * Feature Q: DSS memo schemas.
 */

import { z } from 'zod';

export const DSS_MEMO_SECTION_SCHEMA = z.enum([
  'identity',
  'activities',
  'state',
  'controls',
  'audit',
  'gate2',
]);
export type DssMemoSection = z.infer<typeof DSS_MEMO_SECTION_SCHEMA>;

export const DssMemoSpecSchema = z
  .object({
    auditPdfSha256: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable().optional(),
    sections: z.array(DSS_MEMO_SECTION_SCHEMA).min(1).optional(),
  })
  .strict();
export type DssMemoSpec = z.infer<typeof DssMemoSpecSchema>;

export const DEFAULT_DSS_SECTIONS: DssMemoSection[] = [
  'identity',
  'activities',
  'state',
  'controls',
  'audit',
  'gate2',
];
