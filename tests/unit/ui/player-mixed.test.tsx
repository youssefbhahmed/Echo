// @vitest-environment jsdom
// A music lane holds Spotify songs and YouTube live sessions, but they never share a player: the queue is
// songs only (Spotify Connect gets the lane's whole run of songs, so it plays on with the screen locked),
// and a session plays in its own YouTube player. One sound at a time: a YouTube player that starts pauses
// the music (even a Spotify play still on its way), and music that starts pauses YouTube. The YouTube
// player copes with a script that never loads and with a browser that refuses to start it.
// Network and the YouTube IFrame API are mocked; synthetic items only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionGlobalConfig } from 'motion/react';
import type { AnalyzedItem, Recommendation } from '@shared/types.ts';

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
      library: vi.fn(),
    },
  };
});

vi.mock('../../../src/lib/api', () => ({ api: h.api, ApiError: h.ApiError }));
vi.mock('../../../src/lib/auth', () => ({ useAuth: () => ({ session: { access_token: 't' }, loading: false }) }));
vi.mock('../../../src/lib/supabase', () => ({ supabase: {}, functionsUrl: '', supabaseConfigured: true }));
vi.mock('../../../src/hooks/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/hooks/data')>()),
  useLibraryMap: () => new Map(),
}));

import { isQueueable, PlayerProvider, usePlayQueue } from '../../../src/lib/player';
import { MiniPlayer } from '../../../src/components/MiniPlayer';
import { YouTubePlayer, YT_API_TIMEOUT_MS, YT_START_HINT_MS } from '../../../src/components/Player';
import { DetailSheet } from '../../../src/components/DetailSheet';

// A fake YouTube IFrame API: records each player and lets the test drive its state.
interface FakeOpts { videoId: string; playerVars: Record<string, unknown>; events: { onStateChange: (e: { data: number }) => void; onReady?: (e: unknown) => void; onAutoplayBlocked?: () => void; onError?: (e: { data: number }) => void } }
const yt = { players: [] as FakePlayer[], created: vi.fn<(videoId: string) => void>() };
class FakePlayer {
  destroyed = false;
  pauseVideo = vi.fn();
  playVideo = vi.fn();
  constructor(_el: HTMLElement, public opts: FakeOpts) {
    yt.created(opts.videoId);
    yt.players.push(this);
  }
  destroy() {
    this.destroyed = true;
  }
}
const playing = (p: FakePlayer) => act(async () => p.opts.events.onStateChange({ data: 1 }));

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
// As the ranker lays a lane out: a session after the 2nd song.
const LANE_ITEMS = [s1, s2, video, s3];

function Harness() {
  const { playQueue } = usePlayQueue();
  return <button type="button" onClick={() => playQueue(LANE_ITEMS, 0)}>Play all</button>;
}

function mount(extra?: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <PlayerProvider>
        <Harness />
        <MiniPlayer />
        {extra}
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
const playingFrom = (track: AnalyzedItem, fromMs: number, isPlaying = true) => {
  const t0 = Date.now();
  return () => ({
    isPlaying, progressMs: Math.min(200_000, fromMs + (isPlaying ? Date.now() - t0 : 0)), durationMs: 200_000, shuffle: false,
    device: { id: 'd1', name: 'My phone', type: 'Smartphone' }, track: { uri: uri(track), id: 'x', name: track.title, artists: track.creators, artworkUrl: null },
  });
};

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = async (v: DocumentVisibilityState) => {
  visibility = v;
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

MotionGlobalConfig.skipAnimations = true;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  (window as unknown as { YT: unknown }).YT = { Player: FakePlayer };
  yt.players = [];
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  h.status = { connected: true, scope: 'user-modify-playback-state', since: null, canPlay: true };
  h.api.profile.mockImplementation(async () => ({ account: {}, model: {}, insights: {}, stats: {}, server: { providers: [{ id: 'spotify', label: 'Spotify', configured: true, categories: ['music'] }], ai: { enabled: false }, embeddings: false } }));
  h.api.spotifyStatus.mockImplementation(async () => h.status);
  h.api.spotifyPlay.mockResolvedValue({ ok: true, device: null });
  h.api.spotifyControl.mockResolvedValue({ ok: true });
  h.api.feedback.mockResolvedValue({ ok: true, learned: [], interactionCount: 1, library: null });
  h.api.library.mockResolvedValue([]);
  remote = playingFrom(s1, 2000);
  h.api.spotifyPlayerState.mockImplementation(async () => remote());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  delete (window as unknown as { YT?: unknown }).YT;
  document.head.querySelectorAll('script[src*="iframe_api"]').forEach((s) => s.remove());
});

describe('a lane’s songs and its sessions never share a player', () => {
  it('lane videos are not queueable: the queue is Spotify songs only', () => {
    expect(isQueueable(video)).toBe(false);
    expect(isQueueable({ ...video, category: 'youtube', id: 'youtube:video:VIDEO000001' })).toBe(false);
    expect(isQueueable(s1)).toBe(true);
  });

  it('Spotify mode: "Play all" hands Spotify every song of the lane; with the screen locked it plays on, and nothing pauses it', async () => {
    mount();
    await flush(10);
    fireEvent.click(screen.getByText('Play all'));
    await flush(10);
    // The whole run of songs, the session skipped (before: only the 2 songs up to the session).
    expect(h.api.spotifyPlay).toHaveBeenCalledTimes(1);
    expect(h.api.spotifyPlay).toHaveBeenLastCalledWith({ uris: [uri(s1), uri(s2), uri(s3)], offset: 0 });
    expect(screen.getByRole('button', { name: /Queue, 1 of 3$/ })).toBeInTheDocument();
    await flush(1600); // confirmation poll: song 1 plays
    // The phone is locked: ECHO is hidden, Spotify plays the lane by itself, then its own autoplay.
    await setVisibility('hidden');
    const polls = h.api.spotifyPlayerState.mock.calls.length;
    remote = playingFrom(s2, 190_000);
    await flush(200_000);
    remote = playingFrom(s3, 1000);
    await flush(200_000);
    remote = playingFrom(song(99), 1000);
    await flush(200_000);
    expect(h.api.spotifyPlayerState).toHaveBeenCalledTimes(polls); // no polling while hidden
    // Back in ECHO: nothing stale acts on Spotify (no pause, no video started, no new play).
    await setVisibility('visible');
    await flush(5000);
    expect(h.api.spotifyControl).not.toHaveBeenCalledWith('pause');
    expect(yt.created).not.toHaveBeenCalled();
    expect(h.api.spotifyPlay).toHaveBeenCalledTimes(1);
  });

  it('preview mode: the embed gets the songs only', async () => {
    h.status = { connected: false, scope: null, since: null };
    mount();
    await flush(10);
    fireEvent.click(screen.getByText('Play all'));
    await flush(10);
    expect(h.api.spotifyPlay).not.toHaveBeenCalled();
    expect(screen.getByTitle('Now playing: Song 1')).toBeInTheDocument();
    expect(yt.created).not.toHaveBeenCalled();
  });

  it('a session opened from its tile plays in its own player (the detail sheet), not in the queue; its Play button works', async () => {
    const rec: Recommendation = { item: video, score: { total: 0.5 } as Recommendation['score'], explanation: { text: 'Live.', reasons: [{ kind: 'profile', detail: 'Live.' }], matchedConcepts: [] } };
    const onClose = vi.fn();
    mount(<DetailSheet rec={rec} onClose={onClose} />);
    await flush(10);
    // Where it was filmed, in place of the bare kind.
    expect(screen.getByText('Live at Tiny Desk')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await flush(10);
    expect(yt.created).toHaveBeenCalledWith('VIDEO000001');
    expect(screen.getByRole('button', { name: 'Close player' })).toBeInTheDocument();
    // Never queued: no mini player, no Spotify call.
    expect(screen.queryByRole('region', { name: 'Music player' })).toBeNull();
    expect(h.api.spotifyPlay).not.toHaveBeenCalled();
  });
});

describe('one sound at a time', () => {
  it('Spotify mode: a YouTube player that starts pauses Spotify; music that starts pauses YouTube', async () => {
    mount(<YouTubePlayer videoId="VIDEO000001" title="Session" />);
    await flush(10);
    fireEvent.click(screen.getByText('Play all'));
    await flush(1600);
    await playing(yt.players[0]);
    expect(h.api.spotifyControl).toHaveBeenCalledWith('pause');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument(); // the bar shows Spotify paused
    // Back to the music (resume in the bar): the video pauses.
    remote = playingFrom(s1, 5000, false);
    await flush(5000);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await flush(10);
    expect(h.api.spotifyControl).toHaveBeenCalledWith('resume');
    expect(yt.players[0].pauseVideo).toHaveBeenCalled();
  });

  it('Spotify mode: a play still on its way when a video starts is paused once it lands (no two sounds)', async () => {
    const log: string[] = [];
    let land!: () => void;
    h.api.spotifyPlay.mockImplementation(() => {
      log.push('play-sent');
      return new Promise((resolve) => {
        land = () => {
          log.push('play-landed');
          resolve({ ok: true, device: null });
        };
      });
    });
    h.api.spotifyControl.mockImplementation(async (cmd: string) => {
      log.push(cmd);
      return { ok: true };
    });
    mount(<YouTubePlayer videoId="VIDEO000001" title="Session" />);
    await flush(10);
    fireEvent.click(screen.getByText('Play all'));
    await flush(500);
    await playing(yt.players[0]);
    await act(async () => land());
    await flush(10);
    expect(log).toEqual(['play-sent', 'pause', 'play-landed', 'pause']);
    // It stays paused: no poll flips the bar back to playing for the late play.
    await flush(3000);
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('preview mode: a YouTube player that starts pauses the Spotify embed', async () => {
    h.status = { connected: false, scope: null, since: null };
    mount(<YouTubePlayer videoId="VIDEO000001" title="Session" />);
    await flush(10);
    fireEvent.click(screen.getByText('Play all'));
    await flush(10);
    const frame = screen.getByTitle('Now playing: Song 1') as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => undefined);
    await playing(yt.players[0]);
    expect(post).toHaveBeenCalledWith({ command: 'pause' }, 'https://open.spotify.com');
  });

  it('two YouTube players never play at once; a hidden page pauses the video (no background playback)', async () => {
    render(<><YouTubePlayer videoId="AAAAAAAAAAA" title="One" /><YouTubePlayer videoId="BBBBBBBBBBB" title="Two" /></>);
    await flush(10);
    const [one, two] = yt.players;
    await playing(one);
    two.pauseVideo.mockClear();
    await playing(two);
    expect(one.pauseVideo).toHaveBeenCalledTimes(1);
    expect(two.pauseVideo).not.toHaveBeenCalled();
    await setVisibility('hidden');
    expect(two.pauseVideo).toHaveBeenCalledTimes(1);
  });
});

describe('the YouTube player when things go wrong', () => {
  it('the browser refuses to start it (phones need a tap inside the player): a note under it says to tap, until it plays', async () => {
    render(<YouTubePlayer videoId="VIDEO000001" title="Session" />);
    await flush(10);
    const p = yt.players[0];
    await act(async () => p.opts.events.onReady?.({ target: p }));
    await flush(YT_START_HINT_MS - 100);
    expect(screen.queryByText(/Tap the video to start it/)).toBeNull();
    await flush(200);
    expect(screen.getByText(/Tap the video to start it/)).toBeInTheDocument();
    await playing(p);
    expect(screen.queryByText(/Tap the video to start it/)).toBeNull();
    // YouTube's own signal shows it at once.
    cleanup();
    render(<YouTubePlayer videoId="VIDEO000002" title="Session" />);
    await flush(10);
    await act(async () => yt.players[1].opts.events.onAutoplayBlocked?.());
    expect(screen.getByText(/Tap the video to start it/)).toBeInTheDocument();
  });

  it('meets YouTube’s 200 × 200 px minimum player size', async () => {
    render(<YouTubePlayer videoId="VIDEO000001" title="Session" />);
    await flush(10);
    expect(screen.getByTitle('Session').className).toMatch(/min-h-\[200px\].*min-w-\[200px\]/);
  });

  it('the IFrame API script fails to load: a way to watch on YouTube, and the next player tries again', async () => {
    delete (window as unknown as { YT?: unknown }).YT;
    render(<YouTubePlayer videoId="VIDEO000001" title="Session" />);
    await flush(10);
    const script = document.head.querySelector('script[src*="iframe_api"]')!;
    expect(script).not.toBeNull();
    await act(async () => {
      script.dispatchEvent(new Event('error'));
    });
    await flush(10);
    expect(screen.getByText(/The YouTube player could not load/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Watch on YouTube' })).toHaveAttribute('href', 'https://www.youtube.com/watch?v=VIDEO000001');
    cleanup();
    render(<YouTubePlayer videoId="VIDEO000002" title="Session" />);
    await flush(10);
    const again = document.head.querySelectorAll('script[src*="iframe_api"]');
    expect(again).toHaveLength(1); // a fresh attempt
    await act(async () => {
      again[0].dispatchEvent(new Event('error'));
    });
  });

  it('the IFrame API script never answers: it gives up after a while instead of hanging forever', async () => {
    delete (window as unknown as { YT?: unknown }).YT;
    render(<YouTubePlayer videoId="VIDEO000001" title="Session" />);
    await flush(YT_API_TIMEOUT_MS + 10);
    expect(screen.getByText(/took too long to load/)).toBeInTheDocument();
  });
});
