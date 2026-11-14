import type { Category, ContentItem, ContentKind, DurationPref, ProviderId } from '../types.ts';
import type { HttpClient } from './http.ts';

export type Env = (name: string) => string | undefined;

export interface SearchParams {
  query: string;
  category: Category;
  kinds?: ContentKind[];
  limit?: number;
  language?: string;
  duration?: DurationPref;
  /** Concepts this query was generated for (items inherit them as weak, provider-backed evidence). */
  retrievedFor?: string[];
  /** Hints for structured providers (TMDB genre/keyword discovery). */
  genres?: string[];
  documentary?: boolean;
  /** Prefer critically acclaimed results. */
  acclaimed?: boolean;
}

export interface ProviderContext {
  http: HttpClient;
  env: Env;
}

export interface Provider {
  id: ProviderId;
  label: string;
  categories: Category[];
  /** Approximate quota cost of one search (for budgeting). */
  searchCost: number;
  configured(env: Env): boolean;
  /** Human-readable setup hint shown when unconfigured. */
  setup: string;
  search(p: SearchParams, ctx: ProviderContext): Promise<ContentItem[]>;
  /** Look up a referenced title/creator ("like Interstellar"). */
  resolve?(title: string, ctx: ProviderContext, category?: Category): Promise<ContentItem | null>;
  /** Provider-native "similar" items for a resolved reference. */
  similar?(item: ContentItem, ctx: ProviderContext): Promise<ContentItem[]>;
}

export function tagRetrieval(items: ContentItem[], p: SearchParams): ContentItem[] {
  return items.map((it) => ({ ...it, metadata: { ...(it.metadata ?? {}), retrievedBy: p.query, retrievedFor: p.retrievedFor ?? [] } }));
}
