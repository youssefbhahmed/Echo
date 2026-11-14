// Derived, explainable views of a taste profile for the "My Taste" screen.
// These are descriptive summaries of recorded signals, not psychological claims.
import type { Category, ConceptVector, TasteProfile } from '../types.ts';
import { CONCEPT_BY_ID, conceptLabel } from './concepts.ts';
import { round } from './text.ts';

export interface TasteCluster {
  id: string;
  label: string;
  concepts: Array<{ id: string; label: string; weight: number }>;
  weight: number;
}

export interface CrossMediaConnection {
  concept: string;
  label: string;
  categories: Array<{ category: Category; weight: number }>;
}

export interface TasteInsights {
  clusters: TasteCluster[];
  themes: Array<{ id: string; label: string; weight: number }>;
  moods: Array<{ id: string; label: string; weight: number }>;
  qualities: Array<{ id: string; label: string; weight: number }>;
  avoid: Array<{ id: string; label: string; weight: number }>;
  creators: Array<{ name: string; weight: number }>;
  genres: Array<{ name: string; weight: number }>;
  categories: Array<{ category: Category; weight: number }>;
  connections: CrossMediaConnection[];
  emerging: Array<{ id: string; label: string; delta: number }>;
  currentMood: Array<{ id: string; label: string; weight: number }>;
  confidence: 'none' | 'low' | 'medium' | 'high';
}

function entries(v: ConceptVector, min = 0.05) {
  return Object.entries(v)
    .filter(([k, w]) => w >= min && CONCEPT_BY_ID[k])
    .sort((a, b) => b[1] - a[1])
    .map(([id, weight]) => ({ id, label: conceptLabel(id), weight: round(weight, 3) }));
}

/** Group strong concepts into clusters using the concept adjacency graph (connected components). */
export function clusterConcepts(concepts: ConceptVector, min = 0.3): TasteCluster[] {
  const strong = Object.keys(concepts).filter((k) => concepts[k] >= min && CONCEPT_BY_ID[k]);
  const set = new Set(strong);
  const seen = new Set<string>();
  const clusters: TasteCluster[] = [];
  for (const start of strong.sort((a, b) => concepts[b] - concepts[a])) {
    if (seen.has(start)) continue;
    const stack = [start];
    const members: string[] = [];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      members.push(cur);
      const def = CONCEPT_BY_ID[cur];
      const neighbours = [...def.related, ...strong.filter((o) => CONCEPT_BY_ID[o].related.includes(cur))];
      for (const n of neighbours) if (set.has(n) && !seen.has(n)) stack.push(n);
    }
    members.sort((a, b) => concepts[b] - concepts[a]);
    const weight = members.reduce((s, m) => s + concepts[m], 0);
    clusters.push({
      id: members[0],
      label: members.slice(0, 2).map(conceptLabel).join(' · '),
      concepts: members.map((m) => ({ id: m, label: conceptLabel(m), weight: round(concepts[m], 3) })),
      weight: round(weight, 3),
    });
  }
  return clusters.sort((a, b) => b.weight - a.weight).slice(0, 6);
}

export function crossMediaConnections(p: TasteProfile, min = 0.25): CrossMediaConnection[] {
  const byConcept = new Map<string, Array<{ category: Category; weight: number }>>();
  for (const [cat, vec] of Object.entries(p.conceptsByCategory) as Array<[Category, ConceptVector]>) {
    for (const [k, w] of Object.entries(vec ?? {})) {
      if (w < min || !CONCEPT_BY_ID[k]) continue;
      const arr = byConcept.get(k) ?? [];
      arr.push({ category: cat, weight: round(w, 3) });
      byConcept.set(k, arr);
    }
  }
  return [...byConcept.entries()]
    .filter(([, cats]) => cats.length >= 2)
    .map(([concept, categories]) => ({ concept, label: conceptLabel(concept), categories: categories.sort((a, b) => b.weight - a.weight) }))
    .sort((a, b) => b.categories.length - a.categories.length || b.categories.reduce((s, c) => s + c.weight, 0) - a.categories.reduce((s, c) => s + c.weight, 0))
    .slice(0, 8);
}

export function emergingInterests(current: ConceptVector, previous: ConceptVector | null): Array<{ id: string; label: string; delta: number }> {
  if (!previous) return [];
  return Object.keys(current)
    .filter((k) => CONCEPT_BY_ID[k])
    .map((k) => ({ id: k, label: conceptLabel(k), delta: round((current[k] ?? 0) - (previous[k] ?? 0), 3) }))
    .filter((x) => x.delta >= 0.2 && (current[x.id] ?? 0) > 0.2)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 5);
}

export function buildInsights(p: TasteProfile, previousSnapshot: ConceptVector | null = null): TasteInsights {
  const all = entries(p.concepts);
  const group = (g: 'theme' | 'mood' | 'quality') => all.filter((x) => CONCEPT_BY_ID[x.id].group === g);
  const n = p.interactionCount;
  return {
    clusters: clusterConcepts(p.concepts),
    themes: group('theme').slice(0, 12),
    moods: group('mood').slice(0, 8),
    qualities: group('quality'),
    avoid: Object.entries(p.concepts).filter(([k, w]) => w <= -0.3 && CONCEPT_BY_ID[k]).sort((a, b) => a[1] - b[1]).map(([id, w]) => ({ id, label: conceptLabel(id), weight: round(w, 3) })),
    creators: Object.entries(p.creators).filter(([, w]) => w > 0.2).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, weight]) => ({ name, weight: round(weight, 3) })),
    genres: Object.entries(p.genres).filter(([, w]) => w > 0.2).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, weight]) => ({ name, weight: round(weight, 3) })),
    categories: (Object.entries(p.categories) as Array<[Category, number]>).sort((a, b) => b[1] - a[1]).map(([category, weight]) => ({ category, weight: round(weight, 3) })),
    connections: crossMediaConnections(p),
    emerging: emergingInterests(p.concepts, previousSnapshot),
    currentMood: entries(p.shortTerm.concepts, 0.15).filter((x) => CONCEPT_BY_ID[x.id].group === 'mood').slice(0, 4),
    confidence: n === 0 && all.length === 0 ? 'none' : n < 10 ? 'low' : n < 50 ? 'medium' : 'high',
  };
}
