// Music curation by taste lanes: plan the refresh (which lanes, how many songs each), brief the AI
// curator with generic words only, resolve its picks on Spotify under the owner's rules, and fill
// short lanes from stored songs that fit them. Pure orchestration: I/O is injected.
import type { Category, ContentItem, Intent, MusicLane, MusicPolicy, TasteProfile } from '../types.ts';
import type { HttpClient } from '../providers/http.ts';
import type { Env } from '../providers/types.ts';
import { artistMatches, resolveSpotifyPicks, type ResolveResult, type SpotifyPick } from '../providers/spotify.ts';
import { musicBrief } from '../importer.ts';
import { llmMusicPicks, type AiConfig, type CuratorBrief, type CuratorLane, type MusicPick } from './ai.ts';
import {
  allowScenes, chooseLanes, DEFAULT_MIN_YEAR, effectiveLanes, ENTITY_BY_LANE, ENTITY_LIKE_LANE, eraFloor, inLibrary, LANE_BY_ID, LANES, laneBlocked, laneKey, laneOfGenre, laneOfGenres, laneReject, laneTag,
  laneTagOf, laneTargets, MIX_LANE, mixLane, moodPhrase, musicPolicy, popularityPhrase, REQUEST_LANE, VERSION_RE, withoutPerUser, type LaneRuleContext, type LibrarySongs,
} from './lanes.ts';
import { CONCEPT_BY_ID } from './concepts.ts';
import { categoryQuotas } from './rank.ts';
import { normKey, songKey, splitArtist } from './text.ts';

export interface MusicRules {
  /** Release-era rules (lane era, regional ≥ 2015). Off when the user asked for older music. */
  era: boolean;
  vocals: boolean;
  /** Library-like familiarity (no obscure/experimental). Off when the user asked for deep cuts. */
  familiar: boolean;
}

export interface MusicPlan {
  /** 'lanes' = open feed briefed from taste lanes; 'request' = a typed request (chat/search). */
  mode: 'lanes' | 'request';
  /** Lanes of this refresh, in shelf order. */
  lanes: MusicLane[];
  order: string[];
  /** Songs wanted per lane. */
  targets: Record<string, number>;
  total: number;
  policy: MusicPolicy;
  rules: MusicRules;
  /**
   * A request naming an artist (request sub-modes): lane "entity-by" = their own songs, "entity-like" =
   * songs by closely related artists. want 'all' serves both (by first), split ~50/50. `lang`: the
   * artist's main lyrics language per the interpreter (their scene when their own songs aren't known).
   */
  entity?: PlanEntity;
}

export interface PlanEntity {
  name: string;
  want: 'by' | 'like' | 'all';
  lang?: string;
}

const OLD_RE = /\b(old(ies)?|old school|classics?|vintage|retro|throwback|golden age|traditional|timeless|(19|20)?[0-9]0'?s|19\d\d|sixties|seventies|eighties|nineties)\b/i;
const INSTRUMENTAL_RE = /\b(instrumentals?|no vocals|without vocals|wordless|ambient|classical|orchestral|piano|jazz|soundtracks?|film scores?|lo-?fi beats|beats to (study|relax)|focus music|study music)\b/i;
const DEEP_RE = /\b(obscure|underground|deep cuts?|rare|hidden gems?|lesser[- ]known|unknown|niche|experimental|avant[- ]garde|undiscovered)\b/i;

/** The era/vocal/familiarity rules hold for typed requests too, unless the user's words ask otherwise. */
export function requestRules(text = ''): MusicRules {
  return { era: !OLD_RE.test(text), vocals: !INSTRUMENTAL_RE.test(text), familiar: !DEEP_RE.test(text) };
}

/** Music picks for this response: the music quota of an open feed (~10 of 48), the whole limit for a music-only feed. */
export function musicQuotaFor(categories: Category[], limit: number, mix: Partial<Record<Category, number>> | undefined, hasQuery: boolean): number {
  if (!categories.includes('music')) return 0;
  if (categories.length === 1) return limit;
  if (hasQuery) return Math.max(3, Math.ceil(limit / categories.length));
  return categoryQuotas(categories, limit, mix).get('music') ?? 0;
}

const year = (now: Date) => now.getUTCFullYear();

function requestLane(rules: MusicRules, now: Date): MusicLane {
  return {
    ...REQUEST_LANE, share: 1, descriptors: [], era: { from: rules.era ? DEFAULT_MIN_YEAR : 1900, to: year(now) }, energy: NaN, danceability: NaN, valence: NaN,
    popularity: { p25: NaN, p50: NaN, p75: NaN }, regional: false, genres: [], source: 'default',
  };
}

/** A lane answering a named artist: any era (the era rule is off for an artist the user named; the 'like' lane keeps the regional 2015+ rule per song). */
function entityLane(id: string, label: string, now: Date): MusicLane {
  return {
    id, label, share: 1, descriptors: [], era: { from: 1900, to: year(now) }, energy: NaN, danceability: NaN, valence: NaN,
    popularity: { p25: NaN, p50: NaN, p75: NaN }, regional: false, genres: [], source: 'default',
  };
}

/** Songs shown per entity lane: two lanes split the music ~50/50 (at least 6 each); one lane takes up to 16. */
export function entityTargets(want: 'by' | 'like' | 'all', total: number): { by: number; like: number } {
  if (want === 'all') {
    const by = Math.max(6, Math.ceil(total / 2));
    return { by, like: Math.max(6, total - by) };
  }
  const n = Math.max(6, Math.min(16, total));
  return want === 'by' ? { by: n, like: 0 } : { by: 0, like: n };
}

/** Songs asked from the curator for an entity lane (~14; more for a bigger single lane). */
export const entityAsk = (target: number) => (target <= 8 ? 14 : Math.min(22, target + 6));

/** Which lanes this refresh serves and how many songs each (min 3 per lane; fewer lanes for small quotas). */
export function planMusic(
  profile: TasteProfile,
  opts: { hasQuery: boolean; seed: number; total: number; text?: string; now?: Date; entity?: PlanEntity },
): MusicPlan | null {
  const now = opts.now ?? new Date();
  if (opts.total <= 0) return null;
  const policy = musicPolicy(profile);
  if (opts.hasQuery && opts.entity) {
    const { name, want, lang } = opts.entity;
    const t = entityTargets(want, opts.total);
    const lanes = [...(t.by ? [entityLane(ENTITY_BY_LANE, name, now)] : []), ...(t.like ? [entityLane(ENTITY_LIKE_LANE, `Artists like ${name}`, now)] : [])];
    const targets = Object.fromEntries(lanes.map((l) => [l.id, l.id === ENTITY_BY_LANE ? t.by : t.like]));
    return { mode: 'request', entity: { name, want, ...(lang ? { lang } : {}) }, lanes, order: lanes.map((l) => l.id), targets, total: t.by + t.like, policy, rules: requestRules(opts.text) };
  }
  if (opts.hasQuery) {
    const rules = requestRules(opts.text);
    return { mode: 'request', lanes: [requestLane(rules, now)], order: [REQUEST_LANE.id], targets: { [REQUEST_LANE.id]: opts.total }, total: opts.total, policy, rules };
  }
  // A whole music page (18+ songs) spreads over 4 lanes; a feed's music share over up to 3.
  const n = opts.total >= 18 ? 4 : Math.max(1, Math.min(3, Math.floor(opts.total / 3)));
  const chosen = chooseLanes(effectiveLanes(profile, now), opts.seed, n, { feedback: profile.laneFeedback, blocked: (l) => laneBlocked(l, profile), regionalShare: policy.regionalShare });
  if (!chosen.length) return null;
  const t = laneTargets(chosen, opts.total, 3);
  return {
    mode: 'lanes', lanes: chosen, order: chosen.map((l) => l.id), targets: Object.fromEntries(chosen.map((l, i) => [l.id, t[i]])), total: opts.total, policy,
    rules: { era: true, vocals: true, familiar: true },
  };
}

/**
 * Songs asked from the curator per lane: about three times the lane's slots (12–24). Spotify search is
 * rate-limited most of the time in Development Mode, so picks resolve through ListenBrainz (~40–50%
 * coverage) after the off-lane style, era, library and version filters (~70% pass): ~30% survive.
 */
export const MAX_ASK = 48;
export const askCount = (target: number) => Math.max(12, Math.min(24, Math.ceil(target * 3) + 2));

/** Curator brief from the plan: lane labels, generic descriptors, mood, era — never track or artist names. */
export function buildBrief(plan: MusicPlan, profile: TasteProfile, ctx: { intent?: Intent; words?: string; moods?: string[] } = {}): CuratorBrief {
  // Only what the user typed may be named here (their own dislikes / exclusions), never Spotify data.
  const avoid = [...profile.explicit.dislikes, ...(ctx.intent?.excludes ?? []).filter((x) => !CONCEPT_BY_ID[x])].map((x) => x.trim()).filter(Boolean);
  if (plan.mode === 'request') {
    const intent = ctx.intent;
    return {
      request: {
        text: intent?.rawText ?? '',
        themes: ctx.words || undefined,
        arc: intent?.trajectory ? `from ${intent.trajectory.from} to ${intent.trajectory.to}` : undefined,
        background: profile.music ? musicBrief(profile.music, { styles: false }) : undefined,
        count: Math.max(8, Math.min(16, plan.total + 4)),
        fromYear: plan.rules.era ? DEFAULT_MIN_YEAR : undefined,
        regionalMinYear: plan.rules.era ? plan.policy.regionalMinYear : undefined,
        vocals: plan.rules.vocals,
        familiar: plan.rules.familiar,
        offLanguages: offLanguages(profile, intent?.rawText ?? '', intent?.language, namesOf(intent)),
      },
      avoid: [...new Set(avoid)],
    };
  }
  const lanes: CuratorLane[] = plan.lanes.map((l) => {
    const def = LANE_BY_ID[l.id];
    const descriptors = l.descriptors.length ? l.descriptors : l.genres.length ? l.genres.slice(0, 4) : l.id === MIX_LANE.id ? ['well-loved modern songs across popular styles'] : def?.descriptors ?? [];
    const mood = moodPhrase(l);
    return {
      id: l.id,
      label: l.label,
      descriptors,
      // Library descriptors already carry the mood words; cold-start lanes get the phrase separately.
      mood: mood && !descriptors.some((d) => d.startsWith(mood.split(/[ ,]/)[0])) ? mood : undefined,
      popularity: popularityPhrase(l.popularity) || undefined,
      fromYear: eraFloor(l, plan.policy),
      regional: l.regional,
      instrumental: def?.instrumental,
      count: askCount(plan.targets[l.id] ?? 3),
    };
  });
  // One call answers ~60 songs in full (and stays inside the AI provider's per-minute token budget).
  const asked = lanes.reduce((n, l) => n + l.count, 0);
  if (asked > MAX_ASK) for (const l of lanes) l.count = Math.max(9, Math.floor((l.count * MAX_ASK) / asked));
  return { lanes, moods: ctx.moods?.length ? ctx.moods : undefined, avoid: [...new Set(avoid)] };
}

export interface CurateDeps {
  ai: AiConfig;
  http: HttpClient;
  env: Env;
  profile: TasteProfile;
  intent?: Intent;
  /** Generic theme/mood words for a request. */
  words?: string;
  /** Session mood words for the feed (mood chips). */
  moods?: string[];
  /** Concept ids items are retrieved for (weak, inherited evidence for ranking). */
  concepts?: string[];
  excludeIds?: Set<string>;
  /**
   * The "<Artist>" lane of an entity request: like excludeIds, but songs the user already has may come
   * back (ranked after the rest, flagged "In your library") unless they were just shown.
   */
  entityExcludeIds?: Set<string>;
  /** Liked/saved songs by ISRC and artist|title (a liked song never comes back under another id). */
  library?: LibrarySongs;
  /** Spotify search is rate-limited: resolve via cache, ListenBrainz and single-track lookups only. */
  searchBlocked?: boolean;
  /** Spotify single-track lookups are rate-limited: resolve from cached resolutions only. */
  lookupBlocked?: boolean;
  seed?: number;
  now?: Date;
  /** The curator's own recent suggestions to this user ("Artist – Title"), not to be repeated. */
  recentSongs?: string[];
}

export interface CurateResult {
  items: ContentItem[];
  detail: string;
  /** Spotify search answered 429 (seconds to wait). */
  rateLimitedSec?: number;
  /** Spotify single-track lookups answered 429 (seconds to wait); recorded under its own block key. */
  lookupLimitedSec?: number;
  perLane: Record<string, number>;
  /** The curator's raw suggestions this time ("Artist – Title", its own words), for its memory. */
  suggested?: string[];
}

/** One remembered curator suggestion: its own artist/title text and when it was made (ms). */
export interface CuratorMemoryEntry { s: string; at: number }
export const CURATOR_MEMORY_MS = 3 * 86400_000;
export const CURATOR_MEMORY_MAX = 160;

/** "Artist – Title" from a curator pick (its own words). */
export const pickLabel = (p: Pick<MusicPick, 'artist' | 'track'>) => `${p.artist.trim()} – ${p.track.trim()}`.slice(0, 120);

/**
 * Suggestions to hand back to the curator as "don't repeat": the last 3 days as of `asOf`, newest
 * first, deduped. Entries made at or after `asOf` are left out, so a re-fetch of the same feed sends
 * the same brief (same cache key, same songs).
 */
export function curatorMemoryFor(entries: CuratorMemoryEntry[] | null | undefined, asOf: number, max = 80): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of [...(entries ?? [])].sort((a, b) => b.at - a.at)) {
    if (!e || typeof e.s !== 'string' || !(e.at < asOf) || asOf - e.at > CURATOR_MEMORY_MS) continue;
    const k = e.s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e.s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Memory after this request: the older entries still within 3 days + this request's new suggestions
 * (stamped `at`), capped. A song suggested again keeps its first time, so a re-fetch of this feed
 * (memory as of `at`) still sees it and sends the same brief.
 */
export function rememberSuggestions(entries: CuratorMemoryEntry[] | null | undefined, suggested: string[], at: number): CuratorMemoryEntry[] {
  const old = (entries ?? []).filter((e) => e && typeof e.s === 'string' && Number.isFinite(e.at) && at - e.at <= CURATOR_MEMORY_MS);
  const known = new Set(old.map((e) => e.s.toLowerCase()));
  const fresh: CuratorMemoryEntry[] = [];
  for (const x of suggested.map((v) => v.trim().slice(0, 120)).filter(Boolean)) {
    if (known.has(x.toLowerCase())) continue;
    known.add(x.toLowerCase());
    fresh.push({ s: x, at });
  }
  return [...fresh, ...old].sort((a, b) => b.at - a.at).slice(0, CURATOR_MEMORY_MAX);
}

/** Rules a song must pass for a lane (era/regional, exclusions, library, disliked artists, versions). */
export function laneRules(plan: MusicPlan, profile: TasteProfile, excludeIds?: Set<string>, now?: Date, library?: LibrarySongs): LaneRuleContext {
  return { profile, policy: plan.policy, excludeIds, library, era: plan.rules.era, now };
}

const isRegionalHint = (h: string | string[] | undefined) => {
  const id = Array.isArray(h) ? laneOfGenres(h) : h ? laneOfGenre(h) : null;
  return !!(id && LANE_BY_ID[id]?.regional);
};

/**
 * The lane rules for a song outside the curator's lanes (a typed request, or the open "Fresh picks"
 * lane): regional (modern only) when its own style, the search that found it or the request is
 * French / Arabic / Maghreb.
 */
export function ruleLaneFor(plan: MusicPlan, hints: Array<string | string[] | undefined>, now?: Date): MusicLane {
  const lane = plan.mode === 'request' ? plan.lanes[0] : plan.lanes.find((l) => l.id === MIX_LANE.id) ?? mixLane(now);
  return { ...lane, regional: hints.some(isRegionalHint) };
}

// Style labels a lane also accepts although the taxonomy files them elsewhere (or nowhere):
// "neo-soul"/"funk"/"gospel" in the soul lane, plain "house" in the melodic-house lane, etc.
const LANE_ALSO: Record<string, RegExp> = {
  'blues-soul': /\b(soul|funk|gospel|blues|folk|country|americana)\b/,
  'melodic-house': /\b(house|electronic|electronica|downtempo|organic|melodic techno|afro tech)\b/,
  edm: /\b(edm|house|uk garage|2 step|electro|future bass|big room)\b/,
  'afro-latin': /\b(afro\w*|latin\w*|caribbean|brazil\w*|baile|reggae\w*|dancehall|amapiano)\b/,
  'hiphop-rnb': /\b(hip hop|rap|r b|rnb|trap|drill|neo soul)\b/,
  'rock-metal': /\b(rock|metal|punk|grunge|garage)\b/,
};

/** The regional lane a lyrics language belongs to ("French" → french, "Arabic"/"Darija" → arabic-pop), else null. */
export function regionalLaneOfLanguage(lang: string | undefined): string | null {
  const k = laneKey(lang ?? '');
  if (/\b(french|francais|fr)\b/.test(k)) return 'french';
  if (/\b(arabic|arabe|ar|darija|moroccan|egyptian|levantine|gulf|maghrebi|tamazight|berber|amazigh)\b/.test(k)) return 'arabic-pop';
  return null;
}

/** Does the curator's own style label fit this lane (its taxonomy rule or the lane's looser allowances)? */
export function styleFitsLane(label: string, laneId: string): boolean {
  const k = laneKey(label);
  const def = LANE_BY_ID[laneId];
  if (!k || !def) return false;
  return def.re.test(k) || !!def.broad?.test(k) || !!LANE_ALSO[laneId]?.test(k);
}

// ───────────── regional languages in requests ─────────────

/** Arabic rap & pop and Maghreb fusion are one language scene (same "maghreb" family). */
const regionKey = (id: string) => (id === 'maghreb-fusion' ? 'arabic-pop' : id);
const REGION_LANGUAGE: Record<string, string> = { french: 'French', 'arabic-pop': 'Arabic' };

/** Regional lanes (French, Arabic & Maghreb) this listener switched off in My Taste. */
export function blockedRegions(profile: TasteProfile): string[] {
  return [...new Set(LANES.filter((l) => l.regional && laneBlocked({ id: l.id }, profile)).map((l) => regionKey(l.id)))];
}

const NEGATED = /\b(no|not|without|except|avoid|never|sans|pas d[e']?|aucun\w*|ni)\s+(\S+\s+)?\S+/g;

/** Names a request mentions (its entities and references), never its own words about what it wants. */
export function namesOf(intent?: Pick<Intent, 'entities' | 'references'> | null): string[] {
  return [...(intent?.entities ?? []).map((e) => e.name), ...(intent?.references ?? [])].filter(Boolean);
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The request's own words, without the names it mentions: "French Montana" or "Arab Strap" asks for no scene. */
export function withoutNames(text: string, names: string[] = []): string {
  let k = laneKey(text);
  for (const n of names) {
    const nk = laneKey(n);
    if (nk) k = k.replace(new RegExp(`(^|\\s)${escapeRe(nk)}(?=\\s|$)`, 'g'), ' ');
  }
  return k.replace(/\s+/g, ' ').trim();
}

/**
 * Regional scenes the request itself asks for: its words ("rap français", "moroccan rap", never a name it
 * mentions: `names`) or the content language it asked for.
 */
export function askedRegions(text: string, language?: string, names: string[] = []): Set<string> {
  const out = new Set<string>();
  const k = withoutNames(text, names).replace(NEGATED, ' ');
  for (const l of LANES) if (l.regional && l.re.test(k)) out.add(regionKey(l.id));
  if (language === 'fr') out.add('french');
  if (language === 'ar') out.add('arabic-pop');
  return out;
}

/** Lyrics languages to tell the curator to leave out: switched off and not asked for ("French", "Arabic"). */
export function offLanguages(profile: TasteProfile, text: string, language?: string, names: string[] = []): string[] {
  const asked = askedRegions(text, language, names);
  return blockedRegions(profile).filter((r) => !asked.has(r)).map((r) => REGION_LANGUAGE[r]).filter(Boolean);
}

/** The scene of a lyrics language ("French" → french, "Darija" → arabic-pop), as regionalPicks keys it. */
export function regionOfLanguage(lang: string | undefined): string | null {
  const l = regionalLaneOfLanguage(lang);
  return l ? regionKey(l) : null;
}

/** The regional scene of a curator pick: its lyrics language first, then its own style label. */
export function pickRegion(p: Pick<MusicPick, 'lang' | 'lane' | 'genre'>): string | null {
  const byLang = regionalLaneOfLanguage(p.lang);
  if (byLang) return regionKey(byLang);
  for (const g of [p.genre, p.lane]) {
    const id = g ? laneOfGenre(g) : null;
    if (id && LANE_BY_ID[id]?.regional) return regionKey(id);
  }
  return null;
}

/** The scene of a pick when the request asked for it or named an artist of it (its switched-off styles are then allowed). */
export function wantedRegion(p: Pick<MusicPick, 'lang' | 'lane' | 'genre'>, o: { asked: Set<string>; named?: string | null }): string | null {
  const r = pickRegion(p);
  return r && (o.asked.has(r) || o.named === r) ? r : null;
}

/**
 * Owner rules for French / Arabic / Maghreb picks in a typed request (by the curator's own language and
 * style labels, since Spotify track lookups carry no genres): dropped when that scene is switched off,
 * unless the request asks for it or names an artist of that scene (`named`); otherwise at most `cap` of them.
 */
export function regionalPicks<T extends Pick<MusicPick, 'lang' | 'lane' | 'genre'>>(picks: T[], o: { blocked: string[]; asked: Set<string>; named?: string | null; cap: number }): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let dropped = 0;
  let regional = 0;
  for (const p of picks) {
    const r = pickRegion(p);
    const wanted = !!r && (o.asked.has(r) || o.named === r);
    if (r && !wanted && (o.blocked.includes(r) || regional >= o.cap)) {
      dropped++;
      continue;
    }
    if (r && !wanted) regional++;
    kept.push(p);
  }
  return { kept, dropped };
}

/** The scene most of these picks belong to, when more than half do (an artist the user named is "regional" by their own songs). */
export function majorityRegion(picks: Array<Pick<MusicPick, 'lang' | 'lane' | 'genre'>>): string | null {
  const counts = new Map<string, number>();
  for (const p of picks) {
    const r = pickRegion(p);
    if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  for (const [r, n] of counts) if (n * 2 > picks.length) return r;
  return null;
}

/** Style labels of a pick (the curator's words), used for the blocked-style rule when the catalog has no genres. */
const pickLabels = (p: Pick<MusicPick, 'lane' | 'genre'> | undefined) => [p?.genre, p?.lane].filter((x): x is string => !!x);

/** Brief → curator → resolve on Spotify → items tagged with their lane, in the curator's order. */
export async function curateMusic(plan: MusicPlan, deps: CurateDeps): Promise<CurateResult> {
  if (plan.entity) return curateEntityMusic(plan, deps);
  const base = buildBrief(plan, deps.profile, { intent: deps.intent, words: deps.words, moods: deps.moods });
  // Taste-lane feeds: the curator is told what it already suggested lately (its own words), so a refresh
  // brings songs that weren't just shown instead of the same famous ones the recently-shown filter drops.
  const brief = plan.mode === 'lanes' && deps.recentSongs?.length ? { ...base, avoidSongs: deps.recentSongs } : base;
  let picks = await llmMusicPicks(brief, deps.ai, deps.http, { seed: deps.seed ?? 0 });
  const suggested = plan.mode === 'lanes' ? picks.map(pickLabel) : [];
  let regionalDropped = 0;
  // A typed request's own words may ask for a switched-off scene ("rap français"): its picks are then
  // allowed by language AND by style (the blocked-family rule), never just one of the two.
  const names = namesOf(deps.intent);
  const asked = plan.mode === 'request' ? askedRegions(deps.intent?.rawText ?? '', deps.intent?.language, names) : new Set<string>();
  if (plan.mode === 'request') {
    const r = regionalPicks(picks, { blocked: blockedRegions(deps.profile), asked, cap: Math.max(1, Math.round(plan.total * plan.policy.regionalShare)) });
    picks = r.kept;
    regionalDropped = r.dropped;
  }
  const byId = new Map(plan.lanes.map((l) => [l.id, l]));
  const byLabel = new Map(plan.lanes.map((l) => [normKey(l.label), l.id]));
  const style = new Map<SpotifyPick, string | undefined>();
  const source = new Map<SpotifyPick, MusicPick>();
  const spicks: SpotifyPick[] = [];
  let offStyle = 0;
  for (const p of picks) {
    let laneId: string | undefined;
    if (plan.mode === 'request') laneId = REQUEST_LANE.id;
    else if (p.lane && byId.has(p.lane)) laneId = p.lane;
    else if (p.lane && byLabel.has(normKey(p.lane))) laneId = byLabel.get(normKey(p.lane));
    else if (plan.lanes.length === 1) laneId = plan.lanes[0].id;
    if (!laneId) continue;
    // The curator pads lanes with general hits; its own style label must map to the lane (or to
    // another lane of this refresh, where the song moves). Pop/unknown styles never fill a taste lane.
    // Lyrics in French or Arabic: the song belongs to that regional lane (capped, 2015+) or nowhere.
    const langLane = plan.mode === 'lanes' && laneId !== MIX_LANE.id ? regionalLaneOfLanguage(p.lang) : null;
    if (langLane && !LANE_BY_ID[laneId]?.regional) {
      if (byId.has(langLane)) laneId = langLane;
      else {
        offStyle++;
        continue;
      }
    }
    // (A song placed by its language stays there: its style label can't move it back out.)
    if (plan.mode === 'lanes' && laneId !== MIX_LANE.id && p.genre && !(langLane && laneId === langLane)) {
      const own = laneOfGenre(p.genre);
      // A French / Arabic / Maghreb song only ever counts in its own (capped, 2015+) lane.
      const regionalElsewhere = !!own && own !== laneId && !!LANE_BY_ID[own]?.regional;
      if (own !== laneId && (regionalElsewhere || !styleFitsLane(p.genre, laneId))) {
        if (own && byId.has(own)) laneId = own;
        else {
          offStyle++;
          continue;
        }
      }
    }
    const sp: SpotifyPick = { artist: p.artist, track: p.track, laneId, ...(p.feat?.length ? { feat: p.feat } : {}) };
    style.set(sp, plan.mode === 'request' ? p.lane : undefined);
    source.set(sp, p);
    spicks.push(sp);
  }
  const rules = laneRules(plan, allowScenes(deps.profile, asked), deps.excludeIds, deps.now, deps.library);
  // A request's songs follow the regional rule when their style (or the request's own words, never a
  // name in it) is French / Arabic / Maghreb.
  const requestText = withoutNames(deps.intent?.rawText ?? '', names);
  // Its lyrics language counts too ("French" → the regional rule), and its style labels stand in for the
  // genres Spotify track lookups don't carry, so blocked styles are caught before a song is accepted.
  const ruleLane = (pk: SpotifyPick) => (plan.mode === 'request' ? ruleLaneFor(plan, [style.get(pk), source.get(pk)?.lang, requestText], deps.now) : byId.get(pk.laneId)!);
  const need = Object.fromEntries(plan.order.map((id) => [id, (plan.targets[id] ?? 3) + 2]));
  const res = await resolveSpotifyPicks(spicks, { http: deps.http, env: deps.env }, {
    allowSearch: !deps.searchBlocked && !deps.lookupBlocked, allowLookups: !deps.lookupBlocked, need, excludeIds: deps.excludeIds,
    accept: (item, pk) => laneReject(item.genres.length ? item : { ...item, genres: pickLabels(source.get(pk)) }, ruleLane(pk), rules),
  });
  const perLane: Record<string, number> = {};
  const items = res.items.map((r) => {
    const lane = byId.get(r.pick.laneId)!;
    perLane[lane.id] = (perLane[lane.id] ?? 0) + 1;
    const s = style.get(r.pick);
    const src = source.get(r.pick);
    const genres = plan.mode === 'request' ? (s ? [s] : []) : lane.genres.length ? lane.genres.slice(0, 2) : (LANE_BY_ID[lane.id]?.descriptors ?? []).slice(0, 2);
    const wanted = plan.mode === 'request' && src ? wantedRegion(src, { asked }) : null;
    return {
      ...r.item,
      genres: r.item.genres.length ? r.item.genres : genres,
      metadata: {
        ...(r.item.metadata ?? {}),
        lane: laneTag(lane),
        aiPick: true,
        aiOrder: r.index,
        ...lyricsLangOf(src),
        ...(wanted ? { wantedScene: wanted } : {}),
        ...(lane.source === 'library' ? { laneEra: lane.era } : {}),
        ...(moodPhrase(lane) ? { laneMood: moodPhrase(lane) } : {}),
        resolvedVia: r.via,
        retrievedBy: `ai:${r.pick.artist}`,
        retrievedFor: (deps.concepts ?? []).slice(0, 3),
      },
    } as ContentItem;
  });
  const rejected = [...(offStyle ? [`off-lane style ${offStyle}`] : []), ...(regionalDropped ? [`regional language ${regionalDropped}`] : []), ...Object.entries(res.stats.rejected).map(([k, v]) => `${k} ${v}`)].join(', ');
  const detail = `${items.length}/${picks.length} curator picks resolved for ${plan.mode === 'request' ? 'the request' : plan.lanes.map((l) => l.label).join(' · ')} (cache ${res.stats.cached}, ListenBrainz ${res.stats.listenbrainz}, search ${res.stats.searched}${deps.searchBlocked ? ' blocked' : ''}${deps.lookupBlocked ? ', lookups blocked: cache only' : ''}${rejected ? `; rejected: ${rejected}` : ''})`;
  return { items, detail, rateLimitedSec: res.rateLimitedSec, lookupLimitedSec: res.lookupLimitedSec, perLane, ...(suggested.length ? { suggested } : {}) };
}

// ───────────── a request naming an artist ─────────────

const SKIT_RE = /\b(skit|interlude)\b/i;

/**
 * The curator's lyrics language for the catalog row (metadata.lyricsLang): the stored fallback places a
 * French / Arabic song in its regional lane (switched off, 2015+, capped) whatever its style label.
 */
function lyricsLangOf(p: Pick<MusicPick, 'lang'> | undefined): { lyricsLang?: string } {
  const l = typeof p?.lang === 'string' ? p.lang.trim().slice(0, 24) : '';
  return l && /^[\p{L} ]+$/u.test(l) ? { lyricsLang: l } : {};
}

/** A stored song's lyrics language (the curator's label), when it has one. */
export const lyricsLangOfItem = (s: { metadata?: Record<string, unknown> }) => (typeof s.metadata?.lyricsLang === 'string' ? (s.metadata.lyricsLang as string) : undefined);
const EMPTY_RESOLVE: ResolveResult = { items: [], stats: { cached: 0, listenbrainz: 0, searched: 0, unresolved: 0, rejected: {} } };

/** The pick's main artist is the named artist (any credit form: "Eminem feat. Dido" counts as Eminem). */
const isNamed = (name: string, p: Pick<MusicPick, 'artist' | 'feat'>) => artistMatches(name, [splitArtist(p.artist).main]) || (p.feat ?? []).some((f) => artistMatches(name, [f]));

/**
 * Entity request sub-modes: two curator calls in parallel, each resolved on Spotify under its own rules.
 *  - "<Artist>" (entity-by): that artist's songs, signature songs and deeper cuts, any era; the named
 *    artist must be on every track; songs already in the library may come back, ranked after the others and
 *    flagged metadata.inLibrary; no regional / blocked-style rule (the user named them).
 *  - "Artists like <Artist>" (entity-like): one song each by different related artists, never the named
 *    artist; the owner's rules hold: switched-off languages/styles dropped (by the curator's language and
 *    style labels) unless asked for or the named artist belongs to that scene, regional songs 2015+ and
 *    capped, versions/compilations, library and recently shown songs excluded. Each carries the curator's
 *    short "why".
 */
async function curateEntityMusic(plan: MusicPlan, deps: CurateDeps): Promise<CurateResult> {
  const e = plan.entity!;
  const text = deps.intent?.rawText ?? e.name;
  const byLane = plan.lanes.find((l) => l.id === ENTITY_BY_LANE);
  const likeLane = plan.lanes.find((l) => l.id === ENTITY_LIKE_LANE);
  const blocked = blockedRegions(deps.profile);
  // Scenes the request's own words ask for: the artist's name is not a request ("French Montana").
  const names = [e.name, ...namesOf(deps.intent)];
  const asked = askedRegions(text, deps.intent?.language, names);
  const avoid = [...deps.profile.explicit.dislikes, ...(deps.intent?.excludes ?? []).filter((x) => !CONCEPT_BY_ID[x])].map((x) => x.trim()).filter(Boolean);
  const base = { text, vocals: plan.rules.vocals, familiar: plan.rules.familiar };
  const notes: string[] = [];
  const ask = async (brief: CuratorBrief, label: string) => {
    try {
      return await llmMusicPicks(brief, deps.ai, deps.http, { seed: deps.seed ?? 0 });
    } catch (err) {
      notes.push(`${label} curator failed (${String((err as Error)?.message ?? err).slice(0, 60)})`);
      return [] as MusicPick[];
    }
  };
  const [byRaw, likeRaw] = await Promise.all([
    byLane ? ask({ request: { ...base, count: entityAsk(plan.targets[byLane.id]), entity: { name: e.name, mode: 'by' } } }, 'by') : Promise.resolve([] as MusicPick[]),
    likeLane
      ? ask({
        request: {
          ...base, count: entityAsk(plan.targets[likeLane.id]), entity: { name: e.name, mode: 'like' }, background: deps.profile.music ? musicBrief(deps.profile.music, { styles: false }) : undefined,
          regionalMinYear: plan.policy.regionalMinYear, offLanguages: offLanguages(deps.profile, text, deps.intent?.language, names),
        },
        avoid: [...new Set(avoid)],
      }, 'like')
      : Promise.resolve([] as MusicPick[]),
  ]);
  const byPicks = byRaw.filter((p) => isNamed(e.name, p));
  // The named artist's own scene, so "artists like <a French rapper>" may be French: by their own songs'
  // language/style, else by the language the interpreter gave for them. Never by the like picks being
  // judged (a curator ignoring the off-language rule would otherwise wave its own picks through).
  const named = byPicks.length ? majorityRegion(byPicks) : regionOfLanguage(e.lang);
  const notSelf = likeRaw.filter((p) => !isNamed(e.name, p));
  const likeTarget = likeLane ? plan.targets[likeLane.id] : 0;
  const byTarget = byLane ? plan.targets[byLane.id] : 0;
  const reg = regionalPicks(notSelf, { blocked, asked, named, cap: Math.max(1, Math.round(likeTarget * plan.policy.regionalShare)) });

  const source = new Map<SpotifyPick, MusicPick>();
  const toSpotify = (p: MusicPick, laneId: string): SpotifyPick => {
    const sp: SpotifyPick = { artist: p.artist, track: p.track, laneId, ...(p.feat?.length ? { feat: p.feat } : {}) };
    source.set(sp, p);
    return sp;
  };
  const bySp = byLane ? byPicks.map((p) => toSpotify(p, byLane.id)) : [];
  const likeSp = likeLane ? reg.kept.map((p) => toSpotify(p, likeLane.id)) : [];
  const rules = laneRules(plan, deps.profile, deps.excludeIds, deps.now, deps.library);
  const ctx = { http: deps.http, env: deps.env };
  // The two lanes resolve in parallel and share one stop: the first 429 (search or lookups) stops both.
  const stop = { search: false, lookups: false };
  const common = { allowSearch: !deps.searchBlocked && !deps.lookupBlocked, allowLookups: !deps.lookupBlocked, maxSearches: 4, stop };
  const byExclude = deps.entityExcludeIds ?? deps.excludeIds;
  const owns = (item: ContentItem) => inLibrary(item, deps.library) || !!deps.library?.ids?.has(item.id);
  const [byRes, likeRes] = await Promise.all([
    bySp.length
      ? resolveSpotifyPicks(bySp, ctx, {
        // The lane stops resolving once it has its songs (a couple spare); songs the user already has
        // don't count (they go last), so the lane still fills with ones they haven't saved.
        ...common, excludeIds: byExclude, need: { [byLane!.id]: byTarget + 2 }, counts: (item) => !owns(item),
        accept: (item) => {
          if (!artistMatches(e.name, item.creators)) return 'other artist';
          if (byExclude?.has(item.id)) return 'excluded';
          if (VERSION_RE.test(item.title) || SKIT_RE.test(item.title)) return 'version';
          if (item.metadata?.albumType === 'compilation') return 'compilation';
          return null;
        },
      })
      : Promise.resolve(EMPTY_RESOLVE),
    likeSp.length
      ? resolveSpotifyPicks(likeSp, ctx, {
        ...common, excludeIds: deps.excludeIds, need: { [likeLane!.id]: likeTarget + 2 },
        accept: (item, pk) => {
          if (artistMatches(e.name, item.creators)) return 'named artist';
          const p = source.get(pk);
          // A scene asked for or the named artist's own: its switched-off styles are allowed for this pick
          // (the regional 2015+ era rule still holds).
          const wanted = p ? wantedRegion(p, { asked, named }) : null;
          return laneReject(item.genres.length ? item : { ...item, genres: pickLabels(p) }, { ...likeLane!, regional: !!(p && pickRegion(p)) }, wanted ? { ...rules, profile: allowScenes(rules.profile, [wanted]) } : rules);
        },
      })
      : Promise.resolve(EMPTY_RESOLVE),
  ]);

  const perLane: Record<string, number> = {};
  const items: ContentItem[] = [];
  const seenSongs = new Set<string>();
  for (const [lane, res] of [[byLane, byRes], [likeLane, likeRes]] as const) {
    if (!lane) continue;
    for (const r of res.items) {
      // The same recording under two picks ("Lose Yourself" / "Lose Yourself - From 8 Mile") only once.
      const key = songKey(r.item.creators[0] ?? '', r.item.title) || r.item.id;
      if (seenSongs.has(key)) continue;
      seenSongs.add(key);
      const p = source.get(r.pick);
      const owned = lane.id === ENTITY_BY_LANE && owns(r.item);
      const wanted = lane.id === ENTITY_LIKE_LANE && p ? wantedRegion(p, { asked, named }) : null;
      perLane[lane.id] = (perLane[lane.id] ?? 0) + 1;
      items.push({
        ...r.item,
        genres: r.item.genres.length ? r.item.genres : p?.lane ? [p.lane] : [],
        metadata: {
          ...(r.item.metadata ?? {}),
          lane: laneTag(lane),
          aiPick: true,
          ...lyricsLangOf(p),
          ...(wanted ? { wantedScene: wanted } : {}),
          // Songs the user already has come after the ones they don't, in the curator's order.
          aiOrder: (owned ? 1000 : 0) + r.index,
          ...(lane.id === ENTITY_BY_LANE ? { inLibrary: owned } : {}),
          entity: { name: e.name, role: lane.id === ENTITY_BY_LANE ? 'by' : 'like', ...(lane.id === ENTITY_LIKE_LANE && p?.why ? { note: p.why } : {}) },
          resolvedVia: r.via,
          retrievedBy: `ai:${r.pick.artist}`,
          retrievedFor: (deps.concepts ?? []).slice(0, 3),
        },
      } as ContentItem);
    }
  }
  const stat = (res: ResolveResult) => `cache ${res.stats.cached}, ListenBrainz ${res.stats.listenbrainz}, search ${res.stats.searched}`;
  const rej = (res: ResolveResult, extra: Array<[string, number]>) => {
    const all = [...extra.filter(([, n]) => n > 0), ...Object.entries(res.stats.rejected)].map(([k, v]) => `${k} ${v}`).join(', ');
    return all ? `; rejected: ${all}` : '';
  };
  const parts = [
    byLane ? `${e.name}: ${perLane[byLane.id] ?? 0}/${byRaw.length} (${stat(byRes)}${rej(byRes, [['other artist', byRaw.length - byPicks.length]])})` : '',
    likeLane ? `${likeLane.label}: ${perLane[likeLane.id] ?? 0}/${likeRaw.length} (${stat(likeRes)}${rej(likeRes, [['named artist', likeRaw.length - notSelf.length], ['regional language', reg.dropped]])})` : '',
  ].filter(Boolean);
  const detail = `${items.length}/${byRaw.length + likeRaw.length} curator picks resolved for ${parts.join(' · ')}${deps.searchBlocked ? ', search blocked' : ''}${deps.lookupBlocked ? ', lookups blocked: cache only' : ''}${notes.length ? `; ${notes.join('; ')}` : ''}`;
  const rateLimitedSec = Math.max(byRes.rateLimitedSec ?? -1, likeRes.rateLimitedSec ?? -1);
  const lookupLimitedSec = Math.max(byRes.lookupLimitedSec ?? -1, likeRes.lookupLimitedSec ?? -1);
  return { items, detail, perLane, ...(rateLimitedSec >= 0 ? { rateLimitedSec } : {}), ...(lookupLimitedSec >= 0 ? { lookupLimitedSec } : {}) };
}

// ───────────── music fallback (stored songs for short lanes) ─────────────

/** Songs shown to the user this recently never come back on a refresh (discover's exclusion window). */
export const SHOWN_WINDOW_MS = 3 * 86400_000;
/** A short music-only page may re-show songs last shown at least this long ago. */
export const RESHOW_AFTER_MS = 86400_000;

/**
 * Where a stored song offered to the fallback comes from (metadata.fallbackTier, set by the server):
 * 1 = songs ECHO recommended to this user in the last 90 days, not shown in the last 3 days;
 * 2 = songs ECHO's curator verified for ANY user (the shared catalog);
 * 3 = this user's songs last shown 24 h–3 days ago (only for a short music-only page).
 */
export type FallbackTier = 1 | 2 | 3;

export function fallbackTierOf(s: { metadata?: Record<string, unknown> }): FallbackTier {
  const t = s.metadata?.fallbackTier;
  return t === 2 || t === 3 ? t : 1;
}

const isTrackId = (id: string) => id.startsWith('spotify:track:');

/**
 * This user's recently recommended songs the fallback may use, by last-shown time: `own` (tier 1) =
 * shown before the 3-day window, the `max` shown longest ago first; `reshow` (tier 3, only when asked) =
 * shown 24 h–3 days ago, least recently shown first. Held-back ids (library, dislikes) never appear.
 */
export function historyTiers(lastShown: Map<string, number>, asOf: number, hold: (id: string) => boolean, opts: { reshow?: boolean; max?: number } = {}): { own: string[]; reshow: string[] } {
  const own: Array<[string, number]> = [];
  const reshow: Array<[string, number]> = [];
  for (const [id, at] of lastShown) {
    if (!isTrackId(id) || hold(id) || !Number.isFinite(at)) continue;
    const age = asOf - at;
    if (age >= SHOWN_WINDOW_MS) own.push([id, at]);
    else if (opts.reshow && age >= RESHOW_AFTER_MS) reshow.push([id, at]);
  }
  const oldestFirst = (a: [string, number], b: [string, number]) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1);
  return { own: own.sort(oldestFirst).slice(0, opts.max ?? 900).map(([id]) => id), reshow: reshow.sort(oldestFirst).map(([id]) => id) };
}

/**
 * Tier 2: songs ECHO's lane engine verified for any user in a taste lane (taxonomy lane tag, Spotify
 * track with an embed, not stale or imported), minus this user's own history and anything held back
 * (library, dislikes, shown in the last 3 days). Never another user's typed requests or open "Fresh
 * picks" lane: their only style evidence is a free-text label (a French song labelled "drill" would pass
 * as hip-hop), and one user's requests must not fill everyone's pool. Per-user fields are dropped.
 */
export function sharedPool<T extends ContentItem>(rows: T[], own: Set<string>, hold: (id: string) => boolean): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const i of rows) {
    if (seen.has(i.id) || own.has(i.id) || hold(i.id)) continue;
    if (i.category !== 'music' || i.kind !== 'track' || i.provider !== 'spotify' || !i.embed || i.metadata?.imported || i.metadata?.stale === true) continue;
    if (!LANE_BY_ID[laneTagOf(i)?.id ?? '']) continue;
    seen.add(i.id);
    out.push({ ...i, metadata: { ...withoutPerUser(i.metadata), fallbackTier: 2 } });
  }
  return out;
}

/**
 * Songs a short music-only page may show again: last shown 24 h–3 days before `asOf` (older ones aren't
 * excluded at all) and not held back for another reason (library, dislikes, skips, the page being replaced).
 */
export function reshowableIds(lastShown: Map<string, number>, asOf: number, hold: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const [id, at] of lastShown) {
    const age = asOf - at;
    if (isTrackId(id) && age >= RESHOW_AFTER_MS && age < SHOWN_WINDOW_MS && !hold.has(id)) out.add(id);
  }
  return out;
}

export interface LaneFallbackContext {
  profile: TasteProfile;
  excludeIds?: Set<string>;
  library?: LibrarySongs;
  /** Songs the curator already placed per lane. */
  have?: Record<string, number>;
  now?: Date;
  /** The page shows music only: tier-3 songs (shown 24 h–3 days ago) may fill what is still short. */
  musicOnly?: boolean;
  /** Ids held back only because they were shown 24 h–3 days ago (see reshowableIds). */
  reshowable?: Set<string>;
}

/**
 * Fill lanes the curator left short with stored Spotify songs that fit them: same lane (stored lane tag
 * or genres mapped through the taxonomy), passing the era/regional, exclusion, library, blocked-style and
 * disliked-artist rules. Tier by tier until the lanes are full: (1) songs ECHO recommended to this user,
 * least recently shown first; (2) songs ECHO's curator verified for anyone; (3) on a music-only page only,
 * this user's songs shown more than 24 hours ago, least recently shown first. Never imported libraries.
 */
export function laneFallback(stored: ContentItem[], plan: MusicPlan, ctx: LaneFallbackContext): ContentItem[] {
  if (plan.mode !== 'lanes') return [];
  const now = ctx.now ?? new Date();
  const rules = laneRules(plan, ctx.profile, ctx.excludeIds, now, ctx.library);
  // Tier 3 follows the same rules except the recently-shown window, for the ids the caller marked re-showable.
  const reshowable = ctx.musicOnly && ctx.reshowable?.size ? ctx.reshowable : null;
  const relaxed: LaneRuleContext | null = reshowable ? { ...rules, excludeIds: ctx.excludeIds ? new Set([...ctx.excludeIds].filter((id) => !reshowable.has(id))) : undefined } : null;
  const fitOf = (s: ContentItem) => {
    // French / Arabic lyrics (the curator's label, stored with the song): its regional lane, whatever its style label.
    const byLang = regionalLaneOfLanguage(lyricsLangOfItem(s));
    if (byLang) return byLang;
    const tag = laneTagOf(s)?.id;
    return tag && LANE_BY_ID[tag] ? tag : laneOfGenres(s.genres);
  };
  const shownAt = (s: ContentItem) => (typeof s.metadata?.lastShownAt === 'string' ? new Date(s.metadata.lastShownAt as string).getTime() : NaN);
  const shownBonus = (s: ContentItem) => {
    const at = shownAt(s);
    if (!Number.isFinite(at)) return 0.3;
    return 0.3 * Math.min(1, Math.max(0, (now.getTime() - at) / (30 * 86400_000)));
  };
  // Fit and tier once per song; songs grouped by lane (the open lane takes from all of them).
  type Entry = { s: ContentItem; f: string | null; tier: FallbackTier; regional: boolean };
  const pool: Entry[] = [];
  const byLane = new Map<string, Entry[]>();
  for (const s of stored) {
    if (s.category !== 'music' || s.kind !== 'track' || s.provider !== 'spotify' || !s.embed || s.metadata?.imported) continue;
    const f = fitOf(s);
    // A song whose own lane is switched off for this listener (e.g. French) never fills another lane.
    if (f && laneBlocked({ id: f }, ctx.profile)) continue;
    const e: Entry = { s, f, tier: fallbackTierOf(s), regional: !!LANE_BY_ID[f ?? '']?.regional };
    pool.push(e);
    if (!f) continue;
    const group = byLane.get(f);
    if (group) group.push(e);
    else byLane.set(f, [e]);
  }
  const want = new Map<string, number>();
  for (const lane of plan.lanes) {
    const deficit = (plan.targets[lane.id] ?? 0) - (ctx.have?.[lane.id] ?? 0);
    if (deficit > 0) want.set(lane.id, deficit + 2);
  }
  // The open lane keeps French / Arabic / Maghreb songs within the regional share.
  const regionalCap = Math.floor((plan.targets[MIX_LANE.id] ?? 0) * plan.policy.regionalShare);
  let regionalInMix = 0;
  const taken = new Set<string>();
  const out: ContentItem[] = [];
  for (const tier of [1, 2, 3] as const) {
    const tierRules = tier === 3 ? relaxed : rules;
    if (!tierRules) continue;
    for (const lane of plan.lanes) {
      const left = want.get(lane.id) ?? 0;
      if (left <= 0) continue;
      const mix = lane.id === MIX_LANE.id;
      const ranked = (mix ? pool : byLane.get(lane.id) ?? [])
        .filter((e) => e.tier === tier && !taken.has(e.s.id) && (mix ? !!e.f || !!e.s.metadata?.aiPick : e.f === lane.id))
        .filter((e) => !(tier === 3 && !reshowable!.has(e.s.id)))
        .filter((e) => !laneReject(e.s, mix ? { ...lane, regional: e.regional } : lane, tierRules))
        .map((e) => {
          const affinity = Math.max(0, ...e.s.creators.map((c) => ctx.profile.creators[normKey(c)] ?? 0));
          // Tier 3: least recently shown first. Otherwise lane fit, then songs not shown lately, then artist affinity.
          const score = tier === 3 ? -shownAt(e.s) || 0 : (laneTagOf(e.s)?.id === lane.id ? 1 : 0.7) + shownBonus(e.s) + 0.1 * Math.tanh(affinity);
          return { e, score };
        })
        .sort((a, b) => b.score - a.score || (a.e.s.id < b.e.s.id ? -1 : 1));
      let n = 0;
      for (const { e } of ranked) {
        if (n >= left) break;
        if (mix && e.regional) {
          if (regionalInMix >= regionalCap) continue;
          regionalInMix++;
        }
        taken.add(e.s.id);
        n++;
        // Per-user and per-lane fields are rebuilt here, never carried over from the shared catalog row.
        out.push({
          ...e.s,
          metadata: {
            ...withoutPerUser(e.s.metadata),
            lane: laneTag(lane),
            aiPick: false,
            aiOrder: 1000 + out.length,
            fallback: true,
            fallbackTier: tier,
            ...(lane.source === 'library' ? { laneEra: lane.era } : {}),
            ...(moodPhrase(lane) ? { laneMood: moodPhrase(lane) } : {}),
          },
        });
      }
      want.set(lane.id, left - n);
    }
  }
  return out;
}

/**
 * A named artist's own lane, when the curator left it short (ListenBrainz down, lookups rate-limited):
 * stored songs crediting them as the main artist, under the lane's rules (no versions, skits or
 * compilations, nothing held back), library songs flagged and after the others. Never anyone else's songs.
 */
export function entityLaneFallback(stored: ContentItem[], plan: MusicPlan, ctx: { excludeIds?: Set<string>; library?: LibrarySongs; have?: number }): ContentItem[] {
  const e = plan.entity;
  const lane = plan.lanes.find((l) => l.id === ENTITY_BY_LANE);
  if (!e || !lane) return [];
  const want = (plan.targets[lane.id] ?? 0) - (ctx.have ?? 0);
  const out: ContentItem[] = [];
  const songs = new Set<string>();
  for (const s of stored) {
    if (out.length >= want) break;
    if (s.category !== 'music' || s.kind !== 'track' || s.provider !== 'spotify' || !s.embed || s.metadata?.imported || s.metadata?.stale === true) continue;
    if (!artistMatches(e.name, [s.creators[0] ?? ''])) continue;
    if (ctx.excludeIds?.has(s.id) || VERSION_RE.test(s.title) || SKIT_RE.test(s.title) || s.metadata?.albumType === 'compilation') continue;
    const key = songKey(s.creators[0] ?? '', s.title) || s.id;
    if (songs.has(key)) continue;
    songs.add(key);
    const owned = inLibrary(s, ctx.library) || !!ctx.library?.ids?.has(s.id);
    out.push({
      ...s,
      metadata: { ...withoutPerUser(s.metadata), lane: laneTag(lane), aiPick: false, aiOrder: (owned ? 3000 : 2000) + out.length, inLibrary: owned, fallback: true, entity: { name: e.name, role: 'by' } },
    });
  }
  return out;
}

/** aiOrder of songs that didn't come from the curator: after its picks in their lane, ranked by score among themselves. */
export const SEARCH_ORDER = 1500;
export const STORED_ORDER = 2000;

/**
 * Songs that didn't come from the curator (Spotify search results; stored songs for a request) still
 * follow the shared contract (metadata.lane) and the lane rules (era / regional 2015+, exclusions,
 * library, disliked artists, versions): a request's songs join the request lane, an open feed's join the
 * open "Fresh picks" lane. Songs failing the rules are dropped. Non-music items pass through untouched.
 */
export function laneLooseMusic(
  items: ContentItem[],
  plan: MusicPlan,
  ctx: { profile: TasteProfile; excludeIds?: Set<string>; library?: LibrarySongs; now?: Date; text?: string; order: number; fallback?: boolean },
): ContentItem[] {
  const rules = laneRules(plan, ctx.profile, ctx.excludeIds, ctx.now, ctx.library);
  const tag = laneTag(plan.mode === 'request' ? REQUEST_LANE : MIX_LANE);
  const out: ContentItem[] = [];
  for (const s of items) {
    if (s.category !== 'music') {
      out.push(s);
      continue;
    }
    const by = typeof s.metadata?.retrievedBy === 'string' ? (s.metadata.retrievedBy as string) : undefined;
    const lane = ruleLaneFor(plan, [s.genres, by, plan.mode === 'request' ? ctx.text : undefined], ctx.now);
    // A stored song once served in a regional lane, or in French / Arabic (the curator's label), keeps the
    // regional rule; one whose language is switched off for this listener is never served.
    const langLane = regionalLaneOfLanguage(lyricsLangOfItem(s));
    if (langLane && laneBlocked({ id: langLane }, ctx.profile)) continue;
    const storedRegional = !!LANE_BY_ID[laneTagOf(s)?.id ?? '']?.regional || !!langLane;
    if (laneReject(s, storedRegional ? { ...lane, regional: true } : lane, rules)) continue;
    out.push({ ...s, metadata: { ...withoutPerUser(s.metadata), lane: tag, aiPick: false, aiOrder: ctx.order, ...(ctx.fallback ? { fallback: true } : {}) } });
  }
  return out;
}
