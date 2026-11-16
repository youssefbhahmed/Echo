// Optional AI inference. ECHO never depends on it: rules-based parsing always runs first,
// and the LLM (if configured) can only add signals from ECHO's known vocabulary.
// Only the user's own request text is sent — never catalog content (Spotify's
// Developer Policy forbids feeding Spotify Content into AI models).
import { CATEGORIES, type Category, type Intent } from '../types.ts';
import type { HttpClient } from '../providers/http.ts';
import type { Env } from '../providers/types.ts';
import { CONCEPT_BY_ID, CONCEPT_IDS, MOOD_IDS } from './concepts.ts';
import { round } from './text.ts';

export interface AiConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export function aiConfig(env: Env): AiConfig | null {
  const baseUrl = env('AI_BASE_URL');
  const model = env('AI_MODEL');
  if (!baseUrl || !model) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ''), model, apiKey: env('AI_API_KEY') };
}

export const INTENT_SYSTEM_PROMPT = `You convert a media-discovery request into JSON. Output ONLY a JSON object with these optional keys:
categories: subset of ${JSON.stringify(CATEGORIES)}
concepts: object mapping concept ids to weights 0..1, ids from ${JSON.stringify(CONCEPT_IDS)}
excludes: concept ids the user does not want
relaxed: concept ids the user says are optional
references: array of exact titles/creators the user explicitly named (never invent)
exploration: 0..1 (1 = wants unfamiliar things)
trajectory: {"from": moodId, "to": moodId} with mood ids from ${JSON.stringify(MOOD_IDS)}
duration: "short"|"medium"|"long"
language: ISO 639-1 code
keywords: up to 6 search keywords
Use only the listed ids. Do not recommend titles.`;

type Hint = Partial<{ categories: string[]; concepts: Record<string, number>; excludes: string[]; relaxed: string[]; references: string[]; exploration: number; trajectory: { from: string; to: string }; duration: string; language: string; keywords: string[] }>;

/** Validate untrusted structured hints (from an LLM or a client) against ECHO's vocabulary. */
export function sanitizeHint(raw: unknown, originalText: string): Hint {
  if (!raw || typeof raw !== 'object') return {};
  const h = raw as Record<string, unknown>;
  const strs = (v: unknown, max = 8) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 80)).slice(0, max) : []);
  const out: Hint = {};
  out.categories = strs(h.categories).filter((c) => (CATEGORIES as readonly string[]).includes(c));
  if (h.concepts && typeof h.concepts === 'object') {
    out.concepts = {};
    for (const [k, v] of Object.entries(h.concepts as Record<string, unknown>)) if (CONCEPT_BY_ID[k] && typeof v === 'number' && isFinite(v)) out.concepts[k] = Math.max(0, Math.min(1, v));
  }
  out.excludes = strs(h.excludes).filter((c) => CONCEPT_BY_ID[c]);
  out.relaxed = strs(h.relaxed).filter((c) => CONCEPT_BY_ID[c]);
  // References must literally appear in the user's text: the model may not invent titles.
  const lower = originalText.toLowerCase();
  out.references = strs(h.references, 3).filter((r) => r.length > 1 && lower.includes(r.toLowerCase()));
  if (typeof h.exploration === 'number' && isFinite(h.exploration)) out.exploration = Math.max(0, Math.min(1, h.exploration));
  const t = h.trajectory as { from?: unknown; to?: unknown } | undefined;
  if (t && typeof t.from === 'string' && typeof t.to === 'string' && MOOD_IDS.includes(t.from) && MOOD_IDS.includes(t.to) && t.from !== t.to) out.trajectory = { from: t.from, to: t.to };
  if (typeof h.duration === 'string' && ['short', 'medium', 'long'].includes(h.duration)) out.duration = h.duration;
  if (typeof h.language === 'string' && /^[a-z]{2}$/.test(h.language)) out.language = h.language;
  out.keywords = strs(h.keywords, 6).map((k) => k.toLowerCase().replace(/[^a-z0-9\s\-']/g, '').trim()).filter(Boolean);
  return out;
}

export function mergeHint(intent: Intent, rawHint: Hint, source: Intent['source']): Intent {
  // Models guess. Only accept fields the user's own words support, and never let a guess
  // contradict what the rules parser read explicitly ("doesn't have to be X" ≠ "no X").
  const text = intent.rawText.toLowerCase();
  const hint: Hint = { ...rawHint };
  hint.excludes = (hint.excludes ?? []).filter((x) => !intent.relaxed.includes(x) && (intent.target[x] ?? 0) <= 0);
  if (!/\b(starts?|begin|from|becom|turns?|ends?|gradual|after|then|arc|journey from)/.test(text)) delete hint.trajectory;
  if (!/\b(short|quick|long|minutes?|hours?|brief|epic|binge|series)\b/.test(text)) delete hint.duration;
  if (!/\b(english|french|spanish|german|italian|portuguese|japanese|korean|chinese|arabic|russian|hindi|language|in [a-z]+ please)\b/.test(text)) delete hint.language;
  if (hint.exploration !== undefined && hint.exploration > 0.2 && hint.exploration < 0.8) delete hint.exploration;
  const target = { ...intent.target };
  for (const [k, v] of Object.entries(hint.concepts ?? {})) if (!intent.relaxed.includes(k)) target[k] = round(Math.max(target[k] ?? 0, v * 0.8));
  for (const k of hint.excludes ?? []) target[k] = -0.8;
  for (const k of hint.relaxed ?? []) if ((target[k] ?? 0) > 0) delete target[k];
  if (hint.trajectory) {
    target[hint.trajectory.from] = Math.max(target[hint.trajectory.from] ?? 0, 0.7);
    target[hint.trajectory.to] = Math.max(target[hint.trajectory.to] ?? 0, 0.8);
  }
  const moods = MOOD_IDS.filter((m) => (target[m] ?? 0) > 0).sort((a, b) => target[b] - target[a]);
  const themes = Object.keys(target).filter((k) => target[k] > 0 && CONCEPT_BY_ID[k] && CONCEPT_BY_ID[k].group !== 'mood').sort((a, b) => target[b] - target[a]);
  const categories = intent.categories.length ? intent.categories : ((hint.categories ?? []) as Category[]);
  return {
    ...intent,
    categories,
    target,
    moods,
    themes,
    excludes: [...new Set([...intent.excludes, ...(hint.excludes ?? [])])],
    relaxed: [...new Set([...intent.relaxed, ...(hint.relaxed ?? [])])],
    references: intent.references.length ? intent.references : hint.references ?? [],
    exploration: intent.exploration ?? hint.exploration,
    trajectory: intent.trajectory ?? hint.trajectory,
    duration: intent.duration ?? (hint.duration as Intent['duration']),
    language: intent.language ?? hint.language,
    keywords: intent.keywords.length >= 2 ? intent.keywords : [...new Set([...intent.keywords, ...(hint.keywords ?? [])])].slice(0, 8),
    vague: intent.vague && !Object.keys(hint.concepts ?? {}).length && !(hint.references ?? []).length,
    intent: intent.intent === 'discover' && (hint.references ?? []).length ? 'similar' : intent.intent,
    source,
  };
}

/** Ask an OpenAI-compatible endpoint (Groq, OpenRouter, Gemini OpenAI-compat, Ollama…) to enrich the intent. */
export async function llmEnrichIntent(intent: Intent, cfg: AiConfig, http: HttpClient): Promise<Intent> {
  const res = await http.json<{ choices: Array<{ message: { content: string } }> }>(`${cfg.baseUrl}/chat/completions`, {
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: INTENT_SYSTEM_PROMPT },
          { role: 'user', content: intent.rawText.slice(0, 800) },
        ],
      }),
    },
    timeoutMs: 7000,
    provider: 'ai',
  });
  const content = res.choices?.[0]?.message?.content ?? '{}';
  const json = JSON.parse(content.replace(/^```(json)?|```$/g, '').trim());
  return mergeHint(intent, sanitizeHint(json, intent.rawText), 'rules+llm');
}

export interface MusicPick {
  artist: string;
  track?: string;
  album?: string;
  /** Curator's short style label (e.g. "alternative rock", "afro house"). */
  style?: string;
}

/**
 * Ask the LLM for real, acclaimed music matching a description. Only ECHO's own taste words
 * (and the user's request text) are sent, never catalog/Spotify data. Every pick is then verified
 * against Spotify before it can be shown, so hallucinated titles are dropped.
 */
export async function llmMusicPicks(description: string, cfg: AiConfig, http: HttpClient, opts: { avoid?: string[]; count?: number; cacheKey?: string } = {}): Promise<MusicPick[]> {
  const n = opts.count ?? 12;
  const res = await http.json<{ choices: Array<{ message: { content: string } }> }>(`${cfg.baseUrl}/chat/completions`, {
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.7,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are a music curator with deep, eclectic knowledge. Return ONLY JSON: {"items":[{"artist":"...","track":"...","style":"..."} or {"artist":"...","album":"...","style":"..."}]} where "style" is a short genre label (e.g. "alternative rock", "east coast hip-hop", "afro house", "raï").
Give ${n} real, existing recordings by acclaimed or cult artists that fit the description. Mix eras, countries and genres; include lesser-known gems alongside classics; at most one item per artist.
Never suggest generic sleep/meditation/relaxation/study/frequency/stock music, compilations or "best of" collections.
If the description mentions an arc (from one mood to another), list the items in listening order along that arc.
When the description gives a target mix with percentages, follow those proportions across the picks (round sensibly) and never over-represent one region or language beyond its share; never pick from styles listed under "avoid".`,
          },
          { role: 'user', content: `Description: ${description.slice(0, 600)}${opts.avoid?.length ? `\nAvoid: ${opts.avoid.join(', ').slice(0, 200)}` : ''}` },
        ],
      }),
    },
    timeoutMs: 9000,
    provider: 'ai',
    cacheKey: opts.cacheKey,
    ttl: opts.cacheKey ? 86400 : undefined,
  });
  const content = res.choices?.[0]?.message?.content ?? '{}';
  const json = JSON.parse(content.replace(/^```(json)?|```$/g, '').trim()) as { items?: unknown[] };
  const str = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 && v.length < 120 ? v.trim() : undefined);
  const seen = new Set<string>();
  return (json.items ?? [])
    .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}))
    .map((x) => ({ artist: str(x.artist), track: str(x.track), album: str(x.album), style: str(x.style)?.toLowerCase().slice(0, 40) }))
    .filter((x) => !!x.artist && !!(x.track || x.album))
    .map((x) => ({ artist: x.artist!, ...(x.track ? { track: x.track } : { album: x.album }), ...(x.style ? { style: x.style } : {}) }) as MusicPick)
    .filter((x) => !seen.has(x.artist.toLowerCase()) && seen.add(x.artist.toLowerCase()))
    .slice(0, n);
}
