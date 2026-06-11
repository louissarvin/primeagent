/**
 * Demo Mode script definitions (Path 2).
 *
 * Three immutable scripts, each an ordered array of `DemoStep`. The player
 * iterates the array, waits `delayMs`, then executes `action` with the
 * typed `payload`. Total wall-clock duration is the sum of all `delayMs`
 * plus the per-action execution time (which for `emit`, `tick-price`, and
 * `post-attestation` is microseconds; for `trigger-drill` and
 * `trigger-fleet` the player only kicks the underlying service and does
 * not block on its completion).
 *
 * Hardcoded scripts (NOT user-customisable). The frontend can fetch
 * summaries via `GET /api/agent/:tokenId/demo/scripts`.
 *
 * Mapping to spec section 14 ("3-minute London pitch"):
 *   - `london-investor` is the canonical pitch script.
 *   - `fleet-launch` and `happy-path` are auxiliary recordings for
 *     screen-shots and shorter demo cuts.
 */

import type { DemoScriptId, DemoStep } from './schemas.ts';

/** A canonical Q96.48-encoded base price (e.g. $215.00 for TSLA). */
const TSLA_BASE_Q96 = '60543819151919648768000000000'; // 215 * 2^96 / 1e18 approximated; opaque to the player

// 60543819151919648768000000000 above is illustrative only; the value is
// passed through verbatim to the SSE consumer and never interpreted by
// the player. The frontend formats it for the storyboard chip.

// ---------------------------------------------------------------------
// london-investor (3 minutes; mirrors PrimeAgent.md section 14)
// ---------------------------------------------------------------------
const londonInvestorScript: DemoStep[] = [
  {
    phase: 'idle',
    delayMs: 0,
    action: 'emit',
    payload: { message: 'Demo starting: London investor pitch' },
    description: 'Opening: Mayfair to agentic prime brokerage',
  },
  {
    phase: 'compose-policy',
    delayMs: 4_000,
    action: 'emit',
    payload: { message: 'Composing ERC-7715 policy draft from operator ask' },
    description: 'Feature A: chat composes a balanced preset policy',
  },
  {
    phase: 'sign-policy',
    delayMs: 6_000,
    action: 'emit',
    payload: { message: 'Operator signs policy install on ZeroDev Kernel' },
    description: 'Feature C: balanced preset hash committed on-chain',
  },
  {
    phase: 'attest',
    delayMs: 8_000,
    action: 'post-attestation',
    payload: {
      accountValueQ96: '7920123456789012345678901234567890',
      buyingPowerQ96: '3500000000000000000000000000000000',
      message: 'First EIP-712 attestation posted to PrimeAgentAttestor',
    },
    description: 'Feature C tail: attestor signs cross-domain snapshot',
  },
  {
    phase: 'mark-to-market',
    delayMs: 10_000,
    action: 'tick-price',
    payload: {
      symbol: 'TSLA',
      priceQ96: TSLA_BASE_Q96,
      delta_bps: 0,
      message: 'Mark-to-market: TSLA stable at session open',
    },
    description: 'Stylus margin engine computes equity baseline',
  },
  {
    phase: 'price-tick',
    delayMs: 12_000,
    action: 'tick-price',
    payload: {
      symbol: 'TSLA',
      priceQ96: TSLA_BASE_Q96,
      delta_bps: -150,
      message: 'TSLA down 1.5% as London open hits',
    },
    description: 'Feature E setup: price slips toward margin call zone',
  },
  {
    phase: 'unhealthy',
    delayMs: 8_000,
    action: 'emit',
    payload: { message: 'Margin call triggered: vault flagged unhealthy' },
    description: 'Feature E: Claude Opus runs onMarginCall handler',
  },
  {
    phase: 'liquidating',
    delayMs: 6_000,
    action: 'trigger-drill',
    payload: { message: 'Triggering Feature H liquidation drill' },
    description: 'Feature H: drill orchestrator broadcasts bumped oracle price',
  },
  {
    phase: 'restored',
    delayMs: 12_000,
    action: 'emit',
    payload: { message: 'Drill complete; oracle restored to baseline' },
    description: 'Feature H tail: refund signer settles bounty',
  },
  {
    phase: 'reputation-feedback',
    delayMs: 8_000,
    action: 'emit',
    payload: { message: 'ERC-8004 reputation feedback posted to AgentRegistry' },
    description: 'Feature G: positive signed feedback (P&L > 0)',
  },
  {
    phase: 'complete',
    delayMs: 6_000,
    action: 'emit',
    payload: { message: 'London pitch complete: 3 minutes' },
    description: 'Wrap: DSS perimeter + LSE DMI talking point',
  },
];

// ---------------------------------------------------------------------
// fleet-launch (90 seconds; Feature D focus)
// ---------------------------------------------------------------------
const fleetLaunchScript: DemoStep[] = [
  {
    phase: 'idle',
    delayMs: 0,
    action: 'emit',
    payload: { message: 'Demo starting: bot-builds-bot fleet launch' },
    description: 'Opening: one parent spawns five children',
  },
  {
    phase: 'compose-policy',
    delayMs: 4_000,
    action: 'emit',
    payload: { message: 'Composing fleet policy (delta-neutral preset)' },
    description: 'Feature A: fleet base policy chosen',
  },
  {
    phase: 'fleet-spawning',
    delayMs: 6_000,
    action: 'trigger-fleet',
    payload: {
      count: 5,
      nameTemplate: 'PrimeAgent-Child-#{n}',
      message: 'Building fleet plan for 5 children',
    },
    description: 'Feature D: bundled userOp returned for signing',
  },
  {
    phase: 'sign-policy',
    delayMs: 12_000,
    action: 'emit',
    payload: { message: '5 children deployed; ERC-6551 TBAs minted' },
    description: 'Frontend confirms 5 AgentDeployed events landed',
  },
  {
    phase: 'attest',
    delayMs: 10_000,
    action: 'post-attestation',
    payload: {
      accountValueQ96: '15000000000000000000000000000000000',
      buyingPowerQ96: '7500000000000000000000000000000000',
      message: 'First fleet-wide attestation across 5 children',
    },
    description: 'Each child posts its own attestation in parallel',
  },
  {
    phase: 'mark-to-market',
    delayMs: 8_000,
    action: 'emit',
    payload: { message: 'All 5 children active; net exposure ~0' },
    description: 'Stylus engine aggregates fleet equity',
  },
  {
    phase: 'reputation-feedback',
    delayMs: 6_000,
    action: 'emit',
    payload: { message: 'First reputation feedback to parent agent' },
    description: 'Feature G: parent inherits children PnL contribution',
  },
  {
    phase: 'complete',
    delayMs: 4_000,
    action: 'emit',
    payload: { message: 'Fleet launch complete: 90 seconds' },
    description: 'Wrap: bot-builds-bot demonstration done',
  },
];

// ---------------------------------------------------------------------
// happy-path (60 seconds; everything-works speedrun)
// ---------------------------------------------------------------------
const happyPathScript: DemoStep[] = [
  {
    phase: 'idle',
    delayMs: 0,
    action: 'emit',
    payload: { message: 'Demo starting: happy-path speedrun' },
    description: 'Opening: 60-second smoke loop',
  },
  {
    phase: 'compose-policy',
    delayMs: 3_000,
    action: 'emit',
    payload: { message: 'Composing balanced policy' },
    description: 'Feature A: policy draft ready',
  },
  {
    phase: 'sign-policy',
    delayMs: 4_000,
    action: 'emit',
    payload: { message: 'Policy installed' },
    description: 'Feature C: rotation tx broadcast',
  },
  {
    phase: 'attest',
    delayMs: 5_000,
    action: 'post-attestation',
    payload: {
      accountValueQ96: '5000000000000000000000000000000000',
      buyingPowerQ96: '2500000000000000000000000000000000',
      message: 'Attestation posted',
    },
    description: 'EIP-712 sign + RobinhoodMcpAttestor.attest',
  },
  {
    phase: 'mark-to-market',
    delayMs: 6_000,
    action: 'tick-price',
    payload: {
      symbol: 'TSLA',
      priceQ96: TSLA_BASE_Q96,
      delta_bps: 25,
      message: 'TSLA up 25bps; PnL positive',
    },
    description: 'Profitable tick',
  },
  {
    phase: 'reputation-feedback',
    delayMs: 5_000,
    action: 'emit',
    payload: { message: 'Reputation feedback delivered' },
    description: 'Feature G: positive valueDecibel',
  },
  {
    phase: 'complete',
    delayMs: 5_000,
    action: 'emit',
    payload: { message: 'Happy path complete: 60 seconds' },
    description: 'Wrap',
  },
];

/** Frozen scripts. The frontend has no ability to mutate. */
export const DEMO_SCRIPTS: Readonly<Record<DemoScriptId, readonly DemoStep[]>> = Object.freeze({
  'london-investor': Object.freeze(londonInvestorScript),
  'fleet-launch': Object.freeze(fleetLaunchScript),
  'happy-path': Object.freeze(happyPathScript),
});

/** Human-readable labels surfaced by `GET /demo/scripts`. */
export const DEMO_SCRIPT_LABELS: Readonly<Record<DemoScriptId, string>> = Object.freeze({
  'london-investor': '3-min London investor pitch',
  'fleet-launch': '90-sec fleet launch (5 children)',
  'happy-path': '60-sec everything-works speedrun',
});

/**
 * Compute the wall-clock ETA in whole seconds. Pure sum of step delays
 * rounded up to the next second. The frontend renders this as
 * "Total: 3:00".
 */
export function scriptEtaSeconds(scriptId: DemoScriptId): number {
  const steps = DEMO_SCRIPTS[scriptId];
  const totalMs = steps.reduce((acc, s) => acc + s.delayMs, 0);
  return Math.ceil(totalMs / 1000);
}

/** Number of steps in a script. */
export function scriptStepCount(scriptId: DemoScriptId): number {
  return DEMO_SCRIPTS[scriptId].length;
}
