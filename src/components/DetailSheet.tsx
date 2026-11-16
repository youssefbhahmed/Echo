import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import type { Recommendation } from '@shared/types.ts';
import { MediaCard } from './MediaCard';

/** Bottom sheet on phones, centred panel on desktop. Holds the full card: player, why, actions. */
export function DetailSheet({ rec, onClose, onDismiss, autoPlay }: { rec: Recommendation | null; onClose: () => void; onDismiss?: (id: string) => void; autoPlay?: boolean }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [rec, onClose]);

  return (
    <AnimatePresence>
      {rec && (
        <motion.div className="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
          <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/65 backdrop-blur-sm" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={rec.item.title}
            initial={{ y: 48, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 32, opacity: 0, transition: { duration: 0.16 } }}
            transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.5 }}
            onDragEnd={(_, info) => { if (info.offset.y > 120) onClose(); }}
            className="safe-bottom relative max-h-[92dvh] w-full overflow-y-auto rounded-t-[28px] border border-line bg-ink-2 md:max-w-4xl md:rounded-[28px]"
          >
            <div className="sticky top-0 z-10 flex justify-center bg-gradient-to-b from-ink-2 to-transparent pt-2.5 pb-1 md:hidden" aria-hidden>
              <span className="h-1 w-10 rounded-full bg-white/20" />
            </div>
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Close details" className="absolute top-3 right-3 z-20 grid h-10 w-10 place-items-center rounded-full bg-ink/70 text-mist backdrop-blur-md transition-colors hover:text-bone">
              <X className="h-5 w-5" />
            </button>
            <div className="p-2 md:p-3 [&>article]:border-0 [&>article]:bg-transparent [&>article]:shadow-none">
              <MediaCard key={rec.item.id} featured autoPlay={autoPlay} item={rec.item} explanation={rec.explanation} score={rec.score} trajectoryStep={rec.trajectoryStep} source="feed" onPlayStarted={onClose} onDismiss={onDismiss ? (id) => { onDismiss(id); onClose(); } : undefined} />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
