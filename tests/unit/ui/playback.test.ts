import { describe, expect, it } from 'vitest';
import { canPlayFrom, classifyPlayerError, formatClock, isQuickSkip, ListenTracker, livePosition, openInSpotifyUrl, queueWindow, SKIP_WINDOW_MS, spotifyUri } from '../../../src/lib/playback';

// Synthetic 22-character Spotify ids.
const sid = (n: number) => `T${String(n).padStart(21, '0')}`;
const track = (n: number) => ({ id: `spotify:track:${sid(n)}`, embed: { type: 'spotify', uri: `spotify:track:${sid(n)}` } });

describe('spotifyUri / openInSpotifyUrl', () => {
  it('accepts track and episode URIs only', () => {
    expect(spotifyUri(track(1))).toBe(`spotify:track:${sid(1)}`);
    expect(spotifyUri({ id: 'e', embed: { type: 'spotify', uri: `spotify:episode:${sid(2)}` } })).toBe(`spotify:episode:${sid(2)}`);
    expect(spotifyUri({ id: 'a', embed: { type: 'spotify', uri: `spotify:album:${sid(3)}` } })).toBeNull();
    expect(spotifyUri({ id: 'y', embed: { type: 'youtube' } })).toBeNull();
    expect(spotifyUri({ id: 'bad', embed: { type: 'spotify', uri: 'spotify:track:short' } })).toBeNull();
    expect(spotifyUri(null)).toBeNull();
  });

  it('builds the universal link that opens the Spotify app', () => {
    expect(openInSpotifyUrl(track(4))).toBe(`https://open.spotify.com/track/${sid(4)}`);
    expect(openInSpotifyUrl({ id: 'x', embed: null })).toBe('https://open.spotify.com/');
  });
});

describe('queueWindow', () => {
  it('sends the whole queue and the start offset when it fits', () => {
    const q = [track(1), track(2), track(3)];
    expect(queueWindow(q, 1)).toEqual({ uris: q.map((t) => t.embed.uri), offset: 1, begin: 0, end: 2 });
  });

  it('skips items without a playable URI and keeps the offset aligned', () => {
    const q = [track(1), { id: 'album', embed: { type: 'spotify', uri: `spotify:album:${sid(9)}` } }, track(3)];
    const w = queueWindow(q, 2)!;
    expect(w.uris).toEqual([track(1).embed.uri, track(3).embed.uri]);
    expect(w.uris[w.offset]).toBe(track(3).embed.uri);
  });

  it('starts at the next playable item when the chosen one is not playable', () => {
    const q = [{ id: 'x', embed: null }, track(2)];
    const w = queueWindow(q, 0)!;
    expect(w.uris[w.offset]).toBe(track(2).embed.uri);
  });

  it('caps long queues at Spotify’s limit around the start', () => {
    const q = Array.from({ length: 150 }, (_, i) => track(i));
    const w = queueWindow(q, 120, 100)!;
    expect(w.uris).toHaveLength(100);
    expect(w.uris[w.offset]).toBe(track(120).embed.uri);
    expect(w.begin).toBeLessThanOrEqual(120);
    expect(w.end).toBeGreaterThanOrEqual(120);
  });

  it('returns null when nothing is playable', () => {
    expect(queueWindow([{ id: 'x', embed: null }], 0)).toBeNull();
  });
});

describe('skip within 30 seconds', () => {
  it('uses the real position when known, wall-clock time otherwise', () => {
    expect(isQuickSkip(undefined, 1000)).toBe(false);
    expect(isQuickSkip(0, 10_000)).toBe(true);
    expect(isQuickSkip(0, SKIP_WINDOW_MS)).toBe(false);
    // Paused at 12s for a minute: still a quick skip by position.
    expect(isQuickSkip(0, 72_000, 12_000)).toBe(true);
    expect(isQuickSkip(0, 5_000, 45_000)).toBe(false);
  });

  it('records one play per item and one skip per item', () => {
    const t = new ListenTracker<{ id: string }>();
    const a = { id: 'a' };
    const b = { id: 'b' };
    expect(t.started(a, 0)).toBe(true);
    expect(t.started(a, 0)).toBe(false); // repeated polls
    expect(t.playing).toBe(a);
    expect(t.left(10_000)).toBe(a); // Next after 10 s → skip
    expect(t.playing).toBeNull();
    expect(t.started(a, 20_000)).toBe(false); // played again: no second 'play'
    expect(t.left(25_000)).toBeNull(); // and no second 'skip'
    expect(t.started(b, 30_000)).toBe(true);
    expect(t.left(30_000 + 45_000)).toBeNull(); // listened 45 s → not a skip
  });

  it('never counts a skip for a song that never started', () => {
    const t = new ListenTracker<{ id: string }>();
    expect(t.left(1000)).toBeNull();
    t.started({ id: 'a' }, 0);
    t.stop(); // player closed / automatic advance
    expect(t.left(1000)).toBeNull();
  });

  it('tracks the most recent song when playback moves on by itself', () => {
    const t = new ListenTracker<{ id: string }>();
    t.started({ id: 'a' }, 0);
    t.started({ id: 'b' }, 200_000); // Spotify advanced to the next song
    expect(t.left(205_000)?.id).toBe('b');
  });
});

describe('classifyPlayerError', () => {
  it('maps server codes to player reactions', () => {
    expect(classifyPlayerError('no_device')).toBe('no_device');
    expect(classifyPlayerError('premium_required')).toBe('premium_required');
    expect(classifyPlayerError('reconnect')).toBe('reconnect');
    expect(classifyPlayerError('spotify_not_connected')).toBe('not_connected');
    expect(classifyPlayerError('rate_limited')).toBe('rate_limited');
    expect(classifyPlayerError('restricted')).toBe('restricted');
    expect(classifyPlayerError('network', 0)).toBe('network');
    expect(classifyPlayerError(undefined, 0)).toBe('network');
    expect(classifyPlayerError('spotify_error', 502)).toBe('other');
  });
});

describe('canPlayFrom', () => {
  it('needs a connected account with playback control', () => {
    expect(canPlayFrom(null)).toBe(false);
    expect(canPlayFrom({ connected: false, canPlay: true })).toBe(false);
    expect(canPlayFrom({ connected: true, canPlay: true })).toBe(true);
    expect(canPlayFrom({ connected: true, scope: 'playlist-modify-private' })).toBe(false);
    expect(canPlayFrom({ connected: true, scope: 'playlist-modify-private user-modify-playback-state' })).toBe(true);
  });
});

describe('position', () => {
  it('advances locally while playing and stops at the end', () => {
    expect(livePosition({ isPlaying: true, progressMs: 1000, durationMs: 200_000, at: 0 }, 4000)).toBe(5000);
    expect(livePosition({ isPlaying: false, progressMs: 1000, durationMs: 200_000, at: 0 }, 4000)).toBe(1000);
    expect(livePosition({ isPlaying: true, progressMs: 199_000, durationMs: 200_000, at: 0 }, 9000)).toBe(200_000);
    expect(formatClock(83_500)).toBe('1:23');
  });
});
