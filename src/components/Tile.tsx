import { motion } from 'motion/react';
import { AudioLines, Heart, Info, Play } from 'lucide-react';
import { isQueueable, usePlayer } from '../lib/player';
import type { Recommendation } from '@shared/types.ts';
import { CATEGORY_META, displayTitle, KIND_LABEL } from '../lib/meta';
import { useLibraryMap } from '../hooks/data';
import { Artwork } from './MediaCard';

/** Width by artwork shape so posters, squares and videos sit naturally side by side. */
export const TILE_WIDTH: Record<string, string> = {
  youtube: 'w-[15.5rem] md:w-[19rem]',
  music: 'w-[9.75rem] md:w-[11.5rem]',
  podcasts: 'w-[9.75rem] md:w-[11.5rem]',
  screen: 'w-[8.75rem] md:w-[10.5rem]',
  books: 'w-[8.75rem] md:w-[10.5rem]',
};

/** An artwork-first tile. Tapping opens the detail sheet (player, why, actions). */
export function Tile({ rec, onOpen, onPlay, onWatch, className = '' }: { rec: Recommendation; onOpen: (r: Recommendation) => void; onPlay?: () => void; onWatch?: (r: Recommendation) => void; className?: string }) {
  const { item } = rec;
  const { current } = usePlayer();
  const nowPlaying = current?.id === item.id;
  const playsInline = !!onPlay && isQueueable(item);
  const watches = !playsInline && !!onWatch && item.embed?.type === 'youtube';
  const meta = CATEGORY_META[item.category];
  const liked = useLibraryMap().get(item.id)?.liked === true;
  return (
    <motion.button
      type="button"
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      onClick={() => (playsInline ? onPlay!() : watches ? onWatch!(rec) : onOpen(rec))}
      className={`group shrink-0 snap-start text-left ${TILE_WIDTH[item.category]} ${className}`}
      aria-label={`${item.title}${item.creators[0] ? `, ${item.creators[0]}` : ''}. ${playsInline || watches ? 'Play' : 'Open details'}`}
    >
      <div className="relative">
        <Artwork item={item} rounded="rounded-[14px]" className="shadow-[0_18px_40px_-22px_rgba(0,0,0,0.95)] transition-transform duration-300 ease-[var(--ease-echo)] group-hover:-translate-y-1" />
        {item.embed && (
          <span className={`absolute right-2 bottom-2 grid h-10 w-10 place-items-center rounded-full backdrop-blur-md transition-opacity duration-200 ${nowPlaying ? 'bg-ember text-ink opacity-100' : `bg-ink/70 text-bone ${playsInline || watches ? 'opacity-100 md:opacity-0' : 'opacity-0'} group-hover:opacity-100 group-focus-visible:opacity-100`}`} aria-hidden>
            {nowPlaying ? <AudioLines className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4 fill-current" />}
          </span>
        )}
        {(playsInline || watches) && (
          <span
            role="button"
            tabIndex={0}
            aria-label={`Details for ${item.title}`}
            onClick={(e) => { e.stopPropagation(); onOpen(rec); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpen(rec); } }}
            className="absolute top-2 right-2 grid h-8 w-8 place-items-center rounded-full bg-ink/60 text-bone/90 opacity-100 backdrop-blur-md transition-opacity md:opacity-0 md:group-hover:opacity-100"
          >
            <Info className="h-4 w-4" />
          </span>
        )}
        {liked && (
          <span className="absolute top-2 left-2 grid h-7 w-7 place-items-center rounded-full bg-ink/70 text-ember backdrop-blur-md" aria-label="Liked">
            <Heart className="h-3.5 w-3.5 fill-current" />
          </span>
        )}
      </div>
      <p className="mt-2.5 line-clamp-2 text-[14px] leading-snug font-medium text-bone">{displayTitle(item)}</p>
      <p className="mt-0.5 truncate text-[12.5px] text-mist">
        {item.creators[0] ?? KIND_LABEL[item.kind]}
        <span className="text-dim"> · </span>
        <span style={{ color: meta.color }}>{KIND_LABEL[item.kind]}</span>
      </p>
    </motion.button>
  );
}
