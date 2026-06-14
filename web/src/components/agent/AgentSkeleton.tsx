/**
 * AgentSkeleton — SSR loading placeholder.
 * Wave 7: skeleton-sweep CSS class applied to each bar for an institutional
 * left-to-right gradient sweep (2s ease-in-out infinite).
 * More refined than Tailwind's animate-pulse (opacity-only blink).
 * Reference: BreakBase skeleton-sweep keyframe. DESIGN.md §9.2.
 */

function SkeletonBar({ className = '' }: { className?: string }) {
  return (
    <div
      className={`rounded bg-elevated h-4 skeleton-sweep ${className}`}
      aria-hidden="true"
    />
  )
}

export default function AgentSkeleton() {
  return (
    <div className="max-w-[1440px] mx-auto px-6 py-8 space-y-8">
      {/* Agent header row */}
      <div className="flex items-center gap-4 py-6 border-b border-border-subtle">
        <SkeletonBar className="w-2 h-2 rounded-full" />
        <SkeletonBar className="w-32" />
        <SkeletonBar className="w-20" />
        <div className="ml-auto flex items-center gap-4">
          <SkeletonBar className="w-24 h-8" />
          <SkeletonBar className="w-20 h-8" />
        </div>
      </div>

      {/* Margin stat cards */}
      <div>
        <SkeletonBar className="w-32 mb-3" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-elevated rounded-xl border border-border-subtle p-5">
              <SkeletonBar className="w-20 mb-3" />
              <span className="font-mono text-2xl text-fg-subtle">—</span>
            </div>
          ))}
        </div>
      </div>

      {/* Positions table */}
      <div>
        <SkeletonBar className="w-20 mb-3" />
        <div className="rounded-xl border border-border-subtle overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-6 px-4 py-3 border-b border-border-subtle last:border-0"
            >
              <SkeletonBar className="w-12" />
              <SkeletonBar className="w-16" />
              <SkeletonBar className="w-16" />
              <SkeletonBar className="w-8" />
              <SkeletonBar className="w-20" />
              <SkeletonBar className="w-16 ml-auto" />
            </div>
          ))}
        </div>
      </div>

      {/* Actions log */}
      <div>
        <SkeletonBar className="w-28 mb-3" />
        <div className="bg-surface rounded-xl border border-border-subtle p-4">
          <p className="text-sm text-fg-subtle text-center py-4">
            Waiting for the first event…
          </p>
        </div>
      </div>
    </div>
  )
}
