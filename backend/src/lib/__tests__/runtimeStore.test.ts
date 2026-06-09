import { beforeEach, describe, expect, test } from 'bun:test';

// Set required env BEFORE importing runtimeStore so transitive main-config
// imports do not hit the fatal-exit path. The test imports run after this
// because we use a dynamic import.
process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

const mod = await import('../runtimeStore.ts');
const { __internal, getRuntimeState, listActiveTokenIds, publishEvent, subscribe, updateStatus } =
  mod;
type RuntimeEvent = import('../runtimeStore.ts').RuntimeEvent;

describe('runtimeStore', () => {
  beforeEach(() => {
    __internal.reset();
  });

  test('getRuntimeState creates idle entry on first access', () => {
    const s = getRuntimeState(1n);
    expect(s.status).toBe('idle');
    expect(s.seq).toBe(0);
    expect(s.recent).toEqual([]);
    expect(s.lastSnapshot).toBeNull();
    expect(s.lastTickAt).toBeNull();
  });

  test('updateStatus mutates the existing state', () => {
    updateStatus(2n, 'running');
    expect(getRuntimeState(2n).status).toBe('running');
    updateStatus(2n, 'halted_liquidated');
    expect(getRuntimeState(2n).status).toBe('halted_liquidated');
  });

  test('publishEvent assigns monotonic seq and appends to ring buffer', () => {
    const events: RuntimeEvent[] = [
      { kind: 'risk', tokenId: 3n, ts: 1, severity: 'info', message: 'a' },
      { kind: 'risk', tokenId: 3n, ts: 2, severity: 'info', message: 'b' },
      { kind: 'risk', tokenId: 3n, ts: 3, severity: 'warn', message: 'c' },
    ];
    const seqs = events.map((e) => publishEvent(3n, e).seq);
    expect(seqs).toEqual([1, 2, 3]);
    expect(getRuntimeState(3n).recent.length).toBe(3);
    expect(getRuntimeState(3n).seq).toBe(3);
  });

  test('publishEvent caps ring buffer at 100', () => {
    for (let i = 0; i < 150; i++) {
      publishEvent(4n, {
        kind: 'risk',
        tokenId: 4n,
        ts: i,
        severity: 'info',
        message: `m${i}`,
      });
    }
    const s = getRuntimeState(4n);
    expect(s.recent.length).toBe(__internal.ringCap);
    expect(s.seq).toBe(150);
    // Oldest preserved entry should be m50 (the oldest of the trailing 100).
    const first = s.recent[0] as Extract<RuntimeEvent, { kind: 'risk' }>;
    expect(first.message).toBe('m50');
  });

  test('snapshot event updates lastSnapshot and lastTickAt', () => {
    const ts = 1_700_000_000_000;
    // Build a minimal MarketSnapshot-typed payload. The shape is the same one
    // the tick loop publishes; we use the loose `as never` cast only so the
    // test does not need to mirror the full strategy import surface here.
    const data = {
      tokenId: 5n,
      ts,
      cashUsdQ96: 0n,
      buyingPowerUsdQ96: 0n,
      netCollateralUsdQ96: 0n,
      onChain: {},
      offChain: {},
      paused: false,
      shutdown: false,
    } as never;
    publishEvent(5n, { kind: 'snapshot', tokenId: 5n, ts, data });
    const s = getRuntimeState(5n);
    expect(s.lastSnapshot).not.toBeNull();
    expect(s.lastTickAt?.getTime()).toBe(ts);
  });

  test('subscribe receives live events with the assigned seq', () => {
    const received: Array<{ seq: number; msg: string }> = [];
    const unsub = subscribe(6n, (ev, seq) => {
      if (ev.kind === 'risk') received.push({ seq, msg: ev.message });
    });
    publishEvent(6n, { kind: 'risk', tokenId: 6n, ts: 1, severity: 'info', message: 'x' });
    publishEvent(6n, { kind: 'risk', tokenId: 6n, ts: 2, severity: 'info', message: 'y' });
    unsub();
    publishEvent(6n, { kind: 'risk', tokenId: 6n, ts: 3, severity: 'info', message: 'z' });

    expect(received).toEqual([
      { seq: 1, msg: 'x' },
      { seq: 2, msg: 'y' },
    ]);
  });

  test('subscribe replays events from ring buffer where seq > fromSeq', () => {
    for (let i = 0; i < 5; i++) {
      publishEvent(7n, {
        kind: 'risk',
        tokenId: 7n,
        ts: i,
        severity: 'info',
        message: `r${i}`,
      });
    }
    const replayed: Array<{ seq: number; msg: string }> = [];
    const unsub = subscribe(
      7n,
      (ev, seq) => {
        if (ev.kind === 'risk') replayed.push({ seq, msg: ev.message });
      },
      2,
    );
    unsub();
    // seqs 3, 4, 5 should be replayed (we asked for > 2).
    expect(replayed.map((x) => x.msg)).toEqual(['r2', 'r3', 'r4']);
    expect(replayed.map((x) => x.seq)).toEqual([3, 4, 5]);
  });

  test('listActiveTokenIds returns ids that have any recorded state', () => {
    getRuntimeState(8n);
    publishEvent(9n, { kind: 'risk', tokenId: 9n, ts: 1, severity: 'info', message: 'q' });
    const ids = listActiveTokenIds();
    expect(ids).toContain(8n);
    expect(ids).toContain(9n);
  });

  test('__internal.reset clears state and emitters', () => {
    publishEvent(10n, {
      kind: 'risk',
      tokenId: 10n,
      ts: 0,
      severity: 'info',
      message: 'x',
    });
    expect(getRuntimeState(10n).seq).toBe(1);
    __internal.reset();
    expect(getRuntimeState(10n).seq).toBe(0);
    expect(listActiveTokenIds()).toContain(10n);
  });
});
