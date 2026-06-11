/**
 * Feature O: audit export schemas.
 */

import { z } from 'zod';

export const AUDIT_SECTION_SCHEMA = z.enum([
  'identity',
  'permitted_activities',
  'policy_timeline',
  'transaction_log',
  'state_attestations',
  'risk_events',
  'reputation',
  'integrity',
]);
export type AuditSection = z.infer<typeof AUDIT_SECTION_SCHEMA>;

export const AuditReportSpecSchema = z
  .object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sections: z.array(AUDIT_SECTION_SCHEMA).min(1).optional(),
  })
  .strict();
export type AuditReportSpec = z.infer<typeof AuditReportSpecSchema>;

export const DEFAULT_AUDIT_SECTIONS: AuditSection[] = [
  'identity',
  'permitted_activities',
  'policy_timeline',
  'transaction_log',
  'state_attestations',
  'risk_events',
  'reputation',
  'integrity',
];
