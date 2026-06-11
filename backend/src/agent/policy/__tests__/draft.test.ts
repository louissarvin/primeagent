import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { AgentPolicyDraftSchema } from '../schemas.ts';
import { ComposeDraftError } from '../draft.ts';

const baseInput = {
  operatorAsk: 'I want a delta-neutral TSLA strategy with $50k per trade',
  clientId: 'client-id-aaaaaaaaaaaaaaaa',
  tokenId: null,
  allowedContracts: ['0x' + 'a'.repeat(40)] as `0x${string}`[],
};

describe('composeDraft', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY ||= 'gsk-test-placeholder';
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.GROQ_API_KEY;
    } else {
      process.env.GROQ_API_KEY = originalKey;
    }
  });

  test('LLM_UNAVAILABLE when groq client is null', async () => {
    await mock.module('../../llm.ts', () => ({
      groq: null,
      MODEL_DEFAULT: 'llama-3.3-70b-versatile',
    }));
    const { composeDraft } = await import('../draft.ts');
    try {
      await composeDraft(baseInput);
      throw new Error('expected composeDraft to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ComposeDraftError);
      expect((err as ComposeDraftError).code).toBe('LLM_UNAVAILABLE');
    }
  });

  test('produces a Zod-valid AgentPolicyDraft on a clean JSON response', async () => {
    await mock.module('../../llm.ts', () => ({
      groq: {
        chat: {
          completions: {
            create: async () => ({
              id: 'cmpl_test',
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: JSON.stringify({
                      presetId: 'delta-neutral',
                      maxNotionalUsd: 50_000,
                      dailyCapUsd: 200_000,
                      durationDays: 30,
                      allowedSymbols: ['TSLA'],
                      strategyName: 'tsla-pairs',
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 60 },
            }),
          },
        },
      },
      MODEL_DEFAULT: 'llama-3.3-70b-versatile',
    }));
    const { composeDraft } = await import('../draft.ts');
    const draft = await composeDraft(baseInput);
    const parsed = AgentPolicyDraftSchema.safeParse(draft);
    expect(parsed.success).toBe(true);
    expect(draft.presetId).toBe('delta-neutral');
    expect(draft.maxNotionalUsd).toBe(50_000);
    expect(draft.allowedSymbols).toEqual(['TSLA']);
    expect(draft.allowedSelectors.length).toBeGreaterThan(0);
  });

  test('LLM_BAD_OUTPUT when content is not valid JSON', async () => {
    await mock.module('../../llm.ts', () => ({
      groq: {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                { message: { role: 'assistant', content: 'no json here, just prose' } },
              ],
            }),
          },
        },
      },
      MODEL_DEFAULT: 'llama-3.3-70b-versatile',
    }));
    const { composeDraft } = await import('../draft.ts');
    try {
      await composeDraft(baseInput);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ComposeDraftError).code).toBe('LLM_BAD_OUTPUT');
    }
  });

  test('SCHEMA_FAILED when LLM returns values outside the Zod caps', async () => {
    await mock.module('../../llm.ts', () => ({
      groq: {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: JSON.stringify({
                      presetId: 'balanced',
                      maxNotionalUsd: 999_999_999, // > 10M cap
                      dailyCapUsd: 100,
                      durationDays: 30,
                      allowedSymbols: ['TSLA'],
                      strategyName: 'tsla-pairs',
                    }),
                  },
                },
              ],
            }),
          },
        },
      },
      MODEL_DEFAULT: 'llama-3.3-70b-versatile',
    }));
    const { composeDraft } = await import('../draft.ts');
    try {
      await composeDraft(baseInput);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ComposeDraftError).code).toBe('SCHEMA_FAILED');
    }
  });
});
