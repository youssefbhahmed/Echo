import { forwardRef, memo, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpRight, Bookmark, Check, Clock, Film, FolderPlus, Heart, MoreHorizontal, Pause, Play, Sparkles, Star, ThumbsDown } from 'lucide-react';
import type { AnalyzedItem, Explanation, ScoreBreakdown } from '@shared/types.ts';
import { conceptLabel } from '@shared/engine/concepts.ts';
import { CATEGORY_META, displayTitle, formatDuration, KIND_LABEL, PROVIDER_LABEL, year } from '../lib/meta';
import { api } from '../lib/api';
import { useFeedback, useLibraryMap } from '../hooks/data';
import { isQueueable, usePlayQueue } from '../lib/player';
import { EmbedPlayer, YouTubePlayer } from './Player';
import { CollectionPicker } from './CollectionPicker';
import { toast } from './Toast';

interface Props {
  item: AnalyzedItem;
  explanation?: Explanation;
  score?: ScoreBreakdown;
  trajectoryStep?: number;
  source?: 'feed' | 'chat' | 'library';
  onDismiss?: (id: string) => void;
  /** Large hero presentation (Discover's top pick). */
  featured?: boolean;
  /** Start the player immediately (one tap from a tile). */
  autoPlay?: boolean;
  /** Spotify mode: a song started in ECHO's player bar (the detail sheet closes so the bar and its prompts show). */
  onPlayStarted?: () => void;
}

/** Hero artwork width by shape: posters stay narrow, squares medium, videos wide. */
const FEATURED_ART: Record<string, string> = {
  youtube: 'w-full md:w-[52%]',
  music: 'mx-auto w-[72%] max-w-[300px] md:mx-0 md:w-[280px]',
  podcasts: 'mx-auto w-[72%] max-w-[300px] md:mx-0 md:w-[280px]',
  screen: 'mx-auto w-[58%] max-w-[240px] md:mx-0 md:w-[230px]',
  books: 'mx-auto w-[58%] max-w-[240px] md:mx-0 md:w-[230px]',
};

const ASPECT: Record<string, string> = { youtube: 'aspect-video', music: 'aspect-square', podcasts: 'aspect-square', screen: 'aspect-[2/3]', books: 'aspect-[2/3]' };

/** Artwork with a shimmer placeholder and a soft fade-in once loaded. */
export function Artwork({ item, className = '', rounded = 'rounded-2xl' }: { item: AnalyzedItem; className?: string; rounded?: string }) {
  const meta = CATEGORY_META[item.category];
  const Icon = meta.icon;
  const [state, setState] = useState<'loading' | 'ok' | 'error'>(item.artworkUrl ? 'loading' : 'error');
  return (
    <div className={`relative overflow-hidden bg-ink-3 ${rounded} ${ASPECT[item.category]} ${className}`}>
      {state === 'loading' && <div className="skeleton absolute inset-0" aria-hidden />}
      {item.artworkUrl && state !== 'error' && (
        <img
          src={item.artworkUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setState('ok')}
          onError={() => setState('error')}
          className={`h-full w-full object-cover transition-[opacity,transform] duration-700 ease-[var(--ease-echo)] group-hover:scale-[1.03] ${state === 'ok' ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
      {state === 'error' && (
        <div className="grid h-full w-full place-items-center" style={{ background: `radial-gradient(circle at 30% 20%, color-mix(in oklab, ${meta.color} 28%, transparent), transparent 72%)` }}>
          <Icon className="h-9 w-9 opacity-60" style={{ color: meta.color }} aria-hidden />
        </div>
      )}
      <div className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-white/[0.06] ring-inset" aria-hidden />
    </div>
  );
}

function ActionButton({ label, active, onClick, children, danger }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={`grid h-11 w-11 place-items-center rounded-full transition-[background-color,color,transform] duration-150 active:scale-90 ${
        active ? (danger ? 'bg-white/10 text-bone' : 'bg-ember/15 text-ember') : 'text-mist hover:bg-white/[0.06] hover:text-bone'
      }`}
    >
      {children}
    </button>
  );
}

function MenuItem({ icon: Icon, children, onClick, href }: { icon: React.ComponentType<{ className?: string }>; children: React.ReactNode; onClick?: () => void; href?: string }) {
  const cls = 'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-bone/90 hover:bg-white/[0.06]';
  if (href)
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls} onClick={onClick}>
        <Icon className="h-4 w-4 text-mist" /> {children}
      </a>
    );
  return (
    <button type="button" onClick={onClick} className={cls}>
      <Icon className="h-4 w-4 text-mist" /> {children}
    </button>
  );
}

export const MediaCard = memo(forwardRef<HTMLElement, Props>(function MediaCard({ item, explanation, score, trajectoryStep, source = 'feed', onDismiss, featured, autoPlay, onPlayStarted }, ref) {
  const lib = useLibraryMap().get(item.id);
  const feedback = useFeedback();
  const player = usePlayQueue();
  const [playing, setPlaying] = useState(!!autoPlay && !!item.embed);
  const [trailer, setTrailer] = useState<string | null | undefined>(undefined);
  const [menu, setMenu] = useState(false);
  const [details, setDetails] = useState(false);
  const [collections, setCollections] = useState(false);
  const playedRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const meta = CATEGORY_META[item.category];
  const playable = !!item.embed;
  const canTrailer = item.provider === 'tmdb';
  // Full songs (Spotify Premium connected) play in the user's Spotify app through ECHO's player bar.
  const remoteSong = playable && player.mode === 'spotify' && isQueueable(item);
  const isCurrent = remoteSong && player.currentId === item.id;
  const remotePlaying = isCurrent && player.playing;
  const showPause = playing || remotePlaying;
  const send = (type: Parameters<typeof feedback.mutate>[0]['type'], rating?: number) => feedback.mutate({ item, type, rating, source });

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menu]);

  const onPlayed = useCallback(() => {
    if (playedRef.current) return;
    playedRef.current = true;
    feedback.mutate({ item, type: 'play', source });
  }, [feedback, item, source]);

  const togglePlay = async () => {
    if (remoteSong) {
      // The song in the bar: pause or resume it (never restart it, never replace its lane queue).
      if (isCurrent) return player.togglePlay();
      player.playItem(item);
      onPlayStarted?.();
      return;
    }
    if (playable) return setPlaying((p) => !p);
    if (!canTrailer) return;
    if (trailer !== undefined) return setPlaying((p) => !p && !!trailer);
    try {
      const r = await api.trailer(item.id);
      setTrailer(r.videoId);
      if (r.videoId) setPlaying(true);
      else toast('TMDB lists no trailer for this title.');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const rating = item.rating ? (item.provider === 'openlibrary' ? (item.rating * 5).toFixed(1) : (item.rating * 10).toFixed(1)) : null;
  const facts = [year(item.releaseDate), formatDuration(item.durationSec)].filter(Boolean) as string[];
  const reason = explanation?.reasons[0]?.detail ?? explanation?.text;
  const stacked = featured || item.category === 'youtube';
  // In the detail view a playing video takes the top of the sheet (where the artwork was).
  const videoFirst = !!featured && playing && (item.embed?.type === 'youtube' || !!trailer);

  return (
    <motion.article
      ref={ref}
      layout="position"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.16 } }}
      transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
      className={`group relative flex flex-col rounded-[var(--radius-card)] border border-line bg-ink-2/85 p-3 shadow-[0_24px_60px_-36px_rgba(0,0,0,0.9)] transition-colors duration-200 hover:border-white/[0.13] ${featured ? 'md:p-5' : ''}`}
    >
      {videoFirst && <div className="mb-4 overflow-hidden rounded-2xl">{renderPlayer()}</div>}
      <div className={featured ? 'md:flex md:gap-7' : ''}>
      {!videoFirst && (
      <div className={stacked ? (featured ? `${FEATURED_ART[item.category]} md:shrink-0` : '') : 'flex gap-3.5'}>
        <div className={stacked ? 'relative' : `relative shrink-0 ${item.category === 'music' || item.category === 'podcasts' ? 'w-[36%]' : 'w-[31%]'}`}>
          <Artwork item={item} />
          {(playable || canTrailer) && (
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? `Close player for ${item.title}` : remotePlaying ? `Pause ${item.title}` : playable ? `Play ${item.title}` : `Watch the trailer of ${item.title}`}
              className="absolute right-2 bottom-2 grid h-11 w-11 place-items-center rounded-full bg-bone text-ink shadow-[0_8px_24px_-6px_rgba(0,0,0,0.6)] transition-transform duration-150 hover:scale-105 active:scale-95"
            >
              {showPause ? <Pause className="h-[18px] w-[18px] fill-current" /> : canTrailer && !playable ? <Film className="h-[18px] w-[18px]" /> : <Play className="ml-0.5 h-[18px] w-[18px] fill-current" />}
            </button>
          )}
        </div>
        {!stacked && renderText()}
      </div>
      )}
      {stacked && (
        <div className={featured ? 'mt-4 flex min-w-0 flex-1 flex-col md:mt-1 md:py-1' : 'mt-3'}>
          {renderText()}
          {featured && <div className="md:mt-auto md:pt-4">{renderActions()}</div>}
        </div>
      )}
      </div>

      <AnimatePresence initial={false}>
        {playing && !videoFirst && (item.embed || trailer) && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28 }} className="overflow-hidden">
            <div className="pt-3">{renderPlayer()}</div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {details && explanation && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-3 space-y-3 rounded-2xl bg-ink-3/70 p-3 text-xs text-mist">
              <ul className="space-y-1.5">
                {explanation.reasons.map((r, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="w-[5.5rem] shrink-0 text-dim capitalize">{r.kind}</span>
                    <span className="text-bone/85">{r.detail}</span>
                  </li>
                ))}
              </ul>
              {explanation.matchedConcepts.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-dim">From its metadata:</span>
                  {explanation.matchedConcepts.map((c) => (
                    <span key={c} className="rounded-full bg-ink-4 px-2 py-0.5 text-bone/80">{conceptLabel(c)}</span>
                  ))}
                </div>
              )}
              {item.playbackNote && <p className="text-dim">{item.playbackNote}</p>}
              {score && (
                <div className="grid grid-cols-4 gap-1.5 font-mono text-[10.5px]">
                  {(['query', 'deep', 'surface', 'novelty', 'context', 'quality', 'collaborative', 'semantic'] as const).map((k) => (
                    <div key={k} className="rounded-lg bg-ink-2 px-1.5 py-1">
                      <div className="text-dim">{k}</div>
                      <div className="text-bone">{score[k].toFixed(2)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!featured && renderActions()}
      {collections && <CollectionPicker itemId={item.id} onClose={() => setCollections(false)} />}
    </motion.article>
  );

  function renderPlayer() {
    return trailer ? <YouTubePlayer videoId={trailer} title={`${item.title} trailer`} /> : item.embed && <EmbedPlayer embed={item.embed} title={item.title} onPlay={onPlayed} />;
  }

  function renderActions() {
    return (
      <div className={`flex items-center ${featured ? 'mt-4' : 'mt-2'}`}>
        {featured && (
          playable || canTrailer ? (
            <button type="button" onClick={togglePlay} className="mr-1.5 inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-bone px-4 text-sm font-semibold text-ink shadow-[0_10px_30px_-12px_rgba(239,232,220,0.5)] transition-transform active:scale-95">
              {showPause ? <Pause className="h-4 w-4 fill-current" aria-hidden /> : canTrailer && !playable ? <Film className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4 fill-current" aria-hidden />}
              {playing ? 'Close player' : remotePlaying ? 'Pause' : canTrailer && !playable ? 'Watch trailer' : 'Play'}
            </button>
          ) : (
            <a href={item.externalUrl} target="_blank" rel="noreferrer" onClick={() => send('open')} className="mr-1.5 inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-bone px-4 text-sm font-semibold text-ink transition-transform active:scale-95">
              Open in {PROVIDER_LABEL[item.provider]} <ArrowUpRight className="h-4 w-4" aria-hidden />
            </a>
          )
        )}
        <ActionButton label={lib?.liked ? 'Unlike' : 'Like'} active={lib?.liked === true} onClick={() => send(lib?.liked ? 'unlike' : 'like')}>
          <Heart className={`h-[19px] w-[19px] ${lib?.liked ? 'fill-current' : ''}`} />
        </ActionButton>
        <ActionButton label={lib?.saved ? 'Remove from saved' : 'Save for later'} active={!!lib?.saved} onClick={() => send(lib?.saved ? 'unsave' : 'save')}>
          <Bookmark className={`h-[19px] w-[19px] ${lib?.saved ? 'fill-current' : ''}`} />
        </ActionButton>
        <ActionButton label="Not for me" danger active={lib?.liked === false} onClick={() => { send('dislike'); onDismiss?.(item.id); }}>
          <ThumbsDown className="h-[19px] w-[19px]" />
        </ActionButton>
        {explanation && (
          <button type="button" onClick={() => setDetails((d) => !d)} aria-expanded={details} className="ml-0.5 h-11 shrink-0 rounded-full px-2 text-xs whitespace-nowrap text-dim transition-colors hover:text-bone">
            {details ? 'Hide why' : 'Why this?'}
          </button>
        )}
        <div className="relative ml-auto" ref={menuRef}>
          <ActionButton label="More actions" active={menu} danger onClick={() => setMenu((m) => !m)}>
            <MoreHorizontal className="h-[19px] w-[19px]" />
          </ActionButton>
          <AnimatePresence>
            {menu && (
              <motion.div
                initial={{ opacity: 0, y: 6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
                transition={{ duration: 0.18 }}
                role="menu"
                className="absolute right-0 bottom-12 z-30 w-64 origin-bottom-right rounded-2xl border border-line bg-ink-3/95 p-1.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl"
              >
                <p className="px-3 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.12em] text-dim uppercase">Rate</p>
                <div className="flex gap-0.5 px-1.5 pb-1.5" role="radiogroup" aria-label="Rating">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} type="button" role="radio" aria-checked={lib?.rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => { send('rate', n); setMenu(false); }} className="grid h-10 w-10 place-items-center rounded-xl hover:bg-white/[0.06]">
                      <Star className={`h-5 w-5 ${lib?.rating && n <= lib.rating ? 'fill-amber text-amber' : 'text-mist'}`} />
                    </button>
                  ))}
                </div>
                <div className="my-1 h-px bg-line" />
                <MenuItem icon={Check} onClick={() => { send('consumed'); setMenu(false); }}>{lib?.status === 'consumed' ? 'Finished ✓' : 'Mark as finished'}</MenuItem>
                <MenuItem icon={FolderPlus} onClick={() => { setCollections(true); setMenu(false); }}>Add to collection</MenuItem>
                {onDismiss && <MenuItem icon={Clock} onClick={() => { send('skip'); onDismiss(item.id); setMenu(false); }}>Not now</MenuItem>}
                <MenuItem icon={ArrowUpRight} href={item.externalUrl} onClick={() => { send('open'); setMenu(false); }}>Open on {PROVIDER_LABEL[item.provider]}</MenuItem>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    );
  }

  function renderText() {
    return (
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.13em] uppercase">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: meta.color }} aria-hidden />
          <span style={{ color: meta.color }}>{KIND_LABEL[item.kind]}</span>
          {trajectoryStep !== undefined && <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] tracking-normal text-mist normal-case">step {trajectoryStep + 1}</span>}
          <a
            href={item.externalUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => send('open')}
            className="ml-auto inline-flex min-h-6 items-center gap-0.5 font-medium tracking-normal text-dim normal-case transition-colors hover:text-bone"
            aria-label={`Open ${item.title} on ${PROVIDER_LABEL[item.provider]}`}
          >
            {PROVIDER_LABEL[item.provider]} <ArrowUpRight className="h-3 w-3" aria-hidden />
          </a>
        </div>
        <h3 className={`mt-1.5 font-display leading-[1.18] font-semibold text-bone [overflow-wrap:anywhere] ${featured ? 'line-clamp-3 text-[26px] md:text-[34px]' : 'line-clamp-3 text-[18px]'}`} title={item.title}>{displayTitle(item)}</h3>
        {item.creators.length > 0 && <p className={`mt-1 truncate text-mist ${featured ? 'text-base' : 'text-[13.5px]'}`}>{item.creators.slice(0, 2).join(', ')}</p>}
        {(facts.length > 0 || rating) && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-dim">
            {facts.join(' · ')}
            {rating && (
              <span className="inline-flex items-center gap-0.5">
                {facts.length > 0 && '·'} <Star className="h-3 w-3 fill-amber text-amber" aria-hidden /> {rating}
              </span>
            )}
          </p>
        )}
        {reason && (
          <p data-testid="reason" className={`mt-2.5 flex gap-1.5 leading-snug text-bone/80 ${featured ? 'max-w-xl text-[15px] md:mt-4 md:text-[17px] md:leading-relaxed' : 'line-clamp-3 text-[13.5px]'}`}>
            <Sparkles className="mt-[3px] h-3.5 w-3.5 shrink-0 text-ember" aria-hidden />
            <span>{reason}</span>
          </p>
        )}
      </div>
    );
  }
}));

export function MediaCardSkeleton({ featured }: { featured?: boolean }) {
  return (
    <div className={`rounded-[var(--radius-card)] border border-line bg-ink-2/70 p-3 ${featured ? 'md:flex md:gap-6 md:p-4' : 'flex gap-3.5'}`} aria-hidden>
      <div className={`skeleton rounded-2xl ${featured ? 'aspect-video md:w-[44%]' : 'aspect-[2/3] w-[31%] shrink-0'}`} />
      <div className={`flex-1 space-y-2.5 ${featured ? 'mt-4 md:mt-2' : 'pt-1'}`}>
        <div className="skeleton h-3 w-16 rounded-full" />
        <div className="skeleton h-5 w-4/5 rounded-lg" />
        <div className="skeleton h-3.5 w-1/2 rounded-full" />
        <div className="skeleton mt-4 h-3 w-full rounded-full" />
        <div className="skeleton h-3 w-3/4 rounded-full" />
      </div>
    </div>
  );
}
