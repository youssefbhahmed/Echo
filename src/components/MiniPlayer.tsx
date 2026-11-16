// Persistent mini player.
//  • Spotify mode (Premium connected): ECHO's own now-playing bar, remote-controlling the user's Spotify app.
//  • Preview mode: Spotify's official embed — one tap plays, then it auto-advances through the queue.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ExternalLink, Laptop, ListMusic, LoaderCircle, Music2, Pause, Play, SkipBack, SkipForward, Smartphone, Speaker, X } from 'lucide-react';
import { usePlayer } from '../lib/player';
import { useFeedback } from '../hooks/data';
import { displayTitle } from '../lib/meta';
import { formatClock, livePosition, spotifyUri } from '../lib/playback';

interface PlaybackState { isPaused: boolean; isBuffering: boolean; duration: number; position: number }

function embedUrl(uri: string): string {
  const [, type, id] = uri.split(':');
  // Same URL shape Spotify's own iFrame API uses, so the embed reports playback via postMessage.
  return `https://open.spotify.com/embed/${type}/${id}?utm_source=iframe-api&theme=0`;
}

/** Publish the bar's height as --echo-player-h so pages and toasts can keep clear of it. */
function usePlayerHeight(ref: RefObject<HTMLElement | null>, open: boolean) {
  useEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!open || !el) {
      root.style.removeProperty('--echo-player-h');
      return;
    }
    const set = () => root.style.setProperty('--echo-player-h', `${Math.ceil(el.getBoundingClientRect().height) + 8}px`);
    set();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty('--echo-player-h');
    };
  }, [ref, open]);
}

/** A clock that ticks while `interval` is set (drives the progress bar between polls). */
function useNow(interval: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!interval) return;
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return now;
}

export function MiniPlayer() {
  const { current, mode } = usePlayer();
  const card = useRef<HTMLDivElement>(null);
  const [showQueue, setShowQueue] = useState(false);
  const open = !!current;
  usePlayerHeight(card, open);
  useEffect(() => {
    if (!open) setShowQueue(false);
  }, [open]);

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
          <AnimatePresence>{showQueue && <QueueList key="queue" onDone={() => setShowQueue(false)} />}</AnimatePresence>
          <NoDeviceSheet />
          <div ref={card} className="overflow-hidden rounded-[20px] border border-line bg-ink-2/95 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl">
            <NoteRow />
            {mode === 'spotify' ? (
              <SpotifyBar queueOpen={showQueue} onQueue={() => setShowQueue((s) => !s)} />
            ) : (
              <PreviewBar queueOpen={showQueue} onQueue={() => setShowQueue((s) => !s)} />
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function QueueList({ onDone }: { onDone: () => void }) {
  const { queue, index, jump, close } = usePlayer();
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} className="mb-2 overflow-hidden rounded-2xl border border-line bg-ink-3/95 shadow-2xl backdrop-blur-xl">
      <div className="flex items-center justify-between gap-2 border-b border-line py-1 pr-1 pl-3.5">
        <p className="text-[11px] font-semibold tracking-[0.14em] text-mist uppercase">Queue · {index + 1} of {queue.length}</p>
        <button type="button" onClick={() => { onDone(); close(); }} className="inline-flex h-11 items-center gap-1.5 rounded-full px-3 text-[13px] text-mist hover:text-bone">
          <X className="h-4 w-4" aria-hidden /> Close player
        </button>
      </div>
      <ol className="scrollbar-none max-h-[min(18rem,45dvh)] overflow-y-auto p-1.5">
        {queue.map((q, i) => (
          <li key={q.id}>
            <button type="button" onClick={() => jump(i)} aria-current={i === index ? 'true' : undefined} className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm hover:bg-white/[0.06] ${i === index ? 'text-ember' : 'text-bone/90'}`}>
              <span className="w-5 shrink-0 text-right text-xs text-dim tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{displayTitle(q)} <span className="text-dim">· {q.creators[0]}</span></span>
            </button>
          </li>
        ))}
      </ol>
    </motion.div>
  );
}

/** Spotify isn't open anywhere: one tap opens the song in the Spotify app; coming back starts the queue. */
function NoDeviceSheet() {
  const { notice, retry, dismissNotice, busy } = usePlayer();
  return (
    <AnimatePresence>
      {notice?.kind === 'no_device' && (
        <motion.div key="no-device" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} role="alert" className="mb-2 rounded-2xl border border-line bg-ink-3/95 p-3.5 shadow-2xl backdrop-blur-xl">
          <div className="flex items-start gap-3">
            <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-tide" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-bone">Open Spotify to start playing</p>
              <p className="mt-0.5 text-[13px] leading-snug text-mist">Spotify isn’t open on any of your devices yet. Open it, then come back: ECHO starts the music.</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <a href={notice.url} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center gap-1.5 rounded-full bg-tide px-4 text-[14px] font-semibold text-ink transition-transform active:scale-95">
                  Open Spotify <ExternalLink className="h-4 w-4" aria-hidden />
                </a>
                <button type="button" onClick={retry} disabled={busy} className="inline-flex h-11 items-center rounded-full border border-line px-4 text-[14px] text-bone hover:border-white/20 disabled:opacity-50">
                  {busy ? 'Trying…' : 'Try again'}
                </button>
              </div>
            </div>
            <button type="button" onClick={dismissNotice} aria-label="Dismiss" className="-mt-1.5 -mr-1.5 grid h-11 w-11 shrink-0 place-items-center rounded-full text-dim hover:text-bone">
              <X className="h-4 w-4" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** One compact line at the top of the bar: preview label, permission banner, or a short notice. */
function NoteRow() {
  const { mode, notice, spotify, connect, dismissNotice } = usePlayer();
  let text: string | null = null;
  let action: { label: string; onClick: () => void } | null = null;
  let dismiss = false;
  let warn = false;
  if (notice && notice.kind !== 'no_device') {
    text = notice.kind === 'premium_required' ? 'Full songs need Spotify Premium · playing previews' : notice.message;
    dismiss = true;
    warn = notice.kind === 'error';
  } else if (spotify.needsReconnect) {
    text = 'Full songs need one more Spotify permission';
    action = { label: 'Reconnect', onClick: connect };
  } else if (mode === 'preview' && spotify.configured && spotify.known && !spotify.connected) {
    text = 'Preview · Connect Spotify for full songs';
    action = { label: 'Connect', onClick: connect };
  }
  if (!text) return null;
  return (
    <div className="flex items-center gap-2 border-b border-line py-1 pr-1 pl-3.5 text-[12.5px]" role="status">
      <p className={`min-w-0 flex-1 truncate ${warn ? 'text-amber' : 'text-mist'}`}>{text}</p>
      {action && (
        <button type="button" onClick={action.onClick} className="inline-flex h-9 shrink-0 items-center rounded-full bg-tide px-3.5 text-[12.5px] font-semibold text-ink transition-transform active:scale-95">
          {action.label}
        </button>
      )}
      {dismiss && (
        <button type="button" onClick={dismissNotice} aria-label="Dismiss" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-dim hover:text-bone">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function Art({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <span className="grid h-[52px] w-[52px] shrink-0 place-items-center overflow-hidden rounded-[10px] bg-ink-3 ring-1 ring-white/[0.06] ring-inset">
      {url && !failed ? <img src={url} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} /> : <Music2 className="h-5 w-5 text-tide" aria-hidden />}
    </span>
  );
}

function DeviceIcon({ type }: { type?: string }) {
  const t = (type ?? '').toLowerCase();
  const Icon = t === 'smartphone' || t === 'tablet' ? Smartphone : t === 'computer' ? Laptop : Speaker;
  return <Icon className="h-3 w-3 shrink-0" aria-hidden />;
}

/** ECHO's own now-playing bar for full songs playing in the user's Spotify app. */
function SpotifyBar({ queueOpen, onQueue }: { queueOpen: boolean; onQueue: () => void }) {
  const { current, queue, index, remote, busy, next, prev, togglePlay, close } = usePlayer();
  const playing = !!remote?.isPlaying;
  const now = useNow(playing ? 1000 : null);
  // When Spotify is playing something outside ECHO's queue, show what is really playing.
  const foreign = remote?.track && remote.track.uri !== spotifyUri(current) ? remote.track : null;
  const title = foreign?.name || (current ? displayTitle(current) : '');
  const artist = foreign ? foreign.artists.join(', ') : (current?.creators.slice(0, 2).join(', ') ?? '');
  const artwork = foreign?.artworkUrl ?? current?.artworkUrl ?? remote?.track?.artworkUrl ?? null;
  const duration = remote?.durationMs || (current?.durationSec ?? 0) * 1000;
  const position = remote ? livePosition({ ...remote, durationMs: duration }, now) : 0;
  const pct = duration ? Math.min(100, (position / duration) * 100) : 0;
  const device = remote?.device ?? null;
  const where = device ? `on ${device.name}` : busy ? 'Connecting to Spotify…' : 'Spotify';
  return (
    <div className="relative flex items-center gap-2 p-1.5 pb-2">
      <button type="button" onClick={onQueue} aria-expanded={queueOpen} aria-label={`${title}${artist ? `, ${artist}` : ''}. ${where}. Queue, ${index + 1} of ${queue.length}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-[14px] p-0.5 text-left">
        <Art url={artwork} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] leading-tight font-semibold text-bone">{title}</span>
          <span className="mt-0.5 block truncate text-[12.5px] leading-tight text-mist">{artist}</span>
          <span className="mt-1 flex min-w-0 items-center gap-1 text-[11.5px] leading-tight text-tide">
            <DeviceIcon type={device?.type} />
            <span className="truncate">{where}</span>
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center">
        <button type="button" onClick={prev} disabled={index === 0} aria-label="Previous" className="grid h-11 w-11 place-items-center rounded-full text-mist hover:text-bone disabled:opacity-30"><SkipBack className="h-5 w-5" /></button>
        <button type="button" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} className="grid h-12 w-12 place-items-center rounded-full bg-bone text-ink transition-transform active:scale-95">
          {busy ? <LoaderCircle className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden /> : playing ? <Pause className="h-5 w-5 fill-current" aria-hidden /> : <Play className="ml-0.5 h-5 w-5 fill-current" aria-hidden />}
        </button>
        <button type="button" onClick={next} disabled={index >= queue.length - 1} aria-label="Next" className="grid h-11 w-11 place-items-center rounded-full text-mist hover:text-bone disabled:opacity-30"><SkipForward className="h-5 w-5" /></button>
        <button type="button" onClick={close} aria-label="Close player" className="hidden h-11 w-11 place-items-center rounded-full text-dim hover:text-bone sm:grid"><X className="h-[18px] w-[18px]" /></button>
      </div>
      <div
        className="pointer-events-none absolute inset-x-3 bottom-0.5 h-[3px] overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-label="Song position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration / 1000)}
        aria-valuenow={Math.round(position / 1000)}
        aria-valuetext={`${formatClock(position)} of ${formatClock(duration)}`}
      >
        <div className="h-full rounded-full bg-ember transition-[width] duration-1000 ease-linear motion-reduce:transition-none" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Spotify's official embed (previews unless signed in to Spotify in this browser). */
function PreviewBar({ queueOpen, onQueue }: { queueOpen: boolean; onQueue: () => void }) {
  const { current, queue, index, next, prev, close, advance, previewProgress } = usePlayer();
  const frame = useRef<HTMLIFrameElement>(null);
  const feedback = useFeedback();
  const live = useRef({ advance, current, feedback, previewProgress });
  live.current = { advance, current, feedback, previewProgress };
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
      const { current: item, feedback: fb, advance: goNext, previewProgress: report } = live.current;
      if (item) report(item, !isPaused, position);
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
    <div className="flex items-center gap-1.5 p-1.5">
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
        <button type="button" onClick={onQueue} aria-expanded={queueOpen} aria-label={`Queue, ${index + 1} of ${queue.length}`} className="hidden h-11 items-center gap-1 rounded-full px-2 text-xs text-mist hover:text-bone sm:inline-flex"><ListMusic className="h-[18px] w-[18px]" /> {index + 1}/{queue.length}</button>
        <button type="button" onClick={close} aria-label="Close player" className="grid h-11 w-10 place-items-center rounded-full text-dim hover:text-bone"><X className="h-[18px] w-[18px]" /></button>
      </div>
    </div>
  );
}
