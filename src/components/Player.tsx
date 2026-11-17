// Official embedded players only: YouTube IFrame Player API and Spotify Embed.
import { useEffect, useRef, useState } from 'react';
import type { Embed } from '@shared/types.ts';

/** The parts of a YouTube IFrame API player ECHO uses. */
export interface YTPlayerLike {
  destroy(): void;
  getCurrentTime?(): number;
  getDuration?(): number;
  playVideo?(): void;
}

declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: Record<string, unknown>) => YTPlayerLike };
    onYouTubeIframeAPIReady?: () => void;
  }
}

/** YT.PlayerState values (https://developers.google.com/youtube/iframe_api_reference#Playback_status). */
export const YT_STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

let ytReady: Promise<void> | null = null;
export function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (!ytReady) {
    ytReady = new Promise((resolve) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve();
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      document.head.appendChild(s);
    });
  }
  return ytReady;
}

export function YouTubePlayer({ videoId, title, onPlay }: { videoId: string; title: string; onPlay?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const onPlayRef = useRef(onPlay);
  onPlayRef.current = onPlay;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let player: YTPlayerLike | null = null;
    let cancelled = false;
    loadYouTubeApi().then(() => {
      if (cancelled || !host.current || !window.YT) return;
      const el = document.createElement('div');
      host.current.appendChild(el);
      player = new window.YT.Player(el, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onStateChange: (e: { data: number }) => {
            if (e.data === 1) onPlayRef.current?.();
          },
          onError: (e: { data: number }) => {
            setError(e.data === 101 || e.data === 150 ? 'This video can’t play inside ECHO (embedding or regional restrictions).' : 'This video could not be played here.');
          },
        },
      });
    });
    return () => {
      cancelled = true;
      player?.destroy();
    };
  }, [videoId]);
  if (error)
    return (
      <div className="grid aspect-video place-items-center rounded-2xl bg-ink-3 p-6 text-center text-sm text-mist">
        <div>
          {error}{' '}
          <a className="text-ember underline" href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer">
            Watch on YouTube
          </a>
        </div>
      </div>
    );
  return <div ref={host} title={title} className="aspect-video w-full overflow-hidden rounded-2xl bg-black [&_iframe]:h-full [&_iframe]:w-full" />;
}

/**
 * The mini player's YouTube player for a video in a mixed music queue: autoplays inline (playsinline, so
 * phones don't jump to fullscreen), reports playback every 2 s while it plays, and says when the video
 * ended (YT.PlayerState.ENDED) so the queue moves on. A video that can't play here moves on by itself.
 */
export function QueueVideoPlayer({ videoId, title, onProgress, onEnded }: { videoId: string; title: string; onProgress?: (playing: boolean, positionMs: number, durationMs?: number) => void; onEnded?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef({ onProgress, onEnded });
  cb.current = { onProgress, onEnded };
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let player: YTPlayerLike | null = null;
    let cancelled = false;
    let tick: ReturnType<typeof setInterval> | undefined;
    let skip: ReturnType<typeof setTimeout> | undefined;
    setError(null);
    const report = (playing: boolean) => {
      const pos = Math.max(0, Math.round((player?.getCurrentTime?.() ?? 0) * 1000));
      const dur = player?.getDuration?.();
      cb.current.onProgress?.(playing, pos, dur ? Math.round(dur * 1000) : undefined);
    };
    loadYouTubeApi().then(() => {
      if (cancelled || !host.current || !window.YT) return;
      const el = document.createElement('div');
      host.current.appendChild(el);
      player = new window.YT.Player(el, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: (e: { target?: YTPlayerLike }) => e.target?.playVideo?.(),
          onStateChange: (e: { data: number }) => {
            clearInterval(tick);
            if (e.data === YT_STATE.PLAYING) {
              report(true);
              tick = setInterval(() => report(true), 2000);
            } else if (e.data === YT_STATE.PAUSED) report(false);
            else if (e.data === YT_STATE.ENDED) cb.current.onEnded?.();
          },
          onError: (e: { data: number }) => {
            setError(e.data === 101 || e.data === 150 ? 'This video can’t play inside ECHO.' : 'This video could not be played here.');
            skip = setTimeout(() => cb.current.onEnded?.(), 4000);
          },
        },
      });
    });
    return () => {
      cancelled = true;
      clearInterval(tick);
      clearTimeout(skip);
      player?.destroy();
    };
  }, [videoId]);
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-[12px] bg-black">
      <div ref={host} title={title} className="absolute inset-0 [&_iframe]:h-full [&_iframe]:w-full" />
      {error && (
        <div role="status" className="absolute inset-0 grid place-items-center bg-ink-3 p-2 text-center text-[11.5px] leading-snug text-mist">
          <span>
            {error}{' '}
            <a className="text-ember underline" href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer">YouTube</a>
          </span>
        </div>
      )}
    </div>
  );
}

export function EmbedPlayer({ embed, title, onPlay }: { embed: Embed; title: string; onPlay?: () => void }) {
  const onPlayRef = useRef(onPlay);
  onPlayRef.current = onPlay;
  useEffect(() => {
    // Embeds other than YouTube don't expose play events; opening the player counts as a play.
    if (embed.type !== 'youtube') onPlayRef.current?.();
  }, [embed]);
  switch (embed.type) {
    case 'youtube':
      return <YouTubePlayer videoId={embed.videoId} title={title} onPlay={onPlay} />;
    case 'spotify': {
      const [, type, id] = embed.uri.split(':');
      const tall = type === 'album' || type === 'playlist' || type === 'artist' || type === 'show';
      return (
        <iframe
          title={`Spotify: ${title}`}
          src={`https://open.spotify.com/embed/${type}/${id}?utm_source=echo&theme=0`}
          className="w-full rounded-2xl"
          style={{ height: tall ? 352 : 152 }}
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          loading="lazy"
        />
      );
    }
  }
}
