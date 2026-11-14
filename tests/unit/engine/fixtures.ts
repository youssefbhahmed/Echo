import type { AnalyzedItem, ContentItem } from '@shared/types.ts';
import { analyzeItem } from '@shared/engine/analyze.ts';

let n = 0;
export function make(partial: Partial<ContentItem> & Pick<ContentItem, 'title' | 'category'>): AnalyzedItem {
  n++;
  const kind = partial.kind ?? ({ youtube: 'video', music: 'track', screen: 'movie', books: 'book', podcasts: 'podcast' } as const)[partial.category];
  return analyzeItem({
    id: partial.id ?? `test:${kind}:${n}`,
    kind,
    provider: partial.provider ?? 'tmdb',
    externalId: String(n),
    creators: [],
    genres: [],
    tags: [],
    externalUrl: 'https://example.org',
    ...partial,
  } as ContentItem);
}
