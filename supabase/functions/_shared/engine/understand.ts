// AI-first request understanding with rule-based guardrails.
//
// When an AI provider is configured, the LLM is the PRIMARY interpreter of every chat/search message
// (any language), with the previous request as context so follow-ups resolve correctly. The rules
// parser (intent.ts) still runs first: it is the fallback when AI is unavailable, and its explicit
// readings (negations, "doesn't have to be", literal titles) act as guardrails the LLM cannot override.
// Only the user's own words are sent — never catalog data.
import { CATEGORIES, ENTITY_KINDS, ENTITY_WANTS, WORK_KINDS, type Category, type Entity, type EntityKind, type EntityWant, type EntityWork, type Intent, type PreferenceStatement, type ProviderId, type WorkKind } from '../types.ts';
import type { HttpClient } from '../providers/http.ts';
import { modelParams, withRateLimitRetry, type AiConfig } from './ai.ts';
import { CONCEPT_BY_ID, CONCEPT_IDS, MOOD_IDS } from './concepts.ts';
import { entityMedia } from './entities.ts';
import { contentTokens, fold, round } from './text.ts';

const PROVIDER_IDS = ['youtube', 'spotify', 'tmdb', 'openlibrary', 'tvmaze'] as const;

export const UNDERSTAND_PROMPT = `You are the request interpreter of ECHO, a discovery app for videos (YouTube), music, films & series, books and podcasts.
Read the user's message (any language: English, French, Arabic…) and, if given, the previous request it may refine. Output ONLY a JSON object:
{
 "categories": media the user wants, subset of ${JSON.stringify(CATEGORIES)} ("youtube" = YouTube videos, "screen" = films & TV series). [] if not stated.
 "providers": ONLY if the user names a platform as the SOURCE of another media type, e.g. "youtube podcasts" → categories ["podcasts"], providers ["youtube"]; "spotify podcasts" → providers ["spotify"]. Allowed: ${JSON.stringify(PROVIDER_IDS)}. Otherwise [].
 "search": object mapping each wanted category to a short catalog search query (2-6 words, in the language the content should be in) describing the TOPIC, e.g. {"youtube":"origins of civilization documentary"}. Omit categories where the request is only a mood/feeling.
 "concepts": object of concept ids → weight 0..1 that capture the request's themes and moods. Ids: ${JSON.stringify(CONCEPT_IDS)}
 "excludeConcepts": concept ids the user does NOT want.
 "excludeTerms": short phrases the user does NOT want that are not concept ids (e.g. "motivational speeches", "french pop", "true crime").
 "relaxed": concept ids the user says are optional ("doesn't have to be sci-fi").
 "references": titles or creators the user explicitly names, exactly as written. Never invent.
 "entities": named people or works the message is about, at most 3, [] if none. Each: {"name": the name as the user meant it, properly capitalised; "kind": one of ${JSON.stringify(ENTITY_KINDS)} ("artist" = a musician or band, "creator" = a YouTuber or online creator), or "song" / "album" for a song or album title; "lang": for an artist, the main language of their lyrics (e.g. "English", "French"), else omit; "want": "by" (their own work: "songs by X", "X's books") | "like" (similar things: "songs like X", "films like X") | "about" (things about them: "X documentary", "X interview") | "all" (a bare name with nothing else: "eminem", "kendrick lamar", "dune"); "works": up to 4 well-known works about it or closely tied to it in OTHER media than its own, each {"title": official title, "kind": one of ${JSON.stringify(WORK_KINDS)}, "year": release year, "by": author or director, "note": 3-8 words on how it relates}, [] when you know none for sure, never invented}. Example: "eminem" → {"name":"Eminem","kind":"artist","want":"all","works":[{"title":"8 Mile","kind":"film","year":2002,"by":"Curtis Hanson","note":"the film based on his early life"},{"title":"The Way I Am","kind":"book","year":2008,"by":"Eminem","note":"his illustrated memoir"}]}. A bare name is not a stated medium: leave "categories" [] for it.
 "exploration": 0.9 if they want unfamiliar/surprising things, 0.1 if they want familiar/comfort picks, otherwise null.
 "trajectory": {"from": moodId, "to": moodId} only if they describe a mood arc; mood ids: ${JSON.stringify(MOOD_IDS)}. Otherwise null.
 "duration": "short" | "medium" | "long" only if stated, else null.
 "language": ISO 639-1 code of the CONTENT language only if the user asks for it ("in French", "en anglais"), else null.
 "followUp": true if the message refines or reacts to the previous request ("less dark", "only books", "more like that", "they're bad"). In a follow-up, a platform phrase refers to the previous media: after a podcast request, "only the youtube ones" = categories ["podcasts"], providers ["youtube"].
 "rejectPrevious": true if the user says the previous results were bad/wrong.
 "remember": long-term preferences the user explicitly states about themselves, e.g. "I hate horror", "j'adore Stromae" → [{"polarity":1|-1,"subject":"..."}]. [] otherwise.
}
Do not recommend anything ("works" only describe a named entity). Use only the listed ids.`;

export interface Understanding {
  categories: Category[];
  providers: ProviderId[];
  search: Partial<Record<Category, string>>;
  concepts: Record<string, number>;
  excludeConcepts: string[];
  excludeTerms: string[];
  relaxed: string[];
  references: string[];
  entities: Entity[];
  /** Song / album titles the model named (they are references for the music curator, never entities). */
  musicWorks: string[];
  exploration?: number;
  trajectory?: { from: string; to: string };
  duration?: Intent['duration'];
  language?: string;
  followUp: boolean;
  rejectPrevious: boolean;
  remember: PreferenceStatement[];
}

const str = (v: unknown, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const strs = (v: unknown, n = 8, max = 80) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter((x): x is string => !!x).slice(0, n) : []);

/** Edit distance (small strings only). */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const textWords = (text: string) => text.split(/[\s,;:!?.]+/).map(fold).filter(Boolean);
/** The typed word is this word of the name, or a small misspelling of it. */
const sameWord = (w: string, p: string) => w === p || (w[0] === p[0] && editDistance(w, p) <= (p.length >= 6 ? 2 : 1));
/** Words of a name that identify it ("The", "and", "of"… don't). */
const NAME_FILLER = new Set(['the', 'and', 'of', 'a', 'an', 'la', 'le', 'les', 'el', 'los', 'las', 'de', 'des', 'du', 'et']);

/**
 * Did the user write this name (any case/accents, or a small misspelling of each of its words:
 * "kendrik lamar" → "Kendrick Lamar")? The model may correct spelling and capitalisation, never invent.
 * A fuller form of what they typed counts too ("beatles" → "The Beatles", "kendrick" → "Kendrick
 * Lamar"): its first identifying word and at least half of them were typed.
 */
export function nameInText(name: string, text: string): boolean {
  const n = fold(name);
  if (!n || n.length < 2) return false;
  if (fold(text).includes(n)) return true;
  const words = textWords(text);
  const parts = name.split(/[\s\-]+/).map(fold).filter((p) => p.length >= 2);
  if (parts.length > 0 && parts.every((p) => words.some((w) => sameWord(w, p)))) return true;
  const key = parts.filter((p) => !NAME_FILLER.has(p));
  const typed = key.filter((p) => words.some((w) => sameWord(w, p)));
  return key.length > 0 && key[0].length >= 3 && typed.includes(key[0]) && typed.length * 2 >= key.length;
}

const KIND_ALIAS: Record<string, EntityKind> = {
  musician: 'artist', rapper: 'artist', singer: 'artist', band: 'artist', group: 'artist', dj: 'artist', producer: 'artist', composer: 'artist',
  writer: 'author', novelist: 'author', poet: 'author', filmmaker: 'director', youtuber: 'creator', streamer: 'creator', channel: 'creator',
  movie: 'film', documentary: 'film', show: 'series', tv: 'series', 'tv series': 'series', novel: 'book', memoir: 'book',
};
/** A song or album named in a music request is a reference for the curator, never an entity (it is not an artist). */
const MUSIC_WORK_KINDS = new Set(['song', 'album', 'track', 'single', 'ep', 'record', 'mixtape']);
const WORK_ALIAS: Record<string, WorkKind> = { movie: 'film', documentary: 'film', show: 'series', tv: 'series', 'tv series': 'series', novel: 'book', memoir: 'book', biography: 'book', youtube: 'video' };

function entityKind(v: unknown): EntityKind {
  const k = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (ENTITY_KINDS as readonly string[]).includes(k) ? (k as EntityKind) : KIND_ALIAS[k] ?? 'other';
}

function sanitizeWorks(v: unknown): EntityWork[] {
  const out: EntityWork[] = [];
  const clean = (x: unknown, max: number) => str(x, max)?.replace(/[\u0000-\u001f]/g, ' ').trim();
  for (const raw of Array.isArray(v) ? v : []) {
    const w = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const title = clean(w.title, 100);
    const k = typeof w.kind === 'string' ? w.kind.trim().toLowerCase() : '';
    const kind = (WORK_KINDS as readonly string[]).includes(k) ? (k as WorkKind) : WORK_ALIAS[k];
    if (!title || !kind) continue;
    if (out.some((o) => fold(o.title) === fold(title))) continue;
    const year = typeof w.year === 'number' && Number.isInteger(w.year) && w.year > 1800 && w.year < 2100 ? w.year : typeof w.year === 'string' && /^\d{4}$/.test(w.year) ? Number(w.year) : undefined;
    const by = clean(w.by, 60);
    const note = clean(w.note, 80);
    out.push({ title, kind, ...(year ? { year } : {}), ...(by ? { by } : {}), ...(note ? { note } : {}) });
    if (out.length >= 4) break;
  }
  return out;
}

const rawKind = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const entityName = (v: unknown) => str(v, 80)?.replace(/^["'“”«»]+|["'“”«»]+$/g, '').replace(/[\u0000-\u001f]/g, ' ').trim();
/** A lyrics language label ("French", "Darija"), letters only. */
const langLabel = (v: unknown) => {
  const l = str(v, 24);
  return l && /^[\p{L} ]+$/u.test(l) ? l : undefined;
};

/**
 * Entities, kept only when the user actually wrote the name: at most 3, enum kind/want, at most 4 works.
 * `stored`: entities of a stored intent (the previous request), re-checked when loaded; their names were
 * checked against that request's text when it was made.
 */
export function sanitizeEntities(v: unknown, text: string, opts: { stored?: boolean } = {}): Entity[] {
  const out: Entity[] = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const e = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const name = entityName(e.name);
    if (!name || MUSIC_WORK_KINDS.has(rawKind(e.kind)) || (!opts.stored && !nameInText(name, text)) || out.some((o) => fold(o.name) === fold(name))) continue;
    const want = typeof e.want === 'string' && (ENTITY_WANTS as readonly string[]).includes(e.want) ? (e.want as EntityWant) : 'all';
    const works = sanitizeWorks(e.works);
    const kind = entityKind(e.kind);
    const lang = kind === 'artist' ? langLabel(e.lang) : undefined;
    out.push({ name, kind, want, ...(works.length ? { works } : {}), ...(lang ? { lang } : {}), source: opts.stored && e.source === 'rules' ? 'rules' : 'llm' });
    if (out.length >= 3) break;
  }
  return out;
}

/** Song / album titles the model listed as entities (the user wrote them): references for the music curator. */
export function musicWorkNames(v: unknown, text: string): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const e = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const name = entityName(e.name);
    if (name && MUSIC_WORK_KINDS.has(rawKind(e.kind)) && nameInText(name, text) && !out.some((o) => fold(o) === fold(name))) out.push(name);
  }
  return out.slice(0, 3);
}

/** Validate the model's output against ECHO's vocabulary and the user's actual words. */
export function sanitizeUnderstanding(raw: unknown, text: string): Understanding {
  const h = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const lower = text.toLowerCase();
  const musicWorks = musicWorkNames(h.entities, text);
  const categories = strs(h.categories).filter((c): c is Category => (CATEGORIES as readonly string[]).includes(c));
  const providers = strs(h.providers).filter((p): p is ProviderId => (PROVIDER_IDS as readonly string[]).includes(p));
  const search: Partial<Record<Category, string>> = {};
  if (h.search && typeof h.search === 'object') {
    for (const [k, v] of Object.entries(h.search as Record<string, unknown>)) {
      const q = str(v, 80);
      if (q && (CATEGORIES as readonly string[]).includes(k)) search[k as Category] = q.replace(/[^\p{L}\p{N}\s'&\-:]/gu, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  const concepts: Record<string, number> = {};
  if (h.concepts && typeof h.concepts === 'object') {
    for (const [k, v] of Object.entries(h.concepts as Record<string, unknown>)) if (CONCEPT_BY_ID[k] && typeof v === 'number' && isFinite(v)) concepts[k] = Math.max(0, Math.min(1, v));
  }
  const t = h.trajectory as { from?: unknown; to?: unknown } | null | undefined;
  const trajectory = t && typeof t.from === 'string' && typeof t.to === 'string' && MOOD_IDS.includes(t.from) && MOOD_IDS.includes(t.to) && t.from !== t.to ? { from: t.from, to: t.to } : undefined;
  const remember: PreferenceStatement[] = (Array.isArray(h.remember) ? h.remember : [])
    .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}))
    .map((x) => ({ polarity: x.polarity === -1 ? -1 : 1, subject: str(x.subject, 60) ?? '' }) as PreferenceStatement)
    // The subject must literally appear in what the user wrote (no invented preferences).
    .filter((x) => x.subject && lower.includes(x.subject.toLowerCase()))
    .map((x) => ({ ...x, concepts: [] }))
    .slice(0, 4);
  return {
    categories,
    providers,
    search,
    concepts,
    excludeConcepts: strs(h.excludeConcepts).filter((c) => CONCEPT_BY_ID[c]),
    excludeTerms: strs(h.excludeTerms, 6, 40).map((x) => x.toLowerCase()),
    relaxed: strs(h.relaxed).filter((c) => CONCEPT_BY_ID[c]),
    // References must literally appear in the user's text: the model may not invent titles. Song and
    // album titles it named are references too ("songs like <a song>" asks the curator, not an artist's lanes).
    references: [...new Set([...strs(h.references, 3).filter((r) => r.length > 1 && lower.includes(r.toLowerCase())), ...musicWorks])].slice(0, 3),
    entities: sanitizeEntities(h.entities, text),
    musicWorks,
    exploration: typeof h.exploration === 'number' && isFinite(h.exploration) && (h.exploration >= 0.8 || h.exploration <= 0.2) ? h.exploration : undefined,
    trajectory,
    duration: h.duration === 'short' || h.duration === 'medium' || h.duration === 'long' ? h.duration : undefined,
    language: typeof h.language === 'string' && /^[a-z]{2}$/.test(h.language) ? h.language : undefined,
    followUp: h.followUp === true,
    rejectPrevious: h.rejectPrevious === true,
    remember,
  };
}

const INTENT_KINDS = ['discover', 'similar', 'learn', 'mood', 'explore'] as const;
const enumOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined);
const finiteIn = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);

/**
 * A stored intent (chat_sessions.last_intent: the previous request of a conversation) re-checked when
 * loaded. The row is the user's own and writable by them, so nothing in it is trusted: bounded lists and
 * strings, enum values, finite numbers, known concept ids, at most 3 entities (see sanitizeEntities).
 * Null when it isn't an intent at all.
 */
export function sanitizeStoredIntent(raw: unknown): Intent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const h = raw as Record<string, unknown>;
  const rawText = typeof h.rawText === 'string' ? h.rawText.slice(-1000) : '';
  const target: Record<string, number> = {};
  if (h.target && typeof h.target === 'object') {
    for (const [k, v] of Object.entries(h.target as Record<string, unknown>).slice(0, 80)) {
      const x = finiteIn(v, -1, 1.5);
      if (CONCEPT_BY_ID[k] && x !== undefined) target[k] = x;
    }
  }
  const searchQueries: Partial<Record<Category, string>> = {};
  if (h.searchQueries && typeof h.searchQueries === 'object') {
    for (const [k, v] of Object.entries(h.searchQueries as Record<string, unknown>).slice(0, 10)) {
      const q = str(v, 80);
      if (q && (CATEGORIES as readonly string[]).includes(k)) searchQueries[k as Category] = q;
    }
  }
  const t = h.trajectory as { from?: unknown; to?: unknown } | null | undefined;
  const trajectory = t && typeof t === 'object' && typeof t.from === 'string' && typeof t.to === 'string' && MOOD_IDS.includes(t.from) && MOOD_IDS.includes(t.to) ? { from: t.from, to: t.to } : undefined;
  const providers = strs(h.providers, 5).filter((p): p is ProviderId => (PROVIDER_IDS as readonly string[]).includes(p));
  const entities = sanitizeEntities(h.entities, rawText, { stored: true });
  const language = typeof h.language === 'string' && /^[a-z]{2}$/.test(h.language) ? h.language : undefined;
  return {
    intent: enumOf(h.intent, INTENT_KINDS) ?? 'discover',
    rawText,
    categories: [...new Set(strs(h.categories, 5).filter((c): c is Category => (CATEGORIES as readonly string[]).includes(c)))],
    moods: strs(h.moods, 6).filter((m) => MOOD_IDS.includes(m)),
    themes: strs(h.themes, 10).filter((c) => !!CONCEPT_BY_ID[c]),
    genres: strs(h.genres, 6, 40),
    excludes: strs(h.excludes, 12, 80),
    relaxed: strs(h.relaxed, 8, 40),
    energy: enumOf(h.energy, ['low', 'medium', 'high'] as const),
    complexity: enumOf(h.complexity, ['light', 'medium', 'deep'] as const),
    exploration: finiteIn(h.exploration, 0, 1),
    trajectory,
    duration: enumOf(h.duration, ['short', 'medium', 'long'] as const),
    language,
    references: strs(h.references, 3),
    ordinalRefs: (Array.isArray(h.ordinalRefs) ? h.ordinalRefs : []).filter((n): n is number => Number.isInteger(n) && n >= -1 && n < 50).slice(0, 5),
    keywords: strs(h.keywords, 8, 40),
    target,
    vague: h.vague === true,
    // Preference statements were applied to the profile when made; they never carry over.
    statements: [],
    searchQueries: Object.keys(searchQueries).length ? searchQueries : undefined,
    providers: providers.length ? providers : undefined,
    entities: entities.length ? entities : undefined,
    source: enumOf(h.source, ['rules', 'rules+llm', 'rules+client-llm'] as const) ?? 'rules',
  };
}

// Guards: fields only accepted when the user's words support them (EN + FR).
const TRAJ_WORDS = /\b(starts?|begin|from|becom|turns?|ends?|gradual|then|arc|commence|devient|deviens|finit|termine|puis|progressivement)\b|\bd(e|')\s?\S+\s+(a|à)\b/;
const DUR_WORDS = /\b(short|quick|long|minutes?|hours?|brief|epic|binge|court|courte|longue?|heures?|rapide)\b/;
const LANG_WORDS = /\b(english|french|spanish|german|italian|portuguese|japanese|korean|chinese|arabic|russian|hindi|anglais|fran(c|ç)ais|arabe|espagnol|allemand|italien|darija|language|langue|vf|vo|vostfr|subtitles?|sous[- ]titres?)\b/;

/**
 * Merge the LLM's understanding into the rules intent. The LLM decides media types, sources, search
 * phrases and themes; the rules' explicit readings (exclusions, relaxations, literal references) win
 * when they conflict, and unsupported fields are dropped.
 */
export function applyUnderstanding(rules: Intent, u: Understanding, prev: Intent | null): Intent {
  const text = rules.rawText.toLowerCase();
  const follow = !!prev && u.followUp;
  const target = { ...(follow ? Object.fromEntries(Object.entries(prev!.target).map(([k, v]) => [k, round(v * 0.6)])) : {}), ...rules.target };
  for (const [k, v] of Object.entries(u.concepts)) if (!rules.relaxed.includes(k)) target[k] = round(Math.max(target[k] ?? 0, v * 0.9));
  const relaxed = [...new Set([...rules.relaxed, ...u.relaxed])];
  // An LLM "exclude" never overrides an explicit "doesn't have to be".
  const excludeConcepts = u.excludeConcepts.filter((c) => !relaxed.includes(c));
  for (const k of excludeConcepts) target[k] = -0.8;
  for (const k of relaxed) if ((target[k] ?? 0) > 0) delete target[k];
  const trajectory = rules.trajectory ?? (u.trajectory && TRAJ_WORDS.test(text) ? u.trajectory : follow ? prev!.trajectory : undefined);
  if (trajectory) {
    target[trajectory.from] = Math.max(target[trajectory.from] ?? 0, 0.7);
    target[trajectory.to] = Math.max(target[trajectory.to] ?? 0, 0.8);
  }
  for (const k of Object.keys(target)) if (Math.abs(target[k]) < 0.05) delete target[k];

  let categories = u.categories.length ? u.categories : follow && !rules.categories.length ? prev!.categories : rules.categories;
  // Named people/works: this message's, or (a follow-up like "only books") the previous request's
  // (at most 3: a stored intent is re-checked when loaded, see sanitizeStoredIntent).
  let entities = u.entities.length ? u.entities : follow ? prev!.entities?.slice(0, 3) : undefined;
  // The model listed no entity but echoed the rules' candidate name as a reference ("eminem" →
  // references ["Eminem"]): the name stands, as a name of unknown kind. Not when it said the name is a
  // song or album title, and not when it read the message otherwise (no reference: small talk).
  const candidate = rules.entities?.[0];
  if (!entities?.length && !follow && candidate) {
    const echoed = u.references.find((r) => fold(r) === fold(candidate.name));
    if (echoed && !u.musicWorks.some((w) => fold(w) === fold(candidate.name))) entities = [{ ...candidate, name: echoed }];
  }
  // A bare name ("eminem") states no medium: show it in its own medium and the media that tell its story.
  const primary = entities?.[0];
  if (primary && !follow && primary.want === 'all' && !rules.categories.length && !rules.providers?.length && !u.providers.length) categories = entityMedia(primary.kind) ?? categories;
  const providers = u.providers.length ? u.providers : rules.providers?.length ? rules.providers : follow && !u.categories.length ? prev!.providers : undefined;
  const excludes = [...new Set([...rules.excludes, ...excludeConcepts, ...u.excludeTerms, ...(follow ? prev!.excludes : [])])];
  const searchWords = [...new Set(Object.values(u.search).flatMap((q) => contentTokens(q ?? '')))].filter((w) => w.length > 2);
  const keywords = (searchWords.length ? searchWords : rules.keywords).filter((k) => !excludes.some((x) => x.split(' ').includes(k))).slice(0, 8);
  const moods = MOOD_IDS.filter((m) => (target[m] ?? 0) > 0).sort((a, b) => target[b] - target[a]);
  const themes = Object.keys(target).filter((k) => target[k] > 0 && CONCEPT_BY_ID[k] && CONCEPT_BY_ID[k].group !== 'mood').sort((a, b) => target[b] - target[a]);
  const references = rules.references.length ? rules.references : u.references;
  const statements = [...rules.statements, ...u.remember.filter((r) => !rules.statements.some((s) => s.subject.toLowerCase() === r.subject.toLowerCase()))];
  const exploration = rules.exploration ?? u.exploration ?? (follow ? prev!.exploration : undefined);
  const hasSignal = categories.length > 0 || Object.keys(u.search).length > 0 || Object.keys(target).length > 0 || references.length > 0 || rules.ordinalRefs.length > 0 || u.rejectPrevious || statements.length > 0 || !!entities?.length;
  let kind: Intent['intent'] = rules.intent;
  if (kind === 'discover') {
    if ((exploration ?? 0) >= 0.8) kind = 'explore';
    // A bare name ("eminem") is not a "like X" request just because the model echoed it as a reference.
    else if (primary ? primary.want === 'like' : references.length) kind = 'similar';
    else if (trajectory || (moods.length && !themes.length)) kind = 'mood';
  }
  return {
    ...rules,
    intent: kind,
    categories,
    providers: providers?.length ? providers : undefined,
    searchQueries: Object.keys(u.search).length ? u.search : follow ? prev!.searchQueries : undefined,
    target,
    moods,
    themes,
    excludes,
    relaxed,
    references,
    entities: entities?.length ? entities : undefined,
    trajectory,
    duration: rules.duration ?? (u.duration && DUR_WORDS.test(text) ? u.duration : follow ? prev!.duration : undefined),
    language: rules.language ?? (u.language && LANG_WORDS.test(text) ? u.language : follow ? prev!.language : undefined),
    exploration,
    keywords,
    statements,
    vague: !hasSignal,
    source: 'rules+llm',
  };
}

function summarizePrevious(prev: Intent): string {
  const top = Object.entries(prev.target).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k);
  // Entity names are the user's own words (the model normalised their spelling); works are not repeated.
  const entities = (prev.entities ?? []).map((e) => ({ name: e.name, kind: e.kind, want: e.want }));
  return JSON.stringify({ request: prev.rawText.slice(-300), categories: prev.categories, providers: prev.providers ?? [], search: prev.searchQueries ?? {}, concepts: top, excludes: prev.excludes, ...(entities.length ? { entities } : {}) });
}

/** Ask the LLM to interpret the message (with the previous request as context). */
export async function llmUnderstand(text: string, prev: Intent | null, cfg: AiConfig, http: HttpClient): Promise<Understanding> {
  const ask = (model: string) => http.json<{ choices: Array<{ message: { content: string } }> }>(`${cfg.baseUrl}/chat/completions`, {
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        ...modelParams(model),
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: UNDERSTAND_PROMPT },
          { role: 'user', content: `${prev ? `Previous request: ${summarizePrevious(prev)}\n` : ''}Message: ${text.slice(0, 800)}` },
        ],
      }),
    },
    timeoutMs: 8000,
    provider: 'ai',
  });
  let res: { choices: Array<{ message: { content: string } }> };
  try {
    res = await ask(cfg.model);
  } catch (e) {
    if ((e as { kind?: string })?.kind !== 'quota') throw e;
    // Per-minute token limits are per model: when the general model is over its limit, the music model
    // reads the request instead of dropping to the rules parser (which can't tell a film from a band).
    const other = cfg.musicModel && cfg.musicModel !== cfg.model ? cfg.musicModel : null;
    res = other ? await ask(other).catch(() => withRateLimitRetry(() => ask(cfg.model))) : await withRateLimitRetry(() => ask(cfg.model));
  }
  const content = res.choices?.[0]?.message?.content ?? '{}';
  return sanitizeUnderstanding(JSON.parse(content.replace(/^```(json)?|```$/g, '').trim()), text);
}
