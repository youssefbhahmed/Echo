// Pipeline step 2 — candidate retrieval planning.
// Turns an intent + profile into a small, quota-aware set of provider queries.
import { CATEGORIES, type Category, type ConceptVector, type Intent, type TasteProfile } from '../types.ts';
import { providersFor, type Env } from '../providers/index.ts';
import type { Provider, SearchParams } from '../providers/types.ts';
import { CONCEPT_BY_ID, CONCEPTS } from './concepts.ts';
import { spreadAcrossWorlds, worldOf } from './worlds.ts';
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
  /** Relative weight per category; "more" gets more queries. */
  mix?: Partial<Record<Category, number>>;
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
  const ranked = topKeys(combined, 12, 0.1).filter((k) => CONCEPT_BY_ID[k] && CONCEPT_BY_ID[k].group !== 'quality');
  // Themes drive retrieval; moods mostly colour it (they come in through mood chips and ranking).
  const themes = ranked.filter((k) => CONCEPT_BY_ID[k].group === 'theme');
  const base = themes.length ? themes : ranked.length ? ranked : DEFAULT_FEED_CONCEPTS;
  // Pinned interests are explicit: always searched (rotating if there are many).
  // Pinned interests are explicit: always some searched, rotating 2 at a time so they don't crowd everything else.
  const pinned = rotate(profile.explicit.pinnedConcepts.filter((c) => CONCEPT_BY_ID[c] && !blocked.has(c)), seed * 2).slice(0, 2);
  const familiar = rotate(base.filter((c) => !pinned.includes(c)).slice(0, 6), seed);
  const adjacent = rotate(
    [...new Set(base.flatMap((c) => CONCEPT_BY_ID[c]?.related ?? []))].filter((c) => !base.includes(c) && !blocked.has(c) && CONCEPT_BY_ID[c]?.group === 'theme'),
    seed,
  );
  // Familiar never drops below 2 themes; adventurous adds up to 3 adjacent themes and 2 wildcards.
  const nFam = Math.max(2, 4 - Math.round(3 * exploration)) ;
  const nAdj = Math.round(3 * exploration);
  const known = new Set([...Object.keys(profile.concepts), ...base, ...adjacent]);
  // Wildcards come preferably from "worlds" the rest of the feed doesn't touch (e.g. lightness & joy
  // for someone deep into dark themes), so every refresh has real contrast.
  const core = [...pinned, ...familiar.slice(0, Math.max(0, nFam - pinned.length) + 1), ...adjacent.slice(0, nAdj)];
  const usedWorlds = new Set(core.map(worldOf).filter(Boolean));
  const unexploredAll = CONCEPTS.filter((c) => c.group === 'theme' && !known.has(c.id) && !blocked.has(c.id)).map((c) => c.id);
  const contrast = rotate(unexploredAll.filter((c) => !usedWorlds.has(worldOf(c))), seed * 7 + 3);
  const unexplored = [...contrast, ...rotate(unexploredAll.filter((c) => usedWorlds.has(worldOf(c))), seed * 5 + 1)];
  const nWild = 2 + Math.round(exploration);
  const picks = spreadAcrossWorlds([...new Set([...core, ...unexplored.slice(0, nWild)])].filter((c) => !blocked.has(c)));
  return [...new Set([...moods, ...picks])].slice(0, 9);
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
  // YouTube searches cost 100 quota units each: 2 per request at most, shared by Videos and Podcasts.
  const ytCats = categories.filter((c) => c === 'youtube' || c === 'podcasts').length;
  // Big feeds (48 picks) need more than one page of videos to fill a real Videos shelf.
  const big = (opts.budget ?? 12) >= 18;
  let ytLeft = opts.youtubeBudget ?? ((categories.length === 1 && categories[0] === 'youtube') || intent.providers?.includes('youtube') ? (big ? 3 : 2) : Math.min(big ? 4 : 2, Math.max(1, ytCats + (big ? 2 : 0))));
  const targetTop = topKeys(positivePart(intent.target), 4, 0.15).filter((k) => CONCEPT_BY_ID[k] && !intent.relaxed.includes(k));
  const themeTop = targetTop.filter((k) => CONCEPT_BY_ID[k].group !== 'quality');
  const concepts = opts.hasQuery
    ? [...new Set([...themeTop, ...extraConcepts])].slice(0, 3)
    : feedConcepts(profile, opts.exploration, intent.moods, opts.seed ?? 0);
  const documentary = (intent.target.documentary ?? 0) > 0.3;
  const perCat = Math.max(1, Math.floor(budget / Math.max(1, categories.length)));

  for (const [ci, category] of categories.entries()) {
    const all = providersFor(category, opts.env);
    // Source filter from the request ("youtube podcasts"), unless it would leave nothing.
    const filtered = intent.providers?.length ? all.filter((p) => intent.providers!.includes(p.id)) : all;
    const providers = filtered.length ? filtered : all;
    if (!providers.length) continue;
    const queries: Array<{ q: string; retrievedFor: string[] }> = [];
    // Metaphorical mood requests ("music like a sunrise") search by concept, not literal words.
    const literalOk = !(intent.intent === 'mood' && (category === 'music' || category === 'podcasts') && themeTop.length >= 2);
    const sq = opts.hasQuery ? intent.searchQueries?.[category] : undefined;
    if (sq) queries.push({ q: sq, retrievedFor: [] });
    else if (intent.keywords.length && opts.hasQuery && literalOk) {
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
    const musicable = (c: string) => CONCEPT_BY_ID[c]?.group === 'mood' || MUSIC_THEMES.has(c);
    // Open feed: music is steered by the music taste alone (+ mood chips), never by video/book themes.
    const musicSource = opts.hasQuery ? concepts : [...intent.moods, ...topKeys(positivePart(profile.conceptsByCategory.music ?? {}), 8, 0.1)];
    const musicConcepts = [...new Set(musicSource.filter(musicable))];
    const catConcepts = category === 'music'
      ? [...musicConcepts, ...(musicConcepts.some((c) => CONCEPT_BY_ID[c]?.group === 'mood') ? [] : ['dreamy', 'calm'])]
      : concepts;
    // Each category starts at a different concept, so together they cover more ground.
    const rotated = opts.hasQuery ? catConcepts : rotate(catConcepts, ci + (opts.seed ?? 0));
    // A precise topic search ("Ottoman empire documentary") stays on topic: at most one generic theme
    // search alongside it, and none for YouTube (quota is better spent on the topic itself).
    const themeBudget = sq ? (category === 'youtube' ? 0 : 1) : Infinity;
    let themesAdded = 0;
    for (const c of rotated) {
      if (themesAdded >= themeBudget) break;
      const s = conceptSearch(c, category);
      if (s) {
        queries.push({ q: s, retrievedFor: [c] });
        themesAdded++;
      }
    }
    const seen = new Set<string>();
    const unique = queries.filter((q) => q.q && !seen.has(q.q.toLowerCase()) && seen.add(q.q.toLowerCase()));
    const w = opts.mix?.[category] ?? 1;
    const reserveForPodcasts = category === 'youtube' && categories.includes('podcasts') && ytLeft > 1 ? 1 : 0;
    let n = category === 'youtube' ? Math.min(ytLeft - reserveForPodcasts, perCat) : Math.min(Math.max(1, Math.round(perCat * w)), w > 1 ? 4 : 3);
    if (category === 'youtube') ytLeft -= Math.min(n, unique.length);
    for (const q of unique) {
      if (n <= 0) break;
      for (const provider of providers) {
        // In Podcasts, YouTube gets one search (its quota is precious); Spotify takes the rest.
        if (provider.id === 'youtube' && category !== 'youtube') {
          // Normally one YouTube podcast search; when the user asked for YouTube specifically, up to two.
          const maxHere = intent.providers?.includes('youtube') ? 2 : 1;
          if (ytLeft <= 0 || plan.filter((x) => x.provider.id === 'youtube' && x.params.category === category).length >= maxHere) continue;
          ytLeft--;
        }
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
            limit: category === 'youtube' ? (big ? 25 : 15) : 20,
            acclaimed: intent.complexity === 'deep' || !opts.hasQuery,
          },
        });
      }
      n--;
    }
  }
  return plan.slice(0, budget + 2);
}
