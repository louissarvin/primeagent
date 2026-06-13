/**
 * Section — reusable landing section wrapper with built-in whileInView reveal.
 * Ported structural pattern from web/web/src/routes/index.tsx FadeInWhenVisible
 * and ClipReveal, adapted to Mayfair After Dark tokens and DESIGN.md §6 motion rules.
 *
 * Props:
 *   eyebrow  — small label above heading (e.g. "THE CROSS-DOMAIN GAP")
 *   heading  — section h2
 *   body     — optional paragraph below heading
 *   children — arbitrary content below the header block
 *   border   — adds border-b border-border-subtle (default true)
 *   className — extra classes on the outer <section>
 *   innerClassName — extra classes on the inner max-width container
 */

import { useRef } from 'react'
import { motion, useInView } from 'motion/react'

const EASE = [0.16, 1, 0.3, 1] as const

const revealVariant = {
  hidden: { opacity: 0, filter: 'blur(4px)', y: 16 },
  show: {
    opacity: 1,
    filter: 'blur(0px)',
    y: 0,
    transition: { duration: 0.4, ease: EASE },
  },
}

const staggerVariant = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
}

interface SectionProps {
  eyebrow?: string
  heading?: string
  body?: string
  children?: React.ReactNode
  border?: boolean
  className?: string
  innerClassName?: string
  id?: string
}

export default function Section({
  eyebrow,
  heading,
  body,
  children,
  border = true,
  className,
  innerClassName,
  id,
}: SectionProps) {
  const ref = useRef<HTMLElement>(null)
  const isInView = useInView(ref, { once: true, margin: '-80px 0px' })

  return (
    <motion.section
      ref={ref}
      id={id}
      variants={staggerVariant}
      initial="hidden"
      animate={isInView ? 'show' : 'hidden'}
      className={[
        border ? 'border-b border-border-subtle' : '',
        'py-16',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={['max-w-[1240px] mx-auto px-6', innerClassName ?? ''].filter(Boolean).join(' ')}>
        {(eyebrow || heading || body) && (
          <div className="mb-8">
            {eyebrow && (
              <motion.p variants={revealVariant} className="text-xs uppercase tracking-widest text-fg-muted mb-3">
                {eyebrow}
              </motion.p>
            )}
            {heading && (
              <motion.h2
                variants={revealVariant}
                className="text-3xl font-semibold mb-4"
                style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}
              >
                {heading}
              </motion.h2>
            )}
            {body && (
              <motion.p variants={revealVariant} className="text-sm text-fg-muted leading-relaxed max-w-2xl">
                {body}
              </motion.p>
            )}
          </div>
        )}
        {children && (
          <motion.div variants={revealVariant}>
            {children}
          </motion.div>
        )}
      </div>
    </motion.section>
  )
}
