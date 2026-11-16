// Persistent taste intelligence: how the profile is created, decays, and learns
// from real feedback (pipeline step 8). Pure functions — persistence is done by
// the caller.
import type { AnalyzedItem, Category, ConceptVector, FeedbackType, TasteProfile } from '../types.ts';
import { CONCEPT_BY_ID } from './concepts.ts';
import { normKey, projectText, round } from './text.ts';
import { FAMILIES, familyOf } from './music.ts';

export const CAP = 3;
const LONG_HALF_LIFE_DAYS = 120;
const SHORT_HALF_LIFE_HOURS = 8;

export function emptyProfile(): TasteProfile {
  return {
    concepts: {},
    conceptsByCategory: {},
    genres: {},
    creators: {},
    categories: {},
    shortTerm: { concepts: {}, updatedAt: null },
    explicit: { likes: [], dislikes: [], statements: [], pinnedConcepts: [], blockedConcepts: [] },
    exploration: 0.4,
    interactionCount: 0,
    updatedAt: null,
    embedding: null,
  };
}

/** Coerce possibly-partial JSON from the database into a full profile. */
export function hydrateProfile(raw: Partial<TasteProfile> | null | undefined): TasteProfile {
  const base = emptyProfile();
  if (!raw) return base;
  return {
    ...base,
    ...raw,
    shortTerm: { ...base.shortTerm, ...(raw.shortTerm ?? {}) },
    explicit: { ...base.explicit, ...(raw.explicit ?? {}) },
    conceptsByCategory: raw.conceptsByCategory ?? {},
    concepts: raw.concepts ?? {},
    genres: raw.genres ?? {},
    creators: raw.creators ?? {},
    categories: raw.categories ?? {},
  };
}

export const FEEDBACK_SIGNAL: Record<Exclude<FeedbackType, 'rate'>, number> = {
  like: 1,
  // Undo a like: mostly reverses what the like taught.
  unlike: -0.7,
  save: 0.7,
  unsave: -0.3,
  consumed: 0.5,
  play: 0.15,
  open: 0.1,
  skip: -0.2,
  dislike: -1,
};

export function feedbackSignal(type: FeedbackType, rating?: number): number {
  if (type === 'rate') {
    const r = Math.min(5, Math.max(1, rating ?? 3));
    return (r - 3) / 2;
  }
  return FEEDBACK_SIGNAL[type];
}

function decayFactor(from: string | null, now: Date, halfLifeMs: number): number {
  if (!from) return 1;
  const dt = now.getTime() - new Date(from).getTime();
  if (!(dt > 0)) return 1;
  return Math.pow(0.5, dt / halfLifeMs);
}

function scaleMap<T extends Record<string, number>>(m: T, f: number, min = 0.01): T {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) {
    const nv = v * f;
    if (Math.abs(nv) >= min) out[k] = round(nv);
  }
  return out as T;
}

/** Apply time decay: long-term preferences fade slowly, moods fade fast. */
export function decayProfile(p: TasteProfile, now = new Date()): TasteProfile {
  const fl = decayFactor(p.updatedAt, now, LONG_HALF_LIFE_DAYS * 86_400_000);
  const fs = decayFactor(p.shortTerm.updatedAt, now, SHORT_HALF_LIFE_HOURS * 3_600_000);
  const byCat: TasteProfile['conceptsByCategory'] = {};
  for (const [c, v] of Object.entries(p.conceptsByCategory)) byCat[c as Category] = scaleMap(v ?? {}, fl);
  return {
    ...p,
    concepts: scaleMap(p.concepts, fl),
    conceptsByCategory: byCat,
    genres: scaleMap(p.genres, fl),
    creators: scaleMap(p.creators, fl),
    shortTerm: { concepts: scaleMap(p.shortTerm.concepts, fs, 0.02), updatedAt: p.shortTerm.updatedAt },
  };
}

function bounded(w: number, delta: number): number {
  // Soft-bounded update: moves towards ±CAP with diminishing steps.
  const next = delta >= 0 ? w + delta * ((CAP - w) / CAP) : w + delta * ((CAP + w) / CAP);
  return round(Math.max(-CAP, Math.min(CAP, next)));
}

export function learningRate(interactionCount: number): number {
  return Math.max(0.12, 0.45 / Math.sqrt(1 + interactionCount / 25));
}

function updateMap(map: Record<string, number>, keys: string[], delta: number, limit = 300): Record<string, number> {
  const out = { ...map };
  for (const k of keys) {
    if (!k) continue;
    out[k] = bounded(out[k] ?? 0, delta);
  }
  // Keep maps bounded in size (drop weakest).
  const entries = Object.entries(out);
  if (entries.length > limit) {
    entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    return Object.fromEntries(entries.slice(0, limit));
  }
  return out;
}

function updateConcepts(map: ConceptVector, item: ConceptVector, delta: number): ConceptVector {
  const out = { ...map };
  for (const [c, x] of Object.entries(item)) out[c] = bounded(out[c] ?? 0, delta * x);
  return out;
}

export function genreKeys(item: AnalyzedItem): string[] {
  return [...new Set(item.genres.map(normKey).filter(Boolean))].slice(0, 8);
}

export function creatorKeys(item: AnalyzedItem): string[] {
  return [...new Set(item.creators.map(normKey).filter(Boolean))].slice(0, 4);
}

/**
 * Learn from one interaction. This is what makes ECHO adapt: every like, save,
 * skip, rating or dislike shifts concept, genre, creator and category weights,
 * which directly change the ranking scores in rank.ts.
 */
export function applyFeedback(
  profile: TasteProfile,
  item: AnalyzedItem,
  type: FeedbackType,
  opts: { rating?: number; now?: Date } = {},
): TasteProfile {
  const now = opts.now ?? new Date();
  const p = decayProfile(profile, now);
  const s = feedbackSignal(type, opts.rating);
  if (s === 0) return { ...p, updatedAt: now.toISOString() };
  const lr = learningRate(p.interactionCount);
  // A single dislike says more about the creator/genre than about every concept in the item.
  const conceptDelta = lr * s * (s < 0 ? 0.5 : 1);

  const concepts = updateConcepts(p.concepts, item.concepts, conceptDelta);
  const catConcepts = updateConcepts(p.conceptsByCategory[item.category] ?? {}, item.concepts, conceptDelta);
  const genres = updateMap(p.genres, genreKeys(item), lr * s * 0.8);
  const creators = updateMap(p.creators, creatorKeys(item), lr * s * 1.2);
  const categories = { ...p.categories, [item.category]: bounded(p.categories[item.category] ?? 0, lr * s * 0.5) };

  const st = { ...p.shortTerm.concepts };
  if (s > 0) for (const [c, x] of Object.entries(item.concepts)) st[c] = round(Math.min(1.5, (st[c] ?? 0) + s * x * 0.6));

  let embedding = p.embedding ?? null;
  if (s > 0 && item.embedding?.length) {
    const a = 0.15 * s;
    if (!embedding || embedding.length !== item.embedding.length) embedding = [...item.embedding];
    else embedding = embedding.map((v, i) => v * (1 - a) + item.embedding![i] * a);
    const n = Math.sqrt(embedding.reduce((acc, v) => acc + v * v, 0)) || 1;
    embedding = embedding.map((v) => round(v / n, 6));
  }

  return {
    ...p,
    concepts,
    conceptsByCategory: { ...p.conceptsByCategory, [item.category]: catConcepts },
    genres,
    creators,
    categories,
    shortTerm: { concepts: st, updatedAt: now.toISOString() },
    interactionCount: p.interactionCount + 1,
    updatedAt: now.toISOString(),
    embedding,
  };
}

/** Temporary mood/context from a conversation; does not touch long-term taste. */
export function applyContext(profile: TasteProfile, target: ConceptVector, now = new Date()): TasteProfile {
  const p = decayProfile(profile, now);
  const st = { ...p.shortTerm.concepts };
  for (const [c, v] of Object.entries(target)) if (v > 0) st[c] = round(Math.min(1.5, (st[c] ?? 0) * 0.5 + v * 0.8));
  return { ...p, shortTerm: { concepts: st, updatedAt: now.toISOString() } };
}

export interface OnboardingInput {
  categories?: Category[];
  interests?: string[];
  description?: string;
  exploration?: number;
}

/** Seed a profile from onboarding answers. Favorite titles are applied separately as real 'like' feedback on resolved catalog items. */
export function seedProfile(profile: TasteProfile, input: OnboardingInput, now = new Date()): TasteProfile {
  let p = { ...profile };
  const cats: TasteProfile['categories'] = { ...p.categories };
  for (const c of input.categories ?? []) cats[c] = Math.max(cats[c] ?? 0, 1);
  const concepts = { ...p.concepts };
  for (const id of input.interests ?? []) if (CONCEPT_BY_ID[id]) concepts[id] = Math.max(concepts[id] ?? 0, 1.2);
  if (input.description) {
    const v = projectText([{ text: input.description, weight: 1.4 }]);
    for (const [k, x] of Object.entries(v)) concepts[k] = round(Math.max(concepts[k] ?? 0, x * 1.1));
  }
  p = {
    ...p,
    categories: cats,
    concepts,
    exploration: input.exploration ?? p.exploration,
    explicit: {
      ...p.explicit,
      statements: input.description ? [...p.explicit.statements, input.description.slice(0, 500)].slice(-20) : p.explicit.statements,
    },
    updatedAt: now.toISOString(),
  };
  return p;
}

/** Record an explicit statement from chat ("I love Tarkovsky" / "I hate horror"). */
export function applyStatement(profile: TasteProfile, subject: string, concepts: string[], polarity: 1 | -1, now = new Date()): TasteProfile {
  const p = { ...profile, explicit: { ...profile.explicit } };
  const key = normKey(subject);
  const c = { ...p.concepts };
  for (const id of concepts) c[id] = bounded(c[id] ?? 0, polarity * 0.9);
  const creators = { ...p.creators };
  const genres = { ...p.genres };
  if (!concepts.length) creators[key] = bounded(creators[key] ?? 0, polarity * 1.2);
  else genres[key] = bounded(genres[key] ?? 0, polarity * 0.6);
  if (polarity > 0) {
    p.explicit.likes = [...new Set([...p.explicit.likes, subject])].slice(-50);
    p.explicit.dislikes = p.explicit.dislikes.filter((d) => normKey(d) !== key);
  } else {
    p.explicit.dislikes = [...new Set([...p.explicit.dislikes, subject])].slice(-50);
    p.explicit.likes = p.explicit.likes.filter((d) => normKey(d) !== key);
  }
  return { ...p, concepts: c, creators, genres, updatedAt: now.toISOString() };
}

export interface ProfileEdit {
  setConcept?: { id: string; weight: number };
  removeConcept?: string;
  pinConcept?: string;
  unpinConcept?: string;
  blockConcept?: string;
  unblockConcept?: string;
  removeCreator?: string;
  removeGenre?: string;
  removeStatement?: string;
  removeLike?: string;
  removeDislike?: string;
  exploration?: number;
  /** Music style family control from My Taste → Music mix. */
  family?: { id: string; action: 'more' | 'less' | 'never' | 'allow' };
}

/** User-driven corrections from the My Taste screen. */
export function applyEdit(profile: TasteProfile, e: ProfileEdit): TasteProfile {
  const p: TasteProfile = { ...profile, concepts: { ...profile.concepts }, creators: { ...profile.creators }, genres: { ...profile.genres }, explicit: { ...profile.explicit } };
  const valid = (id?: string) => !!id && !!CONCEPT_BY_ID[id];
  if (e.setConcept && valid(e.setConcept.id)) p.concepts[e.setConcept.id] = round(Math.max(-CAP, Math.min(CAP, e.setConcept.weight)));
  if (valid(e.removeConcept)) {
    delete p.concepts[e.removeConcept!];
    for (const cat of Object.keys(p.conceptsByCategory) as Category[]) {
      const m = { ...(p.conceptsByCategory[cat] ?? {}) };
      delete m[e.removeConcept!];
      p.conceptsByCategory = { ...p.conceptsByCategory, [cat]: m };
    }
  }
  if (valid(e.pinConcept)) {
    p.explicit.pinnedConcepts = [...new Set([...p.explicit.pinnedConcepts, e.pinConcept!])];
    p.explicit.blockedConcepts = p.explicit.blockedConcepts.filter((x) => x !== e.pinConcept);
    p.concepts[e.pinConcept!] = Math.max(p.concepts[e.pinConcept!] ?? 0, 1.5);
  }
  if (e.unpinConcept) p.explicit.pinnedConcepts = p.explicit.pinnedConcepts.filter((x) => x !== e.unpinConcept);
  if (valid(e.blockConcept)) {
    p.explicit.blockedConcepts = [...new Set([...p.explicit.blockedConcepts, e.blockConcept!])];
    p.explicit.pinnedConcepts = p.explicit.pinnedConcepts.filter((x) => x !== e.blockConcept);
    p.concepts[e.blockConcept!] = Math.min(p.concepts[e.blockConcept!] ?? 0, -1.5);
  }
  if (e.unblockConcept) {
    p.explicit.blockedConcepts = p.explicit.blockedConcepts.filter((x) => x !== e.unblockConcept);
    if ((p.concepts[e.unblockConcept] ?? 0) < 0) delete p.concepts[e.unblockConcept];
  }
  if (e.removeCreator) delete p.creators[normKey(e.removeCreator)];
  if (e.removeGenre) delete p.genres[normKey(e.removeGenre)];
  if (e.removeStatement) p.explicit.statements = p.explicit.statements.filter((s) => s !== e.removeStatement);
  if (e.removeLike) p.explicit.likes = p.explicit.likes.filter((s) => s !== e.removeLike);
  if (e.removeDislike) p.explicit.dislikes = p.explicit.dislikes.filter((s) => s !== e.removeDislike);
  if (typeof e.exploration === 'number') p.exploration = Math.max(0, Math.min(1, e.exploration));
  if (e.family && FAMILIES.some((f) => f.id === e.family!.id)) {
    const { id, action } = e.family;
    const genres = { ...p.genres };
    for (const [g, w] of Object.entries(genres)) {
      if (familyOf(g) !== id) continue;
      if (action === 'more') genres[g] = round(Math.min(CAP, Math.max(w, 0) * 1.6 + 0.3));
      if (action === 'less') genres[g] = round(w > 0 ? w * 0.45 : w);
      if (action === 'allow' && w < 0) delete genres[g];
    }
    p.genres = genres;
    const blocked = new Set(p.explicit.blockedFamilies ?? []);
    if (action === 'never') blocked.add(id);
    if (action === 'allow' || action === 'more') blocked.delete(id);
    p.explicit = { ...p.explicit, blockedFamilies: [...blocked] };
  }
  return p;
}
