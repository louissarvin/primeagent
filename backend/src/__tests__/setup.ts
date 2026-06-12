/**
 * Test preload (referenced from bunfig.toml `[test] preload`).
 *
 * `src/config/main-config.ts` fatal-exits when DATABASE_URL or JWT_SECRET
 * are unset. CI / local test runs without a real .env should still pass the
 * unit-test suite, so this preload populates safe placeholders before any
 * test module's static imports execute.
 *
 * Tests that need different values should override these via `process.env`
 * inside the test file (or use `mock.module` for finer control).
 */

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret-placeholder-32-bytes-long-xyz';
process.env.BACKEND_TOKEN_ENC_KEY ||= Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
process.env.NODE_ENV ||= 'development';
