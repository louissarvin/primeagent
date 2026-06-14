/**
 * RiskProfileSelector — five-card chooser shown on /launch before mint.
 *
 * Selecting a profile sets both the on-chain Policy caps (Q96.48 USD) AND the
 * default strategy name the runtime will dispatch on `agent.start`. The
 * caller threads the chosen preset id back to launch.tsx, which builds the
 * actual Policy struct via `buildPolicyForProfile`.
 *
 * Design intent: "Balanced" (TSLA pairs, delta-neutral) is the default.
 * Conservative appeals to institutional judges; market-maker and delta-neutral
 * demo the cross-domain engine.
 *
 * Each card shows the truncated presetHash so the operator can verify on-chain
 * tamper-evidence even before mint.
 */

import { cnm } from '@/utils/style'
import { Check, ShieldCheck, ArrowLeftRight, Flame, Activity, TrendingDown } from 'lucide-react'
import type { RiskPresetId } from '@/lib/policy/schemas'
import { RISK_PRESETS } from '@/lib/policy/riskProfiles'

interface RiskProfileSelectorProps {
  value: RiskPresetId
  onChange: (id: RiskPresetId) => void
  disabled?: boolean
}

type IconComponent = React.ComponentType<{ size?: number; className?: string }>

const ICONS: Record<RiskPresetId, IconComponent> = {
  conservative: ShieldCheck,
  balanced: ArrowLeftRight,
  aggressive: Flame,
  'market-maker': Activity,
  'delta-neutral': TrendingDown,
}

const ORDER: RiskPresetId[] = [
  'conservative',
  'balanced',
  'aggressive',
  'market-maker',
  'delta-neutral',
]

const numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function truncateHash(h: `0x${string}`): string {
  return `${h.slice(0, 6)}…${h.slice(-4)}`
}

export default function RiskProfileSelector({
  value,
  onChange,
  disabled,
}: RiskProfileSelectorProps) {
  return (
    <fieldset
      aria-label="Risk preset"
      className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 mb-6"
      disabled={disabled}
    >
      <legend className="sr-only">Risk preset</legend>
      {ORDER.map((id) => {
        const preset = RISK_PRESETS[id]
        if (!preset) return null
        const Icon = ICONS[id]
        const active = id === value
        const isPlaceholderHash =
          preset.presetHash === '0x0000000000000000000000000000000000000000000000000000000000000000'

        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={active}
            disabled={disabled}
            className={cnm(
              'group relative text-left rounded-xl border p-4 transition-all duration-150',
              'focus:outline-none focus-visible:shadow-glow-brand',
              active
                ? 'border-brand bg-brand/5'
                : 'border-border-subtle bg-surface hover:border-border-strong',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Icon size={14} className={active ? 'text-brand' : 'text-fg-muted'} aria-hidden="true" />
                <p className="text-sm font-semibold text-fg">{preset.label}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className={cnm(
                  'text-[10px] font-mono rounded px-1 py-0.5',
                  active ? 'bg-brand/15 text-brand' : 'bg-canvas text-fg-subtle',
                )}>
                  {preset.leverageDisplay}
                </span>
                {active && (
                  <span
                    className="flex items-center justify-center size-5 rounded-full bg-brand text-canvas shrink-0"
                    aria-hidden="true"
                  >
                    <Check size={11} />
                  </span>
                )}
              </div>
            </div>

            <p className="text-[11px] text-fg-muted leading-relaxed mb-3 min-h-[32px]">{preset.blurb}</p>

            <dl className="space-y-1 text-[10px] font-mono text-fg-subtle tabular-nums">
              <div className="flex justify-between">
                <dt>Max notional</dt>
                <dd className="text-fg">${numberFmt.format(preset.maxNotionalUsd)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Daily cap</dt>
                <dd className="text-fg">${numberFmt.format(preset.dailyCapUsd)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Window</dt>
                <dd className="text-fg">{preset.durationDays}d</dd>
              </div>
              <div className="flex justify-between">
                <dt>Strategy</dt>
                <dd className="text-fg truncate ml-2 max-w-[100px]">{preset.defaultStrategy}</dd>
              </div>
            </dl>

            {/* Preset hash */}
            {!isPlaceholderHash && (
              <p
                className="mt-2 text-[9px] font-mono text-fg-subtle truncate"
                title={preset.presetHash}
              >
                {truncateHash(preset.presetHash)}
              </p>
            )}
          </button>
        )
      })}
    </fieldset>
  )
}
