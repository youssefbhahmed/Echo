import type { Recommendation } from '@shared/types.ts';
import { isQueueable, usePlayQueue } from '../lib/player';
import { isLaneVideo, laneCountLabel, laneDomId, splitAnswer, ownedInEntityLane, type LaneGroup } from '../lib/lanes';
import { MediaCard } from './MediaCard';
import { PlayAll } from './PlayAll';
import { Tile } from './Tile';

/**
 * The picks of one Echo AI answer: songs in their listening lanes ("Eminem", "Artists like Eminem", "For
 * your request"), each with "Play all" and tiles that play inline, then everything else as cards. A lane's
 * live sessions / music videos are part of it (they play in its queue).
 */
export function ChatAnswer({ recs, answerKey, onOpen, onWatch }: { recs: Recommendation[]; answerKey: string; onOpen: (r: Recommendation) => void; onWatch: (r: Recommendation) => void }) {
  const player = usePlayQueue();
  const { lanes, others } = splitAnswer(recs, (r) => r.item);
  const play = (g: LaneGroup<Recommendation>, i = 0) => player.playQueue(g.items.map((r) => r.item), i);
  return (
    <div className="mt-4 space-y-7">
      {lanes.map((g) => {
        const hid = `answer-${answerKey}-${laneDomId(g.key)}`;
        const title = g.lane?.label ?? 'Songs';
        const songs = g.items.filter((r) => !isLaneVideo(r.item)).length;
        const owned = g.items.filter((r) => ownedInEntityLane(r.item)).length;
        const count = laneCountLabel(g.items.map((r) => r.item));
        const subtitle = owned ? `${count} · ${owned === songs ? 'all in your library' : `${songs - owned} not in your library yet`}` : count;
        return (
          <section key={g.key || 'songs'} aria-labelledby={hid}>
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <h3 id={hid} className="truncate font-display text-[19px] leading-tight md:text-[22px]">{title}</h3>
                <p className="mt-0.5 text-[12.5px] text-mist">{subtitle}</p>
              </div>
              {g.items.some((r) => isQueueable(r.item)) && <PlayAll label={title} onClick={() => play(g)} />}
            </div>
            {/* Phones: a swipeable row that bleeds to the screen edges; wider screens: a grid. */}
            <div className="scrollbar-none -mx-4 mt-3 flex snap-x snap-mandatory scroll-px-4 gap-3.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-x-4 sm:gap-y-6 sm:overflow-visible sm:px-0 lg:grid-cols-5">
              {g.items.map((r, i) => (
                <Tile key={r.item.id} rec={r} onOpen={onOpen} onWatch={onWatch} onPlay={() => play(g, i)} className="sm:!w-auto" />
              ))}
            </div>
          </section>
        );
      })}
      {others.length > 0 && (
        <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {others.map((r) => (
            <MediaCard key={r.item.id} item={r.item} explanation={r.explanation} score={r.score} trajectoryStep={r.trajectoryStep} source="chat" />
          ))}
        </div>
      )}
    </div>
  );
}
