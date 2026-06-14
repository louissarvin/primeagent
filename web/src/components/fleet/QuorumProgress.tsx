/**
 * QuorumProgress — visual showing current yesBps vs the 6000 (60%) threshold
 * and totalWeight vs the 5000 (50bp) minimum.
 *
 * Used in the parent-side tally view.
 */

import { cnm } from '@/utils/style'

const QUORUM_BPS = 6000
const MIN_WEIGHT_BPS = 5000

interface QuorumProgressProps {
  yesBps: number
  totalWeight: number
  execute: boolean
}

export default function QuorumProgress({ yesBps, totalWeight, execute }: QuorumProgressProps) {
  const yesPercent = Math.min(100, (yesBps / 10000) * 100)
  const weightPercent = Math.min(100, (totalWeight / 10000) * 100)
  const quorumLine = (QUORUM_BPS / 10000) * 100
  const minWeightLine = (MIN_WEIGHT_BPS / 10000) * 100

  return (
    <div className="space-y-4">
      {/* Consensus bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Consensus</p>
          <p className={cnm(
            'text-[11px] font-mono font-semibold tabular-nums',
            yesBps >= QUORUM_BPS ? 'text-up' : 'text-fg-muted',
          )}>
            {(yesBps / 100).toFixed(1)}% yes
          </p>
        </div>
        <div className="relative h-2 w-full rounded-full bg-elevated overflow-hidden">
          <div
            className={cnm(
              'absolute left-0 top-0 h-full rounded-full transition-[width] duration-500',
              yesBps >= QUORUM_BPS ? 'bg-up' : 'bg-brand',
            )}
            style={{ width: `${yesPercent}%` }}
            role="progressbar"
            aria-valuenow={yesBps}
            aria-valuemin={0}
            aria-valuemax={10000}
          />
          {/* Quorum threshold marker */}
          <div
            className="absolute top-0 h-full w-px bg-warning/60"
            style={{ left: `${quorumLine}%` }}
            aria-label={`Quorum threshold: ${QUORUM_BPS / 100}%`}
          />
        </div>
        <p className="text-[10px] text-fg-subtle">
          Threshold: {QUORUM_BPS / 100}%
        </p>
      </div>

      {/* Weight bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Weight</p>
          <p className={cnm(
            'text-[11px] font-mono font-semibold tabular-nums',
            totalWeight >= MIN_WEIGHT_BPS ? 'text-up' : 'text-fg-muted',
          )}>
            {totalWeight.toLocaleString('en-US')} bps
          </p>
        </div>
        <div className="relative h-2 w-full rounded-full bg-elevated overflow-hidden">
          <div
            className={cnm(
              'absolute left-0 top-0 h-full rounded-full transition-[width] duration-500',
              totalWeight >= MIN_WEIGHT_BPS ? 'bg-up' : 'bg-fg-subtle',
            )}
            style={{ width: `${weightPercent}%` }}
            role="progressbar"
            aria-valuenow={totalWeight}
            aria-valuemin={0}
            aria-valuemax={10000}
          />
          <div
            className="absolute top-0 h-full w-px bg-warning/60"
            style={{ left: `${minWeightLine}%` }}
            aria-label={`Minimum weight: ${MIN_WEIGHT_BPS} bps`}
          />
        </div>
        <p className="text-[10px] text-fg-subtle">
          Minimum: {MIN_WEIGHT_BPS.toLocaleString('en-US')} bps
        </p>
      </div>

      {/* Execute badge */}
      {execute && (
        <div className="flex items-center gap-2 rounded-lg border border-up/30 bg-up/8 px-3 py-2">
          <span className="size-1.5 rounded-full bg-up shrink-0" aria-hidden="true" />
          <p className="text-xs text-up font-medium">Quorum reached. Ready to execute.</p>
        </div>
      )}
    </div>
  )
}
