// Spotify Web API — Client Credentials for catalog search and for resolving curator picks
// (ListenBrainz mapping + single-track lookups, search only when not rate-limited); official embeds for playback.
// https://developer.spotify.com/documentation/web-api
// Constraints honoured (Developer Policy, May 2025 + Feb 2026 dev-mode changes):
//  • search `limit` max 10 in Development Mode; popularity fields may be absent.
//  • Spotify content is NEVER sent to ML/AI models (no embeddings / LLM) — see pipeline.ts.
//  • Cover art & metadata are always shown with a link back to Spotify; playback uses the official embed.
import type { ContentItem } from '../types.ts';
import { ProviderError, stripHtml } from './http.ts';
import { lbSpotifyIds } from './listenbrainz.ts';
import { tagRetrieval, type Provider, type ProviderContext } from './types.ts';

interface Img { url: string; width?: number }
interface SArtist { id: string; name: string }
interface STrack { id: string; name: string; artists: SArtist[]; album: { name: string; images: Img[]; release_date?: string; id: string }; duration_ms: number; external_urls: { spotify: string }; preview_url?: string | null; popularity?: number; explicit?: boolean }
interface SAlbum { id: string; name: string; artists: SArtist[]; images: Img[]; release_date?: string; total_tracks?: number; external_urls: { spotify: string }; album_type?: string }
interface SPlaylist { id: string; name: string; description?: string; owner?: { display_name?: string }; images?: Img[]; external_urls: { spotify: string } }
interface SShow { id: string; name: string; description?: string; publisher?: string; images: Img[]; languages?: string[]; external_urls: { spotify: string }; total_episodes?: number }
interface SEpisode { id: string; name: string; description?: string; duration_ms: number; release_date?: string; images: Img[]; language?: string; external_urls: { spotify: string } }

const img = (i?: Img[]) => i?.[0]?.url;

export function mapSpotify(type: 'track' | 'album' | 'playlist' | 'show' | 'episode', x: unknown): ContentItem | null {
  if (!x) return null;
  switch (type) {
    case 'track': {
      const t = x as STrack;
      return { id: `spotify:track:${t.id}`, category: 'music', kind: 'track', provider: 'spotify', externalId: t.id, title: t.name, creators: t.artists.map((a) => a.name),
        genres: [], tags: [t.album?.name].filter(Boolean) as string[], artworkUrl: img(t.album?.images), durationSec: Math.round(t.duration_ms / 1000), releaseDate: t.album?.release_date,
        externalUrl: t.external_urls.spotify, embed: { type: 'spotify', uri: `spotify:track:${t.id}`, kind: 'track' }, popularity: t.popularity !== undefined ? t.popularity / 100 : undefined,
        metadata: { album: t.album?.name, previewUrl: t.preview_url ?? null } };
    }
    case 'album': {
      const a = x as SAlbum;
      return { id: `spotify:album:${a.id}`, category: 'music', kind: 'album', provider: 'spotify', externalId: a.id, title: a.name, creators: a.artists.map((r) => r.name), genres: [], tags: [],
        artworkUrl: img(a.images), releaseDate: a.release_date, externalUrl: a.external_urls.spotify, embed: { type: 'spotify', uri: `spotify:album:${a.id}`, kind: 'album' }, metadata: { tracks: a.total_tracks, albumType: a.album_type } };
    }
    case 'playlist': {
      const p = x as SPlaylist;
      return { id: `spotify:playlist:${p.id}`, category: 'music', kind: 'playlist', provider: 'spotify', externalId: p.id, title: p.name, creators: p.owner?.display_name ? [p.owner.display_name] : [],
        description: stripHtml(p.description), genres: [], tags: [], artworkUrl: img(p.images), externalUrl: p.external_urls.spotify, embed: { type: 'spotify', uri: `spotify:playlist:${p.id}`, kind: 'playlist' } };
    }
    case 'show': {
      const s = x as SShow;
      return { id: `spotify:show:${s.id}`, category: 'podcasts', kind: 'podcast', provider: 'spotify', externalId: s.id, title: s.name, creators: s.publisher ? [s.publisher] : [], description: stripHtml(s.description).slice(0, 1500),
        genres: [], tags: [], artworkUrl: img(s.images), language: s.languages?.[0]?.slice(0, 2), externalUrl: s.external_urls.spotify, embed: { type: 'spotify', uri: `spotify:show:${s.id}`, kind: 'show' }, metadata: { episodes: s.total_episodes } };
    }
    case 'episode': {
      const e = x as SEpisode;
      return { id: `spotify:episode:${e.id}`, category: 'podcasts', kind: 'episode', provider: 'spotify', externalId: e.id, title: e.name, creators: [], description: stripHtml(e.description).slice(0, 1500),
        genres: [], tags: [], artworkUrl: img(e.images), durationSec: Math.round(e.duration_ms / 1000), language: e.language?.slice(0, 2), releaseDate: e.release_date, externalUrl: e.external_urls.spotify,
        embed: { type: 'spotify', uri: `spotify:episode:${e.id}`, kind: 'episode' } };
    }
  }
}

export async function spotifyAppToken(ctx: ProviderContext): Promise<string> {
  const id = ctx.env('SPOTIFY_CLIENT_ID');
  const secret = ctx.env('SPOTIFY_CLIENT_SECRET');
  if (!id || !secret) throw new ProviderError('spotify', 'auth', 'not configured');
  const res = await ctx.http.json<{ access_token: string; expires_in: number }>('https://accounts.spotify.com/api/token', {
    init: { method: 'POST', headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' },
    cacheKey: `spotify:apptoken:${id}`, ttl: 50 * 60, provider: 'spotify',
  });
  return res.access_token;
}

export const spotify: Provider = {
  id: 'spotify',
  label: 'Spotify',
  categories: ['music', 'podcasts'],
  searchCost: 1,
  setup: 'developer.spotify.com → Dashboard → Create app (Web API). Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET as Supabase secrets. Note: Development Mode apps need the owner to have Spotify Premium and allow 5 users.',
  configured: (env) => !!(env('SPOTIFY_CLIENT_ID') && env('SPOTIFY_CLIENT_SECRET')),
  async search(p, ctx) {
    const token = await spotifyAppToken(ctx);
    // Music: tracks + albums (user playlists in search results are mostly low-quality); podcasts: shows + episodes.
    const types = p.category === 'podcasts' ? ['show', 'episode'] : p.kinds?.length ? p.kinds.filter((k) => ['track', 'album', 'playlist'].includes(k)) : ['track', 'album'];
    const genreFilter = p.category === 'music' && p.genres?.length === 1 && /^[a-z\- ]+$/.test(p.genres[0]) ? ` genre:"${p.genres[0]}"` : '';
    // Podcasts use their own market + language (default: US catalogue, English only); music keeps SPOTIFY_MARKET.
    const isPod = p.category === 'podcasts';
    const market = isPod ? ctx.env('SPOTIFY_PODCAST_MARKET') ?? 'US' : ctx.env('SPOTIFY_MARKET') ?? 'US';
    const podLang = (ctx.env('SPOTIFY_PODCAST_LANGUAGE') ?? 'en').toLowerCase();
    const params = new URLSearchParams({ q: `${p.query}${genreFilter}`, type: types.join(','), limit: '10', market });
    const data = await ctx.http.json<Record<string, { items: unknown[] }>>(`https://api.spotify.com/v1/search?${params}`, {
      init: { headers: { Authorization: `Bearer ${token}` } }, cacheKey: `spotify:search:${params}`, ttl: 2 * 86400, provider: 'spotify',
    });
    const out: ContentItem[] = [];
    for (const t of types as Array<'track' | 'album' | 'playlist' | 'show' | 'episode'>) {
      for (const it of data[`${t}s`]?.items ?? []) {
        const m = mapSpotify(t, it);
        if (m) out.push(m);
      }
    }
    const filtered = isPod && podLang !== 'any' ? out.filter((i) => !i.language || i.language.toLowerCase().startsWith(podLang)) : out;
    return tagRetrieval(filtered, p);
  },
  async resolve(title, ctx, category) {
    const token = await spotifyAppToken(ctx);
    const type = category === 'podcasts' ? 'show' : 'track';
    const params = new URLSearchParams({ q: title, type, limit: '3', market: ctx.env('SPOTIFY_MARKET') ?? 'US' });
    const data = await ctx.http.json<Record<string, { items: unknown[] }>>(`https://api.spotify.com/v1/search?${params}`, {
      init: { headers: { Authorization: `Bearer ${token}` } }, cacheKey: `spotify:resolve:${params}`, ttl: 7 * 86400, provider: 'spotify',
    });
    return mapSpotify(type, data[`${type}s`]?.items?.[0]);
  },
};

const simplify = (x: string) => x.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/** Title without version/feature decorations: "Song (feat. X) - Radio Edit" → "song". */
function simplifyTitle(x: string): string {
  return simplify(x.replace(/\s[-–]\s.*$/, '').replace(/[([].*?[)\]]/g, '').replace(/\b(feat|ft|featuring)\b.*$/i, ''));
}

/** True when one of the pick's credited artists is one of the track's artists (accents/punctuation ignored). */
export function artistMatches(pickArtist: string, trackArtists: string[]): boolean {
  // "The", "&"/"and" and punctuation never decide a match ("Mumford & Sons" = "Mumford and Sons").
  const norm = (x: string) => simplify(x.replace(/&/g, ' and ').replace(/^\s*the\s+/i, '').replace(/\band\b/gi, ' '));
  // The full credit first, then each credited artist ("Beyonce & Jay-Z" → "Jay-Z").
  const parts = [pickArtist, ...pickArtist.split(/\s*(?:,|&|\+|\/|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b)\s*/i)].map((p) => p.trim()).filter(Boolean);
  return parts.some((p) => trackArtists.some((a) => {
    const sp = norm(p);
    const sa = norm(a);
    if (!sp || !sa) return p.toLowerCase().trim() === a.toLowerCase().trim();
    if (sp === sa) return true;
    // Near-identical spellings only: "Drake" is not "Drake Bell".
    const [short, long] = sp.length <= sa.length ? [sp, sa] : [sa, sp];
    return short.length >= 4 && long.includes(short) && short.length / long.length >= 0.8;
  }));
}

/** Loose title check ("Song" ~ "Song (feat. X)" ~ "Song - 2019"); titles in other scripts are left to the artist check. */
export function titleMatches(pickTrack: string, title: string): boolean {
  const a = simplifyTitle(pickTrack);
  const b = simplifyTitle(title);
  if (!a || !b) return true;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.includes(short);
}

interface STrackFull extends STrack {
  is_playable?: boolean;
  external_ids?: { isrc?: string };
  album: STrack['album'] & { album_type?: string };
}

/** Single-track lookup result → item (release date from the album, ISRC/album type for the era rules). */
export function mapSpotifyTrack(t: STrackFull): ContentItem {
  const base = mapSpotify('track', t)!;
  return { ...base, metadata: { ...(base.metadata ?? {}), isrc: t.external_ids?.isrc, albumType: t.album?.album_type, explicit: t.explicit } };
}

export interface SpotifyPick {
  artist: string;
  track: string;
  /** Lane the pick is meant for (quota bookkeeping). */
  laneId: string;
}

export interface ResolveOptions {
  /** false while Spotify search is blocked/rate-limited: only the cache, ListenBrainz and single-track lookups run. */
  allowSearch: boolean;
  /** Search calls allowed for this refresh (default 8). */
  maxSearches?: number;
  /** Accepted songs wanted per lane; a lane stops resolving once it has them. */
  need?: Record<string, number>;
  /** Taste/era rules: a rejection reason, or null to accept. */
  accept?: (item: ContentItem, pick: SpotifyPick) => string | null;
  concurrency?: number;
}

export interface ResolvedPick {
  index: number;
  pick: SpotifyPick;
  item: ContentItem;
  via: 'cache' | 'listenbrainz' | 'search';
}

export interface ResolveResult {
  /** Accepted songs, in the curator's order. */
  items: ResolvedPick[];
  /** Set when Spotify answered 429: seconds to wait (Retry-After). */
  rateLimitedSec?: number;
  stats: { cached: number; listenbrainz: number; searched: number; unresolved: number; rejected: Record<string, number> };
}

type ResolveCache = { id: string } | { none: true };
const resolveKey = (pk: { artist: string; track: string }) => `spotify:resolve:v2:${simplify(pk.artist)}|${simplify(pk.track)}`;

/**
 * Resolve curator picks to real, playable Spotify tracks:
 *   (a) per-pick resolution cache → (b) ListenBrainz metadata mapping (batch, keyless) →
 *   (c) GET /v1/tracks/{id} (single lookups, 3 at a time, cached 30 days), accepted only when an
 *       artist matches and the track is playable → (d) only if search isn't blocked: exact
 *       track+artist search, at most 8 per refresh, stopping at the first 429.
 * There is no "any song by this artist" fallback: an unresolvable pick is dropped.
 */
export async function resolveSpotifyPicks(picks: SpotifyPick[], ctx: ProviderContext, opts: ResolveOptions): Promise<ResolveResult> {
  const stats: ResolveResult['stats'] = { cached: 0, listenbrainz: 0, searched: 0, unresolved: 0, rejected: {} };
  const result: ResolvedPick[] = [];
  if (!picks.length) return { items: result, stats };
  let rateLimitedSec: number | undefined;
  const limited = (e: unknown) => {
    if (!(e instanceof ProviderError && e.kind === 'quota')) return false;
    rateLimitedSec = Math.max(rateLimitedSec ?? 0, e.retryAfterSec ?? 60);
    return true;
  };
  let token: string;
  try {
    token = await spotifyAppToken(ctx);
  } catch (e) {
    limited(e);
    return { items: result, rateLimitedSec, stats: { ...stats, unresolved: picks.length } };
  }
  const market = ctx.env('SPOTIFY_MARKET') ?? 'US';
  const cache = ctx.http.cache;
  const accepted = new Map<string, number>();
  const wants = (pk: SpotifyPick) => opts.need?.[pk.laneId] === undefined || (accepted.get(pk.laneId) ?? 0) < opts.need[pk.laneId];
  const done = new Set<number>(); // resolved to a real track (accepted or rejected by taste rules)
  const reject = (reason: string) => (stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1);

  const take = (index: number, item: ContentItem, via: ResolvedPick['via']) => {
    done.add(index);
    const pick = picks[index];
    const why = opts.accept?.(item, pick) ?? null;
    if (why) return reject(why);
    if (!wants(pick)) return;
    accepted.set(pick.laneId, (accepted.get(pick.laneId) ?? 0) + 1);
    result.push({ index, pick, item, via });
  };

  // (a) cache
  const cached: Array<ResolveCache | undefined> = cache ? await Promise.all(picks.map((pk) => cache.get(resolveKey(pk)).catch(() => undefined) as Promise<ResolveCache | undefined>)) : picks.map(() => undefined);
  cached.forEach((c, i) => {
    if (c && 'none' in c) done.add(i); // known unresolvable
  });
  // (b) ListenBrainz mapping for the rest
  const lbIdx = picks.map((_, i) => i).filter((i) => !cached[i]);
  const lbIds = lbIdx.length ? await lbSpotifyIds(lbIdx.map((i) => picks[i]), ctx.http) : [];
  const candidates = new Map<number, { ids: string[]; via: ResolvedPick['via'] }>();
  cached.forEach((c, i) => c && 'id' in c && candidates.set(i, { ids: [c.id], via: 'cache' }));
  lbIdx.forEach((i, j) => lbIds[j]?.length && candidates.set(i, { ids: lbIds[j].slice(0, 2), via: 'listenbrainz' }));

  // (c) single-track lookups
  const lookup = async (id: string): Promise<STrackFull | null> => {
    try {
      return await ctx.http.json<STrackFull>(`https://api.spotify.com/v1/tracks/${id}?market=${encodeURIComponent(market)}`, {
        init: { headers: { Authorization: `Bearer ${token}` } }, cacheKey: `spotify:track:${id}:${market}`, ttl: 30 * 86400, provider: 'spotify',
      });
    } catch (e) {
      limited(e);
      return null;
    }
  };
  const order = picks.map((_, i) => i).filter((i) => candidates.has(i));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 3, order.length) }, async () => {
    while (next < order.length && rateLimitedSec === undefined) {
      const i = order[next++];
      if (!wants(picks[i])) continue;
      const cand = candidates.get(i)!;
      for (const id of cand.ids) {
        const t = await lookup(id);
        if (rateLimitedSec !== undefined) return;
        if (!t?.id || !artistMatches(picks[i].artist, (t.artists ?? []).map((a) => a.name)) || !titleMatches(picks[i].track, t.name)) continue;
        if (t.is_playable === false) {
          done.add(i);
          reject('unplayable');
          break;
        }
        if (cache && cand.via !== 'cache') await cache.set(resolveKey(picks[i]), { id: t.id } satisfies ResolveCache, 30 * 86400).catch(() => undefined);
        if (cand.via === 'cache') stats.cached++;
        else stats.listenbrainz++;
        take(i, mapSpotifyTrack(t), cand.via);
        break;
      }
    }
  }));

  // (d) exact search, only when allowed and budget remains
  const budget = opts.maxSearches ?? 8;
  if (opts.allowSearch && rateLimitedSec === undefined) {
    for (let i = 0; i < picks.length && stats.searched < budget; i++) {
      const pk = picks[i];
      if (done.has(i) || !wants(pk)) continue;
      const q = `track:"${pk.track.replace(/"/g, '')}" artist:"${pk.artist.replace(/"/g, '')}"`;
      const params = new URLSearchParams({ q, type: 'track', limit: '5', market });
      let data: { tracks?: { items?: STrackFull[] } };
      stats.searched++;
      try {
        data = await ctx.http.json(`https://api.spotify.com/v1/search?${params}`, {
          init: { headers: { Authorization: `Bearer ${token}` } }, cacheKey: `spotify:search-track:${params}`, ttl: 30 * 86400, provider: 'spotify',
        });
      } catch (e) {
        if (limited(e)) break; // stop immediately: Spotify's penalties grow with every extra call
        continue;
      }
      const hit = (data.tracks?.items ?? []).find((t) => t?.id && t.is_playable !== false && artistMatches(pk.artist, (t.artists ?? []).map((a) => a.name)) && titleMatches(pk.track, t.name));
      if (cache) await cache.set(resolveKey(pk), (hit ? { id: hit.id } : { none: true }) satisfies ResolveCache, (hit ? 30 : 14) * 86400).catch(() => undefined);
      if (hit) take(i, mapSpotifyTrack(hit), 'search');
      else done.add(i);
    }
  }
  stats.unresolved = picks.length - done.size;
  result.sort((a, b) => a.index - b.index);
  return { items: result, rateLimitedSec, stats };
}
