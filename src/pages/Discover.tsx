import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpRight, Play, RefreshCw, SlidersHorizontal, Sparkles } from 'lucide-react';
import { CATEGORIES, type Category, type Recommendation } from '@shared/types.ts';
import { api } from '../lib/api';
import { dbToItem, useProfile, useRecent } from '../hooks/data';
import { Artwork } from '../components/MediaCard';
import { Tile } from '../components/Tile';
import { Shelf } from '../components/Shelf';
import { PlayAll } from '../components/PlayAll';
import { DetailSheet } from '../components/DetailSheet';
import { Wordmark } from '../components/Echo';
import { isQueueable, usePlayQueue } from '../lib/player';
import { conceptLabel } from '@shared/engine/concepts.ts';
import { CategoryTabs, ExplorationSlider, MoodChips } from '../components/Controls';
import { CATEGORY_META, displayTitle, KIND_LABEL } from '../lib/meta';
import { groupByLane, isLaneVideo, laneCountLabel, laneDomId, laneOf, type LaneGroup } from '../lib/lanes';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** A single-category page needs this many picks before the top one becomes the hero. */
const HERO_MIN = 6;
/** Fewer verified songs than this on the Music tab: a calm note with "Get more". */
const SHORT_MUSIC = 8;

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
  // Songs kept on screen by "Get more" (it adds a page to them instead of replacing them), per filter.
  const [kept, setKept] = useState<{ key: string; recs: Recommendation[] }>({ key: '', recs: [] });
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
  const filterKey = `${category}|${moods.join(',')}|${debouncedExp}|${JSON.stringify(mix ?? {})}`;
  const feed = useQuery({
    queryKey: ['feed', category, moods.join(','), debouncedExp, seed, JSON.stringify(mix ?? {})],
    queryFn: () => api.discover({ categories, moods, exploration: debouncedExp, limit: category === 'all' ? 48 : 24, seed, exclude, mix }),
    enabled: !!profile.data,
    staleTime: 5 * 60_000,
    // While a new page of the SAME tab loads (new picks, get more, another mood), the current page stays
    // on screen, dimmed. Another tab's feed never stands in for this one: it would read as this tab's
    // finished page (its songs, its count, "that's all") until the real one replaces it.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === category ? prev : undefined),
  });

  const single = category !== 'all';
  const keptRecs = useMemo(() => (kept.key === filterKey ? kept.recs : []), [kept, filterKey]);
  // A single-category tab only ever shows its own category; songs kept by "Get more" come first.
  const recs = useMemo(() => {
    const page = (feed.data?.recommendations ?? []).filter((r) => category === 'all' || r.item.category === category);
    const seen = new Set<string>();
    return [...keptRecs, ...page].filter((r) => !dismissed.has(r.item.id) && !seen.has(r.item.id) && !!seen.add(r.item.id));
  }, [feed.data, keptRecs, dismissed, category]);
  // Rate limits are handled server-side (stored, verified picks fill in), so they aren't worth a warning.
  const notices = (feed.data?.providers ?? []).filter((p) => p.status !== 'ok' && p.status !== 'cached' && p.status !== 'quota');
  const PROVIDER_NAME: Record<string, string> = { youtube: 'YouTube', spotify: 'Spotify', tmdb: 'TMDB', tvmaze: 'TVmaze', openlibrary: 'Open Library' };
  const name = profile.data?.account.display_name;

  const onScreenIds = () => [...new Set([...keptRecs, ...(feed.data?.recommendations ?? [])].map((r) => r.item.id))].slice(0, 100);
  // "New picks": a fresh page instead of this one.
  const refresh = () => {
    setExclude(onScreenIds());
    setKept({ key: '', recs: [] });
    setDismissed(new Set());
    setSeed((s) => s + 1);
  };
  // "Get more" (a short music page): the songs on screen stay, a new page without them is added below.
  const getMore = () => {
    setExclude(onScreenIds());
    setKept({ key: filterKey, recs });
    setSeed((s) => s + 1);
  };

  // Lane videos (live sessions) sit in the music lanes on top of the songs — the ranker adds them where
  // songs are missing — so they never count as picks for the hero or the short-page note.
  const picks = recs.filter((r) => !isLaneVideo(r.item));
  // A small single-category page shows every pick in its grid/lanes: the hero never swallows the page
  // (nor does a page grown by "Get more" turn its first song into a hero). The hero is never a lane video.
  const heroless = single && (picks.length < HERO_MIN || keptRecs.length > 0);
  const hero: Recommendation | undefined = heroless ? undefined : picks[0];
  const rest = hero ? recs.filter((r) => r !== hero) : recs;
  const loading = feed.isLoading || (!feed.data && !feed.isError) || (feed.isPlaceholderData && feed.isFetching && recs.length === 0);
  // The page on screen is the previous one of this tab while the next one loads.
  const refreshing = feed.isPlaceholderData && feed.isFetching;
  const empty = !loading && !feed.isError && recs.length === 0;
  const errorMessage = feed.isError ? (feed.error as Error | null)?.message : undefined;
  // A music page with only a few verified songs says so, with a way to ask for more.
  const shortMusic = category === 'music' && !loading && recs.length > 0 && picks.length < SHORT_MUSIC;
  const toggleMood = (m: string) => setMoods((s) => (s.includes(m) ? s.filter((x) => x !== m) : [...s, m].slice(-3)));
  const [open, setOpenState] = useState<{ rec: Recommendation; play: boolean } | null>(null);
  const setOpen = (rec: Recommendation | null) => setOpenState(rec ? { rec, play: false } : null);
  const watch = (rec: Recommendation) => setOpenState({ rec, play: true });
  const player = usePlayQueue();
  const dismiss = (id: string) => setDismissed((s) => new Set(s).add(id));
  const shelves = CATEGORIES.map((c) => ({ c, items: rest.filter((r) => r.item.category === c) })).filter((x) => x.items.length > 0);
  const SHELF_TITLE: Record<Category, string> = { youtube: 'Videos for you', music: 'Music for you', screen: 'Films & series', books: 'Books to read', podcasts: 'Podcasts to hear' };
  const tunedSubtitle = (n: number) => (moods.length ? `Tuned to ${moods.map((m) => conceptLabel(m).toLowerCase()).join(', ')}` : `${n} picks`);
  // Music arrives in listening lanes (metadata.lane): one shelf per lane, in feed order; songs without a lane stay together.
  // A lane's live sessions / music videos are music items of that lane (never in the Videos shelf): they sit
  // among its songs, but a tap plays one in its own player (the detail sheet) and "Play all" plays the songs.
  const musicLanes = groupByLane(rest.filter((r) => r.item.category === 'music'), (r) => r.item);
  const laneTitle = (g: LaneGroup<Recommendation>) => g.lane?.label ?? SHELF_TITLE.music;
  const laneSubtitle = (g: LaneGroup<Recommendation>) => (g.lane ? laneCountLabel(g.items.map((r) => r.item)) : tunedSubtitle(g.items.length));
  const playLane = (g: LaneGroup<Recommendation>, i = 0) => player.playQueue(g.items.map((r) => r.item), i);
  const playHero = () => {
    if (!hero) return;
    // Music plays the hero's lane (or the unlaned songs) from the top pick; other kinds play their category.
    const lane = hero.item.category === 'music' ? laneOf(hero.item)?.id ?? '' : null;
    const sameShelf = (r: Recommendation) => r.item.category === hero.item.category && (lane === null || (laneOf(r.item)?.id ?? '') === lane);
    player.playQueue(recs.filter(sameShelf).map((r) => r.item), 0);
  };

  const newPicksButton = (
    <button type="button" onClick={refresh} disabled={feed.isFetching} className="inline-flex h-12 items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-5 text-[15px] text-bone backdrop-blur-md transition-colors hover:bg-white/[0.08] disabled:opacity-50">
      <RefreshCw className={`h-4 w-4 ${feed.isFetching ? 'animate-spin' : ''}`} aria-hidden /> New picks
    </button>
  );
  const tuneButton = (
    <button type="button" onClick={() => setTuneOpen((o) => !o)} aria-expanded={tuneOpen} className={`inline-flex h-12 items-center gap-2 rounded-full border px-5 text-[15px] backdrop-blur-md transition-colors ${tuneOpen ? 'border-ember/50 bg-ember/10 text-bone' : 'border-white/15 bg-white/[0.04] text-bone hover:bg-white/[0.08]'}`}>
      <SlidersHorizontal className="h-4 w-4" aria-hidden /> {exp < 0.34 ? 'Familiar' : exp < 0.67 ? 'Balanced' : 'Adventurous'}
    </button>
  );

  return (
    <div>
      {/* Hero: the top pick, full-bleed (a small single-category page has a plain header instead) */}
      <section className="relative isolate overflow-hidden" aria-label={hero || loading ? 'Today’s echo' : single ? CATEGORY_META[category].label : 'Your picks'}>
        <div aria-hidden className="absolute inset-0 -z-10">
          {hero?.item.artworkUrl && <img src={hero.item.artworkUrl} alt="" className="h-full w-full scale-125 object-cover opacity-45 blur-3xl saturate-150" />}
          <div className="absolute inset-0 bg-gradient-to-b from-ink/30 via-ink/60 to-ink" />
          <div className="absolute inset-0 bg-gradient-to-r from-ink/80 via-ink/20 to-transparent" />
        </div>
        <div className="pt-safe px-4 pb-8 md:px-10 md:pt-14 md:pb-12">
          <div className="mb-8 md:hidden"><Wordmark /></div>
          <p className="text-xs font-semibold tracking-[0.2em] text-ember uppercase">{greeting()}{name ? `, ${name}` : ''}</p>
          {loading ? (
            <div className="mt-5 flex flex-col gap-6 md:flex-row md:items-end" aria-hidden>
              <div className="skeleton aspect-square w-44 rounded-2xl md:order-2 md:ml-auto md:w-64" />
              <div className="flex-1 space-y-3"><div className="skeleton h-4 w-32 rounded-full" /><div className="skeleton h-10 w-4/5 rounded-xl" /><div className="skeleton h-4 w-1/2 rounded-full" /></div>
            </div>
          ) : !hero ? (
            <div className="mt-5 max-w-2xl">
              <h1 className="font-display text-[34px] leading-[1.05] font-medium tracking-[-0.015em] md:text-[52px]">{single ? CATEGORY_META[category].label : 'Your picks'}</h1>
              <p className="mt-2 text-base text-mist">
                {feed.isError ? 'Your picks could not be loaded.' : recs.length === 0 ? 'Nothing new right now.' : category === 'music' ? laneCountLabel(recs.map((r) => r.item)) : `${recs.length} ${recs.length === 1 ? 'pick' : 'picks'}`}
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-2.5">{newPicksButton}{tuneButton}</div>
            </div>
          ) : (
            <div className="mt-5 flex flex-col gap-6 md:flex-row md:items-end md:gap-10">
              <button type="button" onClick={() => setOpen(hero)} className="group self-start md:order-2 md:ml-auto" aria-label={`Open ${hero.item.title}`}>
                <Artwork item={hero.item} className={`shadow-[0_30px_80px_-30px_rgba(0,0,0,0.95)] transition-transform duration-500 ease-[var(--ease-echo)] group-hover:-translate-y-1 ${hero.item.category === 'youtube' ? 'w-[min(100%,26rem)] md:w-[30rem]' : hero.item.category === 'music' || hero.item.category === 'podcasts' ? 'w-48 md:w-72' : 'w-40 md:w-60'}`} />
              </button>
              <div className="min-w-0 max-w-2xl flex-1">
                <p className="text-[11px] font-semibold tracking-[0.18em] text-mist uppercase">Today’s echo · <span style={{ color: CATEGORY_META[hero.item.category].color }}>{KIND_LABEL[hero.item.kind]}</span></p>
                <h1 className="mt-2 line-clamp-3 font-display text-[38px] leading-[1.02] font-medium tracking-[-0.015em] text-balance md:text-[64px]" title={hero.item.title}>{displayTitle(hero.item)}</h1>
                {hero.item.creators[0] && <p className="mt-2 text-base text-mist md:text-lg">{hero.item.creators.slice(0, 2).join(', ')}</p>}
                {hero.explanation.reasons[0] && <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-bone/85 md:text-[17px]">{hero.explanation.reasons[0].detail}</p>}
                <div className="mt-6 flex flex-wrap items-center gap-2.5">
                  <button type="button" onClick={() => (isQueueable(hero.item) ? playHero() : hero.item.embed ? watch(hero) : setOpen(hero))} className="inline-flex h-12 items-center gap-2 rounded-full bg-bone px-6 text-[15px] font-semibold text-ink shadow-[0_14px_40px_-14px_rgba(239,232,220,0.55)] transition-transform active:scale-95">
                    {hero.item.embed ? <><Play className="h-4 w-4 fill-current" aria-hidden /> Play</> : <>Discover it <ArrowUpRight className="h-4 w-4" aria-hidden /></>}
                  </button>
                  {newPicksButton}
                  {tuneButton}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Ask + filters */}
      <div className="px-4 md:px-10">
        <form
          className="flex items-center gap-2 rounded-2xl border border-line bg-ink-2/80 p-1.5 pl-4 transition-colors focus-within:border-ember/50 md:max-w-2xl"
          onSubmit={(e) => {
            e.preventDefault();
            if (ask.trim()) nav(`/echo?q=${encodeURIComponent(ask.trim())}`);
          }}
        >
          <Sparkles className="h-4 w-4 shrink-0 text-ember" aria-hidden />
          <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Ask for a feeling, a theme, a title…" className="min-w-0 flex-1 bg-transparent py-2.5 placeholder:text-dim focus:outline-none" aria-label="Ask Echo" />
          <button className="grid h-11 w-11 place-items-center rounded-xl bg-ember text-ink transition-transform active:scale-95" aria-label="Ask Echo"><ArrowUpRight className="h-5 w-5" /></button>
        </form>
        <div className="mt-5 space-y-2.5">
          <CategoryTabs value={category} onChange={(c) => { setCategory(c); setDismissed(new Set()); }} />
          <MoodChips selected={moods} onToggle={toggleMood} />
        </div>
        <AnimatePresence initial={false}>
          {tuneOpen && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <div className="pt-4 md:max-w-md"><ExplorationSlider value={exp} onChange={setExploration} /></div>
            </motion.div>
          )}
        </AnimatePresence>
        {notices.length > 0 && (
          <p className="mt-4 text-xs text-dim">
            {notices.map((n, i) => (
              <span key={n.id}>{i > 0 && ' · '}<span className="text-mist">{PROVIDER_NAME[n.id] ?? n.id}</span> {n.status === 'unconfigured' ? 'not connected' : 'temporarily unavailable'}</span>
            ))}
            {' · '}<button type="button" onClick={() => nav('/settings')} className="text-ember hover:underline">settings</button>
          </p>
        )}
      </div>

      {/* Shelves (everything) or a grid (one category) */}
      <div className={`transition-opacity ${feed.isFetching && !loading ? 'opacity-60' : ''}`}>
        {loading ? (
          [0, 1].map((i) => (
            <Shelf key={i} id={`sk-${i}`} title={i === 0 ? 'Finding your picks…' : ' '}>
              {Array.from({ length: 6 }, (_, j) => <div key={j} className="w-[9.75rem] shrink-0 md:w-[11.5rem]" aria-hidden><div className="skeleton aspect-square rounded-[14px]" /><div className="skeleton mt-3 h-3.5 w-4/5 rounded-full" /><div className="skeleton mt-2 h-3 w-1/2 rounded-full" /></div>)}
            </Shelf>
          ))
        ) : category === 'all' ? (
          shelves.flatMap(({ c, items }) =>
            c === 'music'
              ? musicLanes.map((g, gi) => (
                  <Shelf
                    key={`music-${g.key}`}
                    id={`shelf-music-${gi}-${laneDomId(g.key)}`}
                    title={laneTitle(g)}
                    subtitle={laneSubtitle(g)}
                    action={g.items.some((r) => isQueueable(r.item)) ? <PlayAll label={laneTitle(g)} onClick={() => playLane(g)} /> : undefined}
                  >
                    {g.items.map((r, i) => <Tile key={r.item.id} rec={r} onOpen={setOpen} onWatch={watch} onPlay={() => playLane(g, i)} />)}
                  </Shelf>
                ))
              : [
                  <Shelf
                    key={c}
                    id={`shelf-${c}`}
                    title={SHELF_TITLE[c]}
                    subtitle={tunedSubtitle(items.length)}
                    action={items.some((r) => isQueueable(r.item)) ? <PlayAll label={SHELF_TITLE[c]} onClick={() => player.playQueue(items.map((r) => r.item), 0)} /> : undefined}
                  >
                    {items.map((r, i) => <Tile key={r.item.id} rec={r} onOpen={setOpen} onWatch={watch} onPlay={() => player.playQueue(items.map((x) => x.item), i)} />)}
                  </Shelf>,
                ],
          )
        ) : category === 'music' && musicLanes.some((g) => g.lane) ? (
          musicLanes.map((g, gi) => {
            const hid = `lane-music-${gi}-${laneDomId(g.key)}`;
            return (
              <section key={`music-${g.key}`} className="mt-10 px-4 md:px-10" aria-labelledby={hid}>
                <div className="flex items-end justify-between gap-4">
                  <div className="min-w-0">
                    <h2 id={hid} className="font-display text-[22px] leading-tight md:text-[26px]">{laneTitle(g)}</h2>
                    <p className="mt-0.5 text-[13px] text-mist">{laneSubtitle(g)}</p>
                  </div>
                  {g.items.some((r) => isQueueable(r.item)) && <PlayAll label={laneTitle(g)} onClick={() => playLane(g)} />}
                </div>
                <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-5">
                  {g.items.map((r, i) => <Tile key={r.item.id} rec={r} onOpen={setOpen} onWatch={watch} onPlay={() => playLane(g, i)} className="!w-auto" />)}
                </div>
              </section>
            );
          })
        ) : rest.length > 0 ? (
          <section className="mt-10 px-4 md:px-10" aria-label={CATEGORY_META[category].label}>
            <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-5">
              {rest.map((r, i) => <Tile key={r.item.id} rec={r} onOpen={setOpen} onWatch={watch} onPlay={() => player.playQueue(rest.map((x) => x.item), i)} className="!w-auto" />)}
            </div>
          </section>
        ) : null}
        {shortMusic && (
          <div className="mx-4 mt-10 flex flex-col items-start gap-3 rounded-2xl border border-line bg-ink-2/60 p-4 sm:flex-row sm:items-center sm:justify-between md:mx-10">
            <p className="text-sm text-mist">{refreshing ? 'Looking for more songs…' : 'That’s all ECHO could verify right now.'}</p>
            <button type="button" onClick={getMore} disabled={feed.isFetching} className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-5 text-sm text-bone transition-colors hover:bg-white/[0.08] disabled:opacity-50">
              <RefreshCw className={`h-4 w-4 ${feed.isFetching ? 'animate-spin' : ''}`} aria-hidden /> Get more
            </button>
          </div>
        )}
        {empty && (
          <div className="px-4 py-16 text-center">
            <p className="font-display text-2xl">Nothing new here right now.</p>
            <p className="mt-2 text-sm text-mist">Try another mood, widen the categories, or get new picks.</p>
          </div>
        )}
        {feed.isError && (
          <div role="alert" className="mx-4 mt-10 rounded-2xl border border-danger/30 bg-danger/5 p-5 md:mx-10 md:max-w-2xl">
            <p className="font-medium text-bone">{recs.length ? 'ECHO couldn’t refresh your picks.' : 'ECHO couldn’t load your picks.'}</p>
            {errorMessage && <p className="mt-1 text-sm text-mist">{errorMessage}</p>}
            <button type="button" onClick={() => feed.refetch()} className="mt-4 inline-flex h-11 items-center gap-2 rounded-full bg-bone px-5 text-sm font-semibold text-ink transition-transform active:scale-95">
              <RefreshCw className="h-4 w-4" aria-hidden /> Retry
            </button>
          </div>
        )}
      </div>

      {(recent.data?.length ?? 0) > 0 && (
        <Shelf id="recent-h" title="Recently discovered" subtitle="What ECHO showed you lately">
          {recent.data!.filter((r) => r.content_items).slice(0, 14).map((r) => {
            const it = dbToItem(r.content_items!);
            return (
              <a key={r.item_id} href={it.externalUrl} target="_blank" rel="noreferrer" className="group w-[8rem] shrink-0 snap-start md:w-[9rem]" title={r.explanation}>
                <Artwork item={{ ...it, category: 'music' }} rounded="rounded-xl" className="transition-transform duration-300 group-hover:-translate-y-1" />
                <p className="mt-2 line-clamp-2 text-[13px] leading-snug text-bone/90">{it.title}</p>
                <p className="mt-0.5 text-[11px] font-medium tracking-wide uppercase" style={{ color: CATEGORY_META[it.category].color }}>{CATEGORY_META[it.category].short}</p>
              </a>
            );
          })}
        </Shelf>
      )}

      <DetailSheet rec={open?.rec ?? null} autoPlay={open?.play} onClose={() => setOpenState(null)} onDismiss={dismiss} />
    </div>
  );
}
