/**
 * Unit tests for `stylusHealthCheck`. Each case stubs the viem `getPublicClient`
 * and inspects the in-memory webhook queue (via `__internal`) since the
 * emitter is real-no-op when `WEBHOOK_URL` is unset.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Required env BEFORE imports.
process.env.DATABASE_URL ||= 'postgresql://test/test';
process.env.JWT_SECRET ||= 'test-secret';

const FAKE_ENGINE = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

describe('stylusHealthCheck', () => {
  beforeEach(async () => {
    // Reset the emitter state between tests; force WEBHOOK_URL to a URL so
    // emit actually queues rather than no-opping (we read the queue, not
    // hit the network).
    process.env.WEBHOOK_URL = 'https://example.test/hook';
    process.env.WEBHOOK_SECRET = 'topsecret';
    const wh = await import('../../services/webhookEmitter.ts');
    wh.__internal.reset();
    const mod = await import('../stylusHealthCheck.ts');
    mod.__internal.reset();
  });

  afterEach(async () => {
    delete process.env.WEBHOOK_URL;
    delete process.env.WEBHOOK_SECRET;
    const wh = await import('../../services/webhookEmitter.ts');
    wh.__internal.reset();
    const mod = await import('../stylusHealthCheck.ts');
    mod.__internal.reset();
  });

  test('healthy program: no webhook emitted', async () => {
    await mock.module('../../config/main-config.ts', () => ({
      BACKEND_MARGIN_ENGINE_ADDRESS_ARB_SEPOLIA: FAKE_ENGINE,
      STYLUS_HEALTH_CHECK_CRON: '0 0 * * 0',
    }));
    await mock.module('../../lib/viem.ts', () => ({
      ARB_SEPOLIA_CHAIN_ID: 421614 as const,
      RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
      getPublicClient: () => ({
        getBytecode: async () => '0x60806040' as `0x${string}`,
        readContract: async () => [1234n, 1n] as const,
      }),
    }));

    const wh = await import('../../services/webhookEmitter.ts');
    wh.__internal.reset();
    const mod = await import('../stylusHealthCheck.ts');
    mod.__internal.reset();
    const result = await mod.__internal.runOnce();
    expect(result.checked).toBe(1);
    expect(wh.__internal.queueSize()).toBe(0);
  });

  test('programInitGas revert: webhook is emitted with codeHash + address', async () => {
    await mock.module('../../config/main-config.ts', () => ({
      BACKEND_MARGIN_ENGINE_ADDRESS_ARB_SEPOLIA: FAKE_ENGINE,
      STYLUS_HEALTH_CHECK_CRON: '0 0 * * 0',
    }));
    await mock.module('../../lib/viem.ts', () => ({
      ARB_SEPOLIA_CHAIN_ID: 421614 as const,
      RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
      getPublicClient: () => ({
        getBytecode: async () => '0xdeadbeef' as `0x${string}`,
        readContract: async () => {
          // Simulate the `ProgramNotActivated()` revert.
          throw new Error('execution reverted: ProgramNotActivated()');
        },
      }),
    }));

    const wh = await import('../../services/webhookEmitter.ts');
    wh.__internal.reset();
    const mod = await import('../stylusHealthCheck.ts');
    mod.__internal.reset();
    const result = await mod.__internal.runOnce();
    expect(result.checked).toBe(1);
    expect(wh.__internal.queueSize()).toBe(1);
  });

  test('engine address unset: no-op, no webhook', async () => {
    await mock.module('../../config/main-config.ts', () => ({
      BACKEND_MARGIN_ENGINE_ADDRESS_ARB_SEPOLIA: undefined,
      STYLUS_HEALTH_CHECK_CRON: '0 0 * * 0',
    }));
    await mock.module('../../lib/viem.ts', () => ({
      ARB_SEPOLIA_CHAIN_ID: 421614 as const,
      RH_CHAIN_TESTNET_CHAIN_ID: 46630 as const,
      getPublicClient: () => {
        throw new Error('should not be called');
      },
    }));

    const wh = await import('../../services/webhookEmitter.ts');
    wh.__internal.reset();
    const mod = await import('../stylusHealthCheck.ts');
    mod.__internal.reset();
    const result = await mod.__internal.runOnce();
    expect(result.checked).toBe(0);
    expect(wh.__internal.queueSize()).toBe(0);
  });
});
