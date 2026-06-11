/**
 * Demo Mode DTO (Path 2 - operator-driven storyboard).
 *
 * Demo Mode runs a fully-scripted sequence keyed by `scriptId` against a
 * single `tokenId`. Every step emits one `DemoEvent` over the existing SSE
 * channel via `runtimeStore.publishEvent`. The frontend listens on the same
 * `/api/agent/:tokenId/stream` and switches its storyboard chip on the
 * `phase` field.
 *
 * Hard rule: Demo Mode is gated behind `BACKEND_DEMO_MODE_ENABLED=true`.
 * In production posture the gate hard-fails when the flag is unset so a
 * misconfigured pod cannot accidentally fire scripted txs at real users.
 */

import { z } from 'zod';

// ----- Script ids -----
export const DEMO_SCRIPT_IDS = [
  'london-investor',
  'fleet-launch',
  'happy-path',
] as const;

export const DemoScriptIdSchema = z.enum(DEMO_SCRIPT_IDS);
export type DemoScriptId = z.infer<typeof DemoScriptIdSchema>;

// ----- Phases (storyboard taxonomy) -----
//
// Drives the frontend's storyboard chip. New phases require a frontend
// switch update; do not add ad-hoc phases inline.
export const DEMO_EVENT_PHASES = [
  'idle',
  'compose-policy',
  'sign-policy',
  'attest',
  'mark-to-market',
  'price-tick',
  'unhealthy',
  'liquidating',
  'restored',
  'reputation-feedback',
  'fleet-spawning',
  'complete',
  'error',
] as const;

export const DemoEventPhaseSchema = z.enum(DEMO_EVENT_PHASES);
export type DemoEventPhase = z.infer<typeof DemoEventPhaseSchema>;

// ----- Step actions -----
//
// The script player branches on `action`. Payload is typed per action via
// a discriminated union; unknown actions reject at parse time.
export const DEMO_STEP_ACTIONS = [
  'emit',
  'tick-price',
  'trigger-drill',
  'trigger-fleet',
  'post-attestation',
] as const;

export const DemoStepActionSchema = z.enum(DEMO_STEP_ACTIONS);
export type DemoStepAction = z.infer<typeof DemoStepActionSchema>;

// Strict per-action payload schemas.
const EmitPayloadSchema = z
  .object({
    message: z.string().min(1).max(200),
    // Optional structured side-data the frontend renders verbatim.
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const TickPricePayloadSchema = z
  .object({
    symbol: z.string().min(1).max(16),
    // Q96.48 price encoded as decimal string to stay JSON-safe.
    priceQ96: z.string().regex(/^[0-9]+$/),
    delta_bps: z.number().int().min(-10_000).max(10_000),
    message: z.string().min(1).max(200),
  })
  .strict();

const TriggerDrillPayloadSchema = z
  .object({
    // Optional asset override; falls back to BACKEND_DRILL_DEFAULT_ASSET.
    asset: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    message: z.string().min(1).max(200),
  })
  .strict();

const TriggerFleetPayloadSchema = z
  .object({
    count: z.number().int().min(1).max(10),
    nameTemplate: z.string().min(1).max(64),
    message: z.string().min(1).max(200),
  })
  .strict();

const PostAttestationPayloadSchema = z
  .object({
    accountValueQ96: z.string().regex(/^[0-9]+$/),
    buyingPowerQ96: z.string().regex(/^[0-9]+$/),
    message: z.string().min(1).max(200),
  })
  .strict();

// ----- DemoStep -----
//
// The schema is intentionally a discriminated union on `action` so an
// invalid payload shape rejects at parse time instead of at the player.
export const DemoStepSchema = z.discriminatedUnion('action', [
  z
    .object({
      phase: DemoEventPhaseSchema,
      delayMs: z.number().int().min(0).max(60_000),
      action: z.literal('emit'),
      payload: EmitPayloadSchema,
      description: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      phase: DemoEventPhaseSchema,
      delayMs: z.number().int().min(0).max(60_000),
      action: z.literal('tick-price'),
      payload: TickPricePayloadSchema,
      description: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      phase: DemoEventPhaseSchema,
      delayMs: z.number().int().min(0).max(60_000),
      action: z.literal('trigger-drill'),
      payload: TriggerDrillPayloadSchema,
      description: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      phase: DemoEventPhaseSchema,
      delayMs: z.number().int().min(0).max(60_000),
      action: z.literal('trigger-fleet'),
      payload: TriggerFleetPayloadSchema,
      description: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      phase: DemoEventPhaseSchema,
      delayMs: z.number().int().min(0).max(60_000),
      action: z.literal('post-attestation'),
      payload: PostAttestationPayloadSchema,
      description: z.string().min(1).max(200),
    })
    .strict(),
]);

export type DemoStep = z.infer<typeof DemoStepSchema>;

// ----- DemoEvent (wire shape) -----
//
// The event is serialized as the `data` field of a `chain` runtime event
// with `event: 'demo_step'`. The frontend filters on `event` then reads
// `data` against this schema.
export const DemoEventSchema = z
  .object({
    demoRunId: z
      .string()
      .regex(/^dmo_[0-9a-fA-F-]{8,64}$/),
    scriptId: DemoScriptIdSchema,
    stepIndex: z.number().int().nonnegative(),
    phase: DemoEventPhaseSchema,
    message: z.string().min(1).max(200),
    payload: z.record(z.string(), z.unknown()),
    ts: z.number().int().positive(),
  })
  .strict();

export type DemoEvent = z.infer<typeof DemoEventSchema>;

// ----- Script summary (returned by /demo/scripts) -----
export const DemoScriptSummarySchema = z
  .object({
    id: DemoScriptIdSchema,
    label: z.string().min(1).max(80),
    etaSeconds: z.number().int().positive(),
    steps: z.number().int().positive(),
  })
  .strict();

export type DemoScriptSummary = z.infer<typeof DemoScriptSummarySchema>;
