import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

type ToastMsg = { id: number; text: string; tone: 'info' | 'error' };
let push: ((t: ToastMsg) => void) | null = null;
let nextId = 1;

export function toast(text: string, tone: 'info' | 'error' = 'info') {
  push?.({ id: nextId++, text, tone });
}

export function Toaster() {
  const [items, setItems] = useState<ToastMsg[]>([]);
  useEffect(() => {
    push = (t) => {
      setItems((s) => [...s.slice(-2), t]);
      setTimeout(() => setItems((s) => s.filter((x) => x.id !== t.id)), 3800);
    };
    return () => {
      push = null;
    };
  }, []);
  return (
    <div className="echo-toast-offset md:echo-toast-offset-wide pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-2 px-4" role="status" aria-live="polite">
      <AnimatePresence>
        {items.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6 }}
            className={`pointer-events-auto max-w-md rounded-2xl border px-4 py-2.5 text-sm shadow-2xl backdrop-blur-xl ${t.tone === 'error' ? 'border-danger/40 bg-[#2a1416]/90 text-[#ffd2d2]' : 'border-line bg-ink-3/90 text-bone'}`}
          >
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
