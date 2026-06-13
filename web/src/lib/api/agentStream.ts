/**
 * useAgentStream — SSE consumer for /api/agent/:tokenId/stream.
 *
 * Native EventSource cannot send custom headers (Authorization) in the browser.
 * We use fetch + ReadableStream + manual text parsing instead.
 *
 * Protocol:
 *   - `event: connected` — stream is open
 *   - `event: meta`      — { viewer_is_owner, tokenId }
 *   - `event: snapshot`  — MarketSnapshot data
 *   - `event: action`    — action event
 *   - `event: risk`      — risk event
 *   - `event: chain`     — chain event (StateAttested etc.)
 *   - `: ping`           — heartbeat comment, every 15s
 *
 * Last-Event-ID:
 *   The `id: <seq>` field from the server is tracked locally. On reconnect,
 *   we send `Last-Event-ID: <seq>` so the ring buffer replay starts after
 *   what we already received.
 *
 * Reconnect:
 *   Exponential backoff: 1s, 2s, 4s, 8s, cap 30s. Resets on successful
 *   `connected` event.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MarketSnapshotJson, PnlPoint, ProposalEvent, RuntimeEventJson } from './agentClient'
import { env } from '@/env'

// ── RH Chain SSE event types ──────────────────────────────────────────────────

export interface RhSwapExecutedEvent {
  tokenId: string
  txHash: string
  blockNumber: number
  fromToken: string
  toToken: string
  amountIn: string
  amountOut: string
  priceWad: string
  nonce: number
  gasUsed: string
}

export interface RhSwapFailedEvent {
  tokenId: string
  fromToken: string
  toToken: string
  amountIn: string
  error: string
}

export interface StateUpdateEvent {
  tokenId: string
  snapshot: unknown  // RhChainPositionSnapshot — opaque at this layer
}

const BACKEND_URL = env.VITE_PUBLIC_BACKEND_URL?.replace(/\/$/, '') ?? 'http://localhost:3700'

export type StreamStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface AgentStreamState {
  status: StreamStatus
  lastSeq: number
  viewerIsOwner: boolean
}

import type { LiquidationDrillEventWire } from '@/lib/drill/types'
import type { DemoEvent } from '@/lib/demo/types'

export interface AgentStreamHandlers {
  onSnapshot?: (data: MarketSnapshotJson, seq: number) => void
  onAction?: (event: RuntimeEventJson & { kind: 'action' }, seq: number) => void
  onRisk?: (event: RuntimeEventJson & { kind: 'risk' }, seq: number) => void
  onChain?: (event: RuntimeEventJson & { kind: 'chain' }, seq: number) => void
  onPnlUpdate?: (point: PnlPoint) => void
  onRhSwapExecuted?: (event: RhSwapExecutedEvent) => void
  onRhSwapFailed?: (event: RhSwapFailedEvent) => void
  onStateUpdate?: (event: StateUpdateEvent) => void
  onLiquidationDrill?: (event: LiquidationDrillEventWire) => void
  onDemoEvent?: (event: DemoEvent) => void
  onProposal?: (event: ProposalEvent, seq: number) => void
}

export type { ProposalEvent }

export function useAgentStream(
  tokenId: string | null,
  jwt: string | null,
  handlers: AgentStreamHandlers,
): AgentStreamState {
  const [status, setStatus] = useState<StreamStatus>('disconnected')
  const [lastSeq, setLastSeq] = useState(-1)
  const [viewerIsOwner, setViewerIsOwner] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const backoffRef = useRef(1000)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSeqRef = useRef(-1)
  // Keep handlers in a ref so the reconnect loop doesn't close over stale values.
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const connect = useCallback(() => {
    if (!tokenId || !jwt) return

    // Cancel previous connection.
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setStatus('connecting')

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${jwt}`,
    }
    if (lastSeqRef.current >= 0) {
      headers['Last-Event-ID'] = String(lastSeqRef.current)
    }

    const url = `${BACKEND_URL}/api/agent/${encodeURIComponent(tokenId)}/stream`

    ;(async () => {
      try {
        const res = await fetch(url, { headers, signal: ctrl.signal })

        if (!res.ok || !res.body) {
          throw new Error(`Stream HTTP ${res.status}`)
        }

        setStatus('connected')
        backoffRef.current = 1000 // reset backoff on successful connect

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buf += decoder.decode(value, { stream: true })

          // SSE messages are separated by blank lines (\n\n).
          const parts = buf.split('\n\n')
          buf = parts.pop() ?? ''

          for (const part of parts) {
            if (!part.trim()) continue
            parseAndDispatch(part)
          }
        }
      } catch (err) {
        if (ctrl.signal.aborted) return // intentional abort, no reconnect
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('aborted')) {
          setStatus('error')
          scheduleReconnect()
        }
      }
    })()

    function parseAndDispatch(rawMessage: string) {
      const lines = rawMessage.split('\n')
      let eventType = ''
      let dataStr = ''
      let idStr = ''

      for (const line of lines) {
        if (line.startsWith(':')) continue // comment / heartbeat
        if (line.startsWith('event:')) eventType = line.slice(6).trim()
        else if (line.startsWith('data:')) dataStr = line.slice(5).trim()
        else if (line.startsWith('id:')) idStr = line.slice(3).trim()
      }

      if (!dataStr) return

      if (idStr) {
        const seq = parseInt(idStr, 10)
        if (Number.isFinite(seq)) {
          lastSeqRef.current = seq
          setLastSeq(seq)
        }
      }

      let data: unknown
      try {
        data = JSON.parse(dataStr)
      } catch {
        return
      }

      const seq = lastSeqRef.current

      switch (eventType) {
        case 'connected':
          // Already set status above; nothing more needed.
          break
        case 'meta': {
          const d = data as { viewer_is_owner?: boolean }
          if (typeof d.viewer_is_owner === 'boolean') {
            setViewerIsOwner(d.viewer_is_owner)
          }
          break
        }
        case 'snapshot': {
          const ev = data as RuntimeEventJson & { kind: 'snapshot' }
          if (ev?.data) {
            handlersRef.current.onSnapshot?.(ev.data, seq)
          }
          break
        }
        case 'action': {
          const ev = data as RuntimeEventJson & { kind: 'action' }
          handlersRef.current.onAction?.(ev, seq)
          break
        }
        case 'risk': {
          const ev = data as RuntimeEventJson & { kind: 'risk' }
          handlersRef.current.onRisk?.(ev, seq)
          break
        }
        case 'chain': {
          const ev = data as RuntimeEventJson & { kind: 'chain' }
          handlersRef.current.onChain?.(ev, seq)
          break
        }
        case 'pnl_update': {
          const point = data as PnlPoint
          handlersRef.current.onPnlUpdate?.(point)
          break
        }
        case 'rh_swap_executed': {
          handlersRef.current.onRhSwapExecuted?.(data as RhSwapExecutedEvent)
          break
        }
        case 'rh_swap_failed': {
          handlersRef.current.onRhSwapFailed?.(data as RhSwapFailedEvent)
          break
        }
        case 'state_update': {
          handlersRef.current.onStateUpdate?.(data as StateUpdateEvent)
          break
        }
        case 'liquidation_drill': {
          handlersRef.current.onLiquidationDrill?.(data as LiquidationDrillEventWire)
          break
        }
        case 'demo_event': {
          handlersRef.current.onDemoEvent?.(data as DemoEvent)
          break
        }
        case 'proposal': {
          const ev = data as ProposalEvent
          handlersRef.current.onProposal?.(ev, seq)
          break
        }
      }
    }

    function scheduleReconnect() {
      if (ctrl.signal.aborted) return
      setStatus('disconnected')
      const delay = backoffRef.current
      backoffRef.current = Math.min(backoffRef.current * 2, 30_000)
      reconnectTimerRef.current = setTimeout(() => {
        if (!ctrl.signal.aborted) connect()
      }, delay)
    }
  }, [tokenId, jwt])

  useEffect(() => {
    if (!tokenId || !jwt) {
      setStatus('disconnected')
      return
    }

    connect()

    return () => {
      abortRef.current?.abort()
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    }
  }, [tokenId, jwt, connect])

  return { status, lastSeq, viewerIsOwner }
}
