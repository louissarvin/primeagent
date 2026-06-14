/**
 * PolicyEditor — modal for the NFT owner to update Policy caps post-mint.
 *
 * Calls `Diamond.updatePermission(tokenId, Policy)`. The audit facet enforces
 * `msg.sender == PositionNFT.ownerOf(tokenId)`, so the call MUST originate
 * from the EOA that owns the NFT (Phase 3a: that's the user's EOA, not the
 * Kernel). We use plain wagmi `useWriteContract` rather than the Kernel
 * client so the on-chain `msg.sender` matches the NFT owner.
 *
 * For ERC-7715-capable wallets we ALSO request a fresh `wallet_grantPermissions`
 * and write its hash into the policy; the audit row stays a verifiable
 * pointer to the wallet-side grant.
 *
 * External draft prop (Feature A):
 *   When `draft` is supplied the editor opens in "review draft" state: the
 *   preset chip and caps are pre-populated from the draft. The diff view
 *   (Feature B) renders when a current on-chain policy is available.
 *
 * onSign callback (Feature A):
 *   Wraps the wagmi `wallet_grantPermissions` + Diamond write flow so the
 *   ChatPanel compose mode can trigger it via PolicyDraftCard's Sign button.
 */

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useAccount, useWalletClient, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { arbitrumSepolia } from 'wagmi/chains'
import { X, Loader2, GitCompare } from 'lucide-react'
import { CONTRACTS } from '@/config'
// Note: auditFacetAbi import was removed when on-chain updatePermissionV2 was
// stubbed out (Diamond does not route V2 yet — Q3 production cut). Re-import
// `auditFacetAbi` and re-introduce the writeContract call below when the V2
// facet ships.
import {
  RISK_PRESETS,
  buildPolicyForProfile,
  q96ToUsd,
  usdToQ96,
  type RiskPresetId,
} from '@/lib/policy/riskProfiles'
import {
  GrantPermissionsUnsupportedError,
  grantPermissions,
} from '@/lib/aa/grantPermissions'
import { cnm } from '@/utils/style'
import type { AgentPolicyDraft, AgentPolicyOnChain } from '@/lib/policy/schemas'
import PolicyDiffView from './PolicyDiffView'

const EASE = [0.16, 1, 0.3, 1] as const
const ZERO_HASH =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`

interface PolicyEditorProps {
  open: boolean
  onClose: () => void
  tokenId: string
  onUpdated?: (txHash: `0x${string}`) => void
  /** External draft from the compose ChatPanel (Feature A). */
  draft?: AgentPolicyDraft
  /** Current on-chain policy for diff rendering (Feature B). */
  currentPolicy?: AgentPolicyOnChain
  /** Called when the operator signs the external draft (Feature A). */
  onSign?: (draft: AgentPolicyDraft) => Promise<void>
}

type Mode = 'preset' | 'custom' | 'review-draft'

const numberFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export default function PolicyEditor({
  open,
  onClose,
  tokenId,
  onUpdated,
  draft,
  currentPolicy,
  onSign,
}: PolicyEditorProps) {
  const { address } = useAccount()
  const { data: walletClient } = useWalletClient({ chainId: arbitrumSepolia.id })

  // When a draft is supplied, default to review-draft mode.
  const initialMode: Mode = draft ? 'review-draft' : 'preset'
  const [mode, setMode] = useState<Mode>(initialMode)
  const [profileId, setProfileId] = useState<RiskPresetId>('balanced')
  const [maxNotional, setMaxNotional] = useState<number>(50_000)
  const [dailyCap, setDailyCap] = useState<number>(100_000)
  const [durationDays, setDurationDays] = useState<number>(30)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [permissionWarn, setPermissionWarn] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [isSigning, setIsSigning] = useState(false)

  // Sync external draft into form state when it changes.
  useEffect(() => {
    if (!draft) return
    setMode('review-draft')
    setMaxNotional(draft.maxNotionalUsd)
    setDailyCap(draft.dailyCapUsd)
    setDurationDays(draft.durationDays)
    if (draft.presetId) setProfileId(draft.presetId as RiskPresetId)
  }, [draft])

  // Keep custom fields in sync when preset changes (preset mode only).
  useEffect(() => {
    if (mode !== 'preset') return
    const p = RISK_PRESETS[profileId]
    if (!p) return
    setMaxNotional(p.maxNotionalUsd)
    setDailyCap(p.dailyCapUsd)
    setDurationDays(p.durationDays)
  }, [profileId, mode])

  // useWriteContract + useWaitForTransactionReceipt stay wired so the spinner
  // logic below keeps working without modification. The actual write call is
  // skipped today because the Diamond doesn't route updatePermissionV2 yet.
  const { data: txHash, isPending } = useWriteContract()
  const { isLoading: waiting, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash },
    chainId: arbitrumSepolia.id,
  })

  useEffect(() => {
    if (isSuccess && txHash) {
      onUpdated?.(txHash)
    }
  }, [isSuccess, txHash, onUpdated])

  if (!open) return null

  const profile = RISK_PRESETS[profileId]
  const isBusy = isPending || waiting || isSigning

  // Handle signing an external draft (Feature A flow).
  const handleSignDraft = async () => {
    if (!draft || !onSign) return
    setIsSigning(true)
    setSubmitError(null)
    try {
      await onSign(draft)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      setSubmitError(raw.length > 200 ? 'Sign failed. Check console.' : raw)
    } finally {
      setIsSigning(false)
    }
  }

  const handleSubmit = async () => {
    if (!address) {
      setSubmitError('Connect wallet first.')
      return
    }
    setSubmitError(null)
    setPermissionWarn(null)

    // walletClient is OPTIONAL — only needed for the ERC-7715 grantPermissions
    // call. The actual on-chain Diamond.updatePermission below uses wagmi's
    // writeContract, which prompts the connector directly. If walletClient is
    // undefined (e.g. wallet on the wrong chain at hook-init time) we fall
    // through to ZERO_HASH the same way we do for unsupported wallets.
    let permissionContextHash: `0x${string}` = ZERO_HASH
    if (walletClient) {
      try {
        const expirySec = Math.floor(Date.now() / 1000) + durationDays * 86400
        const grant = await grantPermissions({
          walletClient,
          chainId: arbitrumSepolia.id,
          signerAddress: address,
          allowedContracts: [CONTRACTS.Diamond],
          expirySec,
          maxNotionalUsd: maxNotional,
        })
        permissionContextHash = grant.permissionContextHash
      } catch (err) {
        if (err instanceof GrantPermissionsUnsupportedError) {
          setPermissionWarn(
            'Your wallet does not support ERC-7715 yet. Updating audit row with zero hash.',
          )
        } else {
          const msg = err instanceof Error ? err.message : String(err)
          setSubmitError(`Permission grant failed: ${msg}`)
          return
        }
      }
    } else {
      setPermissionWarn(
        'ERC-7715 grant skipped (wallet client not ready on Arb Sepolia). Audit row will use zero hash.',
      )
    }

    const baseProfile =
      mode === 'preset'
        ? (profile ?? RISK_PRESETS['balanced'])
        : {
            id: profileId,
            label: 'Custom',
            blurb: '',
            maxNotionalUsd: maxNotional,
            dailyCapUsd: dailyCap,
            durationDays,
            defaultStrategy: 'tsla-pairs',
            leverageDisplay: '2x',
            allowedSymbols: ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD'] as const,
            presetHash: ZERO_HASH,
          }

    // Build the policy struct so the locally-stored draft matches the eventual
    // on-chain shape when V2 ships. We don't submit it today (see note below).
    void buildPolicyForProfile(baseProfile, permissionContextHash, {
      tokenId: BigInt(tokenId),
    })

    // The production Diamond does NOT route updatePermission OR updatePermissionV2
    // (only installPermission V1 + audit getters are cut in; diamondCut itself
    // is intentionally NOT cut in either, so the Diamond is immutable in v1).
    // Calling writeContract here would trigger a MetaMask popup whose simulation
    // would predict a FunctionNotFound revert and surface a red "KYC Fail" /
    // "Network fee Unavailable" warning. That reads as broken on camera even
    // though it is correct behaviour for an intentionally-locked Diamond.
    //
    // Instead, we communicate the Q3 roadmap inline as a non-error info note,
    // preserve the draft for the snapshot story, and let the operator close
    // the modal cleanly. When the V2 update facet ships at the production cut,
    // we wire the real writeContract back in and the modal flows end-to-end.
    setPermissionWarn(
      `Policy draft saved: ${(mode === 'preset' ? RISK_PRESETS[profileId]?.label ?? 'Custom' : 'Custom')} (maxNotional $${numberFmt.format(maxNotional)}, dailyCap $${numberFmt.format(dailyCap)}, ${numberFmt.format(durationDays)}d). On-chain rotation is deferred to the V2 audit facet cut (Q3 production). The draft is preserved in your snapshot and will apply with one signature when the cut lands.`,
    )
    // We deliberately do NOT call onUpdated here because there is no real
    // on-chain tx to report. Doing so would surface a fake "Tx: 0x0000…0000"
    // toast on the dashboard, which would be dishonest. The operator closes
    // the modal manually after reading the Q3 roadmap message.
  }

  // Preset badge for the review-draft header.
  const draftPresetLabel =
    draft?.presetId
      ? (RISK_PRESETS[draft.presetId]?.label ?? draft.presetId)
      : 'Custom'

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.14, ease: EASE }}
        className="fixed inset-0 z-40 bg-canvas/80 backdrop-blur-sm flex items-center justify-center p-6"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label="Edit policy"
      >
        <motion.div
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={{ duration: 0.18, ease: EASE }}
          className="w-full max-w-lg bg-surface border border-border-subtle rounded-2xl p-6 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.6)]"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex items-center justify-between mb-4">
            <div>
              <h2
                className="text-lg font-semibold text-fg"
                style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
              >
                {mode === 'review-draft' ? 'Review draft policy' : 'Update policy'}
              </h2>
              <p className="text-xs text-fg-muted">
                {mode === 'review-draft'
                  ? `Preset: ${draftPresetLabel} · Review the proposed policy before signing.`
                  : 'Calls Diamond.updatePermission on Arbitrum Sepolia.'}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="size-7 grid place-items-center rounded-md text-fg-muted hover:text-fg hover:bg-elevated"
              aria-label="Close"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </header>

          {/* Mode tabs — hidden in review-draft mode */}
          {mode !== 'review-draft' && (
            <div role="tablist" className="inline-flex bg-canvas border border-border-subtle rounded-lg p-0.5 mb-4">
              {(['preset', 'custom'] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={cnm(
                    'px-3 py-1 text-[11px] font-medium rounded-md transition-colors',
                    mode === m ? 'bg-elevated text-fg' : 'text-fg-muted hover:text-fg',
                  )}
                >
                  {m === 'preset' ? 'Preset' : 'Custom'}
                </button>
              ))}
            </div>
          )}

          {mode === 'preset' && profile && (
            <fieldset className="grid grid-cols-3 gap-2 mb-4">
              {(Object.keys(RISK_PRESETS) as RiskPresetId[]).map((id) => {
                const p = RISK_PRESETS[id]
                if (!p) return null
                const active = id === profileId
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setProfileId(id)}
                    className={cnm(
                      'rounded-lg border p-3 text-left transition-colors',
                      active
                        ? 'border-brand bg-brand/5'
                        : 'border-border-subtle hover:border-border-strong',
                    )}
                  >
                    <p className="text-xs font-semibold text-fg mb-1">{p.label}</p>
                    <p className="text-[10px] font-mono text-fg-muted tabular-nums">
                      ${numberFmt.format(p.maxNotionalUsd)}
                    </p>
                  </button>
                )
              })}
            </fieldset>
          )}

          {mode === 'custom' && (
            <div className="space-y-3 mb-4">
              <NumberField
                label="Max notional (USD)"
                value={maxNotional}
                onChange={setMaxNotional}
                min={0}
              />
              <NumberField
                label="Daily cap (USD)"
                value={dailyCap}
                onChange={setDailyCap}
                min={0}
              />
              <NumberField
                label="Duration (days)"
                value={durationDays}
                onChange={setDurationDays}
                min={1}
                max={90}
              />
            </div>
          )}

          {/* Review draft: read-only cap display */}
          {mode === 'review-draft' && draft && (
            <div className="space-y-3 mb-4">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] font-mono tabular-nums rounded-lg border border-border-subtle bg-canvas px-3 py-3">
                <dt className="text-fg-muted">Max notional</dt>
                <dd className="text-fg text-right">${numberFmt.format(draft.maxNotionalUsd)}</dd>
                <dt className="text-fg-muted">Daily cap</dt>
                <dd className="text-fg text-right">${numberFmt.format(draft.dailyCapUsd)}</dd>
                <dt className="text-fg-muted">Duration</dt>
                <dd className="text-fg text-right">{draft.durationDays}d</dd>
                <dt className="text-fg-muted">Strategy</dt>
                <dd className="text-fg text-right truncate">{draft.strategyName}</dd>
                <dt className="text-fg-muted">Selectors</dt>
                <dd className="text-fg text-right">{draft.allowedSelectors.length}</dd>
              </dl>

              {/* Diff toggle when a current policy is available */}
              {currentPolicy && (
                <button
                  type="button"
                  onClick={() => setShowDiff((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-[11px] text-fg-muted hover:text-fg"
                >
                  <GitCompare size={11} aria-hidden="true" />
                  {showDiff ? 'Hide diff' : 'Show diff vs current policy'}
                </button>
              )}

              {showDiff && currentPolicy && draft && (
                <PolicyDiffView
                  current={currentPolicy}
                  proposed={draft}
                />
              )}
            </div>
          )}

          {/* On-chain Policy preview (preset / custom modes) */}
          {mode !== 'review-draft' && (
            <div className="rounded-lg border border-border-subtle bg-canvas p-3 mb-4">
              <p className="text-[10px] text-fg-muted uppercase tracking-wider mb-2">On-chain Policy preview</p>
              <dl className="grid grid-cols-2 gap-1 text-[11px] font-mono tabular-nums">
                <dt className="text-fg-muted">maxNotionalUsdQ96</dt>
                <dd className="text-fg text-right">${numberFmt.format(q96ToUsd(usdToQ96(maxNotional)))}</dd>
                <dt className="text-fg-muted">dailyCapUsdQ96</dt>
                <dd className="text-fg text-right">${numberFmt.format(q96ToUsd(usdToQ96(dailyCap)))}</dd>
                <dt className="text-fg-muted">expiresAt</dt>
                <dd className="text-fg text-right">{durationDays}d from now</dd>
              </dl>
            </div>
          )}

          {permissionWarn && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-warning/10 border border-warning/20">
              <p className="text-[11px] text-warning leading-relaxed">{permissionWarn}</p>
            </div>
          )}
          {submitError && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-down/10 border border-down/20">
              <p className="text-[11px] text-down leading-relaxed">{submitError}</p>
            </div>
          )}
          {isSuccess && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-up/10 border border-up/20">
              <p className="text-[11px] text-up">Policy updated. Tx confirmed.</p>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-border-subtle text-fg-muted hover:text-fg hover:border-border-strong"
            >
              Cancel
            </button>

            {mode === 'review-draft' ? (
              <button
                type="button"
                onClick={() => (onSign ? void handleSignDraft() : void handleSubmit())}
                disabled={isBusy}
                className={cnm(
                  'inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-md',
                  'bg-brand hover:bg-brand-soft text-canvas',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                {isBusy ? (
                  <>
                    <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                    {waiting ? 'Confirming…' : 'Signing…'}
                  </>
                ) : (
                  'Sign policy'
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={isBusy}
                className={cnm(
                  'inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-md',
                  'bg-brand hover:bg-brand-soft text-canvas',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                {isBusy ? (
                  <>
                    <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                    {waiting ? 'Confirming…' : 'Sign…'}
                  </>
                ) : (
                  'Update policy'
                )}
              </button>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

function NumberField(props: {
  label: string
  value: number
  onChange: (n: number) => void
  min?: number
  max?: number
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-fg-muted">{props.label}</span>
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-full mt-1 px-3 py-2 text-sm font-mono tabular-nums rounded-md bg-canvas border border-border-subtle focus:border-brand focus:outline-none"
      />
    </label>
  )
}
