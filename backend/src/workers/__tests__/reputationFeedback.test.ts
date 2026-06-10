import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { __internal } from '../reputationFeedback.ts';

describe('reputationFeedback worker', () => {
  let originalKey: string | undefined;
  let originalRegistry: string | undefined;

  beforeEach(() => {
    originalKey = process.env.BACKEND_ATTESTOR_PRIVATE_KEY;
    originalRegistry = process.env.BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.BACKEND_ATTESTOR_PRIVATE_KEY;
    } else {
      process.env.BACKEND_ATTESTOR_PRIVATE_KEY = originalKey;
    }
    if (originalRegistry === undefined) {
      delete process.env.BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA;
    } else {
      process.env.BACKEND_AGENT_REGISTRY_ADDRESS_ARB_SEPOLIA = originalRegistry;
    }
  });

  test('previousHourWindow snaps to hour boundary', () => {
    const now = new Date('2026-06-14T15:42:33.000Z');
    const { start, end } = __internal.previousHourWindow(now);
    expect(start.toISOString()).toBe('2026-06-14T14:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-14T15:00:00.000Z');
  });
});
