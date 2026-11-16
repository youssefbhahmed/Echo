// @vitest-environment jsdom
// Player behaviour with the network mocked: preview vs Spotify mode, no-device recovery, skip feedback.
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
    spotifyConfigured: true,
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

import { PlayerProvider, usePlayQueue } from '../../../src/lib/player';
import { MiniPlayer } from '../../../src/components/MiniPlayer';

// Synthetic songs with 22-character ids.
const song = (n: number): AnalyzedItem => {
  const id = `S${String(n).padStart(21, '0')}`;
  return {
    id: `spotify:track:${id}`, category: 'music', kind: 'track', provider: 'spotify', externalId: id, title: `Song ${n}`, creators: [`Artist ${n}`],
    genres: [], tags: [], externalUrl: `https://open.spotify.com/track/${id}`, embed: { type: 'spotify', uri: `spotify:track:${id}`, kind: 'track' }, concepts: {}, durationSec: 200,
  };
};
const songs = [song(1), song(2), song(3)];

function Harness() {
  const { playQueue } = usePlayQueue();
  return <button type="button" onClick={() => playQueue(songs, 0)}>start</button>;
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

MotionGlobalConfig.skipAnimations = true;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  h.spotifyConfigured = true;
  h.status = { connected: true, scope: 'user-modify-playback-state', since: null, canPlay: true };
  h.api.profile.mockImplementation(async () => ({ account: {}, model: {}, insights: {}, stats: {}, server: { providers: [{ id: 'spotify', label: 'Spotify', configured: h.spotifyConfigured, categories: ['music'] }], ai: { enabled: false }, embeddings: false } }));
  h.api.spotifyStatus.mockImplementation(async () => h.status);
  h.api.spotifyPlay.mockResolvedValue({ ok: true, device: null });
  h.api.spotifyControl.mockResolvedValue({ ok: true });
  h.api.feedback.mockResolvedValue({ ok: true, learned: [], interactionCount: 1, library: null });
  h.api.spotifyPlayerState.mockImplementation(async () => ({ isPlaying: true, progressMs: 2000, durationMs: 200_000, device: { id: 'd1', name: 'My phone', type: 'Smartphone' }, track: { uri: songs[0].embed!.type === 'spotify' ? (songs[0].embed as { uri: string }).uri : '', id: 'x', name: 'Song 1', artists: ['Artist 1'], artworkUrl: null } }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('player modes', () => {
  it('Spotify mode: sends the queue URIs with the start offset and shows ECHO’s own bar', async () => {
    mount();
    await flush(10);
    fireEvent.click(screen.getByText('start'));
    await flush(10);
    expect(h.api.spotifyPlay).toHaveBeenCalledWith({ uris: songs.map((s) => (s.embed as { uri: string }).uri), offset: 0 });
    expect(screen.queryByTitle(/Now playing/)).toBeNull(); // no embed
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    await flush(1600); // confirmation poll
    expect(screen.getByText('on My phone')).toBeInTheDocument();
    // The poll saw song 1 playing → one 'play'.
    expect(h.api.feedback).toHaveBeenCalledWith(expect.objectContaining({ itemId: songs[0].id, type: 'play' }));
    // Next within 30 s → one 'skip' for song 1, and Spotify skips.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await flush(10);
    expect(h.api.spotifyControl).toHaveBeenCalledWith('next');
    expect(h.api.feedback).toHaveBeenCalledWith(expect.objectContaining({ itemId: songs[0].id, type: 'skip' }));
  });

  it('no device: offers to open Spotify, then retries once when the app becomes visible again', async () => {
    h.api.spotifyPlay.mockRejectedValueOnce(new h.ApiError(409, 'Open Spotify to start playing.', 'no_device'));
    mount();
    await flush(10);
    fireEvent.click(screen.getByText('start'));
    await flush(10);
    expect(screen.getByText('Open Spotify to start playing')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Spotify/ })).toHaveAttribute('href', `https://open.spotify.com/track/${songs[0].externalId}`);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush(10);
    expect(h.api.spotifyPlay).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Open Spotify to start playing')).toBeNull();
  });

  it('Premium required: falls back to the preview embed with a one-line note', async () => {
    h.api.spotifyPlay.mockRejectedValueOnce(new h.ApiError(403, 'Full songs need Spotify Premium.', 'premium_required'));
    mount();
    await flush(10);
    fireEvent.click(screen.getByText('start'));
    await flush(10);
    expect(screen.getByText(/Full songs need Spotify Premium/)).toBeInTheDocument();
    expect(screen.getByTitle('Now playing: Song 1')).toBeInTheDocument();
  });

  it('connected without playback permission: preview plus a Reconnect banner', async () => {
    h.status = { connected: true, scope: 'playlist-modify-private', since: null, canPlay: false };
    mount();
    await flush(10);
    fireEvent.click(screen.getByText('start'));
    await flush(10);
    expect(h.api.spotifyPlay).not.toHaveBeenCalled();
    expect(screen.getByTitle('Now playing: Song 1')).toBeInTheDocument();
    expect(screen.getByText('Full songs need one more Spotify permission')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('not connected: preview labelled with a Connect button', async () => {
    h.status = { connected: false, scope: null, since: null };
    mount();
    await flush(10);
    fireEvent.click(screen.getByText('start'));
    await flush(10);
    expect(screen.getByTitle('Now playing: Song 1')).toBeInTheDocument();
    expect(screen.getByText('Preview · Connect Spotify for full songs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('Spotify not configured on the server: the plain embed player, as before', async () => {
    h.spotifyConfigured = false;
    mount();
    await flush(10);
    fireEvent.click(screen.getByText('start'));
    await flush(10);
    expect(h.api.spotifyStatus).not.toHaveBeenCalled();
    expect(screen.getByTitle('Now playing: Song 1')).toBeInTheDocument();
    expect(screen.queryByText(/Connect Spotify/)).toBeNull();
  });
});
