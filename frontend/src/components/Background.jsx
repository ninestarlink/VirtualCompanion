import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'

export default function Background({ theme }) {
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.style.setProperty('background', theme.bg)
  }, [theme])

  return (
    <div className="bg-layer" ref={ref}>
      <motion.div
        className="bg-orb orb-a"
        animate={{
          x: [0, 60, -30, 0],
          y: [0, -40, 30, 0],
          scale: [1, 1.15, 0.95, 1],
        }}
        transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }}
        style={{ background: theme.glowA }}
      />
      <motion.div
        className="bg-orb orb-b"
        animate={{
          x: [0, -70, 40, 0],
          y: [0, 50, -35, 0],
          scale: [1, 0.9, 1.1, 1],
        }}
        transition={{ duration: 22, repeat: Infinity, ease: 'easeInOut' }}
        style={{ background: theme.glowB }}
      />
      <div className="bg-bubbles" aria-hidden="true">
        {Array.from({ length: 9 }).map((_, i) => (
          <span
            key={i}
            className="bg-bubble"
            style={{
              left: `${8 + i * 10}%`,
              animationDelay: `${i * 1.7}s`,
              animationDuration: `${9 + (i % 4) * 2.5}s`,
              width: `${6 + (i % 3) * 5}px`,
              height: `${6 + (i % 3) * 5}px`,
            }}
          />
        ))}
      </div>
      <div className="bg-vignette" />
    </div>
  )
}
