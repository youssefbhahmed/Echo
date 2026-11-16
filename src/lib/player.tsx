// Global music queue: one tap plays, the rest of the shelf follows automatically.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AnalyzedItem } from '@shared/types.ts';

export function isQueueable(item: AnalyzedItem): boolean {
  return item.embed?.type === 'spotify' && (item.kind === 'track' || item.kind === 'episode');
}

interface PlayerApi {
  queue: AnalyzedItem[];
  index: number;
  current: AnalyzedItem | null;
  playQueue: (items: AnalyzedItem[], start?: number) => void;
  next: () => void;
  prev: () => void;
  jump: (i: number) => void;
  close: () => void;
}

const Ctx = createContext<PlayerApi | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<AnalyzedItem[]>([]);
  const [index, setIndex] = useState(0);
  const playQueue = useCallback((items: AnalyzedItem[], start = 0) => {
    const q = items.filter(isQueueable);
    if (!q.length) return;
    const first = items[start] && isQueueable(items[start]) ? q.findIndex((x) => x.id === items[start].id) : 0;
    setQueue(q);
    setIndex(Math.max(0, first));
  }, []);
  const next = useCallback(() => setIndex((i) => (i + 1 < queue.length ? i + 1 : i)), [queue.length]);
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const close = useCallback(() => {
    setQueue([]);
    setIndex(0);
  }, []);
  const value = useMemo<PlayerApi>(() => ({ queue, index, current: queue[index] ?? null, playQueue, next, prev, jump: setIndex, close }), [queue, index, playQueue, next, prev, close]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayer(): PlayerApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePlayer outside PlayerProvider');
  return v;
}
