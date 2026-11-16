import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpRight, RefreshCw, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { Category } from '@shared/types.ts';
import { api } from '../lib/api';
import { dbToItem, useProfile, useRecent } from '../hooks/data';
import { Artwork, MediaCard, MediaCardSkeleton } from '../components/MediaCard';
import { conceptLabel } from '@shared/engine/concepts.ts';
import { CategoryTabs, ExplorationSlider, MoodChips } from '../components/Controls';
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

  const [hero, ...rest] = recs;
  const loading = feed.isLoading || (!feed.data && !feed.isError);
  const toggleMood = (m: string) => setMoods((s) => (s.includes(m) ? s.filter((x) => x !== m) : [...s, m].slice(-3)));

  return (
    <div>
      <PageHeader eyebrow={greeting()} title={<>{name ? <>{name}, </> : null}<span className="text-mist italic">what will you</span> discover?</>} />

      <div className="px-4 md:px-8">
        <form
          className="mt-6 flex items-center gap-2 rounded-2xl border border-line bg-ink-2/80 p-1.5 pl-4 shadow-[0_18px_40px_-30px_rgba(0,0,0,0.9)] transition-colors focus-within:border-ember/50 md:max-w-3xl"
          onSubmit={(e) => {
            e.preventDefault();
            if (ask.trim()) nav(`/echo?q=${encodeURIComponent(ask.trim())}`);
          }}
        >
          <Sparkles className="h-4 w-4 shrink-0 text-ember" aria-hidden />
          <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Describe a feeling, a theme, a title…" className="min-w-0 flex-1 bg-transparent py-2.5 placeholder:text-dim focus:outline-none" aria-label="Ask Echo" />
          <button className="grid h-11 w-11 place-items-center rounded-xl bg-ember text-ink transition-transform active:scale-95" aria-label="Ask Echo"><ArrowUpRight className="h-5 w-5" /></button>
        </form>

        <div className="mt-6 space-y-2.5">
          <CategoryTabs value={category} onChange={(c) => { setCategory(c); setDismissed(new Set()); }} />
          <MoodChips selected={moods} onToggle={toggleMood} />
        </div>

        {notices.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 rounded-2xl border border-line bg-ink-2/60 px-4 py-2.5 text-xs text-mist">
            {notices.map((n) => (
              <p key={n.id}>
                <span className="text-bone capitalize">{n.id}</span> {n.status === 'unconfigured' ? 'isn’t connected yet' : n.status === 'quota' ? 'hit its daily limit, showing other sources' : 'is temporarily unavailable'}
                {n.status === 'unconfigured' && <> · <button type="button" onClick={() => nav('/settings')} className="text-ember underline-offset-2 hover:underline">enable</button></>}
              </p>
            ))}
          </div>
        )}

        {feed.isError && (
          <div className="mt-8 rounded-2xl border border-danger/30 bg-danger/5 p-5 text-sm">
            <p className="text-bone">{(feed.error as Error).message}</p>
            <button type="button" onClick={() => feed.refetch()} className="mt-3 text-ember underline">Try again</button>
          </div>
        )}

        {/* Top pick */}
        {(loading || hero) && (
          <section className="relative mt-8" aria-label="Top pick">
            {hero?.item.artworkUrl && (
              <div aria-hidden className="pointer-events-none absolute -inset-x-6 -inset-y-10 -z-10 opacity-40 blur-3xl saturate-150">
                <img src={hero.item.artworkUrl} alt="" className="h-full w-full object-cover" />
              </div>
            )}
            <p className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-ember uppercase">
              <span className="h-px w-6 bg-ember/60" aria-hidden /> Today’s echo
            </p>
            {hero && !loading ? (
              <MediaCard key={hero.item.id} featured item={hero.item} explanation={hero.explanation} score={hero.score} source="feed" onDismiss={(id) => setDismissed((s) => new Set(s).add(id))} />
            ) : (
              <MediaCardSkeleton featured />
            )}
          </section>
        )}

        <section className="mt-10" aria-labelledby="picks-h">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="picks-h" className="font-display text-[26px] leading-tight">Picked for you</h2>
              <p className="mt-0.5 text-sm text-mist">{moods.length ? `Tuned to ${moods.map((m) => conceptLabel(m).toLowerCase()).join(', ')}` : category === 'all' ? 'Across everything you love' : CATEGORY_META[category].label}</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setTuneOpen((o) => !o)} aria-expanded={tuneOpen} className={`inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm transition-colors ${tuneOpen ? 'border-ember/50 bg-ember/10 text-bone' : 'border-line text-mist hover:text-bone'}`}>
                <SlidersHorizontal className="h-4 w-4" aria-hidden />
                {exp < 0.34 ? 'Familiar' : exp < 0.67 ? 'Balanced' : 'Adventurous'}
              </button>
              <button type="button" onClick={refresh} disabled={feed.isFetching} className="inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-sm text-mist transition-colors hover:text-bone disabled:opacity-50">
                <RefreshCw className={`h-4 w-4 ${feed.isFetching ? 'animate-spin' : ''}`} aria-hidden /> Refresh
              </button>
            </div>
          </div>
          <AnimatePresence initial={false}>
            {tuneOpen && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="pt-4 md:max-w-md"><ExplorationSlider value={exp} onChange={setExploration} /></div>
              </motion.div>
            )}
          </AnimatePresence>

          {feed.data && recs.length === 0 && !feed.isFetching && (
            <div className="py-16 text-center">
              <p className="font-display text-2xl">Nothing new here right now.</p>
              <p className="mt-2 text-sm text-mist">Try another mood, widen the categories, or refresh.</p>
            </div>
          )}

          <div className={`mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 ${feed.isFetching && !loading ? 'opacity-60 transition-opacity' : ''}`}>
            {loading
              ? Array.from({ length: 6 }, (_, i) => <MediaCardSkeleton key={i} />)
              : (
                <AnimatePresence mode="popLayout">
                  {rest.map((r) => (
                    <MediaCard key={r.item.id} item={r.item} explanation={r.explanation} score={r.score} source="feed" onDismiss={(id) => setDismissed((s) => new Set(s).add(id))} />
                  ))}
                </AnimatePresence>
              )}
          </div>
        </section>

        {(recent.data?.length ?? 0) > 0 && (
          <section className="mt-14" aria-labelledby="recent-h">
            <h2 id="recent-h" className="font-display text-[26px] leading-tight">Recently discovered</h2>
            <p className="mt-0.5 text-sm text-mist">What ECHO showed you lately</p>
            <div className="scroll-fade-x -mx-4 mt-4">
              <div className="scrollbar-none flex snap-x gap-3 overflow-x-auto px-4 pb-2">
                {recent.data!.filter((r) => r.content_items).map((r) => {
                  const it = dbToItem(r.content_items!);
                  const m = CATEGORY_META[it.category];
                  return (
                    <a key={r.item_id} href={it.externalUrl} target="_blank" rel="noreferrer" className="group w-[8.5rem] shrink-0 snap-start" title={r.explanation}>
                      <Artwork item={{ ...it, category: 'music' }} rounded="rounded-xl" />
                      <p className="mt-2 line-clamp-2 text-[13px] leading-snug text-bone/90">{it.title}</p>
                      <p className="mt-0.5 text-[11px] font-medium tracking-wide uppercase" style={{ color: m.color }}>{m.short}</p>
                    </a>
                  );
                })}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
