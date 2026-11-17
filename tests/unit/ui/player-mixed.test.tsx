// @vitest-environment jsdom
// A mixed music lane in the player: Spotify songs and a YouTube live session play in order. Spotify mode
// pauses Spotify before the video and starts the next songs when it ends; preview mode swaps the Spotify
// embed and the YouTube player. Play/skip feedback covers the video. Network and YouTube API mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionGlobalConfig } from 'motion/react';
import type { AnalyzedItem } from '@shared/types.ts';

const h = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(public status: number, message: string, public code?: string, public retryAfter?: number) {
      super(message);
    }
  }
  return {
    ApiError,
    status: { connected: true, scope: 'user-modify-playback-state', since: null, canPlay: true } as Record<string, unknown>,
    api: {
      profile: vi.fn(),
      spotifyStatus: vi.fn(),
      spotifyPlay: vi.fn(),
      spotifyPlayerState: vi.fn(),
      spotifyControl: vi.fn(),
      spotifyAuthorize: vi.fn(),
      feedback: vi.fn(),
    },
  };
});

vi.mock('../../../src/lib/api', () => ({ api: h.api, ApiError: h.ApiError }));
vi.mock('../../../src/lib/auth', () => ({ useAuth: () => ({ session: { access_token: 't' }, loading: false }) }));
vi.mock('../../../src/lib/supabase', () => ({ supabase: {}, functionsUrl: '', supabaseConfigured: true }));

import { isQueueable, PlayerProvider, usePlayQueue } from '../../../src/lib/player';
import { MiniPlayer } from '../../../src/components/MiniPlayer';

// A fake YouTube IFrame API: records each player and lets the test drive its state.
interface FakeYT { opts: { videoId: string; playerVars: Record<string, unknown>; events: { onStateChange: (e: { data: number }) => void; onReady?: (e: unknown) => void } }; time: number; destroyed: boolean }
const yt = { players: [] as FakeYT[], created: vi.fn<(videoId: string) => void>() };
class FakePlayer {
  time = 0;
  destroyed = false;
  constructor(_el: HTMLElement, public opts: FakeYT['opts']) {
    yt.created(opts.videoId);
    yt.players.push(this as unknown as FakeYT);
  }
  destroy() {
    this.destroyed = true;
  }
  getCurrentTime() {
    return this.time;
  }
  getDuration() {
    return 900;
  }
  playVideo() {}
}

const LANE = { id: 'hiphop-rnb', label: 'Hip-hop & R&B' };
const song = (n: number): AnalyzedItem => {
  const id = `M${String(n).padStart(21, '0')}`;
  return {
    id: `spotify:track:${id}`, category: 'music', kind: 'track', provider: 'spotify', externalId: id, title: `Song ${n}`, creators: [`Artist ${n}`], genres: [], tags: [],
    externalUrl: `https://open.spotify.com/track/${id}`, embed: { type: 'spotify', uri: `spotify:track:${id}`, kind: 'track' }, concepts: {}, durationSec: 200, metadata: { lane: LANE },
  };
};
const video: AnalyzedItem = {
  id: 'youtube:music:VIDEO000001', category: 'music', kind: 'video', provider: 'youtube', externalId: 'VIDEO000001', title: 'Session Artist: Tiny Desk Concert', creators: ['Session Artist'], genres: [], tags: [],
  externalUrl: 'https://www.youtube.com/watch?v=VIDEO000001', embed: { type: 'youtube', videoId: 'VIDEO000001' }, concepts: {}, durationSec: 900,
  metadata: { lane: LANE, video: true, videoKind: 'live', session: { channel: 'tinydesk', venue: 'Tiny Desk', prep: 'at', artist: 'Session Artist', label: 'Tiny Desk Concert' } },
};
const uri = (i: AnalyzedItem) => (i.embed as { uri: string }).uri;
const [s1, s2, s3] = [song(1), song(2), song(3)];
let queue: AnalyzedItem[] = [s1, s2, video, s3];

function Harness() {
  const { playQueue } = usePlayQueue();
  return <button type="button" onClick={() => playQueue(queue, 0)}>start</button>;
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <PlayerProvider>
        <Harness />
        <MiniPlayer />
      </PlayerProvider>
    </QueryClientProvider>,
  );
}

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** Spotify's player state: `track` playing from `fromMs`, advancing with the (fake) clock. */
let remote: () => Record<string, unknown> = () => ({});
const playingFrom = (track: AnalyzedItem, fromMs: number, playing = true) => {
  const t0 = Date.now();
  return () => ({
    isPlaying: playing, progressMs: Math.min(200_000, fromMs + (playing ? Date.now() - t0 : 0)), durationMs: 200_000, shuffle: false,
    device: { id: 'd1', name: 'My phone', type: 'Smartphone' }, track: { uri: uri(track), id: 'x', name: track.title, artists: track.creators, artworkUrl: null },
  });
};

MotionGlobalConfig.skipAnimations = true;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  (window as unknown as { YT: unknown }).YT = { Player: FakePlayer };
  yt.players = [];
  queue = [s1, s2, video, s3];
  h.status = { connected: true, scope: 'user-modify-playback-state', since: null, canPlay: true };
  h.api.profile.mockImplementation(async () => ({ account: {}, model: {}, insights: {}, stats: {}, server: { providers: [{ id: 'spotify', label: 'Spotify', configured: true, categories: ['music'] }], ai: { enabled: false }, embeddings: false } }));
  h.api.spotifyStatus.mockImplementation(async () => h.status);
  h.api.spotifyPlay.mockResolvedValue({ ok: true, device: null });
  h.api.spotifyControl.mockResolvedValue({ ok: true });
  h.api.feedback.mockResolvedValue({ ok: true, learned: [], interactionCount: 1, library: null });
  remote = playingFrom(s1, 2000);
  h.api.spotifyPlayerState.mockImplementation(async () => remote());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  delete (window as unknown as { YT?: unknown }).YT;
});

const feedbackFor = (id: string, type: string) => h.api.feedback.mock.calls.filter(([b]) => b.itemId === id && b.type === type);

describe('mixed lanes in the queue', () => {
  it('lane videos are queueable; videos outside music lanes are not', () => {
    expect(isQueueable(video)).toBe(true);
    expect(isQueueable({ ...video, category: 'youtube', id: 'youtube:video:VIDEO000001' })).toBe(false);
    expect(isQueueable(s1)).toBe(true);
  });

  it('Spotify mode: Spotify gets only the songs before the video, pauses before it, and the next songs start when it ends', async () => {
    mount();
    await flush(10);
    fireEvent.click(screen.getByText('start'));
    await flush(10);
    // The run up to the video only: Spotify never plays past it.
    expect(h.api.spotifyPlay).toHaveBeenCalledTimes(1);
    expect(h.api.spotifyPlay).toHaveBeenLastCalledWith({ uris: [uri(s1), uri(s2)], offset: 0 });
    await flush(1600); // confirmation poll: song 1 plays
    // Spotify moves on to song 2, the run's last song, near its end.
    remote = playingFrom(s2, 190_000);
    await flush(4000);
    expect(screen.getByText('Song 2')).toBeInTheDocument();
    expect(yt.created).not.toHaveBeenCalled();
    // Just before song 2 ends: Spotify is paused, then the session plays in the mini player.
    await flush(10_000);
    expect(h.api.spotifyControl).toHaveBeenCalledWith('pause');
    expect(yt.created).toHaveBeenCalledWith('VIDEO000001');
    expect(h.api.spotifyControl.mock.invocationCallOrder[0]).toBeLessThan(yt.created.mock.invocationCallOrder[0]);
    expect(screen.getByText('Live at Tiny Desk')).toBeInTheDocument();
    expect(screen.getByTitle('Now playing: Tiny Desk Concert')).toBeInTheDocument();
    // Song 2 played to its end: not a skip.
    expect(feedbackFor(s2.id, 'skip')).toHaveLength(0);
    // Inline, autoplaying, mobile-safe.
    expect(yt.players[0].opts.playerVars).toMatchObject({ autoplay: 1, playsinline: 1 });
    // The video plays → one 'play'; no Spotify polling meanwhile.
    const polls = h.api.spotifyPlayerState.mock.calls.length;
    await act(async () => {
      yt.players[0].time = 3;
      yt.players[0].opts.events.onStateChange({ data: 1 });
    });
    await flush(60_000);
    expect(feedbackFor(video.id, 'play')).toHaveLength(1);
    expect(h.api.spotifyPlayerState).toHaveBeenCalledTimes(polls);
    // The video ends (YT.PlayerState.ENDED) → the songs after it start on Spotify.
    await act(async () => {
      yt.players[0].opts.events.onStateChange({ data: 0 });
    });
    await flush(10);
    expect(h.api.spotifyPlay).toHaveBeenCalledTimes(2);
    expect(h.api.spotifyPlay).toHaveBeenLastCalledWith({ uris: [uri(s3)], offset: 0, shuffle: false });
    expect(yt.players[0].destroyed).toBe(true);
    expect(feedbackFor(video.id, 'skip')).toHaveLength(0);
  });

  it('Spotify mode: when Spotify’s autoplay takes over after the run, it is paused and the video plays', async () => {
    mount();
    await flush(10);
    fireEvent.click(screen.getByText('start'));
    await flush(10);
    await flush(1600);
    remote = playingFrom(s2, 2000);
    await flush(4000); // song 2 seen playing
    // A song ECHO never queued (Spotify's autoplay) is playing now.
    const other = song(99);
    remote = playingFrom(other, 1000);
    await flush(4000);
    expect(h.api.spotifyControl).toHaveBeenCalledWith('pause');
    expect(yt.created).toHaveBeenCalledWith('VIDEO000001');
    expect(h.api.spotifyPlay).toHaveBeenCalledTimes(1);
  });

  it('Spotify mode: tapping Next onto the video pauses Spotify first; a quick Next counts as a skip of the song', async () => {
    queue = [s1, video, s3];
    mount();
    await flush(10);
    fireEvent.click(screen.getByText('start'));
    await flush(10);
    await flush(1600);
    expect(h.api.spotifyPlay).toHaveBeenLastCalledWith({ uris: [uri(s1)], offset: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await flush(10);
    expect(h.api.spotifyControl).toHaveBeenCalledWith('pause');
    expect(h.api.spotifyControl).not.toHaveBeenCalledWith('next');
    expect(h.api.spotifyControl.mock.invocationCallOrder[0]).toBeLessThan(yt.created.mock.invocationCallOrder[0]);
    expect(feedbackFor(s1.id, 'skip')).toHaveLength(1);
    // Previous goes back to the song on Spotify.
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await flush(10);
    expect(h.api.spotifyPlay).toHaveBeenLastCalledWith({ uris: [uri(s1)], offset: 0, shuffle: false });
  });

  it('preview mode: the YouTube player and the Spotify embed swap; Next on a video just played is a skip', async () => {
    h.status = { connected: false, scope: null, since: null };
    queue = [video, s1, s2];
    mount();
    await flush(10);
    fireEvent.click(screen.getByText('start'));
    await flush(10);
    expect(h.api.spotifyPlay).not.toHaveBeenCalled();
    expect(yt.created).toHaveBeenCalledWith('VIDEO000001');
    expect(screen.queryByTitle(/Now playing: Song/)).toBeNull();
    // The preview label isn't shown over a video.
    expect(screen.queryByText('Preview · Connect Spotify for full songs')).toBeNull();
    // It ends → the Spotify embed takes over with the next song.
    await act(async () => {
      yt.players[0].opts.events.onStateChange({ data: 1 });
      yt.players[0].opts.events.onStateChange({ data: 0 });
    });
    await flush(10);
    expect(screen.getByTitle('Now playing: Song 1')).toBeInTheDocument();
    expect(feedbackFor(video.id, 'play')).toHaveLength(1);
    expect(feedbackFor(video.id, 'skip')).toHaveLength(0);
  });

  it('a video skipped within 30 seconds is a skip (once)', async () => {
    h.status = { connected: false, scope: null, since: null };
    queue = [video, s1];
    mount();
    await flush(10);
    fireEvent.click(screen.getByText('start'));
    await flush(10);
    await act(async () => {
      yt.players[0].time = 5;
      yt.players[0].opts.events.onStateChange({ data: 1 });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await flush(10);
    expect(feedbackFor(video.id, 'skip')).toHaveLength(1);
    expect(screen.getByTitle('Now playing: Song 1')).toBeInTheDocument();
  });
});
