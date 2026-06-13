/**
 * Frontend mirror of backend/src/agent/strategies/llm-executor/schema.ts.
 *
 * No Zod at runtime — backend validates before returning.
 * Keep in sync with the backend source.
 */

export type StrategyActionKind = 'rh-chain-swap' | 'close-half' | 'write-put'

export type StockSymbol = 'TSLA' | 'AMZN' | 'PLTR' | 'NFLX' | 'AMD'

export interface StrategyAction {
  kind: StrategyActionKind
  symbol: StockSymbol
  side: 'buy' | 'sell'
  /** Decimal string. Regex /^\d+(\.\d+)?$/ */
  quantity: string
  strikeUsd?: number
  expiryIso?: string
}

export type StrategyTrigger =
  | { kind: 'immediate' }
  | {
      kind: 'price_crosses'
      symbol: StockSymbol
      direction: 'above' | 'below'
      thresholdUsd: number
    }

export interface StrategyDecision {
  trigger: StrategyTrigger
  /** 1..3 actions */
  actions: StrategyAction[]
  /** 1..500 chars */
  rationale: string
}

/** Shape of POST /api/agent/:tokenId/strategy/propose response data. */
export interface ProposeStrategyResponse {
  status: 'armed' | 'executed' | 'rejected'
  txHashes?: string[]
  reasons?: string[]
  directiveId?: string
  decision?: StrategyDecision
}

/** Shape of POST /api/agent/:tokenId/strategy/propose request body. */
export interface ProposeStrategyRequest {
  directive: string
  clientId: string
  dryRun?: boolean
}
