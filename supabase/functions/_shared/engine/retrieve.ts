// Pipeline step 2 — candidate retrieval planning.
// Turns an intent + profile into a small, quota-aware set of provider queries.
import { CATEGORIES, type Category, type ConceptVector, type Intent, type TasteProfile } from '../types.ts';
import { providersFor, type Env } from '../providers/index.ts';
import type { Provider, SearchParams } from '../providers/types.ts';
import { CONCEPT_BY_ID } from './concepts.ts';
import { positivePart, topKeys } from './text.ts';

export interface PlannedQuery {
  provider: Provider;
  params: SearchParams;
}

export interface PlanOptions {
  env: Env;
  exploration: number;
  hasQuery: boolean;
  /** Rotates feed concepts between refreshes. */
  seed?: number;
  /** Max provider calls for this request. */
  budget?: number;
  /** Max YouTube searches (100 quota units each). */
  youtubeBudget?: number;
}

const FORMAT_WORD: Partial<Record<Category, string>> = { youtube: '', podcasts: '' };
const DEFAULT_FEED_CONCEPTS = ['awe', 'philosophy', 'uplifting', 'science', 'history', 'dreamy', 'art', 'nature'];

function rotate<T>(arr: T[], seed: number): T[] {
  if (!arr.length) return arr;
  const k = Math.abs(seed) % arr.length;
  return [...arr.slice(k), ...arr.slice(0, k)];
}

/** Concepts to explore for an open feed: familiar = strongest, adventurous = adjacent-but-unexplored. */
export function feedConcepts(profile: TasteProfile, exploration: number, moods: string[], seed = 0): string[] {
  const combined: ConceptVector = { ...positivePart(profile.concepts) };
  for (const p of profile.explicit.pinnedConcepts) combined[p] = Math.max(combined[p] ?? 0, 1.5);
  const blocked = new Set([...profile.explicit.blockedConcepts, ...Object.keys(profile.concepts).filter((k) => profile.concepts[k] < -0.3)]);
  const top = topKeys(combined, 8, 0.1).filter((k) => CONCEPT_BY_ID[k] && CONCEPT_BY_ID[k].group !== 'quality');
  const base = top.length ? top : DEFAULT_FEED_CONCEPTS;
  const familiar = rotate(base.slice(0, 6), seed);
  const adjacent = rotate(
    [...new Set(base.flatMap((c) => CONCEPT_BY_ID[c]?.related ?? []))].filter((c) => !base.slice(0, 6).includes(c) && !blocked.has(c) && CONCEPT_BY_ID[c]),
    seed,
  );
  const nAdj = Math.round(4 * exploration);
  const picks = [...moods, ...familiar.slice(0, 4 - Math.min(nAdj, 3)), ...adjacent.slice(0, nAdj)];
  return [...new Set(picks)].filter((c) => !blocked.has(c)).slice(0, 5);
}

export function targetCategories(intent: Intent, _profile: TasteProfile, requested?: Category[]): Category[] {
  if (requested?.length) return requested;
  if (intent.categories.length) return intent.categories;
  return [...CATEGORIES];
}

function conceptSearch(concept: string, category: Category): string | undefined {
  return CONCEPT_BY_ID[concept]?.search?.[category];
}

export function planRetrieval(intent: Intent, profile: TasteProfile, categories: Category[], opts: PlanOptions, extraConcepts: string[] = []): PlannedQuery[] {
  const plan: PlannedQuery[] = [];
  const budget = opts.budget ?? 12;
  let ytLeft = opts.youtubeBudget ?? (categories.length === 1 && categories[0] === 'youtube' ? 2 : 1);
  const targetTop = topKeys(positivePart(intent.target), 4, 0.15).filter((k) => CONCEPT_BY_ID[k] && !intent.relaxed.includes(k));
  const themeTop = targetTop.filter((k) => CONCEPT_BY_ID[k].group !== 'quality');
  const concepts = opts.hasQuery
    ? [...new Set([...themeTop, ...extraConcepts])].slice(0, 3)
    : feedConcepts(profile, opts.exploration, intent.moods, opts.seed ?? 0);
  const documentary = (intent.target.documentary ?? 0) > 0.3;
  const perCat = Math.max(1, Math.floor(budget / Math.max(1, categories.length)));

  for (const category of categories) {
    const providers = providersFor(category, opts.env);
    if (!providers.length) continue;
    const queries: Array<{ q: string; retrievedFor: string[] }> = [];
    // Metaphorical mood requests ("music like a sunrise") search by concept, not literal words.
    const literalOk = !(intent.intent === 'mood' && (category === 'music' || category === 'podcasts') && themeTop.length >= 2);
    if (intent.keywords.length && opts.hasQuery && literalOk) {
      const words = intent.keywords.slice(0, 4).join(' ');
      const fmt = FORMAT_WORD[category] ?? '';
      queries.push({ q: `${words}${documentary && (category === 'youtube' || category === 'podcasts') ? ' documentary' : ''}${fmt}`.trim(), retrievedFor: [] });
    }
    for (const g of intent.genres.slice(0, 1)) if (category === 'music' || category === 'books') queries.push({ q: [g, ...intent.moods.slice(0, 1)].join(' '), retrievedFor: intent.moods.slice(0, 1) });
    if (intent.trajectory && category === 'music') {
      queries.push({ q: conceptSearch(intent.trajectory.from, 'music') ?? intent.trajectory.from, retrievedFor: [intent.trajectory.from] });
      queries.push({ q: conceptSearch(intent.trajectory.to, 'music') ?? intent.trajectory.to, retrievedFor: [intent.trajectory.to] });
    }
    // Music search works best with moods/atmospheres; abstract themes ("history") retrieve noise.
    const MUSIC_THEMES = new Set(['cosmic', 'nature', 'spiritual', 'love', 'loss', 'solitude', 'sci-fi', 'myth', 'time-memory']);
    const catConcepts = category === 'music'
      ? [...concepts.filter((c) => CONCEPT_BY_ID[c]?.group === 'mood' || MUSIC_THEMES.has(c)), ...(concepts.some((c) => CONCEPT_BY_ID[c]?.group === 'mood') ? [] : ['dreamy', 'calm'])]
      : concepts;
    for (const c of catConcepts) {
      const s = conceptSearch(c, category);
      if (s) queries.push({ q: s, retrievedFor: [c] });
    }
    const seen = new Set<string>();
    const unique = queries.filter((q) => q.q && !seen.has(q.q.toLowerCase()) && seen.add(q.q.toLowerCase()));
    let n = category === 'youtube' ? Math.min(ytLeft, perCat) : Math.min(perCat, 3);
    if (category === 'youtube') ytLeft -= Math.min(n, unique.length);
    for (const q of unique) {
      if (n <= 0) break;
      for (const provider of providers) {
        plan.push({
          provider,
          params: {
            query: q.q,
            category,
            retrievedFor: q.retrievedFor,
            language: intent.language,
            duration: intent.duration,
            documentary: documentary && category === 'screen',
            genres: category === 'screen' ? [...themeTop, ...intent.genres].filter((x) => x !== 'documentary') : intent.genres,
            kinds: category === 'podcasts' && opts.hasQuery && intent.keywords.length ? ['episode'] : undefined,
            limit: category === 'youtube' ? 15 : 20,
            acclaimed: intent.complexity === 'deep' || !opts.hasQuery,
          },
        });
      }
      n--;
    }
  }
  return plan.slice(0, budget + 2);
}
