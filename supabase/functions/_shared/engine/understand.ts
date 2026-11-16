// AI-first request understanding with rule-based guardrails.
//
// When an AI provider is configured, the LLM is the PRIMARY interpreter of every chat/search message
// (any language), with the previous request as context so follow-ups resolve correctly. The rules
// parser (intent.ts) still runs first: it is the fallback when AI is unavailable, and its explicit
// readings (negations, "doesn't have to be", literal titles) act as guardrails the LLM cannot override.
// Only the user's own words are sent — never catalog data.
import { CATEGORIES, type Category, type Intent, type PreferenceStatement, type ProviderId } from '../types.ts';
import type { HttpClient } from '../providers/http.ts';
import { modelParams, withRateLimitRetry, type AiConfig } from './ai.ts';
import { CONCEPT_BY_ID, CONCEPT_IDS, MOOD_IDS } from './concepts.ts';
import { contentTokens, round } from './text.ts';

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
 "exploration": 0.9 if they want unfamiliar/surprising things, 0.1 if they want familiar/comfort picks, otherwise null.
 "trajectory": {"from": moodId, "to": moodId} only if they describe a mood arc; mood ids: ${JSON.stringify(MOOD_IDS)}. Otherwise null.
 "duration": "short" | "medium" | "long" only if stated, else null.
 "language": ISO 639-1 code of the CONTENT language only if the user asks for it ("in French", "en anglais"), else null.
 "followUp": true if the message refines or reacts to the previous request ("less dark", "only books", "more like that", "they're bad"). In a follow-up, a platform phrase refers to the previous media: after a podcast request, "only the youtube ones" = categories ["podcasts"], providers ["youtube"].
 "rejectPrevious": true if the user says the previous results were bad/wrong.
 "remember": long-term preferences the user explicitly states about themselves, e.g. "I hate horror", "j'adore Stromae" → [{"polarity":1|-1,"subject":"..."}]. [] otherwise.
}
Do not recommend anything. Use only the listed ids.`;

export interface Understanding {
  categories: Category[];
  providers: ProviderId[];
  search: Partial<Record<Category, string>>;
  concepts: Record<string, number>;
  excludeConcepts: string[];
  excludeTerms: string[];
  relaxed: string[];
  references: string[];
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

/** Validate the model's output against ECHO's vocabulary and the user's actual words. */
export function sanitizeUnderstanding(raw: unknown, text: string): Understanding {
  const h = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const lower = text.toLowerCase();
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
    // References must literally appear in the user's text: the model may not invent titles.
    references: strs(h.references, 3).filter((r) => r.length > 1 && lower.includes(r.toLowerCase())),
    exploration: typeof h.exploration === 'number' && isFinite(h.exploration) && (h.exploration >= 0.8 || h.exploration <= 0.2) ? h.exploration : undefined,
    trajectory,
    duration: h.duration === 'short' || h.duration === 'medium' || h.duration === 'long' ? h.duration : undefined,
    language: typeof h.language === 'string' && /^[a-z]{2}$/.test(h.language) ? h.language : undefined,
    followUp: h.followUp === true,
    rejectPrevious: h.rejectPrevious === true,
    remember,
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

  const categories = u.categories.length ? u.categories : follow && !rules.categories.length ? prev!.categories : rules.categories;
  const providers = u.providers.length ? u.providers : rules.providers?.length ? rules.providers : follow && !u.categories.length ? prev!.providers : undefined;
  const excludes = [...new Set([...rules.excludes, ...excludeConcepts, ...u.excludeTerms, ...(follow ? prev!.excludes : [])])];
  const searchWords = [...new Set(Object.values(u.search).flatMap((q) => contentTokens(q ?? '')))].filter((w) => w.length > 2);
  const keywords = (searchWords.length ? searchWords : rules.keywords).filter((k) => !excludes.some((x) => x.split(' ').includes(k))).slice(0, 8);
  const moods = MOOD_IDS.filter((m) => (target[m] ?? 0) > 0).sort((a, b) => target[b] - target[a]);
  const themes = Object.keys(target).filter((k) => target[k] > 0 && CONCEPT_BY_ID[k] && CONCEPT_BY_ID[k].group !== 'mood').sort((a, b) => target[b] - target[a]);
  const references = rules.references.length ? rules.references : u.references;
  const statements = [...rules.statements, ...u.remember.filter((r) => !rules.statements.some((s) => s.subject.toLowerCase() === r.subject.toLowerCase()))];
  const exploration = rules.exploration ?? u.exploration ?? (follow ? prev!.exploration : undefined);
  const hasSignal = categories.length > 0 || Object.keys(u.search).length > 0 || Object.keys(target).length > 0 || references.length > 0 || rules.ordinalRefs.length > 0 || u.rejectPrevious || statements.length > 0;
  let kind: Intent['intent'] = rules.intent;
  if (kind === 'discover') {
    if ((exploration ?? 0) >= 0.8) kind = 'explore';
    else if (references.length) kind = 'similar';
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
  return JSON.stringify({ request: prev.rawText.slice(-300), categories: prev.categories, providers: prev.providers ?? [], search: prev.searchQueries ?? {}, concepts: top, excludes: prev.excludes });
}

/** Ask the LLM to interpret the message (with the previous request as context). */
export async function llmUnderstand(text: string, prev: Intent | null, cfg: AiConfig, http: HttpClient): Promise<Understanding> {
  const res = await withRateLimitRetry(() => http.json<{ choices: Array<{ message: { content: string } }> }>(`${cfg.baseUrl}/chat/completions`, {
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        ...modelParams(cfg.model),
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
  }));
  const content = res.choices?.[0]?.message?.content ?? '{}';
  return sanitizeUnderstanding(JSON.parse(content.replace(/^```(json)?|```$/g, '').trim()), text);
}
