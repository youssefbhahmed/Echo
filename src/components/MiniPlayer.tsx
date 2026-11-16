// Persistent mini-player around Spotify's official embed: one tap plays, then it auto-advances through the queue.
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ListMusic, SkipBack, SkipForward, X } from 'lucide-react';
import { usePlayer } from '../lib/player';
import { useFeedback } from '../hooks/data';
import { displayTitle } from '../lib/meta';

interface PlaybackState { isPaused: boolean; isBuffering: boolean; duration: number; position: number }

function embedUrl(uri: string): string {
  const [, type, id] = uri.split(':');
  // Same URL shape Spotify's own iFrame API uses, so the embed reports playback via postMessage.
  return `https://open.spotify.com/embed/${type}/${id}?utm_source=iframe-api&theme=0`;
}

export function MiniPlayer() {
  const { current, queue, index, next, prev, close, jump } = usePlayer();
  const frame = useRef<HTMLIFrameElement>(null);
  const [showQueue, setShowQueue] = useState(false);
  const feedback = useFeedback();
  const live = useRef({ next, current, feedback });
  live.current = { next, current, feedback };
  const track = useRef({ id: '', advanced: false, played: false, lastPos: 0 });
  const uri = current?.embed?.type === 'spotify' ? current.embed.uri : null;

  useEffect(() => {
    track.current = { id: current?.id ?? '', advanced: false, played: false, lastPos: 0 };
  }, [current?.id]);

  // Talk to the official Spotify embed directly (the same messages its iFrame API exchanges),
  // which avoids loading Spotify's eval-based script under our strict CSP.
  useEffect(() => {
    const send = (msg: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(msg, 'https://open.spotify.com');
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== 'https://open.spotify.com' || e.source !== frame.current?.contentWindow) return;
      const data = e.data as { type?: string; payload?: PlaybackState };
      if (data?.type === 'ready') {
        send({ command: 'load_complete_ack' });
        send({ command: 'play' });
        return;
      }
      if (data?.type !== 'playback_update' || !data.payload) return;
      const { isPaused, duration, position } = data.payload;
      const t = track.current;
      const { current: item, feedback: fb, next: goNext } = live.current;
      if (!isPaused && position > 0 && !t.played && item) {
        t.played = true;
        fb.mutate({ item, type: 'play', source: 'feed' });
      }
      // Finished (full track, or the 30-second preview when not signed in to Spotify): next, once.
      const ended = duration > 0 && ((isPaused && (position >= duration - 1500 || (position === 0 && t.lastPos >= duration - 2500))) || (!isPaused && position >= duration - 250));
      t.lastPos = position;
      if (ended && t.played && !t.advanced) {
        t.advanced = true;
        setTimeout(goNext, 350);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <AnimatePresence>
      {current && (
        <motion.div
          initial={{ y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 40, opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+4.4rem)] z-40 md:right-6 md:bottom-5 md:left-[17.5rem]"
          role="region"
          aria-label="Music player"
        >
          <AnimatePresence>
            {showQueue && (
              <motion.ol initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} className="scrollbar-none mb-2 max-h-72 overflow-y-auto rounded-2xl border border-line bg-ink-3/95 p-1.5 shadow-2xl backdrop-blur-xl">
                {queue.map((q, i) => (
                  <li key={q.id}>
                    <button type="button" onClick={() => jump(i)} className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm hover:bg-white/[0.06] ${i === index ? 'text-ember' : 'text-bone/90'}`}>
                      <span className="w-5 text-right text-xs text-dim tabular-nums">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate">{displayTitle(q)} <span className="text-dim">· {q.creators[0]}</span></span>
                    </button>
                  </li>
                ))}
              </motion.ol>
            )}
          </AnimatePresence>
          <div className="flex items-center gap-1.5 rounded-[20px] border border-line bg-ink-2/95 p-1.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl">
            <div className="min-w-0 flex-1 overflow-hidden rounded-[14px]">
              {uri && (
                <iframe
                  ref={frame}
                  title={`Now playing: ${current ? displayTitle(current) : ''}`}
                  src={embedUrl(uri)}
                  className="block h-20 w-full"
                  allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                />
              )}
            </div>
            <div className="flex shrink-0 items-center">
              <button type="button" onClick={prev} disabled={index === 0} aria-label="Previous" className="grid h-11 w-10 place-items-center rounded-full text-mist hover:text-bone disabled:opacity-30"><SkipBack className="h-[18px] w-[18px]" /></button>
              <button type="button" onClick={next} disabled={index >= queue.length - 1} aria-label="Next" className="grid h-11 w-10 place-items-center rounded-full text-mist hover:text-bone disabled:opacity-30"><SkipForward className="h-[18px] w-[18px]" /></button>
              <button type="button" onClick={() => setShowQueue((s) => !s)} aria-expanded={showQueue} aria-label={`Queue, ${index + 1} of ${queue.length}`} className="hidden h-11 items-center gap-1 rounded-full px-2 text-xs text-mist hover:text-bone sm:inline-flex"><ListMusic className="h-[18px] w-[18px]" /> {index + 1}/{queue.length}</button>
              <button type="button" onClick={close} aria-label="Close player" className="grid h-11 w-10 place-items-center rounded-full text-dim hover:text-bone"><X className="h-[18px] w-[18px]" /></button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
