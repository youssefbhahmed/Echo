import { motion, useReducedMotion } from 'motion/react';

export function EchoMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
      <circle cx="32" cy="32" r="6" fill="var(--color-ember)" />
      {[13, 20, 27].map((r, i) => (
        <circle key={r} cx="32" cy="32" r={r} fill="none" stroke="var(--color-ember)" strokeOpacity={0.7 - i * 0.25} strokeWidth="2.5" />
      ))}
    </svg>
  );
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <EchoMark size={28} />
      <span className="font-display text-[22px] font-semibold tracking-[0.18em]">ECHO</span>
    </div>
  );
}

/** Concentric "listening" rings — ECHO's loading state. */
export function Listening({ label = 'Listening for echoes…' }: { label?: string }) {
  const reduce = useReducedMotion();
  return (
    <div className="flex flex-col items-center justify-center gap-6 py-14" role="status" aria-live="polite">
      <div className="relative grid h-24 w-24 place-items-center">
        {[0, 0.8, 1.6].map((d) => (
          <span key={d} className="echo-ring absolute inset-0 rounded-full border border-ember/60" style={{ animationDelay: `${d}s` }} />
        ))}
        <motion.span
          className="h-4 w-4 rounded-full bg-ember"
          animate={reduce ? undefined : { scale: [1, 1.25, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>
      <p className="font-display text-lg italic text-mist">{label}</p>
    </div>
  );
}
