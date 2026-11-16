// TMDB — free API key for non-commercial use, attribution required.
// https://developer.themoviedb.org/docs  ("This product uses the TMDB API but is not endorsed or certified by TMDB.")
import type { ContentItem } from '../types.ts';
import { fold } from '../engine/text.ts';
import { tagRetrieval, type Env, type Provider, type ProviderContext } from './types.ts';

export const TMDB_MOVIE_GENRES: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
};
export const TMDB_TV_GENRES: Record<number, string> = {
  10759: 'Action & Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family', 10762: 'Kids', 9648: 'Mystery',
  10763: 'News', 10764: 'Reality', 10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics', 37: 'Western',
};
/** Concept → TMDB genre ids [movie, tv] for structured discovery. */
export const CONCEPT_GENRES: Record<string, [number[], number[]]> = {
  'sci-fi': [[878], [10765]], horror: [[27], []], mystery: [[9648, 80], [9648, 80]], humor: [[35], [35]], war: [[10752], [10768]], history: [[36], []],
  documentary: [[99], [99]], love: [[10749], []], romantic: [[10749], []], myth: [[14], [10765]], family: [[10751], [10751]], 'music-culture': [[10402], []],
  tense: [[53], []], adventure: [[12], [10759]], energetic: [[28], [10759]], politics: [[], [10768]],
};

interface TmdbResult {
  id: number; media_type?: 'movie' | 'tv' | 'person'; title?: string; name?: string; overview?: string; genre_ids?: number[]; poster_path?: string | null; backdrop_path?: string | null;
  release_date?: string; first_air_date?: string; vote_average?: number; vote_count?: number; popularity?: number; original_language?: string;
}

function auth(env: Env): { qs: string; headers: Record<string, string> } {
  const token = env('TMDB_READ_TOKEN');
  if (token) return { qs: '', headers: { Authorization: `Bearer ${token}` } };
  return { qs: `api_key=${encodeURIComponent(env('TMDB_API_KEY') ?? '')}`, headers: {} };
}

async function tmdb<T>(path: string, params: Record<string, string>, ctx: ProviderContext, ttl = 3 * 86400): Promise<T> {
  const a = auth(ctx.env);
  const sp = new URLSearchParams({ include_adult: 'false', ...params });
  const url = `https://api.themoviedb.org/3${path}?${sp}${a.qs ? `&${a.qs}` : ''}`;
  return ctx.http.json<T>(url, { init: { headers: a.headers }, cacheKey: `tmdb:${path}?${sp}`, ttl, provider: 'tmdb' });
}

export function mapTmdb(r: TmdbResult, forced?: 'movie' | 'tv'): ContentItem | null {
  const type = forced ?? r.media_type;
  if (type !== 'movie' && type !== 'tv') return null;
  const genres = (r.genre_ids ?? []).map((g) => (type === 'movie' ? TMDB_MOVIE_GENRES[g] : TMDB_TV_GENRES[g]) ?? TMDB_MOVIE_GENRES[g]).filter(Boolean);
  const kind = type === 'movie' ? 'movie' : 'series';
  return {
    id: `tmdb:${kind}:${r.id}`, category: 'screen', kind, provider: 'tmdb', externalId: `${type}/${r.id}`, title: r.title ?? r.name ?? 'Untitled',
    creators: [], description: r.overview, genres, tags: [], artworkUrl: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : undefined,
    language: r.original_language, releaseDate: r.release_date || r.first_air_date || undefined, externalUrl: `https://www.themoviedb.org/${type}/${r.id}`,
    embed: null, playbackNote: 'Films and series stream on their own platforms. ECHO can play the official trailer when TMDB lists one.',
    rating: (r.vote_count ?? 0) >= 50 && r.vote_average ? r.vote_average / 10 : undefined,
    popularity: r.popularity ? Math.min(1, Math.log10(r.popularity + 1) / 3) : undefined,
    metadata: { tmdbType: type, tmdbId: r.id, voteCount: r.vote_count, backdrop: r.backdrop_path ? `https://image.tmdb.org/t/p/w780${r.backdrop_path}` : undefined },
  };
}

async function keywordIds(q: string, ctx: ProviderContext): Promise<number[]> {
  const res = await tmdb<{ results: Array<{ id: number; name: string }> }>('/search/keyword', { query: q }, ctx, 30 * 86400);
  const exact = res.results.filter((k) => k.name.toLowerCase() === q.toLowerCase());
  return (exact.length ? exact : res.results).slice(0, 2).map((k) => k.id);
}

/** Enrich with TMDB keywords (themes) — a few extra calls, cached for 30 days. */
export async function tmdbKeywords(item: ContentItem, ctx: ProviderContext): Promise<string[]> {
  const [type, id] = item.externalId.split('/');
  const res = await tmdb<{ keywords?: Array<{ name: string }>; results?: Array<{ name: string }> }>(`/${type}/${id}/keywords`, {}, ctx, 30 * 86400);
  return (res.keywords ?? res.results ?? []).map((k) => k.name).slice(0, 30);
}

export async function tmdbTrailer(externalId: string, ctx: ProviderContext): Promise<string | null> {
  const [type, id] = externalId.split('/');
  const res = await tmdb<{ results: Array<{ site: string; type: string; key: string; official?: boolean }> }>(`/${type}/${id}/videos`, {}, ctx, 7 * 86400);
  const yt = res.results.filter((v) => v.site === 'YouTube');
  const best = yt.find((v) => v.type === 'Trailer' && v.official) ?? yt.find((v) => v.type === 'Trailer') ?? yt[0];
  return best?.key ?? null;
}

export const tmdbProvider: Provider = {
  id: 'tmdb',
  label: 'TMDB',
  categories: ['screen'],
  searchCost: 3,
  setup: 'Create a free account at themoviedb.org → Settings → API, then set TMDB_READ_TOKEN (or TMDB_API_KEY) as a Supabase secret.',
  configured: (env) => !!(env('TMDB_READ_TOKEN') || env('TMDB_API_KEY')),
  async search(p, ctx) {
    const out: ContentItem[] = [];
    const genreIds = (p.genres ?? []).flatMap((c) => CONCEPT_GENRES[c] ?? [[], []]);
    const movieGenres = [...new Set([...(p.documentary ? [99] : []), ...genreIds.filter((_, i) => i % 2 === 0).flat()])];
    const tvGenres = [...new Set([...(p.documentary ? [99] : []), ...genreIds.filter((_, i) => i % 2 === 1).flat()])];
    const wantTv = !p.kinds || p.kinds.includes('series');
    const wantMovie = !p.kinds || p.kinds.includes('movie');
    // 1) Thematic discovery via TMDB keywords
    const kws = await keywordIds(p.query, ctx).catch(() => [] as number[]);
    const lang: Record<string, string> = p.language ? { with_original_language: p.language } : {};
    if (kws.length) {
      const base = { with_keywords: kws.join('|'), sort_by: p.acclaimed === false ? 'popularity.desc' : 'vote_average.desc', ...lang };
      if (wantMovie) {
        const r = await tmdb<{ results: TmdbResult[] }>('/discover/movie', { ...base, 'vote_count.gte': '150', ...(movieGenres.length ? { with_genres: movieGenres.join('|') } : {}) }, ctx);
        out.push(...r.results.map((x) => mapTmdb(x, 'movie')).filter((x): x is ContentItem => !!x));
      }
      if (wantTv) {
        const r = await tmdb<{ results: TmdbResult[] }>('/discover/tv', { ...base, 'vote_count.gte': '40', ...(tvGenres.length ? { with_genres: tvGenres.join('|') } : {}) }, ctx);
        out.push(...r.results.slice(0, 8).map((x) => mapTmdb(x, 'tv')).filter((x): x is ContentItem => !!x));
      }
    }
    // 2) Genre-only discovery when the theme maps to genres but has no keyword
    if (!kws.length && movieGenres.length && wantMovie) {
      const r = await tmdb<{ results: TmdbResult[] }>('/discover/movie', { with_genres: movieGenres.join(','), sort_by: 'vote_average.desc', 'vote_count.gte': '300', ...lang }, ctx);
      out.push(...r.results.map((x) => mapTmdb(x, 'movie')).filter((x): x is ContentItem => !!x));
    }
    // 3) Free-text match
    if (out.length < 10) {
      const r = await tmdb<{ results: TmdbResult[] }>('/search/multi', { query: p.query }, ctx);
      out.push(...r.results.map((x) => mapTmdb(x)).filter((x): x is ContentItem => !!x && (!p.documentary || x.genres.includes('Documentary'))));
    }
    return tagRetrieval(out.slice(0, p.limit ?? 30), p);
  },
  async resolve(title, ctx) {
    const r = await tmdb<{ results: TmdbResult[] }>('/search/multi', { query: title }, ctx, 30 * 86400);
    const items = r.results.map((x) => mapTmdb(x)).filter((x): x is ContentItem => !!x);
    const exact = items.find((i) => i.title.toLowerCase() === title.toLowerCase());
    const best = exact ?? items[0];
    if (!best) return null;
    const keywords = await tmdbKeywords(best, ctx).catch(() => []);
    return { ...best, tags: keywords };
  },
  async similar(item, ctx) {
    const [type, id] = item.externalId.split('/');
    const r = await tmdb<{ results: TmdbResult[] }>(`/${type}/${id}/recommendations`, {}, ctx, 7 * 86400);
    return r.results.map((x) => mapTmdb(x, type as 'movie' | 'tv')).filter((x): x is ContentItem => !!x).slice(0, 15);
  },
};

/** A person's best-known films and series (TMDB "known for"), from one person search. */
export async function tmdbPersonWorks(name: string, ctx: ProviderContext): Promise<{ department?: string; works: ContentItem[] }> {
  const r = await tmdb<{ results: Array<{ name?: string; known_for_department?: string; known_for?: TmdbResult[] }> }>('/search/person', { query: name }, ctx, 30 * 86400);
  const want = fold(name);
  const person = (r.results ?? []).find((p) => fold(p.name ?? '') === want) ?? (r.results ?? [])[0];
  if (!person) return { works: [] };
  return { department: person.known_for_department, works: (person.known_for ?? []).map((x) => mapTmdb(x)).filter((x): x is ContentItem => !!x) };
}
