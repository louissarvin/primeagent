/**
 * ScrollRevealText — word-by-word progressive opacity reveal driven by scroll position.
 * As the user scrolls the element into view, words light up sequentially left-to-right.
 *
 * Reference: web/web/src/components/elements/ScrollRevealText.tsx.
 * Adapted for Mayfair After Dark: base colour rgba(250,250,250,...) always (dark-first, no
 * dark: toggle logic needed). Dim floor: 0.12 (slightly darker than BreakBase's 0.15 to
 * match the lower ambient brightness of the zinc canvas).
 *
 * Passive scroll listener — no layout reads inside the handler beyond getBoundingClientRect
 * (unavoidable for positional logic). Cleans up on unmount.
 *
 * Use on ONE high-impact heading per page. Not a generic text component.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

interface ScrollRevealTextProps {
  text: string
  className?: string
  style?: React.CSSProperties
  /** Tag to render as. Defaults to 'p'. */
  as?: 'p' | 'h2' | 'h3' | 'span'
}

export default function ScrollRevealText({
  text,
  className,
  style,
  as: Tag = 'p',
}: ScrollRevealTextProps) {
  const ref = useRef<HTMLElement>(null)
  const [progress, setProgress] = useState(0)

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vh = window.innerHeight
    // Dead zone: allow 30% of viewport height before the element exits upward.
    // This matches BreakBase's original formula exactly.
    const deadZone = 0.3 * vh - rect.height
    setProgress(Math.max(0, Math.min(1, (vh - rect.top) / (vh - deadZone))))
  }, [])

  useEffect(() => {
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [onScroll])

  const words = text.split(' ')

  // Cast ref to the polymorphic element type. Safe: all listed tags have HTMLElement shape.
  const refProp = { ref: ref as React.RefObject<HTMLParagraphElement> }

  return (
    // @ts-ignore — polymorphic 'as' pattern; Tag is constrained to 4 known HTML elements
    <Tag {...refProp} className={className} style={style}>
      {words.map((word, i) => {
        // BreakBase spread factor: 1.5 / words.length per word window.
        const wordProgress = 1.5 / words.length
        const opacity = Math.max(
          0.12,
          Math.min(1, (progress - i / words.length) / wordProgress),
        )
        return (
          <span
            key={i}
            style={{
              color: `rgba(250, 250, 250, ${opacity})`,
              transition: 'color 0.08s linear',
            }}
            className="inline-block mr-[0.25em]"
          >
            {word}
          </span>
        )
      })}
    </Tag>
  )
}
