// Spotify Web API — Client Credentials for catalog search; official embeds for playback.
// https://developer.spotify.com/documentation/web-api
// Constraints honoured (Developer Policy, May 2025 + Feb 2026 dev-mode changes):
//  • search `limit` max 10 in Development Mode; popularity fields may be absent.
//  • Spotify content is NEVER sent to ML/AI models (no embeddings / LLM) — see pipeline.ts.
//  • Cover art & metadata are always shown with a link back to Spotify; playback uses the official embed.
import type { ContentItem } from '../types.ts';
import { ProviderError, stripHtml } from './http.ts';
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

const simplify = (x: string) => x.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

/** Verify AI-suggested picks exist on Spotify (exact track/album + artist match). Unverifiable picks are dropped. */
export async function verifySpotifyPicks(picks: Array<{ artist: string; track?: string; album?: string }>, ctx: ProviderContext): Promise<ContentItem[]> {
  const token = await spotifyAppToken(ctx);
  const market = ctx.env('SPOTIFY_MARKET') ?? 'US';
  const found = await Promise.all(picks.map(async (pk) => {
    const type = pk.track ? 'track' : 'album';
    const q = `${type}:"${(pk.track ?? pk.album)!.replace(/"/g, '')}" artist:"${pk.artist.replace(/"/g, '')}"`;
    const params = new URLSearchParams({ q, type, limit: '3', market });
    try {
      const data = await ctx.http.json<Record<string, { items: unknown[] }>>(`https://api.spotify.com/v1/search?${params}`, {
        init: { headers: { Authorization: `Bearer ${token}` } }, cacheKey: `spotify:verify:${params}`, ttl: 30 * 86400, provider: 'spotify',
      });
      const want = simplify(pk.artist);
      const hit = (data[`${type}s`]?.items ?? []).find((it) => {
        const artists = ((it as { artists?: Array<{ name: string }> })?.artists ?? []).map((a) => simplify(a.name));
        return artists.some((a) => a === want || a.includes(want) || want.includes(a));
      });
      if (hit) return mapSpotify(type, hit);
      // Title not found (transliterations, alternate spellings): fall back to the artist, verified by name.
      const ap = new URLSearchParams({ q: `artist:"${pk.artist.replace(/"/g, '')}"`, type: 'track', limit: '5', market });
      const byArtist = await ctx.http.json<Record<string, { items: unknown[] }>>(`https://api.spotify.com/v1/search?${ap}`, {
        init: { headers: { Authorization: `Bearer ${token}` } }, cacheKey: `spotify:verify:${ap}`, ttl: 30 * 86400, provider: 'spotify',
      });
      const fb = (byArtist.tracks?.items ?? []).find((it) => ((it as { artists?: Array<{ name: string }> })?.artists ?? []).some((a) => simplify(a.name) === want));
      return fb ? mapSpotify('track', fb) : null;
    } catch {
      return null;
    }
  }));
  return found.filter((x): x is ContentItem => !!x);
}
