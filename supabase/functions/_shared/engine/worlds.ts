// Broad thematic "worlds" used to keep a feed varied in TONE, not just in creators or searches.
import type { AnalyzedItem } from '../types.ts';
import { CONCEPT_BY_ID } from './concepts.ts';

export const WORLDS: Record<string, string[]> = {
  dark: ['horror', 'mystery', 'dystopia', 'war', 'dark', 'tense', 'eerie', 'intense', 'survival'],
  world: ['history', 'civilization', 'politics', 'society', 'economics'],
  science: ['science', 'technology', 'cosmic', 'sci-fi', 'nature'],
  mind: ['philosophy', 'psychology', 'existential', 'spiritual', 'contemplative', 'solitude', 'time-memory', 'cerebral'],
  heart: ['love', 'romantic', 'family', 'coming-of-age', 'loss', 'identity', 'melancholic', 'nostalgic'],
  light: ['humor', 'joyful', 'cozy', 'uplifting', 'food', 'travel', 'sports', 'health', 'adventure', 'energetic', 'calm', 'accessible'],
  art: ['art', 'music-culture', 'myth', 'dreamy', 'awe'],
};

const WORLD_OF: Record<string, string> = Object.fromEntries(Object.entries(WORLDS).flatMap(([w, cs]) => cs.map((c) => [c, w])));

export function worldOf(concept: string): string | null {
  return WORLD_OF[concept] ?? null;
}

/** The item's dominant world: the strongest concept from its own metadata (documentary/quality tags ignored). */
export function itemWorld(item: AnalyzedItem): string | null {
  const inherited = new Set(Array.isArray(item.metadata?.inheritedConcepts) ? (item.metadata!.inheritedConcepts as string[]) : []);
  const ranked = Object.entries(item.concepts)
    .filter(([k]) => WORLD_OF[k] && CONCEPT_BY_ID[k]?.group !== 'quality')
    .sort((a, b) => (inherited.has(a[0]) ? 0.5 : 1) * b[1] - (inherited.has(b[0]) ? 0.5 : 1) * a[1]);
  const top = ranked.sort((a, b) => b[1] - a[1])[0];
  return top ? WORLD_OF[top[0]] : null;
}

/** Re-order concepts so consecutive picks come from different worlds (round-robin). */
export function spreadAcrossWorlds(concepts: string[]): string[] {
  const buckets = new Map<string, string[]>();
  for (const c of concepts) {
    const w = worldOf(c) ?? `solo:${c}`;
    buckets.set(w, [...(buckets.get(w) ?? []), c]);
  }
  const out: string[] = [];
  const lists = [...buckets.values()];
  for (let i = 0; out.length < concepts.length; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}
