// Feed sessions: a re-fetch of the feed on screen returns that same feed.
// The phone PWA refetches on focus/remount (e.g. after listening in the Spotify app for a while). The
// server used to exclude every song shown in the last 3 days and fold that count into the seed, so
// each refetch swapped the whole feed. A feed session remembers, per user and per feed filters, the
// effective seed and the moment the feed was first served (`createdAt`): a re-fetch with the same
// client seed reuses both, and "recently shown" is measured as of `createdAt`, so the feed's own
// songs never exclude themselves. The Refresh button sends seed + 1 → a new session.
// Pure functions; storage is injected by the server (provider_cache).

export interface FeedSession {
  /** The app's refresh counter for these filters (restarts at 0 when the app restarts). */
  clientSeed: number;
  /** Effective seed: lane rotation, curator brief cache key and retrieval plan. */
  seed: number;
  /** When the feed was first served (ms): recently-shown music is measured as of this moment. */
  createdAt: number;
  /** Last time it was served (ms): a session idle for FEED_IDLE_MS ends. */
  lastAt: number;
}

/** A feed nobody re-fetched for 2 hours is over; none lives longer than 12 hours. */
export const FEED_IDLE_MS = 2 * 3600_000;
export const FEED_MAX_MS = 12 * 3600_000;

/** Everything the app's feed query depends on except the refresh seed (and the exclusions that come with it). */
export function feedFilterKey(body: { query?: string; categories?: string[]; moods?: string[]; exploration?: number; limit?: number; mix?: Partial<Record<string, number>> }): string {
  const mix = Object.entries(body.mix ?? {}).filter(([, v]) => typeof v === 'number').sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    (body.query ?? '').trim().toLowerCase(),
    [...(body.categories ?? [])].sort(),
    [...(body.moods ?? [])].sort(),
    typeof body.exploration === 'number' ? Math.round(body.exploration * 100) : null,
    body.limit ?? null,
    mix,
  ]);
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** A stored session read back from the cache (untrusted shape), or null. */
export function parseFeedSession(x: unknown): FeedSession | null {
  const s = x as Partial<FeedSession> | null | undefined;
  return s && isNum(s.clientSeed) && isNum(s.seed) && isNum(s.createdAt) && isNum(s.lastAt) ? { clientSeed: s.clientSeed, seed: s.seed, createdAt: s.createdAt, lastAt: s.lastAt } : null;
}

/** The stored session when this request re-fetches it (same client seed, not idle, not too old), else null. */
export function reusableSession(stored: FeedSession | null | undefined, clientSeed: number, now: number): FeedSession | null {
  if (!stored || stored.clientSeed !== clientSeed) return null;
  if (now - stored.lastAt > FEED_IDLE_MS || now - stored.createdAt > FEED_MAX_MS || stored.createdAt > now) return null;
  return stored;
}

/**
 * Seed of a new feed: the app restarts its counter at 0, so how much music was served lately is mixed
 * in to put every new feed on a fresh lane rotation and curator brief (same seed + same history = same feed).
 */
export function freshFeedSeed(clientSeed: number, shownCount: number): number {
  return (clientSeed + shownCount * 7919) | 0;
}
