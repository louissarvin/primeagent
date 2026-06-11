/**
 * Strategy registry.
 *
 * The runtime looks up strategies by name. Add a new strategy by importing
 * it here and adding to the `strategyRegistry` map; the agent endpoint will
 * accept it on the next reload.
 */

import type { Strategy } from '../Strategy.ts';
import { tslaPairs } from './tsla-pairs.ts';
import { meanReversion } from './mean-reversion.ts';
import { momentumBreakout } from './momentum-breakout.ts';
import { llmAdvisor } from './llm-advisor.ts';

export const strategyRegistry: Record<string, Strategy> = {
  'tsla-pairs': tslaPairs,
  'mean-reversion': meanReversion,
  'momentum-breakout': momentumBreakout,
  'llm-advisor': llmAdvisor,
};

export function getStrategy(name: string): Strategy | null {
  return strategyRegistry[name] ?? null;
}

export function listStrategies(): string[] {
  return Object.keys(strategyRegistry);
}
