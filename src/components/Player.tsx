// Official embedded players only: YouTube IFrame Player API, Spotify Embed, Apple Podcasts embed,
// and plain <audio> for publisher-provided podcast audio / licensed 30-second previews.
import { useEffect, useRef, useState } from 'react';
import type { Embed } from '@shared/types.ts';

declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: Record<string, unknown>) => { destroy(): void } };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytReady: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
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
    let player: { destroy(): void } | null = null;
    let cancelled = false;
    loadYouTubeApi().then(() => {
      if (cancelled || !host.current || !window.YT) return;
      const el = document.createElement('div');
      host.current.appendChild(el);
      player = new window.YT.Player(el, {
        videoId,
        host: 'https://www.youtube-nocookie.com',
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onStateChange: (e: { data: number }) => {
            if (e.data === 1) onPlayRef.current?.();
          },
          onError: (e: { data: number }) => {
            setError(e.data === 101 || e.data === 150 ? 'The uploader does not allow playback outside YouTube.' : 'This video could not be played here.');
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
    case 'applepodcast': {
      const src = `https://embed.podcasts.apple.com/us/podcast/id${embed.collectionId}${embed.episodeId ? `?i=${embed.episodeId}&theme=dark` : '?theme=dark'}`;
      return (
        <iframe
          title={`Apple Podcasts: ${title}`}
          src={src}
          className="w-full overflow-hidden rounded-2xl"
          style={{ height: embed.episodeId ? 175 : 450 }}
          sandbox="allow-forms allow-popups allow-same-origin allow-scripts allow-storage-access-by-user-activation allow-top-navigation-by-user-activation"
          allow="autoplay *; encrypted-media *; clipboard-write"
          loading="lazy"
        />
      );
    }
    case 'audio':
      return (
        <div className="rounded-2xl bg-ink-3 p-3">
          <audio controls autoPlay preload="none" src={embed.previewUrl} className="w-full" aria-label={title} />
          {embed.label && <p className="mt-2 text-xs text-dim">{embed.label}</p>}
        </div>
      );
  }
}
