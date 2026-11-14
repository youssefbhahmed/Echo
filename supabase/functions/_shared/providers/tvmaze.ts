// TVmaze — free, no key, CC BY-SA. https://www.tvmaze.com/api
// Keyless fallback for TV series when TMDB is not configured.
import type { ContentItem } from '../types.ts';
import { stripHtml } from './http.ts';
import { tagRetrieval, type Provider } from './types.ts';

interface TVShow {
  id: number; url: string; name: string; language?: string; genres?: string[]; averageRuntime?: number; runtime?: number; premiered?: string;
  rating?: { average?: number | null }; image?: { medium?: string; original?: string } | null; summary?: string; weight?: number;
  network?: { name?: string } | null; webChannel?: { name?: string } | null;
}
const LANG: Record<string, string> = { English: 'en', German: 'de', French: 'fr', Spanish: 'es', Japanese: 'ja', Korean: 'ko', Italian: 'it', Danish: 'da', Swedish: 'sv', Norwegian: 'no' };

export function mapTvShow(s: TVShow): ContentItem {
  return {
    id: `tvmaze:series:${s.id}`, category: 'screen', kind: 'series', provider: 'tvmaze', externalId: String(s.id), title: s.name,
    creators: [s.network?.name ?? s.webChannel?.name ?? ''].filter(Boolean), description: stripHtml(s.summary).slice(0, 1500), genres: s.genres ?? [], tags: [],
    artworkUrl: s.image?.original ?? s.image?.medium, durationSec: (s.averageRuntime ?? s.runtime ?? 0) * 60 || undefined, language: s.language ? LANG[s.language] ?? s.language : undefined,
    releaseDate: s.premiered ?? undefined, externalUrl: s.url, embed: null, playbackNote: 'Series details from TVmaze. Streaming happens on the platform that carries the show.',
    rating: s.rating?.average ? s.rating.average / 10 : undefined, popularity: s.weight ? s.weight / 100 : undefined,
  };
}

export const tvmaze: Provider = {
  id: 'tvmaze',
  label: 'TVmaze',
  categories: ['screen'],
  searchCost: 1,
  setup: 'No key required (used for series when TMDB is not configured).',
  configured: () => true,
  async search(p, { http }) {
    const url = `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(p.query)}`;
    const data = await http.json<Array<{ show: TVShow }>>(url, { cacheKey: `tvm:${p.query.toLowerCase()}`, ttl: 3 * 86400, provider: 'tvmaze' });
    return tagRetrieval((data ?? []).map((r) => mapTvShow(r.show)).slice(0, p.limit ?? 15), p);
  },
  async resolve(title, { http }) {
    try {
      const s = await http.json<TVShow>(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(title)}`, { cacheKey: `tvm:single:${title.toLowerCase()}`, ttl: 30 * 86400, provider: 'tvmaze' });
      return s?.id ? mapTvShow(s) : null;
    } catch {
      return null;
    }
  },
};
