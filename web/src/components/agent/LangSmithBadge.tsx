/**
 * LangSmithBadge — shows agent tracing status and a deep link.
 *
 * Reads `/health` on the backend (cached for 60s). When LangSmith tracing is
 * enabled, renders a pill that links to the project view filtered to this
 * tokenId. When disabled, renders nothing.
 *
 * Per-trace deep links require the backend to capture `run_id` in
 * AgentAction.payload; not shipped in Wave B but the project-level link is
 * still useful for judges who want to see the agent reasoning chain on the
 * LangSmith UI.
 */

import { useEffect, useState } from 'react'
import { ExternalLink, Cpu } from 'lucide-react'
import { getBackendHealth } from '@/lib/api/agentClient'

interface LangSmithBadgeProps {
  tokenId: string
}

interface State {
  enabled: boolean
  project: string | null
}

export default function LangSmithBadge({ tokenId }: LangSmithBadgeProps) {
  const [state, setState] = useState<State | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const health = await getBackendHealth()
        if (cancelled) return
        setState(health.langsmith)
      } catch {
        if (cancelled) return
        setState({ enabled: false, project: null })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!state || !state.enabled || !state.project) return null

  // LangSmith project URL with a metadata filter on `user_id == agent_<tokenId>`.
  // Backend tags every Claude call with this metadata (see
  // agentChatRoutes.ts). The `searchModel` query is the supported filter
  // shape; LangSmith decodes the URL-encoded JSON.
  const filter = JSON.stringify({
    filter: `eq(metadata_key, "user_id"), eq(metadata_value, "agent_${tokenId}")`,
  })
  const href = `https://smith.langchain.com/projects/p/${encodeURIComponent(state.project)}?searchModel=${encodeURIComponent(filter)}`

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open LangSmith project ${state.project} (tokenId ${tokenId})`}
      className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface px-2 py-0.5 text-[10px] font-medium text-fg-muted hover:text-fg hover:border-border-strong"
    >
      <Cpu size={9} aria-hidden="true" />
      Traces
      <ExternalLink size={9} aria-hidden="true" />
    </a>
  )
}
