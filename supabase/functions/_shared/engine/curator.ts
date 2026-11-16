// Music curation by taste lanes: plan the refresh (which lanes, how many songs each), brief the AI
// curator with generic words only, resolve its picks on Spotify under the owner's rules, and fill
// short lanes from stored songs that fit them. Pure orchestration: I/O is injected.
import type { Category, ContentItem, Intent, MusicLane, MusicPolicy, TasteProfile } from '../types.ts';
import type { HttpClient } from '../providers/http.ts';
import type { Env } from '../providers/types.ts';
import { resolveSpotifyPicks, type SpotifyPick } from '../providers/spotify.ts';
import { musicBrief } from '../importer.ts';
import { llmMusicPicks, type AiConfig, type CuratorBrief, type CuratorLane } from './ai.ts';
import {
  chooseLanes, DEFAULT_MIN_YEAR, effectiveLanes, eraFloor, LANE_BY_ID, laneBlocked, laneOfGenre, laneOfGenres, laneReject, laneTag, laneTagOf, laneTargets, MIX_LANE, moodPhrase,
  musicPolicy, popularityPhrase, REQUEST_LANE, type LaneRuleContext,
} from './lanes.ts';
import { CONCEPT_BY_ID } from './concepts.ts';
import { categoryQuotas } from './rank.ts';
import { normKey } from './text.ts';

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

/** Which lanes this refresh serves and how many songs each (min 3 per lane; fewer lanes for small quotas). */
export function planMusic(profile: TasteProfile, opts: { hasQuery: boolean; seed: number; total: number; text?: string; now?: Date }): MusicPlan | null {
  const now = opts.now ?? new Date();
  if (opts.total <= 0) return null;
  const policy = musicPolicy(profile);
  if (opts.hasQuery) {
    const rules = requestRules(opts.text);
    return { mode: 'request', lanes: [requestLane(rules, now)], order: [REQUEST_LANE.id], targets: { [REQUEST_LANE.id]: opts.total }, total: opts.total, policy, rules };
  }
  const n = Math.max(1, Math.min(3, Math.floor(opts.total / 3)));
  const chosen = chooseLanes(effectiveLanes(profile, now), opts.seed, n, { feedback: profile.laneFeedback, blocked: (l) => laneBlocked(l, profile) });
  if (!chosen.length) return null;
  const t = laneTargets(chosen, opts.total, 3);
  return {
    mode: 'lanes', lanes: chosen, order: chosen.map((l) => l.id), targets: Object.fromEntries(chosen.map((l, i) => [l.id, t[i]])), total: opts.total, policy,
    rules: { era: true, vocals: true, familiar: true },
  };
}

/** Songs asked from the curator per lane: ~9, more when a lane must fill a bigger shelf. */
export const askCount = (target: number) => Math.max(9, Math.min(14, target + 4));

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
  /** Spotify search is rate-limited: resolve via cache, ListenBrainz and single-track lookups only. */
  searchBlocked?: boolean;
  seed?: number;
  now?: Date;
}

export interface CurateResult {
  items: ContentItem[];
  detail: string;
  rateLimitedSec?: number;
  perLane: Record<string, number>;
}

/** Rules a song must pass for a lane (era/regional, exclusions, disliked artists, versions). */
export function laneRules(plan: MusicPlan, profile: TasteProfile, excludeIds?: Set<string>, now?: Date): LaneRuleContext {
  return { profile, policy: plan.policy, excludeIds, era: plan.rules.era, now };
}

/** Brief → curator → resolve on Spotify → items tagged with their lane, in the curator's order. */
export async function curateMusic(plan: MusicPlan, deps: CurateDeps): Promise<CurateResult> {
  const brief = buildBrief(plan, deps.profile, { intent: deps.intent, words: deps.words, moods: deps.moods });
  const picks = await llmMusicPicks(brief, deps.ai, deps.http, { seed: deps.seed ?? 0 });
  const byId = new Map(plan.lanes.map((l) => [l.id, l]));
  const byLabel = new Map(plan.lanes.map((l) => [normKey(l.label), l.id]));
  const style = new Map<SpotifyPick, string | undefined>();
  const spicks: SpotifyPick[] = [];
  for (const p of picks) {
    let laneId: string | undefined;
    if (plan.mode === 'request') laneId = REQUEST_LANE.id;
    else if (p.lane && byId.has(p.lane)) laneId = p.lane;
    else if (p.lane && byLabel.has(normKey(p.lane))) laneId = byLabel.get(normKey(p.lane));
    else if (plan.lanes.length === 1) laneId = plan.lanes[0].id;
    if (!laneId) continue;
    const sp = { artist: p.artist, track: p.track, laneId };
    style.set(sp, plan.mode === 'request' ? p.lane : undefined);
    spicks.push(sp);
  }
  const rules = laneRules(plan, deps.profile, deps.excludeIds, deps.now);
  // A request's songs follow the regional rule when their style is French / Arabic / Maghreb.
  const ruleLane = (pk: SpotifyPick) => {
    const lane = byId.get(pk.laneId)!;
    if (plan.mode !== 'request') return lane;
    const s = style.get(pk);
    const def = s ? LANE_BY_ID[laneOfGenre(s) ?? ''] : undefined;
    return { ...lane, regional: !!def?.regional };
  };
  const need = Object.fromEntries(plan.order.map((id) => [id, (plan.targets[id] ?? 3) + 2]));
  const res = await resolveSpotifyPicks(spicks, { http: deps.http, env: deps.env }, { allowSearch: !deps.searchBlocked, need, accept: (item, pk) => laneReject(item, ruleLane(pk), rules) });
  const perLane: Record<string, number> = {};
  const items = res.items.map((r) => {
    const lane = byId.get(r.pick.laneId)!;
    perLane[lane.id] = (perLane[lane.id] ?? 0) + 1;
    const s = style.get(r.pick);
    const genres = plan.mode === 'request' ? (s ? [s] : []) : lane.genres.length ? lane.genres.slice(0, 2) : (LANE_BY_ID[lane.id]?.descriptors ?? []).slice(0, 2);
    return {
      ...r.item,
      genres: r.item.genres.length ? r.item.genres : genres,
      metadata: {
        ...(r.item.metadata ?? {}),
        lane: laneTag(lane),
        aiPick: true,
        aiOrder: r.index,
        ...(lane.source === 'library' ? { laneEra: lane.era } : {}),
        ...(moodPhrase(lane) ? { laneMood: moodPhrase(lane) } : {}),
        resolvedVia: r.via,
        retrievedBy: `ai:${r.pick.artist}`,
        retrievedFor: (deps.concepts ?? []).slice(0, 3),
      },
    } as ContentItem;
  });
  const rejected = Object.entries(res.stats.rejected).map(([k, v]) => `${k} ${v}`).join(', ');
  const detail = `${items.length}/${picks.length} curator picks resolved for ${plan.mode === 'request' ? 'the request' : plan.lanes.map((l) => l.label).join(' · ')} (cache ${res.stats.cached}, ListenBrainz ${res.stats.listenbrainz}, search ${res.stats.searched}${deps.searchBlocked ? ' blocked' : ''}${rejected ? `; rejected: ${rejected}` : ''})`;
  return { items, detail, rateLimitedSec: res.rateLimitedSec, perLane };
}

/**
 * Fill lanes the curator left short with stored Spotify songs that fit them: same lane (stored
 * lane tag or genres mapped through the taxonomy), passing the era/regional, exclusion and
 * disliked-artist rules, least recently shown first. Never other users' imported libraries.
 */
export function laneFallback(stored: ContentItem[], plan: MusicPlan, ctx: { profile: TasteProfile; excludeIds?: Set<string>; have?: Record<string, number>; now?: Date }): ContentItem[] {
  if (plan.mode !== 'lanes') return [];
  const now = ctx.now ?? new Date();
  const rules = laneRules(plan, ctx.profile, ctx.excludeIds, now);
  const usable = stored.filter((s) => s.category === 'music' && s.kind === 'track' && s.provider === 'spotify' && !!s.embed && !s.metadata?.imported);
  const fit = (s: ContentItem) => {
    const tag = laneTagOf(s)?.id;
    return tag && LANE_BY_ID[tag] ? tag : laneOfGenres(s.genres);
  };
  const shownBonus = (s: ContentItem) => {
    const at = typeof s.metadata?.lastShownAt === 'string' ? new Date(s.metadata.lastShownAt as string).getTime() : NaN;
    if (!Number.isFinite(at)) return 0.3;
    return 0.3 * Math.min(1, Math.max(0, (now.getTime() - at) / (30 * 86400_000)));
  };
  const taken = new Set<string>();
  const out: ContentItem[] = [];
  for (const lane of plan.lanes) {
    const deficit = (plan.targets[lane.id] ?? 0) - (ctx.have?.[lane.id] ?? 0);
    if (deficit <= 0) continue;
    const ranked = usable
      .map((s) => ({ s, f: fit(s) }))
      .filter(({ s, f }) => !taken.has(s.id) && (lane.id === MIX_LANE.id ? !!f || !!s.metadata?.aiPick : f === lane.id))
      .filter(({ s, f }) => !laneReject(s, lane.id === MIX_LANE.id ? { ...lane, regional: !!LANE_BY_ID[f ?? '']?.regional } : lane, rules))
      .map(({ s }) => {
        const affinity = Math.max(0, ...s.creators.map((c) => ctx.profile.creators[normKey(c)] ?? 0));
        return { s, score: (laneTagOf(s)?.id === lane.id ? 1 : 0.7) + shownBonus(s) + 0.1 * Math.tanh(affinity) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, deficit + 2);
    for (const { s } of ranked) {
      taken.add(s.id);
      // Per-user and per-lane fields are rebuilt here, never carried over from the shared catalog row.
      const { lastShownAt: _shown, laneEra: _era, laneMood: _mood, ...meta } = s.metadata ?? {};
      out.push({
        ...s,
        metadata: {
          ...meta,
          lane: laneTag(lane),
          aiPick: false,
          aiOrder: 1000 + out.length,
          fallback: true,
          ...(lane.source === 'library' ? { laneEra: lane.era } : {}),
          ...(moodPhrase(lane) ? { laneMood: moodPhrase(lane) } : {}),
        },
      });
    }
  }
  return out;
}
