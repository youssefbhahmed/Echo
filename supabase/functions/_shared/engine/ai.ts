// Optional AI inference. ECHO never depends on it: rules-based parsing always runs first,
// and the LLM (if configured) can only add signals from ECHO's known vocabulary.
// Only the user's own request text is sent — never catalog content (Spotify's
// Developer Policy forbids feeding Spotify Content into AI models).
import { CATEGORIES, type Category, type Intent } from '../types.ts';
import { hashKey, type HttpClient } from '../providers/http.ts';
import type { Env } from '../providers/types.ts';
import { CONCEPT_BY_ID, CONCEPT_IDS, MOOD_IDS } from './concepts.ts';
import { round } from './text.ts';

export interface AiConfig {
  baseUrl: string;
  model: string;
  /** Optional separate model for the music curator (spreads per-model rate limits). */
  musicModel?: string;
  apiKey?: string;
}

/** Extra body params for reasoning models (keep latency and token use low). */
export function modelParams(model: string): Record<string, unknown> {
  return /gpt-oss|deepseek-r1|qwq/i.test(model) ? { reasoning_effort: 'low' } : {};
}

/** Retry once after a short pause when the provider says we're over the per-minute limit. */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, waitMs = 2500): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { kind?: string })?.kind !== 'quota') throw e;
    await new Promise((r) => setTimeout(r, waitMs));
    return await fn();
  }
}

export function aiConfig(env: Env): AiConfig | null {
  const baseUrl = env('AI_BASE_URL');
  const model = env('AI_MODEL');
  if (!baseUrl || !model) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ''), model, musicModel: env('AI_MUSIC_MODEL') || undefined, apiKey: env('AI_API_KEY') };
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
  /** Main credited artist. */
  artist: string;
  /** Official title, ideally without "(feat. …)" parts. */
  track: string;
  /** Officially credited featured artists (omitted when none). ListenBrainz matches full credits. */
  feat?: string[];
  /** Feed: the lane id the curator filed the song under. Request: a short style label ("afro house"). */
  lane?: string;
  /** Feed: the song's own main style in a few words, as the curator sees it (checked against the lane). */
  genre?: string;
  /** Main language of the lyrics (French/Arabic songs only ever fill their own regional lane, or are dropped when switched off). */
  lang?: string;
  /** "Artists like X" lane: 3-8 words on what the song shares with X (the curator's words about its own pick). */
  why?: string;
}

/** One lane of the listener's taste, described in generic words only (never track/artist names). */
export interface CuratorLane {
  id: string;
  label: string;
  descriptors: string[];
  /** "bittersweet but danceable, mid-energy" */
  mood?: string;
  /** Familiarity in words, from the lane's popularity quartiles. */
  popularity?: string;
  fromYear: number;
  regional: boolean;
  /** Lane whose style is instrumental by nature (jazz, classical, scores). */
  instrumental?: boolean;
  count: number;
}

/** A typed request (chat/search); rules apply unless the user asked otherwise. */
export interface CuratorRequest {
  text: string;
  themes?: string;
  background?: string;
  arc?: string;
  count: number;
  /** Undefined when the user asked for older music. */
  fromYear?: number;
  regionalMinYear?: number;
  vocals: boolean;
  familiar: boolean;
  /**
   * A request naming an artist: 'by' = that artist's own songs (any era, signature songs + deeper cuts);
   * 'like' = songs by other artists closely related in sound, scene and era.
   */
  entity?: { name: string; mode: 'by' | 'like' };
  /** Lyrics languages the listener switched off ("French", "Arabic or Maghreb") that the request doesn't ask for. */
  offLanguages?: string[];
}

export interface CuratorBrief {
  lanes?: CuratorLane[];
  request?: CuratorRequest;
  /** Session moods (generic words). */
  moods?: string[];
  /** User-typed dislikes only. */
  avoid?: string[];
}

const NEVER_STOCK = 'never novelty, meme, comedy, parody, children\'s, sleep, meditation, relaxation, study, frequency or stock music, and no compilations or "best of" collections';
/** How each song is named: main artist, clean official title, featured artists apart (catalog matching needs the full credit). */
const CREDIT_RULE = '"artist" is the main credited artist only; "track" is the official song title WITHOUT any "(feat. …)", "(with …)" or version part; "feat" lists the officially credited featured artists ([] when none).';

const LANG_RULE = '"lang" is the main language of the lyrics (e.g. English, French, Arabic, Spanish).';

/** "No French-language songs (the listener switched them off)…" for the languages switched off, '' when none. */
function offLanguageRule(off: string[] | undefined, unless?: string): string {
  if (!off?.length) return '';
  return `No ${off.join(' or ')}-language songs: the listener switched them off${unless ? ` (unless ${unless} is a ${off.join(' or ')}-language artist)` : ''}.`;
}

/**
 * Prompts for a request naming an artist (sub-modes of a request): their own songs ('by'), or songs by
 * closely related artists ('like'). Only the user's text and the artist's name as the user wrote it
 * (spelling normalised by the interpreter) are sent.
 */
export function entityCuratorPrompt(r: CuratorRequest, e: { name: string; mode: 'by' | 'like' }, avoidLine = ''): { system: string; user: string } {
  const name = e.name;
  if (e.mode === 'by') {
    const rules = [
      `List ${r.count} real, officially released songs by ${name} that are on Spotify: their signature songs and biggest hits plus fan-favourite deeper cuts and album tracks, from any era of their career.`,
      `${name} is the main credited artist of every song.`,
      'Original studio versions only: no live, remix, sped-up, slowed, cover, karaoke, instrumental, skit or interlude tracks, and no compilations or "best of" collections.',
      'Order them for a good first listen: a few signature songs first, then deeper cuts, alternating eras and energy.',
      'Never invent a title: give fewer songs rather than one you are not sure exists.',
      CREDIT_RULE,
      LANG_RULE,
    ];
    return {
      system: `You are ECHO's music curator. Return ONLY JSON: {"items":[{"artist":"<main artist>","track":"<official title>","feat":["<featured artist>"],"lane":"<the song's style, 1-3 words>","lang":"<main language of the lyrics>"}]}.\n${rules.map((x) => `- ${x}`).join('\n')}`,
      user: `Artist: ${name}\nRequest: ${r.text.slice(0, 500)}`,
    };
  }
  const rules = [
    `Give ${r.count} real, officially released songs that are on Spotify, by ${r.count} DIFFERENT artists closely related to ${name} in sound, style, scene and era: peers, collaborators, artists ${name} influenced or was influenced by.`,
    `Never a song by ${name} or featuring ${name}.`,
    `"why" is 3-8 plain words on what the song shares with ${name} (e.g. "storytelling rap with rapid-fire flow"), never a list of names.`,
    r.vocals ? 'Songs with vocals, in their original studio version: no live, remix, sped-up, slowed, cover, karaoke or instrumental versions.' : '',
    r.regionalMinYear ? `French, Arabic or Maghreb songs only from ${r.regionalMinYear} on (modern, never traditional or classic-era recordings).` : '',
    offLanguageRule(r.offLanguages, name),
    r.familiar ? 'Familiar like the listener\'s own library: artists well known in that scene and their best-known songs, a couple of bigger hits; never obscure, avant-garde or experimental.' : '',
    'One song per artist; never an artist or style listed under "avoid".',
    'Order them for a smooth listening flow.',
    `${NEVER_STOCK.charAt(0).toUpperCase()}${NEVER_STOCK.slice(1)}.`,
    CREDIT_RULE,
    LANG_RULE,
  ].filter(Boolean);
  return {
    system: `You are ECHO's music curator. Return ONLY JSON: {"items":[{"artist":"<main artist>","track":"<official title>","feat":["<featured artist>"],"lane":"<the song's own style, 1-3 words>","lang":"<main language of the lyrics>","why":"<3-8 words: what it shares with ${name}>"}]}.\n${rules.map((x) => `- ${x}`).join('\n')}`,
    user: `Artist: ${name}\nRequest: ${r.text.slice(0, 500)}${r.background ? `\nListener background: ${r.background.slice(0, 400)}` : ''}${avoidLine}`,
  };
}

/** System + user messages for the music curator. Pure: tests check what is (and isn't) sent. */
export function curatorPrompt(brief: CuratorBrief): { system: string; user: string } {
  const avoid = (brief.avoid ?? []).map((a) => a.trim()).filter(Boolean).slice(0, 20);
  const avoidLine = avoid.length ? `\nAvoid: ${avoid.join(', ').slice(0, 300)}` : '';
  if (brief.request?.entity) return entityCuratorPrompt(brief.request, brief.request.entity, avoidLine);
  if (brief.request) {
    const r = brief.request;
    const rules = [
      `Give ${r.count} real, officially released songs that are on Spotify and fit the request.`,
      r.vocals ? 'Songs with vocals, in their original studio version: no live, remix, sped-up, slowed, cover, karaoke or instrumental versions.' : '',
      r.fromYear ? `Songs first released in or after ${r.fromYear}${r.regionalMinYear ? `; French, Arabic or Maghreb songs only from ${r.regionalMinYear} on (modern, never traditional or classic-era recordings)` : ''}.` : '',
      r.familiar ? 'Familiar like the listener\'s own library: songs well known in their scene, mostly mid-popularity with a couple of bigger hits; never obscure, avant-garde or experimental.' : '',
      offLanguageRule(r.offLanguages),
      'One song per artist; never an artist or style listed under "avoid".',
      'If the request describes an arc (from one mood to another), list the songs in listening order along it; otherwise order them for a smooth listening flow.',
      `${NEVER_STOCK.charAt(0).toUpperCase()}${NEVER_STOCK.slice(1)}.`,
      CREDIT_RULE,
      LANG_RULE,
    ].filter(Boolean);
    return {
      system: `You are ECHO's music curator. Return ONLY JSON: {"items":[{"artist":"<main artist>","track":"<official title>","feat":["<featured artist>"],"lane":"<short style label, e.g. afro house>","lang":"<main language of the lyrics>"}]}.\n${rules.map((x) => `- ${x}`).join('\n')}`,
      user: `Request: ${r.text.slice(0, 500)}${r.themes ? `\nThemes: ${r.themes}` : ''}${r.arc ? `\nArc: ${r.arc}` : ''}${r.background ? `\nListener background: ${r.background.slice(0, 400)}` : ''}${avoidLine}`,
    };
  }
  const lanes = brief.lanes ?? [];
  const instrumentalLane = lanes.some((l) => l.instrumental);
  const system = `You are ECHO's music curator for one listener. Return ONLY JSON: {"items":[{"artist":"<main artist>","track":"<official title>","feat":["<featured artist>"],"lane":"<lane id>","genre":"<the song's own main style, 1-3 words>","lang":"<main language of the lyrics>"}]}.
Choose real, officially released songs that are on Spotify:
- ${CREDIT_RULE}
- Songs with vocals, in their original studio version: no live, remix, sped-up, slowed, cover, karaoke or instrumental versions${instrumentalLane ? ' (a lane marked "instrumental style" may include instrumentals)' : ''}.
- Only songs first released in or after the year given for their lane.
- Lanes not marked "modern only" never contain French-, Arabic- or Maghreb-language songs.
- Familiar like the listener's own library: songs that are well known in their scene, mostly solid mid-popularity tracks plus a couple of bigger hits, at most one deeper cut per lane. Never obscure, avant-garde, experimental, ambient, noise, jazz or classical (unless the lane is that style); ${NEVER_STOCK}.
- Every song must squarely belong to its lane's style: a mainstream pop or dance-pop song is not hip-hop, Afro, Latin or house just because it is popular or danceable. If a lane can't be filled with songs that truly fit, give fewer.
- Match each lane's mood and energy.
- One song per artist across the whole list; never an artist or style listed under "avoid".
- Within each lane, order the songs for a smooth listening flow: energy and mood glide from one song to the next.
- Give the requested number of songs for every lane, each tagged with its lane id.`;
  const laneLine = (l: CuratorLane) =>
    [
      `- lane "${l.id}" (${l.label}): ${l.descriptors.join(', ')}`,
      l.mood ? `feel: ${l.mood}` : '',
      l.popularity ?? '',
      l.instrumental ? 'instrumental style' : '',
      l.regional ? `modern only: released ${l.fromYear} or later, no traditional or classic-era songs` : `released ${l.fromYear} or later`,
      `${l.count} songs`,
    ].filter(Boolean).join('; ');
  const user = `Lanes for this listener:\n${lanes.map(laneLine).join('\n')}${brief.moods?.length ? `\nSession mood: ${brief.moods.join(', ')}` : ''}${avoidLine}`;
  return { system, user };
}

/** Cache key: stable for the same seed + brief, different for every refresh seed. */
export async function curatorCacheKey(model: string, prompt: { system: string; user: string }, seed: number): Promise<string> {
  return `ai:music:v3:${await hashKey(`${model}\n${prompt.system}\n${prompt.user}`)}:${seed}`;
}

/**
 * Ask the LLM for real songs for each taste lane (or a typed request). Only generic taste words and
 * the user's own text are sent, never catalog/Spotify data. Every pick is then resolved on Spotify
 * and checked (artist, era, exclusions) before it can be shown, so hallucinated songs are dropped.
 */
export async function llmMusicPicks(brief: CuratorBrief, cfg: AiConfig, http: HttpClient, opts: { seed?: number } = {}): Promise<MusicPick[]> {
  const music = cfg.musicModel ?? cfg.model;
  const ask = async (b: CuratorBrief, model: string, salt: string) => {
    const prompt = curatorPrompt(b);
    const cacheKey = `${await curatorCacheKey(model, prompt, opts.seed ?? 0)}${salt}`;
    return http.json<{ choices: Array<{ message: { content: string } }> }>(`${cfg.baseUrl}/chat/completions`, {
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({
          model,
          ...modelParams(model),
          temperature: 0.7,
          // No strict JSON mode: long answers fail it outright ("Failed to generate JSON"); the
          // lenient parser keeps every complete song instead.
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        }),
      },
      timeoutMs: 20000,
      provider: 'ai',
      cacheKey,
      ttl: 86400,
    });
  };
  const run = async (b: CuratorBrief, salt: string) => {
    let res: { choices: Array<{ message: { content: string } }> };
    try {
      res = await ask(b, music, salt);
    } catch (e) {
      if ((e as { kind?: string })?.kind !== 'quota') throw e;
      // Per-minute token limits are per model: a rate-limited music model hands over to the general one.
      res = await withRateLimitRetry(() => ask(b, cfg.model, salt));
    }
    // An artist's own songs share one artist: one song per TITLE there, one per artist everywhere else.
    return parseMusicPicks(res.choices?.[0]?.message?.content ?? '{}', briefTotal(b) + 6, { perArtist: b.request?.entity?.mode !== 'by' });
  };
  const total = briefTotal(brief);
  const picks = await run(brief, '');
  // A refusal ("I can't fulfill that request") or a near-empty answer: ask once more for half as many
  // songs (under its own cache key, so the cached refusal is never served again).
  if (picks.length >= Math.max(1, Math.floor(total / 5))) return picks;
  try {
    const retry = await run(shrinkBrief(brief, 0.5), ':retry');
    return retry.length > picks.length ? retry : picks;
  } catch {
    return picks;
  }
}

const briefTotal = (b: CuratorBrief) => (b.request ? b.request.count : (b.lanes ?? []).reduce((s, l) => s + l.count, 0));

/** The same brief asking for a fraction of the songs (at least 6 per lane / request). */
export function shrinkBrief(b: CuratorBrief, f: number): CuratorBrief {
  if (b.request) return { ...b, request: { ...b.request, count: Math.max(6, Math.round(b.request.count * f)) } };
  return { ...b, lanes: (b.lanes ?? []).map((l) => ({ ...l, count: Math.max(6, Math.round(l.count * f)) })) };
}

/**
 * The curator's item objects: the {"items":[…]} JSON when it parses (fences and chatter around it are
 * ignored), otherwise every complete {"artist":…,"track":…} object found, so a cut-off answer still counts.
 */
export function curatorItems(content: string): unknown[] {
  const text = content.replace(/```(json)?/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(text.slice(start, end + 1)) as { items?: unknown };
      if (Array.isArray(j.items)) return j.items;
    } catch {
      // fall through to the lenient scan
    }
  }
  const out: unknown[] = [];
  for (const m of text.matchAll(/\{[^{}]*"artist"\s*:[^{}]*\}/g)) {
    try {
      out.push(JSON.parse(m[0]));
    } catch {
      // incomplete object: skip
    }
  }
  return out;
}

/** Featured artists from the curator: an array of short names (or one string "A, B & C"), at most 4, never the main artist. */
export function parseFeat(v: unknown, artist: string): string[] {
  const raw = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? v.split(/\s*[,;]\s*|\s+&\s+/) : [];
  const main = artist.trim().toLowerCase();
  const out: string[] = [];
  for (const r of raw) {
    const n = r.trim();
    if (!n || n.length >= 60 || n.toLowerCase() === main || out.some((o) => o.toLowerCase() === n.toLowerCase())) continue;
    out.push(n);
    if (out.length >= 4) break;
  }
  return out;
}

/** "why" from the curator: a few plain words, no quotes or line breaks; undefined when empty or a ramble. */
function parseWhy(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const w = v.replace(/[\u0000-\u001f"“”]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
  const words = w.split(' ').filter(Boolean).length;
  return w && words >= 2 && words <= 12 && w.length <= 80 ? w : undefined;
}

/** Validate the curator's JSON: real-looking artist + track, one song per artist (per title with perArtist: false). */
export function parseMusicPicks(content: string, max = 60, opts: { perArtist?: boolean } = {}): MusicPick[] {
  const perArtist = opts.perArtist !== false;
  const json = { items: curatorItems(content) };
  const str = (v: unknown, n = 120) => (typeof v === 'string' && v.trim().length > 0 && v.length < n ? v.trim() : undefined);
  const seen = new Set<string>();
  const out: MusicPick[] = [];
  for (const raw of Array.isArray(json.items) ? json.items : []) {
    const x = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const artist = str(x.artist);
    const track = str(x.track);
    if (!artist || !track) continue;
    const key = perArtist ? artist.toLowerCase() : `${artist.toLowerCase()}|${track.toLowerCase().replace(/\s*[([].*$/, '').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lane = str(x.lane, 60) ?? str(x.style, 60);
    const genre = str(x.genre, 60);
    const lang = str(x.lang, 40) ?? str(x.language, 40);
    const feat = parseFeat(x.feat ?? x.featuring, artist);
    const why = parseWhy(x.why);
    out.push({ artist, track, ...(feat.length ? { feat } : {}), ...(lane ? { lane: lane.toLowerCase() } : {}), ...(genre ? { genre } : {}), ...(lang ? { lang } : {}), ...(why ? { why } : {}) });
    if (out.length >= max) break;
  }
  return out;
}
