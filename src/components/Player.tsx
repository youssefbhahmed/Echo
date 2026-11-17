// Official embedded players only: YouTube IFrame Player API and Spotify Embed.
import { useEffect, useId, useRef, useState } from 'react';
import type { Embed } from '@shared/types.ts';
import { claimSound, onSoundClaimed } from '../lib/media';

/** The parts of a YouTube IFrame API player ECHO uses. */
export interface YTPlayerLike {
  destroy(): void;
  playVideo?(): void;
  pauseVideo?(): void;
}

declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: Record<string, unknown>) => YTPlayerLike };
    onYouTubeIframeAPIReady?: () => void;
  }
}

/** YT.PlayerState values (https://developers.google.com/youtube/iframe_api_reference#Playback_status). */
export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

/** The IFrame API script must load within this long (a blocked or stalled script fails, and the next player tries again). */
export const YT_API_TIMEOUT_MS = 10_000;
/** No playback this long after the player is ready: the browser refused to start it (phones need a tap inside the player). */
export const YT_START_HINT_MS = 3000;

let ytReady: Promise<void> | null = null;
export function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (!ytReady) {
    ytReady = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      const fail = (why: string) => {
        clearTimeout(timer);
        s.remove();
        reject(new Error(why));
      };
      const timer = setTimeout(() => fail('The YouTube player took too long to load.'), YT_API_TIMEOUT_MS);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timer);
        prev?.();
        resolve();
      };
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => fail('The YouTube player could not load.');
      document.head.appendChild(s);
    }).catch((e) => {
      // Not cached: the next player tries again (a flaky network shouldn't break every video until a reload).
      ytReady = null;
      throw e;
    });
  }
  return ytReady;
}

/**
 * The YouTube player (videos, trailers, and the live sessions of music lanes, which always play here, on
 * their own: never in the music queue). It starts on the tap that opened it; when the browser refuses
 * that (phones without a tap inside the player, or YouTube's autoplay block), a note under the player —
 * never over it — says to tap it. It claims the sound when it plays (ECHO's music and any other YouTube
 * player pause) and pauses when another player starts or the page is hidden (no background playback).
 * At least 200 × 200 px, YouTube's minimum player size.
 */
export function YouTubePlayer({ videoId, title, onPlay }: { videoId: string; title: string; onPlay?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const onPlayRef = useRef(onPlay);
  onPlayRef.current = onPlay;
  const owner = `youtube:${useId()}`;
  const [error, setError] = useState<string | null>(null);
  const [needsTap, setNeedsTap] = useState(false);
  useEffect(() => {
    let player: YTPlayerLike | null = null;
    let cancelled = false;
    let started = false;
    let hint: ReturnType<typeof setTimeout> | undefined;
    setError(null);
    setNeedsTap(false);
    const offClaim = onSoundClaimed((o) => {
      if (o !== owner) player?.pauseVideo?.();
    });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') player?.pauseVideo?.();
    };
    document.addEventListener('visibilitychange', onVisibility);
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
          onReady: () => {
            hint = setTimeout(() => !started && !cancelled && setNeedsTap(true), YT_START_HINT_MS);
          },
          onAutoplayBlocked: () => setNeedsTap(true),
          onStateChange: (e: { data: number }) => {
            if (e.data !== YT_STATE.PLAYING) return;
            started = true;
            clearTimeout(hint);
            setNeedsTap(false);
            claimSound(owner);
            onPlayRef.current?.();
          },
          onError: (e: { data: number }) => {
            clearTimeout(hint);
            setNeedsTap(false);
            setError(e.data === 101 || e.data === 150 ? 'This video can’t play inside ECHO (embedding or regional restrictions).' : 'This video could not be played here.');
          },
        },
      });
    }).catch((e: Error) => {
      if (!cancelled) setError(e.message || 'The YouTube player could not load.');
    });
    return () => {
      cancelled = true;
      clearTimeout(hint);
      offClaim();
      document.removeEventListener('visibilitychange', onVisibility);
      player?.destroy();
    };
  }, [videoId, owner]);
  if (error)
    return (
      <div role="status" className="grid aspect-video min-h-[200px] place-items-center rounded-2xl bg-ink-3 p-6 text-center text-sm text-mist">
        <div>
          {error}{' '}
          <a className="text-ember underline" href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer">
            Watch on YouTube
          </a>
        </div>
      </div>
    );
  return (
    <div>
      <div ref={host} title={title} className="aspect-video min-h-[200px] w-full min-w-[200px] overflow-hidden rounded-2xl bg-black [&_iframe]:h-full [&_iframe]:w-full" />
      {needsTap && (
        <p role="status" className="mt-2 text-center text-[13px] text-mist">
          Tap the video to start it.{' '}
          <a className="text-ember underline" href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer">Open on YouTube</a>
        </p>
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
