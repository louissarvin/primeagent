/**
 * ActionsLog — virtualised recent actions + live SSE events.
 * DESIGN.md §7.6: timestamp-left / content-centre / link-right pattern.
 * Virtualised with @tanstack/react-virtual, cap 100 rows.
 *
 * New row entrance: CSS animation (opacity 0->1, y -4->0) on .row-enter class.
 * AnimatePresence is incompatible with react-virtual's absolute positioning;
 * CSS animation is cleaner here.
 */

import { useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowUpRight, ChevronRight } from 'lucide-react'
import { cnm } from '@/utils/style'
import { formatTimeLondon, truncateTxHash } from '@/lib/currency'
import { CONTRACTS } from '@/config'
import type { RuntimeEventJson } from '@/lib/api/agentClient'

const ARBISCAN = 'https://sepolia.arbiscan.io'
const RH_CHAIN_EXPLORER = 'https://explorer.testnet.chain.robinhood.com'

/** Which explorer should a given event link to? */
type ExplorerKind = 'arbiscan' | 'rh_chain'

function explorerTxUrl(kind: ExplorerKind, hash: string): string {
  return kind === 'rh_chain'
    ? `${RH_CHAIN_EXPLORER}/tx/${hash}`
    : `${ARBISCAN}/tx/${hash}`
}

function explorerAddressUrl(kind: ExplorerKind, addr: string): string {
  return kind === 'rh_chain'
    ? `${RH_CHAIN_EXPLORER}/address/${addr}`
    : `${ARBISCAN}/address/${addr}`
}

/**
 * Map a tokenised stock symbol to its RH Chain testnet contract address.
 * Source: https://docs.robinhood.com/chain/contracts (also mirrored in
 * web/src/config.ts CONTRACTS).
 */
function rhChainTokenAddress(symbol: string | undefined): `0x${string}` | null {
  switch ((symbol ?? '').toUpperCase()) {
    case 'TSLA': return CONTRACTS.RH_CHAIN_TSLA
    case 'AMZN': return CONTRACTS.RH_CHAIN_AMZN
    case 'PLTR': return CONTRACTS.RH_CHAIN_PLTR
    case 'NFLX': return CONTRACTS.RH_CHAIN_NFLX
    case 'AMD':  return CONTRACTS.RH_CHAIN_AMD
    case 'USDG': return CONTRACTS.RH_CHAIN_USDG
    default:     return null
  }
}

interface EventLabel {
  text: string
  colorClass: string
  dotClass?: string
  txHash?: string
  /** Which explorer the txHash link should hit. */
  explorerKind?: ExplorerKind
  /** Address link surfaced when no txHash exists (e.g. "Plan:" rows). */
  contractAddress?: string
  contractAddressExplorer?: ExplorerKind
  /** Optional label override for the address link ("TSLA" vs "contract"). */
  contractAddressLabel?: string
}

function eventLabel(ev: RuntimeEventJson): EventLabel {
  if (ev.kind === 'action') {
    const d = ev.data
    const side = d.side ? (d.side === 'buy' ? 'Buy' : 'Sell') : (d.type ?? 'Action')
    // qty is Q96.48 fixed-point (backend bigintReplacer string). Render as
    // human-readable shares for the demo audience: divide by 2^48 and trim
    // trailing zeros. Falls back to the raw string if conversion fails.
    const Q48 = 281474976710656
    let qty = ''
    if (d.qty) {
      try {
        const shares = Number(BigInt(d.qty)) / Q48
        qty = Math.abs(shares) >= 0.01
          ? shares.toFixed(2)
          : shares.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
      } catch {
        qty = String(d.qty)
      }
    }
    const sym = d.symbol ?? ''
    // Distinguish on-chain (RH Chain swap contract) from off-chain (Robinhood
    // MCP attestor). On-chain actions are PLANS at this stage; the actual
    // swap result lands as a separate rh_swap_executed or rh_swap_failed
    // event. Label them with "Plan:" so users do not assume execution.
    const isChain = (d.type ?? '').includes('chain')
    const venue = isChain ? 'RH Chain' : 'Robinhood (off-chain)'
    const prefix = isChain ? 'Plan: ' : ''
    // For RH Chain plan rows, link to the actual tokenised-stock contract
    // (TSLA, AMZN, PLTR, NFLX, AMD, USDG) so operators land on the real
    // asset page on the RH Chain explorer rather than the swap router.
    // Falls back to the swap contract when the symbol is unknown.
    const tokenAddr = isChain ? rhChainTokenAddress(d.symbol) : null
    const fallbackSwapAddr =
      isChain && typeof CONTRACTS.RH_CHAIN_SWAP === 'string' && CONTRACTS.RH_CHAIN_SWAP.length > 0
        ? CONTRACTS.RH_CHAIN_SWAP
        : undefined
    const target = tokenAddr ?? fallbackSwapAddr ?? undefined
    return {
      text: `${prefix}${side} ${qty} ${sym} via ${venue}`.replace(/\s+/g, ' ').trim(),
      colorClass: isChain ? 'text-fg-muted' : 'text-fg',
      contractAddress: target,
      contractAddressExplorer: target ? 'rh_chain' : undefined,
      contractAddressLabel: tokenAddr ? (d.symbol ?? '').toUpperCase() : undefined,
    }
  }

  if (ev.kind === 'rh_swap_executed') {
    const Q48 = 281474976710656
    const fmt = (raw?: string) => {
      if (!raw) return ''
      try {
        const v = Number(BigInt(raw)) / Q48
        return Math.abs(v) >= 0.01 ? v.toFixed(2) : v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
      } catch { return '' }
    }
    const out = fmt(ev.data?.amountOut)
    const toSym = ev.data?.toToken?.slice(-4) ?? ''
    return {
      text: `Swap landed · received ${out} (${toSym}) on RH Chain`,
      colorClass: 'text-up',
      dotClass: 'bg-up',
      txHash: ev.data?.txHash,
      explorerKind: 'rh_chain',
    }
  }

  if (ev.kind === 'rh_swap_failed') {
    // Failed swaps may carry a reverted-tx hash when the failure happened
    // after submission. The runtime currently does not include it, but the
    // shape allows for it.
    const txHash = (ev.data as { txHash?: string })?.txHash
    // Prefer the tokenised-stock destination address; fall back to the
    // toToken address from the event payload (already a token address) or
    // the swap router as a last resort.
    const toTokenAddr =
      typeof ev.data?.toToken === 'string' && /^0x[0-9a-fA-F]{40}$/.test(ev.data.toToken)
        ? (ev.data.toToken as `0x${string}`)
        : undefined
    const swapAddr =
      typeof CONTRACTS.RH_CHAIN_SWAP === 'string' && CONTRACTS.RH_CHAIN_SWAP.length > 0
        ? CONTRACTS.RH_CHAIN_SWAP
        : undefined
    const fallbackAddr = toTokenAddr ?? swapAddr
    return {
      text: `Swap failed: ${ev.data?.error ?? 'unknown error'}`,
      colorClass: 'text-down',
      dotClass: 'bg-down',
      txHash,
      explorerKind: txHash ? 'rh_chain' : undefined,
      contractAddress: !txHash ? fallbackAddr : undefined,
      contractAddressExplorer: !txHash && fallbackAddr ? 'rh_chain' : undefined,
    }
  }

  if (ev.kind === 'risk') {
    const cls =
      ev.severity === 'critical'
        ? 'text-down'
        : ev.severity === 'warn'
          ? 'text-warning'
          : 'text-fg-muted'
    const dot = ev.severity === 'critical' ? 'bg-down' : ev.severity === 'warn' ? 'bg-warning' : undefined
    return { text: ev.message, colorClass: cls, dotClass: dot }
  }

  if (ev.kind === 'chain') {
    const isAttest = ev.event === 'StateAttested'
    return {
      text: isAttest
        ? `Attestation posted · block ${ev.blockNumber ?? ''}`
        : ev.event,
      colorClass: isAttest ? 'text-fg' : 'text-fg-muted',
      dotClass: isAttest ? 'bg-live' : undefined,
      txHash: ev.txHash,
      explorerKind: 'arbiscan',
    }
  }

  return { text: 'Event', colorClass: 'text-fg-subtle' }
}

interface ActionsLogProps {
  events: RuntimeEventJson[]
}

export default function ActionsLog({ events }: ActionsLogProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<number | null>(null)

  // Cap at 100, newest first.
  const rows = events.slice(-100).reverse()

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 5,
  })

  // Render the reason field (action events only). null when absent.
  function getReason(ev: RuntimeEventJson): string | null {
    if (ev.kind !== 'action') return null
    return (ev.data as { reason?: string }).reason ?? null
  }

  return (
    <section aria-label="Recent actions">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-fg-muted">Recent actions</p>
        <span className="font-mono text-xs text-fg-subtle tabular-nums">last 100 events, live</span>
      </div>

      <div className="bg-surface rounded-xl border border-border-subtle">
        {rows.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-fg-subtle">Waiting for the first event…</p>
          </div>
        ) : (
          <div
            ref={parentRef}
            className="overflow-y-auto"
            style={{ maxHeight: 480 }}
          >
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const ev = rows[virtualRow.index]
                if (!ev) return null
                const {
                  text,
                  colorClass,
                  dotClass,
                  txHash,
                  explorerKind,
                  contractAddress,
                  contractAddressExplorer,
                  contractAddressLabel,
                } = eventLabel(ev)
                const isFirst = virtualRow.index === 0

                return (
                  <div
                    key={`${ev.kind}-${ev.ts}-${virtualRow.index}`}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div
                      className={cnm(
                        'border-b border-border-subtle',
                        isFirst && 'row-enter',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          const reason = getReason(ev)
                          if (!reason) return
                          setExpanded((prev) => (prev === virtualRow.index ? null : virtualRow.index))
                        }}
                        className={cnm(
                          'w-full flex items-center gap-3 px-4 py-2.5 text-left',
                          getReason(ev) ? 'cursor-pointer hover:bg-elevated/40' : 'cursor-default',
                        )}
                        style={{ minHeight: 40 }}
                        aria-expanded={expanded === virtualRow.index}
                      >
                        {/* Chevron when reason is present */}
                        {getReason(ev) ? (
                          <ChevronRight
                            size={11}
                            className={cnm(
                              'text-fg-subtle shrink-0 transition-transform duration-150',
                              expanded === virtualRow.index && 'rotate-90',
                            )}
                            aria-hidden="true"
                          />
                        ) : (
                          <span className="size-[11px] shrink-0" aria-hidden="true" />
                        )}

                        {/* Timestamp */}
                        <time
                          className="font-mono text-xs text-fg-muted tabular-nums shrink-0 w-16"
                          style={{ fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }}
                        >
                          {formatTimeLondon(ev.ts)}
                        </time>

                        {/* Event type dot */}
                        {dotClass && (
                          <span className={cnm('size-1.5 rounded-full shrink-0', dotClass)} aria-hidden="true" />
                        )}

                        {/* Event text */}
                        <span className={cnm('flex-1 text-sm min-w-0 truncate', colorClass)}>
                          {text}
                        </span>

                        {/* Tx link (prefers RH Chain explorer when the event
                            originated on chain 46630, falls back to Arbiscan
                            for attestation events on Arbitrum Sepolia). */}
                        {txHash && (
                          <a
                            href={explorerTxUrl(explorerKind ?? 'arbiscan', txHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="flex items-center gap-1 font-mono text-xs text-fg-subtle hover:text-brand transition-colors duration-[120ms] shrink-0"
                            style={{ fontFamily: 'var(--font-mono)' }}
                            title={
                              explorerKind === 'rh_chain'
                                ? 'Open on RH Chain explorer'
                                : 'Open on Arbiscan'
                            }
                          >
                            {truncateTxHash(txHash)}
                            <ArrowUpRight className="size-3" aria-hidden="true" />
                          </a>
                        )}

                        {/* When there is no tx hash but the event has a
                            related contract (e.g. RH Chain swap "Plan:" rows
                            and pre-submission failures), surface a small
                            link to that contract on the right explorer. The
                            label prefers the tokenised-stock symbol ("TSLA",
                            "AMZN", ...) when known, falling back to the
                            generic "contract" word otherwise. */}
                        {!txHash && contractAddress && contractAddressExplorer && (
                          <a
                            href={explorerAddressUrl(contractAddressExplorer, contractAddress)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="flex items-center gap-1 font-mono text-[10px] text-fg-subtle hover:text-brand transition-colors duration-[120ms] shrink-0"
                            style={{ fontFamily: 'var(--font-mono)' }}
                            title={
                              contractAddressExplorer === 'rh_chain'
                                ? `Open ${contractAddressLabel ?? 'contract'} on RH Chain explorer`
                                : 'Open contract on Arbiscan'
                            }
                          >
                            {contractAddressLabel ?? 'contract'}
                            <ArrowUpRight className="size-3" aria-hidden="true" />
                          </a>
                        )}
                      </button>

                      {expanded === virtualRow.index && getReason(ev) && (
                        <div className="px-4 pb-3 pt-0 pl-[68px] -mt-1">
                          <p className="text-[11px] text-fg-muted italic leading-relaxed">
                            {getReason(ev)}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
