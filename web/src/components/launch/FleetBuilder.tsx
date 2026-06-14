/**
 * FleetBuilder — Feature D fleet spawn form.
 *
 * Operator selects count (1..10), a base preset, a name template, and an
 * optional parent tokenId. Submits to POST /api/fleet/spawn which returns a
 * batched userOp call array for the operator to sign once via the Kernel.
 *
 * After signing, POSTs /api/fleet/confirm with the txHash. The result table
 * is rendered by FleetResultTable.
 *
 * NOTE: The on-chain execution path (Kernel client sign + sendUserOperation)
 * requires a live backend. The form compiles and validates without one;
 * the submit button is disabled when no jwt is present.
 */

import { useState } from 'react'
import { Loader2, Users } from 'lucide-react'
import { cnm } from '@/utils/style'
import { RISK_PRESETS } from '@/lib/policy/riskProfiles'
import { selectorsForPreset } from '@/lib/policy/selectors'
import { CONTRACTS } from '@/config'
import type { RiskPresetId } from '@/lib/policy/schemas'
import { createAgentClient } from '@/lib/api/agentClient'
import type { FleetResult } from '@/lib/fleet/types'
import FleetResultTable from './FleetResultTable'

interface FleetBuilderProps {
  jwt: string | null
  disabled?: boolean
  /** Optional parent tokenId (when spawning from an existing agent dashboard). */
  parentTokenId?: bigint
}

const PRESET_IDS = Object.keys(RISK_PRESETS) as RiskPresetId[]
const numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function previewNames(template: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => template.replace(/#{n}/g, String(i + 1)))
}

export default function FleetBuilder({ jwt, disabled, parentTokenId }: FleetBuilderProps) {
  const [count, setCount] = useState(3)
  const [nameTemplate, setNameTemplate] = useState('Alpha-#{n}')
  const [presetId, setPresetId] = useState<RiskPresetId>('balanced')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<FleetResult | null>(null)

  const preset = RISK_PRESETS[presetId]
  const names = previewNames(nameTemplate, count)
  const canSubmit = !!jwt && !disabled && !loading && nameTemplate.trim().length > 0

  const handleSpawn = async () => {
    if (!jwt || !preset) return
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const client = createAgentClient(jwt)

      // Generate a stable clientId for this spawn attempt.
      const clientId = `fleet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

      // Derive selector allowlist from the preset's canonical strategy sigs.
      // Mirrors backend/src/lib/selectors.ts STRATEGY_SELECTOR_PRESETS.
      const allowedSelectors = selectorsForPreset(presetId)
      // Diamond is the primary allowed contract for all presets. Additional
      // adapter addresses would be added here once deployed on testnet.
      const allowedContracts: `0x${string}`[] = [CONTRACTS.Diamond]

      const baseDraft = {
        tokenId: null,
        clientId,
        presetId,
        maxNotionalUsd: preset.maxNotionalUsd,
        dailyCapUsd: preset.dailyCapUsd,
        durationDays: preset.durationDays,
        allowedSymbols: preset.allowedSymbols,
        allowedContracts,
        allowedSelectors,
        strategyName: preset.defaultStrategy,
        presetHash: preset.presetHash,
        draftedAt: Math.floor(Date.now() / 1000),
      }

      const spawnRes = await client.spawnFleet({
        clientId,
        count,
        strategyName: preset.defaultStrategy,
        policy: baseDraft,
        nameTemplate,
        parentTokenId: parentTokenId ?? null,
      })

      // Signing the batched userOp via the Kernel client requires a connected
      // wallet and a live ZeroDev project. In DEV mode we surface the expected
      // names as a demo preview so the table renders without signing.
      if (import.meta.env.DEV) {
        // DEV PREVIEW ONLY — not signed, no userOp submitted.
        setResult({
          clientId,
          members: spawnRes.data.expectedMembers.map((m, i) => ({
            tokenId: BigInt(i + 1),
            vault: '0x0000000000000000000000000000000000000000' as `0x${string}`,
            tba: '0x0000000000000000000000000000000000000000' as `0x${string}`,
            agentId: BigInt(i + 1),
            txHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
            name: m.name,
          })),
          errors: [],
        })
      } else {
        // Production path: sign the batched userOp via the Kernel client.
        // kernelClient.sendUserOperation(spawnRes.data.calls) is wired in
        // useKernelClient once the ZeroDev project is configured.
        // Until that hook is wired here, show an actionable error rather
        // than fabricating a successful result.
        throw new Error('Kernel sign path not yet wired. Connect a ZeroDev-enabled wallet to deploy.')
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      setError(raw.length > 200 ? 'Spawn failed. Check console.' : raw)
    } finally {
      setLoading(false)
    }
  }

  if (result) {
    return (
      <div className="space-y-4">
        {import.meta.env.DEV && (
          <div className="px-3 py-2 rounded-lg bg-warning/10 border border-warning/20">
            <p className="text-xs text-warning font-medium">Demo preview — not signed. Kernel sign path not yet wired.</p>
          </div>
        )}
        <FleetResultTable result={result} />
        <button
          type="button"
          onClick={() => setResult(null)}
          className="text-xs text-fg-muted hover:text-fg"
        >
          Spawn another fleet
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h1
          className="text-xl font-semibold text-fg mb-1"
          style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}
        >
          Deploy a Fleet
        </h1>
        <p className="text-sm text-fg-muted leading-relaxed">
          Mint multiple Agent NFTs in a single signed transaction. All members share the same base policy.
        </p>
      </div>

      {/* Count slider */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label htmlFor="fleet-count" className="text-[10px] uppercase tracking-wider text-fg-muted">
            Count
          </label>
          <span className="font-mono text-sm text-fg tabular-nums">{count}</span>
        </div>
        <input
          id="fleet-count"
          type="range"
          min={1}
          max={10}
          step={1}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
          disabled={disabled}
          className="w-full accent-brand"
          aria-label="Number of agents to spawn"
        />
        <div className="flex justify-between text-[9px] text-fg-subtle font-mono tabular-nums">
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setCount(n)}
              className={cnm(
                'transition-colors',
                count === n ? 'text-brand' : 'hover:text-fg',
              )}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* Name template */}
      <div className="space-y-1">
        <label htmlFor="fleet-template" className="block text-[10px] uppercase tracking-wider text-fg-muted">
          Name template
        </label>
        <input
          id="fleet-template"
          type="text"
          value={nameTemplate}
          onChange={(e) => setNameTemplate(e.target.value)}
          placeholder="Alpha-#{n}"
          maxLength={40}
          disabled={disabled}
          className="w-full px-3 py-2 text-sm font-mono rounded-md bg-canvas border border-border-subtle focus:border-brand focus:outline-none disabled:opacity-50"
        />
        <p className="text-[10px] text-fg-subtle">Use <code className="font-mono text-fg-muted">{'#{n}'}</code> for 1-indexed counter.</p>
      </div>

      {/* Preset selector */}
      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-wider text-fg-muted">Base preset</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {PRESET_IDS.map((id) => {
            const p = RISK_PRESETS[id]
            if (!p) return null
            const active = id === presetId
            return (
              <button
                key={id}
                type="button"
                onClick={() => setPresetId(id)}
                disabled={disabled}
                className={cnm(
                  'rounded-lg border p-2.5 text-left transition-colors',
                  active ? 'border-brand bg-brand/5' : 'border-border-subtle hover:border-border-strong',
                  disabled && 'opacity-50 cursor-not-allowed',
                )}
              >
                <p className="text-xs font-semibold text-fg">{p.label}</p>
                <p className="text-[10px] font-mono text-fg-muted tabular-nums mt-0.5">
                  ${numberFmt.format(p.maxNotionalUsd)}
                </p>
              </button>
            )
          })}
        </div>
      </div>

      {/* Preview names */}
      {names.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-fg-subtle">Preview</p>
          <div className="flex flex-wrap gap-1">
            {names.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-canvas px-2 py-0.5 text-[10px] font-mono text-fg"
              >
                <Users size={8} aria-hidden="true" />
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg px-3 py-2 bg-down/10 border border-down/20">
          <p className="text-xs text-down leading-relaxed">{error}</p>
        </div>
      )}

      {!jwt && (
        <p className="text-xs text-fg-subtle">Sign in with Ethereum first to deploy a fleet.</p>
      )}

      <button
        type="button"
        onClick={() => { void handleSpawn() }}
        disabled={!canSubmit}
        className={cnm(
          'w-full flex items-center justify-center gap-2 px-5 py-3 rounded-xl',
          'bg-brand text-canvas text-sm font-semibold',
          'transition-all duration-150 hover:bg-brand-soft',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          'focus:outline-none focus-visible:shadow-glow-brand',
        )}
      >
        {loading ? (
          <>
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            Preparing spawn…
          </>
        ) : (
          <>
            <Users size={14} aria-hidden="true" />
            Deploy {count} Agent{count !== 1 ? 's' : ''}
          </>
        )}
      </button>

      <p className="text-[11px] text-fg-subtle leading-relaxed">
        Gas is sponsored by the ZeroDev paymaster for the first 3 operations. Remaining operations use operator gas.
      </p>
    </div>
  )
}
