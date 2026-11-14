import { forwardRef, memo, useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bookmark, Check, ChevronDown, ExternalLink, Film, Heart, MoreHorizontal, Play, Star, ThumbsDown, X } from 'lucide-react';
import type { AnalyzedItem, Explanation, ScoreBreakdown } from '@shared/types.ts';
import { conceptLabel } from '@shared/engine/concepts.ts';
import { CATEGORY_META, formatDuration, KIND_LABEL, PROVIDER_LABEL, year } from '../lib/meta';
import { api } from '../lib/api';
import { useFeedback, useLibraryMap } from '../hooks/data';
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
  compact?: boolean;
}

const ASPECT: Record<string, string> = { youtube: 'aspect-video', music: 'aspect-square', podcasts: 'aspect-square', screen: 'aspect-[2/3]', books: 'aspect-[2/3]' };

function Artwork({ item, onPlay, playable }: { item: AnalyzedItem; onPlay?: () => void; playable: boolean }) {
  const meta = CATEGORY_META[item.category];
  const Icon = meta.icon;
  const [broken, setBroken] = useState(false);
  return (
    <button
      type="button"
      onClick={onPlay}
      disabled={!onPlay}
      className={`group relative block w-full overflow-hidden rounded-2xl bg-ink-3 ${ASPECT[item.category]} ${onPlay ? 'cursor-pointer' : 'cursor-default'}`}
      aria-label={playable ? `Play ${item.title}` : item.title}
    >
      {item.artworkUrl && !broken ? (
        <img src={item.artworkUrl} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className="h-full w-full object-cover transition duration-700 ease-[var(--ease-echo)] group-hover:scale-[1.04]" />
      ) : (
        <div className="grid h-full w-full place-items-center" style={{ background: `radial-gradient(circle at 30% 20%, color-mix(in oklab, ${meta.color} 30%, transparent), transparent 70%)` }}>
          <Icon className="h-10 w-10 opacity-60" style={{ color: meta.color }} />
        </div>
      )}
      {playable && (
        <span className="absolute bottom-2.5 right-2.5 grid h-11 w-11 place-items-center rounded-full bg-bone text-ink shadow-xl transition group-hover:scale-110">
          <Play className="ml-0.5 h-5 w-5 fill-current" />
        </span>
      )}
    </button>
  );
}

function IconButton({ label, active, onClick, children, tone = 'ember' }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode; tone?: 'ember' | 'mist' }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={`grid h-10 w-10 place-items-center rounded-full border transition active:scale-90 ${active ? (tone === 'ember' ? 'border-ember/50 bg-ember/15 text-ember' : 'border-line bg-ink-4 text-bone') : 'border-line text-mist hover:border-white/20 hover:text-bone'}`}
    >
      {children}
    </button>
  );
}

export const MediaCard = memo(forwardRef<HTMLElement, Props>(function MediaCard({ item, explanation, score, trajectoryStep, source = 'feed', onDismiss, compact }, ref) {
  const lib = useLibraryMap().get(item.id);
  const feedback = useFeedback();
  const [playing, setPlaying] = useState(false);
  const [trailer, setTrailer] = useState<string | null | undefined>(undefined);
  const [more, setMore] = useState(false);
  const [details, setDetails] = useState(false);
  const [collections, setCollections] = useState(false);
  const playedRef = useRef(false);
  const meta = CATEGORY_META[item.category];
  const playable = !!item.embed;
  const send = (type: Parameters<typeof feedback.mutate>[0]['type'], rating?: number) => feedback.mutate({ item, type, rating, source });

  const onPlayed = useCallback(() => {
    if (playedRef.current) return;
    playedRef.current = true;
    feedback.mutate({ item, type: 'play', source });
  }, [feedback, item, source]);

  const openTrailer = async () => {
    if (trailer !== undefined) return setPlaying((p) => !p);
    try {
      const r = await api.trailer(item.id);
      setTrailer(r.videoId);
      if (r.videoId) setPlaying(true);
      else toast('TMDB lists no trailer for this title.');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const facts = [KIND_LABEL[item.kind], year(item.releaseDate), formatDuration(item.durationSec), item.rating ? `★ ${item.provider === 'openlibrary' || item.provider === 'itunes' ? (item.rating * 5).toFixed(1) : (item.rating * 10).toFixed(1)}` : null].filter(Boolean);
  const side = !compact && item.category !== 'youtube';

  return (
    <motion.article
      ref={ref}
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="relative rounded-[var(--radius-card)] border border-line bg-ink-2/80 p-3 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.8)] backdrop-blur"
    >
      <div className={side ? 'flex gap-3.5' : 'space-y-3'}>
        <div className={side ? (item.category === 'music' || item.category === 'podcasts' ? 'w-[38%] shrink-0' : 'w-[34%] shrink-0') : ''}>
          <Artwork item={item} playable={playable} onPlay={playable ? () => setPlaying((p) => !p) : undefined} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: meta.color }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
            {meta.short}
            {trajectoryStep !== undefined && <span className="rounded-full border border-line px-1.5 py-0.5 text-[10px] tracking-normal text-mist">step {trajectoryStep + 1}</span>}
            <span className="ml-auto font-medium normal-case tracking-normal text-dim">{PROVIDER_LABEL[item.provider]}</span>
          </div>
          <h3 className="mt-1.5 font-display text-[19px] leading-snug font-semibold text-bone [overflow-wrap:anywhere]">{item.title}</h3>
          {item.creators.length > 0 && <p className="mt-0.5 truncate text-sm text-mist">{item.creators.slice(0, 2).join(', ')}</p>}
          {facts.length > 0 && <p className="mt-1 text-xs text-dim">{facts.join(' · ')}</p>}
          {explanation && (
            <p className="mt-2.5 border-l-2 border-ember/60 pl-2.5 font-display text-[14.5px] leading-snug text-bone/90 italic">{explanation.text}</p>
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {playing && (item.embed || trailer) && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="pt-3">{trailer ? <YouTubePlayer videoId={trailer} title={`${item.title} trailer`} /> : item.embed && <EmbedPlayer embed={item.embed} title={item.title} onPlay={onPlayed} />}</div>
          </motion.div>
        )}
      </AnimatePresence>

      {!playable && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {item.provider === 'tmdb' && (
            <button type="button" onClick={openTrailer} className="inline-flex items-center gap-1.5 rounded-full bg-bone px-3.5 py-1.5 text-sm font-semibold text-ink active:scale-95">
              <Film className="h-4 w-4" /> {playing ? 'Hide trailer' : 'Trailer'}
            </button>
          )}
          <a href={item.externalUrl} target="_blank" rel="noreferrer" onClick={() => send('open')} className="inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-sm text-bone hover:border-white/25">
            Open on {PROVIDER_LABEL[item.provider]} <ExternalLink className="h-3.5 w-3.5" />
          </a>
          {item.playbackNote && <p className="w-full text-xs text-dim">{item.playbackNote}</p>}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <IconButton label={lib?.liked ? 'Liked' : 'Like'} active={lib?.liked === true} onClick={() => send('like')}>
          <Heart className={`h-[18px] w-[18px] ${lib?.liked ? 'fill-current' : ''}`} />
        </IconButton>
        <IconButton label={lib?.saved ? 'Remove from library' : 'Save'} active={!!lib?.saved} onClick={() => send(lib?.saved ? 'unsave' : 'save')}>
          <Bookmark className={`h-[18px] w-[18px] ${lib?.saved ? 'fill-current' : ''}`} />
        </IconButton>
        <IconButton label="Not for me" tone="mist" active={lib?.liked === false} onClick={() => { send('dislike'); onDismiss?.(item.id); }}>
          <ThumbsDown className="h-[18px] w-[18px]" />
        </IconButton>
        {onDismiss && (
          <IconButton label="Skip for now" tone="mist" onClick={() => { send('skip'); onDismiss(item.id); }}>
            <X className="h-[18px] w-[18px]" />
          </IconButton>
        )}
        <div className="relative ml-auto">
          <IconButton label="More actions" tone="mist" active={more} onClick={() => setMore((m) => !m)}>
            <MoreHorizontal className="h-[18px] w-[18px]" />
          </IconButton>
          <AnimatePresence>
            {more && (
              <motion.div
                initial={{ opacity: 0, y: 6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4 }}
                className="absolute right-0 bottom-12 z-20 w-60 rounded-2xl border border-line bg-ink-3/95 p-2 shadow-2xl backdrop-blur-xl"
              >
                <p className="px-2 pt-1 pb-1.5 text-xs text-dim">Rate it</p>
                <div className="flex gap-1 px-1 pb-2" role="radiogroup" aria-label="Rating">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} type="button" role="radio" aria-checked={lib?.rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => { send('rate', n); setMore(false); }} className="grid h-9 w-9 place-items-center rounded-lg hover:bg-ink-4">
                      <Star className={`h-5 w-5 ${lib?.rating && n <= lib.rating ? 'fill-amber text-amber' : 'text-mist'}`} />
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => { send('consumed'); setMore(false); }} className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm hover:bg-ink-4">
                  <Check className="h-4 w-4 text-tide" /> {lib?.status === 'consumed' ? 'Finished ✓' : 'Mark as finished'}
                </button>
                <button type="button" onClick={() => { setCollections(true); setMore(false); }} className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm hover:bg-ink-4">
                  <Bookmark className="h-4 w-4 text-iris" /> Add to collection…
                </button>
                <a href={item.externalUrl} target="_blank" rel="noreferrer" className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-sm hover:bg-ink-4">
                  <ExternalLink className="h-4 w-4 text-mist" /> Open on {PROVIDER_LABEL[item.provider]}
                </a>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {explanation && (
        <div className="mt-2">
          <button type="button" onClick={() => setDetails((d) => !d)} className="inline-flex items-center gap-1 text-xs text-dim hover:text-mist" aria-expanded={details}>
            Why this? <ChevronDown className={`h-3.5 w-3.5 transition ${details ? 'rotate-180' : ''}`} />
          </button>
          <AnimatePresence initial={false}>
            {details && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="space-y-2.5 pt-2 text-xs text-mist">
                  <ul className="space-y-1">
                    {explanation.reasons.map((r, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="w-20 shrink-0 text-dim capitalize">{r.kind}</span>
                        <span>{r.detail}</span>
                      </li>
                    ))}
                  </ul>
                  {explanation.matchedConcepts.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      <span className="text-dim">Detected from metadata:</span>
                      {explanation.matchedConcepts.map((c) => (
                        <span key={c} className="rounded-full bg-ink-4 px-2 py-0.5 text-bone/80">{conceptLabel(c)}</span>
                      ))}
                    </div>
                  )}
                  {score && (
                    <div className="grid grid-cols-4 gap-1.5 font-mono text-[10.5px]">
                      {(['query', 'deep', 'surface', 'novelty', 'context', 'quality', 'collaborative', 'semantic'] as const).map((k) => (
                        <div key={k} className="rounded-lg bg-ink-3 px-1.5 py-1">
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
        </div>
      )}
      {collections && <CollectionPicker itemId={item.id} onClose={() => setCollections(false)} />}
    </motion.article>
  );
}));
