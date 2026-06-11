/**
 * Wave-K: thesis hash determinism tests.
 */
import { describe, it, expect } from 'bun:test';

import { computeThesisHash, type FleetThesisBody } from '../voteSchemas.ts';

const body: FleetThesisBody = {
  parentTokenId: 1n,
  body: 'reduce TSLA exposure to 5 contracts',
  proposedActions: [{ kind: 'rh-chain-swap', symbol: 'TSLA', side: 'sell', quantity: '5' }],
  nonce: 7n,
  deadline: 1_700_000_000n,
};

describe('computeThesisHash', () => {
  it('is stable across two calls with identical body', () => {
    expect(computeThesisHash(body)).toBe(computeThesisHash(body));
  });
  it('changes when nonce changes', () => {
    expect(computeThesisHash({ ...body, nonce: 8n })).not.toBe(computeThesisHash(body));
  });
  it('changes when body text changes', () => {
    expect(computeThesisHash({ ...body, body: 'different text' })).not.toBe(computeThesisHash(body));
  });
});
