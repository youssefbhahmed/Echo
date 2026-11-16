// Pipeline steps 5–7 — personal ranking, diversity adjustment, explanation.
import type { AnalyzedItem, ConceptVector, Explanation, Intent, Recommendation, ScoreBreakdown, TasteProfile } from '../types.ts';
import { conceptPhrase, CONCEPT_BY_ID } from './concepts.ts';
import { creatorKeys, genreKeys } from './profile.ts';
import { contentTokens, cosine, denseCosine, negativePart, normalize, normKey, positivePart, round } from './text.ts';

export interface EvidenceItem {
  id: string;
  title: string;
  category: AnalyzedItem['category'];
  kind: AnalyzedItem['kind'];
  concepts: ConceptVector;
}

export interface ReferenceInfo {
  title: string;
  concepts: ConceptVector;
  /** Provider that resolved the reference (e.g. 'tmdb'). */
  provider: string;
}

export interface RankContext {
  /** Effective exploration in 0..1 (0 familiar, 1 adventurous). */
  exploration: number;
  hasQuery: boolean;
  /** Items that must not be recommended (disliked, already consumed, already shown in this session). */
  excludeIds?: Set<string>;
  /** Items that ARE the referenced works themselves. */
  referenceIds?: Set<string>;
  /** Items the provider itself lists as similar to a reference → reference title. */
  referenceSimilar?: Map<string, string>;
  references?: ReferenceInfo[];
  /** Item-item collaborative score 0..1. */
  collaborative?: Map<string, number>;
  /** Items the user liked/saved, for grounded "because you liked X" explanations. */
  evidence?: EvidenceItem[];
  queryEmbedding?: number[] | null;
  limit?: number;
  now?: Date;
}

const LANG_NAMES: Record<string, string> = { en: 'English', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic', ru: 'Russian', hi: 'Hindi' };

function clamp(x: number, lo = -1, hi = 1) {
  return Math.max(lo, Math.min(hi, x));
}

function maxAffinity(map: Record<string, number>, keys: string[]): number {
  let best = 0;
  let bestAbs = 0;
  for (const k of keys) {
    const v = map[k];
    if (v !== undefined && Math.abs(v) > bestAbs) {
      best = v;
      bestAbs = Math.abs(v);
    }
  }
  return best;
}

function durationMismatch(item: AnalyzedItem, pref?: Intent['duration']): boolean {
  if (!pref || !item.durationSec) return false;
  const m = item.durationSec / 60;
  if (item.kind === 'track') return false;
  if (pref === 'short') return m > 25;
  if (pref === 'long') return m < 20;
  return m < 5 || m > 150;
}

function keywordMatch(item: AnalyzedItem, keywords: string[]): { score: number; hits: string[] } {
  if (!keywords.length) return { score: 0, hits: [] };
  const hay = new Set(contentTokens(`${item.title} ${item.genres.join(' ')} ${item.tags.slice(0, 30).join(' ')} ${(item.description ?? '').slice(0, 1200)}`));
  const hits = keywords.filter((k) => hay.has(k) || [...hay].some((h) => h.length >= 5 && k.length >= 5 && (h.startsWith(k.slice(0, 5)))));
  return { score: hits.length / keywords.length, hits };
}

export interface ProfileView {
  positive: ConceptVector;
  negative: ConceptVector;
  shortTerm: ConceptVector;
  cold: boolean;
}

export function profileView(p: TasteProfile): ProfileView {
  const combined: ConceptVector = { ...p.concepts };
  for (const id of p.explicit.pinnedConcepts) combined[id] = Math.max(combined[id] ?? 0, 1.5);
  for (const id of p.explicit.blockedConcepts) combined[id] = Math.min(combined[id] ?? 0, -1.5);
  const positive = positivePart(combined);
  return {
    positive,
    negative: negativePart(combined),
    shortTerm: positivePart(p.shortTerm.concepts),
    cold: Object.keys(positive).length === 0 && Object.keys(p.genres).length === 0 && Object.keys(p.creators).length === 0,
  };
}

export function scoreItem(item: AnalyzedItem, intent: Intent, profile: TasteProfile, view: ProfileView, ctx: RankContext): ScoreBreakdown & { keywordHits: string[] } {
  const e = clamp(ctx.exploration, 0, 1);
  const targetPos = positivePart(intent.target);
  const targetNeg = negativePart(intent.target);

  // Query relevance
  const kw = keywordMatch(item, intent.keywords);
  const itemGenres = genreKeys(item);
  const genreHit = intent.genres.length ? (intent.genres.some((g) => itemGenres.some((ig) => ig.includes(normKey(g))) || normalize(item.title + ' ' + item.tags.join(' ')).includes(normKey(g))) ? 1 : 0) : 0;
  let query = 0;
  if (Object.keys(targetPos).length || kw.hits.length || genreHit) {
    const wConcept = Object.keys(targetPos).length ? 0.6 : 0;
    const wKw = intent.keywords.length ? 0.28 : 0;
    const wGenre = intent.genres.length ? 0.2 : 0;
    const denom = wConcept + wKw + wGenre || 1;
    query = (wConcept * cosine(targetPos, item.concepts) + wKw * kw.score + wGenre * genreHit) / denom;
  }
  if (ctx.referenceSimilar?.has(item.id)) query = Math.min(1, query + 0.35);
  if (ctx.references?.length) {
    const refSim = Math.max(...ctx.references.map((r) => cosine(r.concepts, item.concepts)));
    query = Math.max(query, 0.5 * query + 0.5 * refSim);
  }

  // Personal relevance
  const deep = view.cold ? 0 : cosine(view.positive, item.concepts) - 0.5 * cosine(view.negative, item.concepts);
  const g = Math.tanh(maxAffinity(profile.genres, itemGenres) / 1.5);
  const c = Math.tanh(maxAffinity(profile.creators, creatorKeys(item)) / 1.5);
  const cat = Math.tanh((profile.categories[item.category] ?? 0) / 1.5);
  const surface = clamp(0.4 * g + 0.45 * c + 0.15 * cat);
  // Familiarity saturates faster than affinity: two likes for a genre already make it "known".
  const familiarity = Math.max(0, Math.tanh(maxAffinity(profile.genres, itemGenres) / 0.6), Math.tanh(maxAffinity(profile.creators, creatorKeys(item)) / 0.6), 0.4 * cat);
  const novelty = 1 - Math.min(1, familiarity);
  const context = cosine(view.shortTerm, item.concepts);
  const quality = item.rating ?? item.popularity ?? 0.5;
  const collaborative = ctx.collaborative?.get(item.id) ?? 0;
  let semantic = 0;
  if (ctx.queryEmbedding && item.embedding) semantic = clamp((denseCosine(ctx.queryEmbedding, item.embedding) - 0.72) / 0.2, 0, 1);
  else if (profile.embedding && item.embedding) semantic = clamp((denseCosine(profile.embedding, item.embedding) - 0.72) / 0.2, 0, 1);

  // Penalties (hard constraints become large penalties so they still rank last if nothing else is available)
  let penalty = 0;
  if (cosine(targetNeg, item.concepts) > 0.2) penalty += 0.5;
  const excluded = new Set(intent.excludes.map(normKey));
  if (itemGenres.some((ig) => [...excluded].some((x) => ig.includes(x)))) penalty += 0.5;
  // Free-text exclusions ("no motivational speeches") and explicit dislikes ("I hate true crime")
  const itemText = ` ${normalize(`${item.title} ${item.creators.join(' ')} ${item.genres.join(' ')} ${item.tags.slice(0, 25).join(' ')} ${(item.description ?? '').slice(0, 600)}`)} `;
  const freeTerms = intent.excludes.filter((x) => !CONCEPT_BY_ID[x]).map(normKey).filter((x) => x.length > 2);
  // Stem match ("speeches" ~ "speech"): every word of the phrase must appear in the item.
  const has = (phrase: string) => {
    const words = normKey(phrase).split(' ').filter((w) => w.length > 2);
    return words.length > 0 && words.every((w) => itemText.includes(` ${w.slice(0, Math.max(4, w.length - 2))}`));
  };
  if (freeTerms.some(has)) penalty += 0.8;
  if (profile.explicit.dislikes.some(has)) penalty += 0.6;
  for (const b of profile.explicit.blockedConcepts) if ((item.concepts[b] ?? 0) >= 0.3) penalty += 0.4;
  if (c < -0.3) penalty += 0.4;
  if (g < -0.4) penalty += 0.2;
  if (durationMismatch(item, intent.duration)) penalty += 0.15;
  if (intent.language && item.language && !item.language.toLowerCase().startsWith(intent.language)) penalty += 0.25;
  if (intent.energy === 'low' && (item.concepts.energetic ?? 0) > 0.5) penalty += 0.1;
  if (intent.energy === 'high' && (item.concepts.calm ?? 0) > 0.5) penalty += 0.1;

  const familiarPart = 0.55 * deep + 0.45 * surface;
  // Adventurous: a meaningful deep connection is enough (saturates at 0.5); unfamiliarity decides.
  const adventurousPart = 0.5 * Math.min(1, Math.max(-1, deep) / 0.5) + 0.5 * novelty - 0.3 * Math.max(0, surface);
  const personal = (1 - e) * familiarPart + e * adventurousPart;

  const semW = item.embedding && (ctx.queryEmbedding || profile.embedding) ? 1 : 0;
  let w;
  if (ctx.hasQuery) w = { q: 0.5 - 0.06 * semW, p: view.cold ? 0.12 : 0.28, x: 0.05, ql: 0.09, cf: 0.04, s: 0.08 * semW };
  else w = { q: Object.keys(targetPos).length ? 0.22 : 0.05, p: view.cold ? 0.25 : 0.5, x: 0.1, ql: 0.12, cf: 0.06, s: 0.05 * semW };
  if (view.cold) w.ql += 0.1;

  w.x *= 1 - 0.6 * e;
  const total = w.q * query + w.p * personal + w.x * context + w.ql * quality + w.cf * collaborative + w.s * semantic - penalty;
  return {
    query: round(query),
    deep: round(deep),
    surface: round(surface),
    novelty: round(novelty),
    context: round(context),
    quality: round(quality),
    collaborative: round(collaborative),
    semantic: round(semantic),
    penalty: round(penalty),
    total: round(total),
    keywordHits: kw.hits,
  };
}

/** Similarity between two items, used for diversity (MMR). */
export function itemSimilarity(a: AnalyzedItem, b: AnalyzedItem, multiCategory: boolean): number {
  const ca = creatorKeys(a);
  if (ca.length && creatorKeys(b).some((x) => ca.includes(x))) return 1;
  const sharedGenre = genreKeys(a).some((x) => genreKeys(b).includes(x)) ? 1 : 0;
  const sameCat = a.category === b.category ? 1 : 0;
  return 0.65 * cosine(a.concepts, b.concepts) + 0.2 * sharedGenre * sameCat + (multiCategory ? 0.15 * sameCat : 0);
}

/** Maximal Marginal Relevance re-ranking: balances relevance and variety. */
export function diversify<T extends { item: AnalyzedItem; score: ScoreBreakdown }>(ranked: T[], limit: number, exploration: number, multiCategory: boolean): T[] {
  const lambda = 0.82 - 0.22 * clamp(exploration, 0, 1);
  const pool = [...ranked];
  const selected: T[] = [];
  const creatorCount = new Map<string, number>();
  while (selected.length < limit && pool.length) {
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      const creators = creatorKeys(cand.item);
      if (creators.some((cr) => (creatorCount.get(cr) ?? 0) >= 2)) continue;
      const maxSim = selected.length ? Math.max(...selected.map((s) => itemSimilarity(cand.item, s.item, multiCategory))) : 0;
      const val = lambda * cand.score.total - (1 - lambda) * maxSim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const [chosen] = pool.splice(bestIdx, 1);
    for (const cr of creatorKeys(chosen.item)) creatorCount.set(cr, (creatorCount.get(cr) ?? 0) + 1);
    selected.push(chosen);
  }
  return selected;
}

/** Order picks so the sequence travels along the requested emotional arc. */
export function sequenceTrajectory<T extends { item: AnalyzedItem }>(items: T[], from: string, to: string): Array<T & { trajectoryStep: number }> {
  const scored = items.map((x) => ({ x, pos: (x.item.concepts[to] ?? 0) - (x.item.concepts[from] ?? 0) }));
  scored.sort((a, b) => a.pos - b.pos);
  return scored.map((s, i) => ({ ...s.x, trajectoryStep: i }));
}

function list(labels: string[]): string {
  const l = labels.map((x) => x.toLowerCase());
  if (l.length <= 1) return l[0] ?? '';
  return `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
}

function kindNoun(kind: AnalyzedItem['kind'], plural = false): string {
  const m: Record<string, [string, string]> = {
    video: ['video', 'videos'], track: ['song', 'songs'], album: ['album', 'albums'], artist: ['artist', 'artists'], playlist: ['playlist', 'playlists'],
    movie: ['film', 'films'], series: ['series', 'series'], book: ['book', 'books'], podcast: ['podcast', 'podcasts'], episode: ['episode', 'episodes'],
  };
  return (m[kind] ?? ['pick', 'picks'])[plural ? 1 : 0];
}

/**
 * Build a grounded explanation. Every clause is derived from (a) concepts found
 * in the item's own provider metadata, (b) the parsed request, or (c) the
 * user's recorded profile/feedback. Nothing is invented.
 */
export function explain(item: AnalyzedItem, score: ScoreBreakdown & { keywordHits?: string[] }, intent: Intent, profile: TasteProfile, view: ProfileView, ctx: RankContext, trajectoryStep?: number, total?: number): Explanation {
  const reasons: Explanation['reasons'] = [];
  // Claims about an item's qualities only use concepts found in its OWN metadata (not ones inherited from the search query).
  const inherited = new Set(Array.isArray(item.metadata?.inheritedConcepts) ? (item.metadata!.inheritedConcepts as string[]) : []);
  const strong = (cv: ConceptVector, min = 0.25) => Object.keys(cv).filter((k) => !inherited.has(k) && (item.concepts[k] ?? 0) >= min && cv[k] > 0);
  const matchedConcepts = Object.entries(item.concepts).filter(([k, v]) => v >= 0.25 && !inherited.has(k)).sort((a, b) => b[1] - a[1]).map(([k]) => k);

  const refTitle = ctx.referenceSimilar?.get(item.id);
  if (refTitle) reasons.push({ kind: 'reference', detail: `Listed as similar to ${refTitle} by the catalog provider` });
  else if (ctx.references?.length) {
    for (const r of ctx.references) {
      const shared = Object.keys(r.concepts).filter((k) => !inherited.has(k) && r.concepts[k] >= 0.3 && (item.concepts[k] ?? 0) >= 0.3).sort((a, b) => r.concepts[b] - r.concepts[a]).slice(0, 3);
      if (shared.length) {
        reasons.push({ kind: 'reference', detail: `Shares the ${list(shared.map(conceptPhrase))} qualities of ${r.title}` });
        break;
      }
    }
  }

  if (trajectoryStep !== undefined && intent.trajectory && total) {
    const { from, to } = intent.trajectory;
    const hasFrom = (item.concepts[from] ?? 0) >= 0.25;
    const hasTo = (item.concepts[to] ?? 0) >= 0.25;
    const phase = trajectoryStep < total / 3 ? 'opens' : trajectoryStep >= (2 * total) / 3 ? 'resolves' : 'bridges';
    // Only claim a role in the arc that the item's own metadata supports.
    let detail: string | null = null;
    if (phase === 'opens' && hasFrom) detail = `Opens the arc in a ${conceptPhrase(from)} register`;
    else if (phase === 'resolves' && hasTo) detail = `Lands on the ${conceptPhrase(to)} end of the arc`;
    else if (hasFrom && hasTo) detail = `Bridges ${conceptPhrase(from)} and ${conceptPhrase(to)}`;
    if (detail) reasons.push({ kind: 'trajectory', detail: `Step ${trajectoryStep + 1} of ${total}: ${detail.charAt(0).toLowerCase()}${detail.slice(1)}` });
  }

  const qMatched = strong(positivePart(intent.target)).sort((a, b) => (intent.target[b] ?? 0) - (intent.target[a] ?? 0)).slice(0, 3);
  const qMoods = qMatched.filter((k) => CONCEPT_BY_ID[k]?.group === 'mood');
  const qThemes = qMatched.filter((k) => CONCEPT_BY_ID[k]?.group !== 'mood');
  if (qMatched.length && ctx.hasQuery) {
    const parts = [qThemes.length ? `the ${list(qThemes.map(conceptPhrase))} you asked about` : '', qMoods.length ? `the ${list(qMoods.map(conceptPhrase))} feel you wanted` : ''].filter(Boolean);
    reasons.push({ kind: 'query', detail: `Speaks to ${parts.join(', with ')}` });
  }
  else if (qMatched.length) reasons.push({ kind: 'context', detail: `Fits the ${list(qMatched.map(conceptPhrase))} mood you selected` });
  else if (score.keywordHits?.length && ctx.hasQuery) reasons.push({ kind: 'query', detail: `Directly about ${score.keywordHits.slice(0, 3).join(', ')}` });

  // Creator familiarity
  const cKeys = creatorKeys(item);
  const likedCreator = item.creators.find((_cr, i) => (profile.creators[cKeys[i]] ?? 0) >= 0.5);
  if (likedCreator && ctx.exploration < 0.75) reasons.push({ kind: 'creator', detail: `From ${likedCreator}, whose work you've responded to` });

  // Profile / cross-media evidence
  if (!view.cold) {
    const pMatched = strong(view.positive, 0.3).sort((a, b) => view.positive[b] - view.positive[a]).slice(0, 2);
    if (pMatched.length) {
      const ev = (ctx.evidence ?? [])
        .filter((e) => e.id !== item.id)
        .map((e) => ({ e, overlap: pMatched.filter((k) => (e.concepts[k] ?? 0) >= 0.3).length, cross: e.category !== item.category }))
        .filter((x) => x.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap || Number(b.cross) - Number(a.cross))[0];
      const labels = list(pMatched.map(conceptPhrase));
      if (ev && ev.cross) reasons.push({ kind: 'profile', detail: `You liked ${ev.e.title} (${kindNoun(ev.e.kind)}); this ${kindNoun(item.kind)} carries the same ${labels} qualities` });
      else if (ev) reasons.push({ kind: 'profile', detail: `In the ${labels} vein of ${ev.e.title}, which you liked` });
      else reasons.push({ kind: 'profile', detail: `Aligned with your interest in ${labels}` });
    }
  }

  // Novelty (adventurous mode)
  if (ctx.exploration >= 0.55 && score.novelty >= 0.7 && score.deep > 0.15) {
    const shared = strong(view.positive, 0.3).slice(0, 2);
    const genre = item.genres[0];
    reasons.push({
      kind: 'novelty',
      detail: shared.length ? `A step outside your usual ${genre ? `territory (${genre.toLowerCase()})` : 'territory'}, connected through ${list(shared.map(conceptPhrase))}` : `Something new to you${genre ? ` in ${genre.toLowerCase()}` : ''}`,
    });
  }

  if (score.collaborative >= 0.3) reasons.push({ kind: 'collaborative', detail: 'Saved by people whose likes overlap with yours' });

  if (item.rating !== undefined && item.rating >= 0.72) {
    const src = item.provider === 'tmdb' ? 'TMDB' : item.provider === 'tvmaze' ? 'TVmaze' : item.provider === 'openlibrary' ? 'Open Library readers' : item.provider;
    const scale = item.provider === 'openlibrary' ? `${round(item.rating * 5, 1)}/5` : `${round(item.rating * 10, 1)}/10`;
    reasons.push({ kind: 'quality', detail: `Rated ${scale} by ${src}` });
  }

  if (!reasons.length) {
    const by = typeof item.metadata?.retrievedBy === 'string' ? item.metadata.retrievedBy : null;
    if (by) reasons.push({ kind: 'query', detail: `Found by searching ${item.provider === 'youtube' ? 'YouTube' : item.provider} for “${by}”` });
    if (matchedConcepts.length) reasons.push({ kind: 'query', detail: `Tagged ${list(matchedConcepts.slice(0, 2).map(conceptPhrase))} from its description and genres` });
  }

  const order: Explanation['reasons'][number]['kind'][] = ['reference', 'trajectory', 'query', 'context', 'profile', 'creator', 'novelty', 'collaborative', 'quality'];
  const sorted = [...reasons].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const top = sorted.slice(0, 2).map((r) => r.detail);
  const text = top.length ? `${top.join('. ')}.` : 'Retrieved for your request; not enough metadata to say more.';
  if (intent.language && item.language && LANG_NAMES[intent.language] && item.language.startsWith(intent.language)) sorted.push({ kind: 'query', detail: `In ${LANG_NAMES[intent.language]}` });
  return { text, reasons: sorted, matchedConcepts: matchedConcepts.filter((k) => CONCEPT_BY_ID[k]).slice(0, 6) };
}

/** Full ranking: score → filter → diversify → sequence → explain. */
export function rankCandidates(candidates: AnalyzedItem[], intent: Intent, profile: TasteProfile, ctx: RankContext): Recommendation[] {
  const limit = ctx.limit ?? 12;
  const view = profileView(profile);
  const seen = new Set<string>();
  const scored: Array<{ item: AnalyzedItem; score: ScoreBreakdown & { keywordHits: string[] } }> = [];
  for (const item of candidates) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (ctx.excludeIds?.has(item.id) || ctx.referenceIds?.has(item.id)) continue;
    scored.push({ item, score: scoreItem(item, intent, profile, view, ctx) });
  }
  scored.sort((a, b) => b.score.total - a.score.total);
  const cats = new Set(scored.map((s) => s.item.category));
  let picked: Array<{ item: AnalyzedItem; score: ScoreBreakdown & { keywordHits: string[] }; trajectoryStep?: number }> = diversify(scored, limit, ctx.exploration, cats.size > 1);
  if (intent.trajectory) picked = sequenceTrajectory(picked, intent.trajectory.from, intent.trajectory.to);
  return picked.map((p) => {
    const { keywordHits, ...score } = p.score;
    return {
      item: p.item,
      score,
      trajectoryStep: p.trajectoryStep,
      explanation: explain(p.item, { ...score, keywordHits }, intent, profile, view, ctx, p.trajectoryStep, picked.length),
    };
  });
}
