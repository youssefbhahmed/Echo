// Pure playback helpers (no React, no network): Spotify URIs, queue windows, listen tracking
// for play/skip feedback, and player error classification. Unit-tested in tests/unit/ui.

/** Queue items only need their id and (optional) Spotify embed. */
export interface QueueItemLike {
  id: string;
  embed?: { type: string; uri?: string } | null;
}

const PLAYABLE_URI = /^spotify:(track|episode):[A-Za-z0-9]{22}$/;

/** The item's Spotify track/episode URI, when it is one Spotify Connect can play. */
export function spotifyUri(item: QueueItemLike | null | undefined): string | null {
  const uri = item?.embed?.type === 'spotify' ? item.embed.uri : undefined;
  return uri && PLAYABLE_URI.test(uri) ? uri : null;
}

/** Universal link for the item: on phones it opens the Spotify app (and wakes it as a playback device). */
export function openInSpotifyUrl(item: QueueItemLike | null | undefined): string {
  const uri = item?.embed?.type === 'spotify' ? item.embed.uri : undefined;
  const [, type, id] = (uri ?? '').split(':');
  return type && id ? `https://open.spotify.com/${type}/${id}` : 'https://open.spotify.com/';
}

/**
 * The URIs to hand Spotify for a queue started at `start` (at most `max`, Spotify's limit), and the
 * offset of the start item within them. Items without a playable URI are left out; when the start
 * item has none, the next playable one starts instead. `begin`/`end` are queue indexes covered.
 */
export function queueWindow(items: QueueItemLike[], start: number, max = 100): { uris: string[]; offset: number; begin: number; end: number } | null {
  const playable = items.map((it, i) => ({ i, uri: spotifyUri(it) })).filter((x): x is { i: number; uri: string } => !!x.uri);
  if (!playable.length) return null;
  let pos = playable.findIndex((x) => x.i >= start);
  if (pos < 0) pos = playable.length - 1;
  const from = Math.max(0, Math.min(pos - Math.floor(max / 10), playable.length - max));
  const slice = playable.slice(from, from + max);
  return { uris: slice.map((x) => x.uri), offset: pos - from, begin: slice[0].i, end: slice[slice.length - 1].i };
}

/** Full-song playback is allowed when the linked account granted playback control. */
export function canPlayFrom(s: { connected: boolean; scope?: string | null; canPlay?: boolean } | null | undefined): boolean {
  if (!s?.connected) return false;
  return s.canPlay ?? (s.scope ?? '').split(/\s+/).includes('user-modify-playback-state');
}

/** Moving on within this long after a song starts counts as a skip. */
export const SKIP_WINDOW_MS = 30_000;

/** True when leaving a song now is a quick skip. `progressMs` (the real position) wins over wall-clock time. */
export function isQuickSkip(startedAt: number | undefined, now: number, progressMs?: number | null): boolean {
  if (startedAt === undefined) return false;
  const elapsed = typeof progressMs === 'number' && progressMs >= 0 ? progressMs : now - startedAt;
  return elapsed < SKIP_WINDOW_MS;
}

/**
 * Remembers what actually started playing, so each item gets at most one 'play' and at most one
 * 'skip' (Next, or picking another song, within 30 s of it starting).
 */
export class ListenTracker<T extends { id: string }> {
  private played = new Set<string>();
  private skipped = new Set<string>();
  private now: { item: T; at: number } | null = null;

  /** The item currently known to be playing. */
  get playing(): T | null {
    return this.now?.item ?? null;
  }

  /** `item` was observed playing (since `at`). Returns true the first time, i.e. when to record a 'play'. */
  started(item: T, at: number): boolean {
    if (this.now?.item.id !== item.id) this.now = { item, at };
    if (this.played.has(item.id)) return false;
    this.played.add(item.id);
    return true;
  }

  /** The user moved on from the playing item. Returns it when a 'skip' should be recorded (once per item). */
  left(now: number, progressMs?: number | null): T | null {
    const cur = this.now;
    this.now = null;
    if (!cur || this.skipped.has(cur.item.id) || !isQuickSkip(cur.at, now, progressMs)) return null;
    this.skipped.add(cur.item.id);
    return cur.item;
  }

  /** Playback stopped without a choice (player closed): forget the playing item. */
  stop(): void {
    this.now = null;
  }
}

export type PlayerErrorKind = 'no_device' | 'premium_required' | 'reconnect' | 'not_connected' | 'rate_limited' | 'restricted' | 'network' | 'other';

/** Classify an ECHO API error code from the spotify function's player actions. */
export function classifyPlayerError(code: string | undefined, status?: number): PlayerErrorKind {
  switch (code) {
    case 'no_device':
    case 'premium_required':
    case 'reconnect':
    case 'rate_limited':
    case 'restricted':
      return code;
    case 'spotify_not_connected':
      return 'not_connected';
    case 'network':
      return 'network';
    default:
      return status === 0 ? 'network' : 'other';
  }
}

/** Current position, advancing locally between polls while playing. */
export function livePosition(s: { isPlaying: boolean; progressMs: number; durationMs: number; at: number }, now: number): number {
  const p = s.progressMs + (s.isPlaying ? Math.max(0, now - s.at) : 0);
  return s.durationMs > 0 ? Math.min(p, s.durationMs) : p;
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
