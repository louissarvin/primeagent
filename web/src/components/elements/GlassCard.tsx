/**
 * GlassCard — frosted-glass card surface for the Mayfair After Dark canvas.
 * Backdrop blur over bg-surface/60 with a 1px inner highlight at the top edge.
 * The `hover` prop adds a 0.5px lift + border brightening transition.
 *
 * Reference: web/web/src/components/GlassCard.tsx — adapted for dark-first palette.
 * All BreakBase blue/light variants removed. Uses semantic PALETTE.md tokens only.
 * No dark: prefixes (dark is the base).
 *
 * DESIGN.md §5: glass elevation sits between bg-surface and bg-elevated.
 * Border: border-border-subtle → border-border on hover.
 * Shadow: inset 1px white/4 top edge (subtle inner highlight — institutional).
 */

import { cnm } from '@/utils/style'

interface GlassCardProps {
  children: React.ReactNode
  className?: string
  /** Adds lift + border brightening on hover. Default false. */
  hover?: boolean
  /** Forward a click handler — adds cursor-pointer. */
  onClick?: () => void
}

export default function GlassCard({
  children,
  className,
  hover = false,
  onClick,
}: GlassCardProps) {
  return (
    <div
      onClick={onClick}
      className={cnm(
        'relative rounded-2xl border border-border-subtle bg-surface/60 backdrop-blur-md',
        'shadow-[inset_0_1px_0_rgba(250,250,250,0.04)]',
        hover && [
          'transition-all duration-200',
          'hover:border-border hover:bg-surface/80 hover:-translate-y-0.5',
          '[transition-timing-function:cubic-bezier(0.16,1,0.3,1)]',
        ],
        onClick && 'cursor-pointer',
        className,
      )}
    >
      {children}
    </div>
  )
}
