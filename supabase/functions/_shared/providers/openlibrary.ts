// Open Library — free, no key. https://openlibrary.org/developers/api
// Search results include rich subject lists, which feed the concept analysis.
import type { ContentItem } from '../types.ts';
import { tagRetrieval, type Provider } from './types.ts';

const FIELDS = 'key,title,author_name,first_publish_year,subject,cover_i,language,number_of_pages_median,ratings_average,ratings_count,edition_count,first_sentence';
const LANG3: Record<string, string> = { en: 'eng', fr: 'fre', es: 'spa', de: 'ger', it: 'ita', pt: 'por', ja: 'jpn', ru: 'rus', zh: 'chi', ar: 'ara' };

interface OLDoc {
  key: string; title: string; author_name?: string[]; first_publish_year?: number; subject?: string[]; cover_i?: number; language?: string[];
  number_of_pages_median?: number; ratings_average?: number; ratings_count?: number; edition_count?: number; first_sentence?: string[];
}

export function mapOpenLibraryDoc(d: OLDoc): ContentItem {
  const id = d.key.replace('/works/', '');
  const rated = (d.ratings_count ?? 0) >= 5 && d.ratings_average;
  return {
    id: `openlibrary:book:${id}`,
    category: 'books',
    kind: 'book',
    provider: 'openlibrary',
    externalId: id,
    title: d.title,
    creators: (d.author_name ?? []).slice(0, 3),
    description: d.first_sentence?.[0],
    genres: [],
    tags: (d.subject ?? []).filter((s) => s.length < 60 && !/^[A-Z]{1,3}\d|^\d/.test(s)).slice(0, 40),
    artworkUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : undefined,
    language: d.language?.[0] ? ({ eng: 'en', fre: 'fr', spa: 'es', ger: 'de', ita: 'it', por: 'pt', jpn: 'ja', rus: 'ru' } as Record<string, string>)[d.language[0]] ?? d.language[0] : undefined,
    releaseDate: d.first_publish_year ? String(d.first_publish_year) : undefined,
    externalUrl: `https://openlibrary.org${d.key}`,
    embed: null,
    playbackNote: 'Books open on Open Library, where you can borrow, read samples or find editions.',
    rating: rated ? d.ratings_average! / 5 : undefined,
    popularity: d.edition_count ? Math.min(1, Math.log10(d.edition_count + 1) / 2.5) : undefined,
    metadata: { pages: d.number_of_pages_median, editions: d.edition_count, ratingsCount: d.ratings_count },
  };
}

export const openLibrary: Provider = {
  id: 'openlibrary',
  label: 'Open Library',
  categories: ['books'],
  searchCost: 1,
  setup: 'No key required.',
  configured: () => true,
  async search(p, { http }) {
    // Theme queries search subjects; free-text queries search everything.
    // Theme (concept) queries search the subject index; free-text queries search everything.
    const q = p.retrievedFor?.length ? `subject:"${p.query}"` : p.query;
    const params = new URLSearchParams({ q, fields: FIELDS, limit: String(Math.min(p.limit ?? 20, 30)) });
    if (p.language && LANG3[p.language]) params.set('lang', p.language);
    const url = `https://openlibrary.org/search.json?${params}`;
    const data = await http.json<{ docs: OLDoc[] }>(url, { cacheKey: `ol:${params}`, ttl: 7 * 86400, provider: 'openlibrary', timeoutMs: 9000 });
    return tagRetrieval((data.docs ?? []).filter((d) => d.title && d.author_name?.length).map(mapOpenLibraryDoc), p);
  },
  async resolve(title, { http }) {
    const params = new URLSearchParams({ title, fields: FIELDS, limit: '3' });
    const data = await http.json<{ docs: OLDoc[] }>(`https://openlibrary.org/search.json?${params}`, { cacheKey: `ol:resolve:${title.toLowerCase()}`, ttl: 30 * 86400, provider: 'openlibrary' });
    const d = (data.docs ?? []).find((x) => x.title.toLowerCase() === title.toLowerCase()) ?? data.docs?.[0];
    return d ? mapOpenLibraryDoc(d) : null;
  },
};
