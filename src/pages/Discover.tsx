import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpRight, RefreshCw, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { Category } from '@shared/types.ts';
import { api } from '../lib/api';
import { dbToItem, useProfile, useRecent } from '../hooks/data';
import { MediaCard } from '../components/MediaCard';
import { CategoryTabs, ExplorationSlider, MoodChips } from '../components/Controls';
import { Listening } from '../components/Echo';
import { PageHeader } from '../components/Shell';
import { CATEGORY_META } from '../lib/meta';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export default function Discover() {
  const nav = useNavigate();
  const profile = useProfile();
  const recent = useRecent();
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [moods, setMoods] = useState<string[]>([]);
  const [exploration, setExploration] = useState<number | null>(null);
  const [seed, setSeed] = useState(0);
  const [exclude, setExclude] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [tuneOpen, setTuneOpen] = useState(false);
  const [ask, setAsk] = useState('');
  const savedExploration = useRef<number | null>(null);

  const serverExploration = profile.data?.model.exploration ?? 0.4;
  const exp = exploration ?? serverExploration;
  const debouncedExp = useDebounced(exp, 450);

  // Persist the slider to the profile (syncs across devices).
  useEffect(() => {
    if (exploration === null || savedExploration.current === debouncedExp) return;
    savedExploration.current = debouncedExp;
    api.editProfile({ exploration: debouncedExp }).catch(() => undefined);
  }, [debouncedExp, exploration]);

  const categories = category === 'all' ? (profile.data?.account.settings?.categories as Category[] | undefined)?.length ? (profile.data!.account.settings!.categories as Category[]) : undefined : [category];
  const mix = (profile.data?.account.settings?.mix as Partial<Record<Category, number>> | undefined) ?? undefined;
  const feed = useQuery({
    queryKey: ['feed', category, moods.join(','), debouncedExp, seed, JSON.stringify(mix ?? {})],
    queryFn: () => api.discover({ categories, moods, exploration: debouncedExp, limit: 12, seed, exclude, mix }),
    enabled: !!profile.data,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

  const recs = useMemo(() => (feed.data?.recommendations ?? []).filter((r) => !dismissed.has(r.item.id)), [feed.data, dismissed]);
  const notices = (feed.data?.providers ?? []).filter((p) => p.status !== 'ok' && p.status !== 'cached');
  const name = profile.data?.account.display_name;

  const refresh = () => {
    setExclude((feed.data?.recommendations ?? []).map((r) => r.item.id).slice(0, 100));
    setDismissed(new Set());
    setSeed((s) => s + 1);
  };

  return (
    <div>
      <PageHeader eyebrow={greeting()} title={<>{name ? <>{name},<br className="md:hidden" /> </> : null}<span className="text-mist italic">what will you</span> discover?</>} />

      <div className="px-4 md:px-8">
        <form
          className="mt-6 flex items-center gap-2 rounded-2xl border border-line bg-ink-2/80 p-1.5 pl-4 focus-within:border-ember/50"
          onSubmit={(e) => {
            e.preventDefault();
            if (ask.trim()) nav(`/echo?q=${encodeURIComponent(ask.trim())}`);
          }}
        >
          <Sparkles className="h-4 w-4 shrink-0 text-ember" />
          <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Describe a feeling, a theme, a title…" className="min-w-0 flex-1 bg-transparent py-2 placeholder:text-dim focus:outline-none" aria-label="Ask Echo" />
          <button className="grid h-10 w-10 place-items-center rounded-xl bg-ember text-ink" aria-label="Ask Echo"><ArrowUpRight className="h-5 w-5" /></button>
        </form>

        <div className="mt-6 space-y-3">
          <CategoryTabs value={category} onChange={(c) => { setCategory(c); setDismissed(new Set()); }} />
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1"><MoodChips selected={moods} onToggle={(m) => setMoods((s) => (s.includes(m) ? s.filter((x) => x !== m) : [...s, m].slice(-3)))} /></div>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-2">
          <button type="button" onClick={() => setTuneOpen((o) => !o)} aria-expanded={tuneOpen} className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm ${tuneOpen ? 'border-ember/50 text-bone' : 'border-line text-mist'}`}>
            <SlidersHorizontal className="h-4 w-4" />
            {exp < 0.34 ? 'Familiar' : exp < 0.67 ? 'Balanced' : 'Adventurous'}
          </button>
          <button type="button" onClick={refresh} disabled={feed.isFetching} className="inline-flex items-center gap-2 rounded-full border border-line px-3.5 py-2 text-sm text-mist hover:text-bone disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${feed.isFetching ? 'animate-spin' : ''}`} /> Refresh
          </button>
          {feed.data && <span className="ml-auto hidden text-xs text-dim sm:block">{feed.data.pipeline.map((p) => p.step).join(' → ')}</span>}
        </div>
        <AnimatePresence initial={false}>
          {tuneOpen && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <div className="pt-3 md:max-w-md"><ExplorationSlider value={exp} onChange={setExploration} /></div>
            </motion.div>
          )}
        </AnimatePresence>

        {notices.length > 0 && (
          <div className="mt-4 rounded-2xl border border-line bg-ink-2/60 p-3 text-xs text-mist">
            {notices.map((n) => (
              <p key={n.id}>
                <span className="text-bone">{n.id}</span>: {n.status === 'unconfigured' ? 'not connected on this server, so no results from it.' : n.status === 'quota' ? 'daily quota reached. Showing other sources.' : 'temporarily unavailable.'}{' '}
                {n.status === 'unconfigured' && <button type="button" onClick={() => nav('/settings')} className="text-ember underline">How to enable</button>}
              </p>
            ))}
          </div>
        )}

        {feed.isLoading && <Listening label="Listening for echoes across your worlds…" />}
        {feed.isError && (
          <div className="mt-10 rounded-2xl border border-danger/30 bg-danger/5 p-5 text-sm">
            <p className="text-bone">{(feed.error as Error).message}</p>
            <button type="button" onClick={() => feed.refetch()} className="mt-3 text-ember underline">Try again</button>
          </div>
        )}
        {feed.data && recs.length === 0 && !feed.isFetching && (
          <div className="py-16 text-center">
            <p className="font-display text-2xl">Nothing new here right now.</p>
            <p className="mt-2 text-sm text-mist">Try another mood, widen the categories, or refresh.</p>
          </div>
        )}

        <div className={`mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 ${feed.isFetching && !feed.isLoading ? 'opacity-60 transition-opacity' : ''}`}>
          <AnimatePresence mode="popLayout">
            {recs.map((r) => (
              <MediaCard key={r.item.id} item={r.item} explanation={r.explanation} score={r.score} source="feed" onDismiss={(id) => setDismissed((s) => new Set(s).add(id))} />
            ))}
          </AnimatePresence>
        </div>

        {(recent.data?.length ?? 0) > 0 && (
          <section className="mt-12" aria-labelledby="recent-h">
            <h2 id="recent-h" className="font-display text-2xl">Recently discovered</h2>
            <div className="scrollbar-none -mx-4 mt-4 flex gap-3 overflow-x-auto px-4 pb-2">
              {recent.data!.filter((r) => r.content_items).map((r) => {
                const it = dbToItem(r.content_items!);
                const m = CATEGORY_META[it.category];
                return (
                  <a key={r.item_id} href={it.externalUrl} target="_blank" rel="noreferrer" className="group w-32 shrink-0" title={r.explanation}>
                    <div className="aspect-square overflow-hidden rounded-xl bg-ink-3">
                      {it.artworkUrl ? <img src={it.artworkUrl} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" /> : <m.icon className="m-auto mt-10 h-8 w-8" style={{ color: m.color }} />}
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm leading-snug">{it.title}</p>
                    <p className="text-[11px]" style={{ color: m.color }}>{m.short}</p>
                  </a>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
