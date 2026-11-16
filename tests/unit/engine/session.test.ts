import { FEED_IDLE_MS, FEED_MAX_MS, feedFilterKey, freshFeedSeed, parseFeedSession, reusableSession, type FeedSession } from '@shared/engine/session.ts';
import { planMusic } from '@shared/engine/curator.ts';
import { emptyProfile } from '@shared/engine/profile.ts';

const T0 = Date.UTC(2026, 10, 16, 18);

describe('feed sessions (re-fetching the feed on screen returns that feed)', () => {
  const body = { categories: ['music', 'youtube'], moods: ['melancholic'], exploration: 0.4, limit: 48, mix: { music: 2 } };

  it('keys a feed by its filters, not by the refresh seed or the exclusions sent with it', () => {
    const k = feedFilterKey(body);
    expect(feedFilterKey({ ...body, ...{ seed: 3, exclude: ['spotify:track:x'] } } as typeof body)).toBe(k);
    expect(feedFilterKey({ ...body, categories: ['youtube', 'music'], moods: ['melancholic'] })).toBe(k);
    expect(feedFilterKey({ ...body, moods: ['calm'] })).not.toBe(k);
    expect(feedFilterKey({ ...body, categories: ['music'] })).not.toBe(k);
    expect(feedFilterKey({ ...body, exploration: 0.7 })).not.toBe(k);
  });

  it('reuses the stored session only for the same client seed while it is fresh', () => {
    const s: FeedSession = { clientSeed: 0, seed: 7919 * 12, createdAt: T0, lastAt: T0 };
    // Back from the Spotify app 20 minutes later: same feed (same effective seed, same "shown as of").
    expect(reusableSession(s, 0, T0 + 20 * 60_000)).toEqual(s);
    // Refresh button (seed + 1): a new feed.
    expect(reusableSession(s, 1, T0 + 60_000)).toBeNull();
    // Idle for longer than the window, or older than the hard cap: a new feed.
    expect(reusableSession(s, 0, T0 + FEED_IDLE_MS + 1)).toBeNull();
    expect(reusableSession({ ...s, lastAt: T0 + FEED_MAX_MS - 60_000 }, 0, T0 + FEED_MAX_MS + 1)).toBeNull();
    expect(reusableSession(null, 0, T0)).toBeNull();
  });

  it('validates what comes back from storage', () => {
    expect(parseFeedSession({ clientSeed: 1, seed: 2, createdAt: 3, lastAt: 4 })).toEqual({ clientSeed: 1, seed: 2, createdAt: 3, lastAt: 4 });
    expect(parseFeedSession({ clientSeed: '1', seed: 2, createdAt: 3, lastAt: 4 })).toBeNull();
    expect(parseFeedSession(undefined)).toBeNull();
  });

  it('a reused session gives the same lanes and brief; a new feed gets a fresh rotation', () => {
    const lane = (id: string, share: number) => ({ id, label: id, share, descriptors: ['x'], era: { from: 2005, to: 2026 }, energy: 0.6, danceability: 0.7, valence: 0.4, popularity: { p25: 30, p50: 50, p75: 70 }, regional: false, genres: [] });
    const profile = { ...emptyProfile(), music: { tracks: 1, distinctArtists: 1, styles: [], recentStyles: [], decades: [], languages: [], mood: { valence: 0.4, energy: 0.6, danceability: 0.7, topQuadrant: '' }, importedAt: '', lanes: [lane('hiphop-rnb', 0.3), lane('rock-metal', 0.25), lane('melodic-house', 0.2), lane('edm', 0.15), lane('afro-latin', 0.1)] } };
    const first = freshFeedSeed(0, 24);
    const session: FeedSession = { clientSeed: 0, seed: first, createdAt: T0, lastAt: T0 };
    // 24 more songs were shown since (other tabs, refreshes): a re-fetch still uses the stored seed.
    const reused = reusableSession(session, 0, T0 + 30 * 60_000)!.seed;
    const plan = (seed: number) => planMusic(profile, { hasQuery: false, seed, total: 10 })!.order;
    expect(plan(reused)).toEqual(plan(first));
    const seeds = new Set(Array.from({ length: 8 }, (_, i) => plan(freshFeedSeed(0, 24 + 12 * i)).join(',')));
    expect(seeds.size).toBeGreaterThan(1);
  });
});
