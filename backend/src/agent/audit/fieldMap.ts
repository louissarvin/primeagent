/**
 * Feature O: CP25/40 + MiCA Title V field map.
 *
 * Eight sections; every row labels CP25/40 area + MiCA parallel.
 *
 * DO NOT reference "FSMA Article 7" or "FSMA 2026 Article 7" anywhere in
 * this file, in audit collect/render code, or in the rendered PDF text.
 * CI greps for those strings. Real regulatory anchors are CP25/40 (UK FCA
 * Consultation Paper) and MiCA Title V Commission Delegated Regulations
 * (EU) 2025/1140, 2025/294, 2025/1142.
 */

import type { AuditSection } from './schemas.ts';

export interface FieldMapRow {
  section: AuditSection;
  title: string;
  cpReference: string;
  micaReference: string;
}

export const AUDIT_FIELD_MAP: readonly FieldMapRow[] = [
  {
    section: 'identity',
    title: 'Firm and agent identity',
    cpReference: 'CP25/40 systems and controls',
    micaReference: 'MiCA Title V Art. 68 governance arrangements',
  },
  {
    section: 'permitted_activities',
    title: 'Permitted activities and limits',
    cpReference: 'CP25/40 record-keeping; transaction limits',
    micaReference: 'Reg. (EU) 2025/1140 records of services',
  },
  {
    section: 'policy_timeline',
    title: 'Policy revision timeline',
    cpReference: 'CP25/40 record-keeping; change log',
    micaReference: 'Reg. (EU) 2025/1140 records of activities',
  },
  {
    section: 'transaction_log',
    title: 'Transaction and order log',
    cpReference: 'CP25/40 order record-keeping',
    micaReference: 'Reg. (EU) 2025/1140 records of orders and transactions',
  },
  {
    section: 'state_attestations',
    title: 'State attestations',
    cpReference: 'CP25/40 operational resilience evidence',
    micaReference: 'Reg. (EU) 2025/1142 conflicts (custody evidence)',
  },
  {
    section: 'risk_events',
    title: 'Risk events and liquidations',
    cpReference: 'CP25/40 operational resilience; incidents',
    micaReference: 'MiCA Title V Art. 68(7) operational resilience',
  },
  {
    section: 'reputation',
    title: 'Reputation feedback',
    cpReference: 'CP25/40 complaints handling proxy',
    micaReference: 'Reg. (EU) 2025/294 complaints records',
  },
  {
    section: 'integrity',
    title: 'Document integrity',
    cpReference: 'CP25/40 audit trail integrity',
    micaReference: 'Reg. (EU) 2025/1140 record integrity',
  },
] as const;
