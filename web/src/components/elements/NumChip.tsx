/**
 * NumChip — a number display that pulses briefly when its value changes.
 *
 * Uses a CSS keyframe (numchip-pulse) triggered via data-pulse attribute.
 * No motion/react — pure CSS + a single useRef to track previous value.
 *
 * Reference: jpeg.fun numchip-pulse. INSPIRATION.md §4 delta 4, §5 delta 2.
 *
 * Props:
 *   value        — the formatted string to display (already formatted)
 *   className    — extra classes on the outer span
 *   staggerIndex — optional; delays the pulse onset by staggerIndex * 30ms
 *                  so simultaneous updates cascade rather than fire together.
 */

import { useEffect, useRef } from 'react'

interface NumChipProps {
  value: string
  className?: string
  staggerIndex?: number
}

export default function NumChip({ value, className, staggerIndex = 0 }: NumChipProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const prevValue = useRef<string>(value)

  useEffect(() => {
    if (prevValue.current === value) return
    prevValue.current = value

    const el = ref.current
    if (!el) return

    // Stagger: delay each chip slightly so simultaneous batch updates cascade.
    const delayMs = staggerIndex * 30

    const timer = setTimeout(() => {
      // Set pulse attribute. The CSS selector .num-chip[data-pulse="true"] fires the keyframe.
      el.dataset.pulse = 'true'
    }, delayMs)

    return () => clearTimeout(timer)
  }, [value, staggerIndex])

  function handleAnimationEnd() {
    if (ref.current) {
      delete ref.current.dataset.pulse
    }
  }

  return (
    <span
      ref={ref}
      className={`num-chip${className ? ` ${className}` : ''}`}
      onAnimationEnd={handleAnimationEnd}
    >
      {value}
    </span>
  )
}
