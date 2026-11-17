// The transparent ECHO recommendation pipeline:
//   1 intent → 2 retrieval → 3 enrichment → 4 semantic analysis → 5 personal ranking
//   → 6 diversity → 7 explanation   (8 feedback happens in profile.ts via the feedback endpoint)
// Pure orchestration: all I/O is injected so it runs in Deno, Node and tests alike.
import type { AnalyzedItem, Category, ContentItem, DiscoverRequest, DiscoverResponse, Intent, ProviderId, TasteProfile } from '../types.ts';
import { PROVIDERS, providersFor } from '../providers/index.ts';
import { ProviderError, type HttpClient } from '../providers/http.ts';
import type { Env, Provider } from '../providers/types.ts';
import { aiConfig, mergeHint, sanitizeHint } from './ai.ts';
import { applyUnderstanding, llmUnderstand } from './understand.ts';
import { askedRegions, curateMusic, entityLaneFallback, fallbackTierOf, laneFallback, laneLooseMusic, musicQuotaFor, namesOf, planMusic, SEARCH_ORDER, STORED_ORDER, withoutNames, type MusicPlan } from './curator.ts';
import { allowScenes, ENTITY_BY_LANE, entityTagOf, isLaneVideo, laneTagOf, MIX_LANE, type LibrarySongs } from './lanes.ts';
import { liveSessionPool, staleSessionPool, type SessionPoolResult } from '../providers/youtube.ts';
import { matchEntitySessions, matchLaneSessions, sessionsServe } from './sessions.ts';
import { entityExtras, entityReply, extrasCap, isArtistEntity, primaryEntity, resolveEntity, type EntityResolution } from './entities.ts';
import { analyzeItem } from './analyze.ts';
import { conceptLabel, CONCEPT_BY_ID } from './concepts.ts';
import { parseIntent, refineIntent } from './intent.ts';
import { rankCandidates, type EvidenceItem, type ReferenceInfo } from './rank.ts';
import { planRetrieval, targetCategories } from './retrieve.ts';
import { fold, positivePart, topKeys } from './text.ts';

export interface PipelineDeps {
  env: Env;
  http: HttpClient;
  profile: TasteProfile;
  /** The music curator's own recent suggestions to this user ("Artist – Title"), not to be repeated. */
  curatorRecent?: string[];
  excludeIds?: Set<string>;
  /** The user's liked/saved songs by ISRC and artist|title: never served again under another id. */
  library?: LibrarySongs;
  /**
   * Items held back for a reason other than being in the library: shown very recently (this
   * conversation's last answer, the feed being replaced), skipped lately, disliked. Never served again,
   * even the library songs a named artist's own lane may otherwise show.
   */
  shownIds?: Set<string>;
  evidence?: EvidenceItem[];
  previousIntent?: Intent | null;
  previousResults?: AnalyzedItem[];
  /** Providers temporarily blocked (e.g. quota exhausted today). 'spotify' = Spotify search. */
  blockedProviders?: Set<ProviderId>;
  /** Spotify single-track lookups rate-limited (their own block): the curator resolves from cache only. */
  spotifyLookupBlocked?: boolean;
  collaborative?: (ids: string[]) => Promise<Map<string, number>>;
  /** Optional text embedder (Supabase gte-small). */
  embed?: (texts: string[]) => Promise<number[][]>;
  /** Previously stored embeddings by item id. */
  storedEmbeddings?: (ids: string[]) => Promise<Map<string, number[]>>;
  useLlm?: boolean;
  /**
   * Stored catalog items for a provider that is down/out of quota (keeps e.g. the Videos shelf alive).
   * Music: this user's recently recommended songs (fallback tier 1); with `shared`, also songs ECHO's
   * curator verified for any user (tier 2); with `reshow`, this user's songs shown 24 h–3 days ago (tier 3).
   */
  catalogFallback?: (provider: ProviderId, categories: Category[], opts?: CatalogFallbackOptions) => Promise<ContentItem[]>;
  /**
   * Stored catalog items naming `name` (title words or credits), minus what this user was shown lately or
   * holds back: the items around a named entity when its provider is out of quota, and a named artist's
   * own stored songs when the curator's lane comes back short.
   */
  catalogByName?: (provider: ProviderId, categories: Category[], name: string) => Promise<ContentItem[]>;
  /**
   * Songs held back only because they were shown 24 h–3 days ago: a music-only page that is still short
   * after the curator and the stored songs may show them again (least recently shown first).
   */
  reshowable?: Set<string>;
  seed?: number;
  now?: Date;
}

export interface CatalogFallbackOptions {
  /** Music: also the shared pool of curator-verified songs (fallback tier 2). */
  shared?: boolean;
  /** Music: also this user's songs shown 24 h–3 days ago (fallback tier 3). */
  reshow?: boolean;
}

export interface PipelineResult extends DiscoverResponse {
  candidates: AnalyzedItem[];
  quotaErrors: ProviderId[];
  /** Seconds a provider asked us to wait (Retry-After), when it said so. */
  quotaRetryAfter: Partial<Record<ProviderId, number>>;
  /** Spotify single-track lookups answered 429: seconds to wait (blocked separately from search). */
  spotifyLookupLimitedSec?: number;
  /** The curator's suggestions in this request (its own words), for the server to remember. */
  curatorSuggested?: string[];
}

const CATEGORY_NOUN: Record<Category, string> = { youtube: 'videos', music: 'music', screen: 'films & series', books: 'books', podcasts: 'podcasts' };

function timer() {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

function canEmbed(item: ContentItem): boolean {
  // Spotify Developer Policy: Spotify Content must not be ingested into ML/AI models. Sessions in music
  // lanes are matched locally only: their titles aren't embedded either.
  return item.provider !== 'spotify' && !isLaneVideo(item);
}

/** How long music waits for a session pool still being built once its songs are ready (then: the last good copy). */
export const POOL_WAIT_MS = 2500;

/** Live sessions / music videos each music lane shows on top of its songs: 2 on a music page or for a named artist, 1 in a mixed feed. */
export function laneVideosPerLane(categories: Category[], entity: boolean): number {
  return entity || (categories.length === 1 && categories[0] === 'music') ? 2 : 1;
}

export function embeddingText(item: ContentItem): string {
  return [item.title, item.genres.join(', '), item.tags.slice(0, 12).join(', '), (item.description ?? '').slice(0, 400)].filter(Boolean).join('. ');
}

/** Items limit for this request: `entityLimit` when it names an entity (chat: 20), else `limit` (default 12), at most 60. */
export function requestLimit(req: Pick<DiscoverRequest, 'limit' | 'entityLimit'>, intent: Pick<Intent, 'entities'>): number {
  const n = intent.entities?.length && req.entityLimit ? req.entityLimit : req.limit ?? 12;
  return Math.max(1, Math.min(n, 60));
}

/**
 * Provider calls of one request: blocked providers (stored blocks, plus any that answered "out of quota"
 * during this request: never called again in it), and the quota errors to record as blocks afterwards.
 */
interface RequestQuota {
  blocked: Set<ProviderId>;
  note: (provider: ProviderId, retryAfterSec?: number) => void;
}

async function resolveReferences(intent: Intent, deps: PipelineDeps, statuses: Map<ProviderId, DiscoverResponse['providers'][number]>, quota: RequestQuota) {
  const refs: ReferenceInfo[] = [];
  const refItems: AnalyzedItem[] = [];
  const similar: AnalyzedItem[] = [];
  const similarMap = new Map<string, string>();
  const entities: EntityResolution[] = [];
  const onError = (p: Provider, e: unknown) => {
    if (!(e instanceof ProviderError)) return;
    statuses.set(p.id, { id: p.id, status: e.kind === 'quota' ? 'quota' : 'error', message: e.message.slice(0, 160) });
    // Out of quota: recorded as a block, and no further call to that provider in this request.
    if (e.kind === 'quota') quota.note(p.id, e.retryAfterSec);
  };
  // Named entities are looked up by kind (an artist is never resolved as a book or a show); their works,
  // similar items and things about them come from entityExtras. At most 3 (a stored intent is bounded too).
  if (intent.entities && intent.entities.length > 3) intent.entities = intent.entities.slice(0, 3);
  for (const [i, e] of (intent.entities ?? []).entries()) {
    const r = await resolveEntity(e, intent.categories, { env: deps.env, http: deps.http, blocked: quota.blocked }, onError);
    entities.push(r);
    // A name of unknown kind the catalog revealed as a work ("dune" → the film): it takes that kind.
    if (r.kind && intent.entities) intent.entities[i] = { ...e, kind: r.kind };
    if (!r.item) continue;
    const a = analyzeItem(r.item);
    refs.push({ title: a.title, concepts: a.concepts, provider: r.provider ?? a.provider });
    // "like X": X itself isn't a recommendation; "X" / "by X": it is (shown first, see entityExtras).
    if (e.want === 'like') refItems.push(a);
  }
  const named = new Set((intent.entities ?? []).map((e) => fold(e.name)));
  const order: Category[] = intent.categories.length && !intent.categories.includes('screen') ? [...intent.categories, 'screen', 'books'] : ['screen', 'books', 'music', 'podcasts'];
  for (const title of intent.references.slice(0, 3)) {
    if (named.has(fold(title))) continue;
    let resolved: ContentItem | null = null;
    let via: Provider | null = null;
    for (const cat of [...new Set(order)]) {
      for (const p of providersFor(cat, deps.env)) {
        if (!p.resolve || quota.blocked.has(p.id)) continue;
        try {
          resolved = await p.resolve(title, { http: deps.http, env: deps.env }, cat);
          if (resolved) {
            via = p;
            break;
          }
        } catch (e) {
          onError(p, e);
        }
      }
      if (resolved) break;
    }
    if (!resolved || !via) continue;
    const a = analyzeItem(resolved);
    refItems.push(a);
    refs.push({ title: a.title, concepts: a.concepts, provider: via.id });
    if (via.similar) {
      try {
        for (const s of await via.similar(resolved, { http: deps.http, env: deps.env })) {
          const sa = analyzeItem(s);
          similar.push(sa);
          similarMap.set(sa.id, a.title);
        }
      } catch {
        /* similar is best-effort */
      }
    }
  }
  // Ordinal references to earlier results ("more like the second one")
  for (const idx of intent.ordinalRefs) {
    const list = deps.previousResults ?? [];
    const item = idx === -1 ? list[list.length - 1] : list[idx];
    if (!item) continue;
    refItems.push(item);
    refs.push({ title: item.title, concepts: item.concepts, provider: item.provider });
    const p = PROVIDERS[item.provider];
    if (p?.similar) {
      try {
        for (const s of await p.similar(item, { http: deps.http, env: deps.env })) {
          const sa = analyzeItem(s);
          similar.push(sa);
          similarMap.set(sa.id, item.title);
        }
      } catch {
        /* best-effort */
      }
    }
  }
  return { refs, refItems, similar, similarMap, entities };
}

export function describeIntent(intent: Intent): string {
  const parts: string[] = [];
  const top = topKeys(positivePart(intent.target), 4, 0.2).filter((k) => CONCEPT_BY_ID[k]);
  if (top.length) parts.push(top.map((k) => conceptLabel(k).toLowerCase()).join(' · '));
  if (intent.providers?.length) parts.push(`from ${intent.providers.join(', ')}`);
  if (intent.searchQueries && Object.keys(intent.searchQueries).length) parts.push(`searching “${[...new Set(Object.values(intent.searchQueries))].slice(0, 2).join('”, “')}”`);
  const e = primaryEntity(intent);
  if (e) parts.push(`${e.name} (${e.kind === 'other' ? 'a name' : e.kind}, ${e.want === 'all' ? 'everything' : e.want === 'by' ? 'their own work' : e.want === 'like' ? 'things like it' : 'things about it'})`);
  const refsShown = intent.references.filter((r) => !intent.entities?.some((x) => fold(x.name) === fold(r)));
  if (refsShown.length) parts.push(`in the spirit of ${refsShown.join(', ')}`);
  if (intent.relaxed.length) parts.push(`not necessarily ${[...new Set(intent.relaxed.map((r) => (CONCEPT_BY_ID[r] ? conceptLabel(r).toLowerCase() : r === 'sci-fi' ? 'science fiction' : r)))].join(', ')}`);
  if (intent.excludes.length) parts.push(`avoiding ${intent.excludes.map((r) => (CONCEPT_BY_ID[r] ? conceptLabel(r).toLowerCase() : r)).join(', ')}`);
  if (intent.trajectory) parts.push(`moving from ${conceptLabel(intent.trajectory.from).toLowerCase()} to ${conceptLabel(intent.trajectory.to).toLowerCase()}`);
  if (intent.complexity === 'deep') parts.push('in-depth');
  if (intent.duration) parts.push(`${intent.duration} format`);
  return parts.join('; ');
}

export async function runPipeline(req: DiscoverRequest, deps: PipelineDeps): Promise<PipelineResult> {
  const pipeline: DiscoverResponse['pipeline'] = [];
  const statuses = new Map<ProviderId, DiscoverResponse['providers'][number]>();
  const query = (req.query ?? '').trim();
  const hasQuery = query.length > 0;

  // ── Step 1: intent ──
  let t = timer();
  const rulesIntent = parseIntent(query, { moods: req.moods, categories: req.categories, exploration: undefined });
  const prevIntent = hasQuery ? deps.previousIntent ?? null : null;
  // Rules-only reading (the fallback), with conversational refinement.
  let intent = prevIntent ? refineIntent(prevIntent, rulesIntent) : rulesIntent;
  const ai = aiConfig(deps.env);
  if (ai && deps.useLlm !== false && hasQuery) {
    // AI-first understanding (any language, conversation-aware), with the rules as guardrails.
    try {
      const u = await llmUnderstand(query, prevIntent, ai, deps.http);
      intent = applyUnderstanding(rulesIntent, u, prevIntent);
      if (req.categories?.length && !u.categories.length) intent.categories = [...new Set([...intent.categories, ...req.categories])];
    } catch (e) {
      pipeline.push({ step: 'intent-llm', ms: 0, detail: `AI unavailable, rules only (${(e as Error).message.slice(0, 80)})` });
    }
  }
  if (req.intentHint) intent = mergeHint(intent, sanitizeHint(req.intentHint, query), 'rules+client-llm');
  const exploration = Math.max(0, Math.min(1, intent.exploration ?? req.exploration ?? deps.profile.exploration ?? 0.4));
  pipeline.push({ step: 'intent', ms: t(), detail: `${intent.intent} via ${intent.source}${describeIntent(intent) ? `: ${describeIntent(intent)}` : ''}` });

  let clarifyingQuestion: DiscoverResponse['clarifyingQuestion'] = null;
  const effectiveHasQuery = hasQuery && !intent.vague;
  if (hasQuery && intent.vague) {
    clarifyingQuestion = {
      text: 'Tell me a bit more. What are you in the mood for, or what did you last love?',
      options: ['Something calm and beautiful', 'A mind-expanding documentary', 'Music for focus', 'Surprise me, outside my comfort zone'],
    };
  }

  // Quota of this request: a provider that answers "out of quota" anywhere (references, entity lookups,
  // the items around an entity, searches) is recorded as a block and not called again in this request.
  const blocked = new Set<ProviderId>(deps.blockedProviders ?? []);
  const quotaErrors: ProviderId[] = [];
  const quotaRetryAfter: Partial<Record<ProviderId, number>> = {};
  const quota: RequestQuota = {
    blocked,
    note: (pid, retryAfterSec) => {
      blocked.add(pid);
      if (!quotaErrors.includes(pid)) quotaErrors.push(pid);
      if (retryAfterSec) quotaRetryAfter[pid] = Math.max(quotaRetryAfter[pid] ?? 0, retryAfterSec);
    },
  };

  // ── Step 2a: references ──
  t = timer();
  const needsRefs = intent.references.length || intent.ordinalRefs.length || intent.entities?.length;
  const { refs, refItems, similar, similarMap, entities: resolvedEntities } = needsRefs
    ? await resolveReferences(intent, deps, statuses, quota)
    : { refs: [], refItems: [], similar: [], similarMap: new Map<string, string>(), entities: [] as EntityResolution[] };
  const extraConcepts: string[] = [];
  for (const r of refs) {
    for (const k of topKeys(r.concepts, 4, 0.3)) {
      if (intent.relaxed.includes(k) || !CONCEPT_BY_ID[k] || CONCEPT_BY_ID[k].group === 'quality') continue;
      intent.target[k] = Math.max(intent.target[k] ?? 0, 0.7 * r.concepts[k]);
      extraConcepts.push(k);
    }
  }
  if (needsRefs) {
    const details = [...resolvedEntities.map((r) => r.detail), ...refs.filter((r) => !resolvedEntities.some((x) => x.item?.title === r.title)).map((r) => `${r.title} (${r.provider})`)];
    pipeline.push({ step: 'references', ms: t(), detail: details.length ? `resolved ${details.join(', ')}` : 'could not resolve references' });
  }

  // ── Step 2b: retrieval ──
  t = timer();
  const categories = targetCategories(intent, deps.profile, req.categories);
  for (const cat of categories) {
    if (!providersFor(cat, deps.env).length) {
      const p = cat === 'youtube' ? PROVIDERS.youtube! : PROVIDERS.spotify!;
      statuses.set(p.id, { id: p.id, status: 'unconfigured', message: p.setup });
    }
  }
  // A follow-up with nothing new to search for ("they're bad") explores fresh themes instead of repeating searches.
  const nothingToSearch = effectiveHasQuery && !intent.keywords.length && !topKeys(positivePart(intent.target), 1, 0.15).length && !intent.references.length && !intent.genres.length;
  const limit = requestLimit(req, intent);
  // A named entity: an artist is answered in music lanes ("<Artist>", "Artists like <Artist>") by the
  // curator, and every entity gets a bounded set of items around it in other media (entityExtras).
  const entity = effectiveHasQuery ? primaryEntity(intent) : null;
  const artist = entity && isArtistEntity(entity, categories) ? entity : null;
  const capExtras = entity ? extrasCap(entity, categories, limit) : 0;
  const curatorPossible = !!ai && deps.useLlm !== false && !!PROVIDERS.spotify?.configured(deps.env);
  const entityMusic = !!artist && artist.want !== 'about' && categories.includes('music') && curatorPossible;
  // Music is curated by taste lanes: which lanes this refresh serves and how many songs each.
  // (Spotify search answered 429 while resolving references: blocked for the curator too.)
  const searchBlocked = blocked.has('spotify');
  const musicTotal = entityMusic
    ? categories.length === 1 ? limit : Math.max(12, limit - (artist!.want === 'all' ? capExtras : 0))
    : musicQuotaFor(categories, limit, req.mix, effectiveHasQuery);
  const musicPlan: MusicPlan | null = categories.includes('music') && !(artist && artist.want === 'about')
    ? planMusic(deps.profile, {
      hasQuery: effectiveHasQuery, seed: deps.seed ?? 0, total: musicTotal, text: query, now: deps.now,
      entity: entityMusic ? { name: artist!.name, want: artist!.want as 'by' | 'like' | 'all', ...(artist!.lang ? { lang: artist!.lang } : {}) } : undefined,
    })
    : null;
  // The curator keeps working while Spotify search is rate-limited: picks resolve via ListenBrainz + single-track lookups.
  const curatorOn = !!musicPlan && curatorPossible;
  // A typed request's own words (never a name in it: "French Montana") may ask for a switched-off scene
  // ("rap français"): for this request its songs are allowed by style as well as by language, in every
  // step (curator, searched and stored songs, ranking). The named artist's own scene is per song (curator.ts).
  const names = namesOf(intent);
  const regionText = withoutNames(query, names);
  const askedScenes = musicPlan?.mode === 'request' && !musicPlan.entity ? askedRegions(query, intent.language, names) : new Set<string>();
  const musicProfile = allowScenes(deps.profile, askedScenes);
  // A named artist: their music comes from the curator's lanes. A bare name the interpreter knows as an
  // artist ("eminem") is answered by those lanes and the items around them (entityExtras): generic theme
  // searches ("music culture" films, videos) would only bury them. Otherwise ("eminem documentary", a
  // follow-up "only books", a name the rules only guessed) each other medium is searched for the name
  // itself (the interpreter's phrase, else the name), never by generic themes. YouTube's own search for
  // them is entityExtras' (its quota is precious).
  const bareArtist = !!artist && artist.source !== 'rules' && artist.want === 'all' && entityMusic;
  const nameSearch: Partial<Record<Category, string>> | null = artist && !bareArtist
    ? Object.fromEntries(categories.filter((c) => c !== 'music' && c !== 'youtube').map((c) => [c, intent.searchQueries?.[c] ?? artist.name]))
    : null;
  const nameQuery = (q: { params: { category: Category; query: string; retrievedFor?: string[] } }) =>
    !q.params.retrievedFor?.length && (q.params.query === intent.searchQueries?.[q.params.category] || fold(q.params.query).includes(fold(artist!.name)));
  const planIntent: Intent = nameSearch ? { ...intent, searchQueries: { ...intent.searchQueries, ...nameSearch } } : intent;
  const plan = planRetrieval(planIntent, deps.profile, categories, { env: deps.env, exploration, hasQuery: effectiveHasQuery && (!nothingToSearch || !!nameSearch), seed: deps.seed, mix: req.mix, budget: (req.limit ?? 12) > 20 ? 18 : 12 }, extraConcepts)
    .filter((q) => !blocked.has(q.provider.id))
    // When the AI curator runs, Spotify mood-word searches for music are discarded anyway: don't spend calls on them.
    .filter((q) => !(curatorOn && !effectiveHasQuery && q.provider.id === 'spotify' && q.params.category === 'music'))
    // A named artist's music comes from the curator's lanes (without the curator, a music search for the
    // name is the fallback); other media as above.
    .filter((q) => !artist || (q.params.category === 'music' ? !entityMusic : !bareArtist && nameQuery(q)));
  for (const id of deps.blockedProviders ?? []) statuses.set(id, { id, status: 'quota', message: 'Daily quota reached; using cached results until it resets.' });
  const callsBefore = deps.http.calls;
  // Music discovery: Spotify's dev-mode search can't find music by mood or genre (it returns stock
  // "sleep/ambient" filler), so the optional LLM proposes real songs per taste lane (generic words
  // only) and every pick is resolved and checked on Spotify. Runs in parallel with provider searches.
  let spotifyLimitedSec: number | undefined;
  let spotifyLookupLimitedSec: number | undefined;
  let curatorSuggested: string[] | undefined;
  // The named artist's own lane may bring back songs from the library (flagged), never ones just shown.
  const libraryIds = deps.library?.ids;
  const entityExcludeIds = musicPlan?.entity && deps.excludeIds && libraryIds?.size
    ? new Set([...deps.excludeIds].filter((id) => !libraryIds.has(id) || !!deps.shownIds?.has(id)))
    : undefined;
  type MusicPicks = { items: ContentItem[]; detail: string; perLane: Record<string, number>; lanePicks?: Record<string, Array<{ artist: string; feat?: string[] }>>; regionalArtists?: Array<{ artist: string; region: string }> };
  const musicPicks = (async (): Promise<MusicPicks | null> => {
    if (!curatorOn || !musicPlan || !ai) return null;
    // Open feed: briefed from the MUSIC taste (+ chosen moods) only; video/book themes never steer songs.
    const concepts = (effectiveHasQuery
      ? topKeys(positivePart(intent.target), 5, 0.15)
      : [...new Set([...intent.moods, ...topKeys(positivePart(deps.profile.conceptsByCategory.music ?? {}), 6, 0.15)])]).filter((c) => CONCEPT_BY_ID[c]);
    // Music is briefed with moods (and the few themes that translate to sound), not e.g. "politics".
    const SOUND_THEMES = new Set(['cosmic', 'nature', 'spiritual', 'love', 'loss', 'solitude', 'time-memory', 'identity', 'travel']);
    const musicConcepts = effectiveHasQuery ? concepts : concepts.filter((c) => CONCEPT_BY_ID[c].group === 'mood' || SOUND_THEMES.has(c));
    const words = musicConcepts.map((c) => conceptLabel(c).toLowerCase()).join(', ');
    const moods = intent.moods.filter((m) => CONCEPT_BY_ID[m]).map((m) => conceptLabel(m).toLowerCase());
    const r = await curateMusic(musicPlan, {
      ai, http: deps.http, env: deps.env, profile: deps.profile, intent, words, moods, concepts, excludeIds: deps.excludeIds, entityExcludeIds, library: deps.library, searchBlocked,
      lookupBlocked: deps.spotifyLookupBlocked, seed: deps.seed ?? 0, now: deps.now, recentSongs: deps.curatorRecent,
    });
    if (r.suggested?.length) curatorSuggested = r.suggested;
    if (r.rateLimitedSec !== undefined) spotifyLimitedSec = r.rateLimitedSec;
    if (r.lookupLimitedSec !== undefined) spotifyLookupLimitedSec = r.lookupLimitedSec;
    return r;
  })().catch((e): MusicPicks => ({ items: [], detail: `AI music picks skipped (${(e as Error).message.slice(0, 60)})`, perLane: {} }));
  // Live sessions for the music lanes: the shared, day-cached pool of session channels' uploads (no
  // search.list; out of quota → the cached or last good pool only). Matched to lanes after the curator.
  const sessionLanes = musicPlan ? (musicPlan.entity ? musicPlan.lanes.filter((l) => l.id === ENTITY_BY_LANE) : musicPlan.mode === 'lanes' ? musicPlan.lanes : []).map((l) => l.id) : [];
  const poolP: Promise<SessionPoolResult> | null = sessionLanes.length && sessionsServe(sessionLanes) && !!PROVIDERS.youtube?.configured(deps.env)
    ? liveSessionPool({ http: deps.http, env: deps.env }, { allowNetwork: !blocked.has('youtube') }).catch((e) => ({ videos: [], source: 'none' as const, units: 0, detail: `pool failed (${String((e as Error)?.message ?? e).slice(0, 60)})` }))
    : null;
  // Items around a named entity in other media (bounded: a few provider calls), in parallel with the rest.
  const ownResolved = entity ? resolvedEntities.find((r) => fold(r.entity.name) === fold(entity.name))?.item ?? null : null;
  const extrasP = entity
    ? entityExtras(entity, {
      env: deps.env, http: deps.http, blocked, categories, resolved: ownResolved, cap: capExtras, byMax: entity.want === 'by' ? capExtras : undefined,
      stored: deps.catalogFallback ? (provider, cats) => deps.catalogFallback!(provider, cats).catch(() => [] as ContentItem[]) : undefined,
      storedNamed: deps.catalogByName ? (provider, cats, name) => deps.catalogByName!(provider, cats, name).catch(() => [] as ContentItem[]) : undefined,
      onQuota: (pid, sec) => quota.note(pid, sec),
    }).catch((e) => ({ items: [] as ContentItem[], calls: 0, detail: `skipped (${(e as Error).message.slice(0, 60)})` }))
    : null;
  const settled = await Promise.allSettled(plan.map((q) => q.provider.search(q.params, { http: deps.http, env: deps.env })));
  const raw: ContentItem[] = [];
  settled.forEach((s, i) => {
    const pid = plan[i].provider.id;
    if (s.status === 'fulfilled') {
      raw.push(...s.value);
      if (!statuses.has(pid)) statuses.set(pid, { id: pid, status: 'ok' });
    } else {
      const e = s.reason as ProviderError;
      const kind = e instanceof ProviderError ? e.kind : 'error';
      if (kind === 'quota') quota.note(pid, e instanceof ProviderError ? e.retryAfterSec : undefined);
      statuses.set(pid, { id: pid, status: kind === 'quota' ? 'quota' : 'error', message: String(e?.message ?? e).slice(0, 200) });
    }
  });
  // Stored podcasts follow the same language rule as live search (SPOTIFY_PODCAST_LANGUAGE, default English).
  const podLang = (deps.env('SPOTIFY_PODCAST_LANGUAGE') ?? 'en').toLowerCase();
  const podcastLanguageOk = (i: ContentItem) => i.category !== 'podcasts' || podLang === 'any' || !i.language || i.language.toLowerCase().startsWith(podLang);
  // YouTube out of daily quota: serve its shelves from the stored, already-verified catalog instead of dropping them.
  const ytCats = categories.filter((c) => c === 'youtube' || c === 'podcasts');
  // (A named artist's videos come from entityExtras, which only keeps stored videos that name them.)
  if (ytCats.length && !artist && deps.catalogFallback && blocked.has('youtube')) {
    const fb = (await deps.catalogFallback('youtube', ytCats).catch(() => [] as ContentItem[])).filter(podcastLanguageOk);
    raw.push(...fb);
    pipeline.push({ step: 'fallback', ms: 0, detail: `YouTube quota reached: ${fb.length} stored videos/episodes used instead` });
  }
  const extras = extrasP ? await extrasP : null;
  if (extras && entity) {
    raw.push(...extras.items);
    pipeline.push({ step: 'entity', ms: 0, detail: extras.detail });
  }
  const mp = await musicPicks;
  if (mp) {
    // Enough verified curator picks → drop Spotify mood-word search results for music (mostly filler);
    // otherwise they remain as the fallback.
    if (mp.items.length >= 3) {
      for (let i = raw.length - 1; i >= 0; i--) if (raw[i].category === 'music' && raw[i].provider === 'spotify') raw.splice(i, 1);
    }
    raw.push(...mp.items);
    pipeline.push({ step: 'music-ai', ms: 0, detail: mp.detail });
  }
  // Only a SEARCH 429 blocks 'spotify'; a track-lookup 429 is reported separately (spotifyLookupLimitedSec).
  if (spotifyLimitedSec !== undefined) quota.note('spotify', spotifyLimitedSec);
  // Music that didn't come from the curator (Spotify search results) still gets a lane and passes the
  // lane rules (era / regional 2015+, exclusions, library, disliked artists) before it can be served.
  if (musicPlan) {
    const loose = raw.filter((i) => i.category === 'music' && !laneTagOf(i));
    if (loose.length) {
      const kept = laneLooseMusic(loose, musicPlan, { profile: musicProfile, excludeIds: deps.excludeIds, library: deps.library, now: deps.now, text: regionText, order: SEARCH_ORDER });
      for (let i = raw.length - 1; i >= 0; i--) if (raw[i].category === 'music' && !laneTagOf(raw[i])) raw.splice(i, 1);
      raw.push(...kept);
      if (kept.length < loose.length) pipeline.push({ step: 'music-rules', ms: 0, detail: `${loose.length - kept.length} of ${loose.length} searched songs failed the era/regional, library or taste rules` });
    }
  }
  const spotifyDown = searchBlocked || quotaErrors.includes('spotify');
  // Spotify search rate-limited: podcasts come from stored, already-verified Spotify shows/episodes.
  if (categories.includes('podcasts') && !artist && deps.catalogFallback && spotifyDown) {
    const fb = (await deps.catalogFallback('spotify', ['podcasts']).catch(() => [] as ContentItem[])).filter(podcastLanguageOk);
    raw.push(...fb);
    pipeline.push({ step: 'fallback', ms: 0, detail: `Spotify rate-limited: ${fb.length} stored podcasts added` });
  }
  // Lanes the curator left short: stored songs that fit the lane and pass its rules (never tracks failing era/regional rules).
  // Songs shown again on a short music-only page (tier 3) are let through the ranker's recently-shown exclusion.
  const reshown = new Set<string>();
  // An artist's lanes are theirs: stored songs from other requests never pad them. Only their own lane,
  // when the curator left it short (ListenBrainz down, lookups rate-limited), takes stored songs that
  // credit them as the main artist, under the same rules as the lane.
  if (musicPlan?.entity && deps.catalogByName) {
    const byLane = musicPlan.lanes.find((l) => l.id === ENTITY_BY_LANE);
    const have = mp?.perLane?.[ENTITY_BY_LANE] ?? 0;
    if (byLane && have < (musicPlan.targets[ENTITY_BY_LANE] ?? 0)) {
      const stored = await deps.catalogByName('spotify', ['music'], musicPlan.entity.name).catch(() => [] as ContentItem[]);
      const taken = new Set(raw.filter((i) => i.category === 'music').map((i) => i.id));
      const fill = entityLaneFallback(stored.filter((s) => !taken.has(s.id)), musicPlan, { excludeIds: entityExcludeIds ?? deps.excludeIds, library: deps.library, have });
      raw.push(...fill);
      pipeline.push({ step: 'fallback', ms: 0, detail: `${fill.length} stored songs by ${musicPlan.entity.name} for their lane (${have} from the curator)` });
    }
  }
  if (musicPlan && !musicPlan.entity && deps.catalogFallback) {
    const have = mp?.perLane ?? {};
    const open = musicPlan.order.reduce((s, id) => s + Math.max(0, (musicPlan.targets[id] ?? 0) - (have[id] ?? 0)), 0);
    // Distinct songs: several searches often return the same track.
    const musicCount = new Set(raw.filter((i) => i.category === 'music').map((i) => i.id)).size;
    if (open > 0 && (musicPlan.mode === 'lanes' || spotifyDown || musicCount < 3)) {
      const lanes = musicPlan.mode === 'lanes';
      const musicOnly = categories.length === 1 && categories[0] === 'music';
      const reshow = lanes && musicOnly && !!deps.reshowable?.size;
      const stored = await deps.catalogFallback('spotify', ['music'], { shared: lanes, reshow }).catch(() => [] as ContentItem[]);
      if (lanes) {
        const fill = laneFallback(stored, musicPlan, { profile: deps.profile, excludeIds: deps.excludeIds, library: deps.library, have, now: deps.now, musicOnly, reshowable: reshow ? deps.reshowable : undefined });
        raw.push(...fill);
        const tiers = [1, 2, 3].map((t) => fill.filter((f) => fallbackTierOf(f) === t).length);
        for (const f of fill) if (fallbackTierOf(f) === 3) reshown.add(f.id);
        pipeline.push({ step: 'fallback', ms: 0, detail: `${fill.length} stored songs fit ${open} open lane slots (yours ${tiers[0]}, shared ${tiers[1]}, shown again ${tiers[2]})` });
      } else {
        // A request: this user's own stored songs join the request lane after the fresh picks, still under the era/regional rules.
        const ok = laneLooseMusic(stored.filter((s) => s.category === 'music' && !s.metadata?.imported && fallbackTierOf(s) === 1), musicPlan, {
          profile: musicProfile, excludeIds: deps.excludeIds, library: deps.library, now: deps.now, text: regionText, order: STORED_ORDER, fallback: true,
        }).slice(0, 40);
        raw.push(...ok);
        pipeline.push({ step: 'fallback', ms: 0, detail: `${spotifyDown ? 'Spotify rate-limited' : 'Few fresh songs'}: ${ok.length} stored songs added` });
      }
    }
  }
  // Sessions in the music lanes: matched locally to the curator's picks per lane and the user's library
  // artists (or a named artist), under the lane rules; the ranker places them among the lane's songs.
  if (poolP && musicPlan) {
    // The day's pool is normally ready long before the curator; a build still running then (YouTube slow)
    // doesn't hold the answer up: the last good copy is used and the build finishes for the next request.
    let wait: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<SessionPoolResult>((resolve) => {
      wait = setTimeout(() => resolve(staleSessionPool({ http: deps.http }, undefined, 'the day’s pool is still being built')), POOL_WAIT_MS);
    });
    const pool = await Promise.race([poolP, late]);
    clearTimeout(wait);
    if (pool.quota) quota.note('youtube', pool.quota.retryAfterSec);
    const byLane = musicPlan.lanes.find((l) => l.id === ENTITY_BY_LANE);
    const videos = musicPlan.entity
      ? byLane ? matchEntitySessions(pool.videos, { name: musicPlan.entity.name, lane: byLane, excludeIds: deps.excludeIds, max: 2 }) : []
      : matchLaneSessions(pool.videos, {
        lanes: musicPlan.lanes, picks: mp?.lanePicks, regionalArtists: mp?.regionalArtists, profile: deps.profile, libraryArtistLanes: deps.library?.artistLanes, excludeIds: deps.excludeIds,
      });
    raw.push(...videos);
    const kinds = ['pick', 'library', 'channel', 'entity'].map((k) => [k, videos.filter((v) => v.metadata?.videoMatch === k).length] as const).filter(([, n]) => n > 0);
    pipeline.push({ step: 'music-videos', ms: 0, detail: `${pool.detail}; ${videos.length} offered to the lanes${kinds.length ? ` (${kinds.map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}` });
  }
  pipeline.push({ step: 'retrieval', ms: t(), detail: `${plan.length} queries → ${raw.length} items (${deps.http.calls - callsBefore} network calls, rest cached)` });

  // ── Steps 3–4: enrichment + semantic analysis ──
  t = timer();
  const byId = new Map<string, AnalyzedItem>();
  for (const it of [...similar, ...raw.map(analyzeItem)]) {
    const prev = byId.get(it.id);
    if (!prev) byId.set(it.id, it);
    else {
      // Merge retrieval evidence from several queries.
      const merged = { ...prev.concepts };
      for (const [k, v] of Object.entries(it.concepts)) merged[k] = Math.max(merged[k] ?? 0, v);
      // An item around a named entity keeps its entity tag (role, note, order) when a general search
      // found it too (an author's books also come back from a search for their name).
      const base = !entityTagOf(prev) && entityTagOf(it) ? it : prev;
      byId.set(it.id, { ...base, concepts: merged });
    }
  }
  let candidates = [...byId.values()];
  pipeline.push({ step: 'analysis', ms: t(), detail: `${candidates.length} unique candidates projected into the concept space` });

  // Optional semantic embeddings (never for Spotify items)
  let queryEmbedding: number[] | null = null;
  if (deps.embed) {
    t = timer();
    try {
      const stored = deps.storedEmbeddings ? await deps.storedEmbeddings(candidates.map((c) => c.id)) : new Map<string, number[]>();
      const need = candidates.filter((c) => canEmbed(c) && !stored.has(c.id)).slice(0, 24);
      const texts = [...(effectiveHasQuery ? [query] : []), ...need.map(embeddingText)];
      const vecs = texts.length ? await deps.embed(texts) : [];
      if (effectiveHasQuery) queryEmbedding = vecs.shift() ?? null;
      need.forEach((c, i) => stored.set(c.id, vecs[i]));
      candidates = candidates.map((c) => (canEmbed(c) && stored.get(c.id) ? { ...c, embedding: stored.get(c.id) } : c));
      pipeline.push({ step: 'embeddings', ms: t(), detail: `gte-small: ${need.length} new item vectors${queryEmbedding ? ' + query' : ''}` });
    } catch (e) {
      pipeline.push({ step: 'embeddings', ms: t(), detail: `skipped (${(e as Error).message.slice(0, 60)})` });
    }
  }

  // Collaborative signal (only when enough community data exists — decided by the injected function)
  let collaborative: Map<string, number> | undefined;
  if (deps.collaborative) {
    try {
      collaborative = await deps.collaborative(candidates.map((c) => c.id));
    } catch {
      collaborative = undefined;
    }
  }

  // ── Steps 5–7: ranking, diversity, explanation ──
  t = timer();
  // Let through the ranker's exclusions: songs shown again on a short music page, and library songs the
  // named artist's own lane brought back (flagged "In your library").
  const allowed = new Set([...reshown, ...candidates.filter((c) => laneTagOf(c)?.id === ENTITY_BY_LANE && c.metadata?.inLibrary === true).map((c) => c.id)]);
  const recommendations = rankCandidates(candidates, intent, musicProfile, {
    exploration,
    hasQuery: effectiveHasQuery,
    excludeIds: allowed.size && deps.excludeIds ? new Set([...deps.excludeIds].filter((id) => !allowed.has(id))) : deps.excludeIds,
    referenceIds: new Set(refItems.map((r) => r.id)),
    referenceSimilar: similarMap,
    references: refs,
    collaborative,
    evidence: deps.evidence,
    queryEmbedding,
    limit,
    mix: req.mix,
    now: deps.now,
    musicLanes: musicPlan ? rankLanePlan(musicPlan, candidates) : undefined,
    entityBlock: entity ? { cap: capExtras } : undefined,
    laneVideos: { perLane: laneVideosPerLane(categories, !!musicPlan?.entity) },
  });
  pipeline.push({ step: 'ranking', ms: t(), detail: `exploration ${Math.round(exploration * 100)}% · ${recommendations.length} picks after diversity` });

  // Reply (deterministic, grounded in what was actually retrieved)
  let reply: string | undefined;
  if (hasQuery) {
    const cats = [...new Set(recommendations.map((r) => r.item.category))].map((c) => CATEGORY_NOUN[c]);
    const desc = describeIntent(intent);
    const aboutEntity = entity && recommendations.length ? entityReply(entity, recommendations) : null;
    if (aboutEntity) {
      reply = aboutEntity;
      if (intent.statements.length) reply += ` Noted for your taste profile: ${intent.statements.map((st) => `${st.polarity > 0 ? 'you like' : "you don't like"} ${st.subject}`).join('; ')}.`;
    } else if (!recommendations.length) {
      const unconfigured = [...statuses.values()].filter((s) => s.status === 'unconfigured' || s.status === 'error' || s.status === 'quota');
      reply = `I couldn't find real catalog matches for that${unconfigured.length ? ` (${unconfigured.map((u) => `${u.id}: ${u.status}`).join(', ')})` : ''}. Try rephrasing or widening the categories.`;
    } else {
      reply = `${desc ? `I read this as ${desc}. ` : ''}Here ${recommendations.length === 1 ? 'is 1 pick' : `are ${recommendations.length} picks`} across ${cats.join(', ')}${intent.trajectory ? `, ordered to travel from ${conceptLabel(intent.trajectory.from).toLowerCase()} to ${conceptLabel(intent.trajectory.to).toLowerCase()}` : ''}.`;
      // A named entity none of the picks answers (not found, its lookups failed): said so, above picks that fit the rest.
      if (entity) reply += ` I couldn't find ${entity.name} itself in the connected catalogs right now, so these are the closest picks I found.`;
      else if (intent.references.length && !refs.length) reply += ` I couldn't find “${intent.references.join(', ')}” in the connected catalogs, so I matched on the qualities you described instead.`;
      if (intent.statements.length) reply += ` Noted for your taste profile: ${intent.statements.map((s) => `${s.polarity > 0 ? 'you like' : "you don't like"} ${s.subject}`).join('; ')}.`;
    }
  }

  return {
    intent: { ...intent, exploration },
    recommendations,
    reply,
    clarifyingQuestion,
    providers: [...statuses.values()],
    pipeline,
    candidates,
    quotaErrors,
    quotaRetryAfter,
    spotifyLookupLimitedSec,
    curatorSuggested,
  };
}

/**
 * Lane plan for the ranker. An open feed whose songs partly came from search (no AI curator) shows them
 * in an extra "Fresh picks" lane after the taste lanes, sized to the slots the lanes can't fill.
 */
export function rankLanePlan(plan: MusicPlan, candidates: Array<{ category: string; kind?: string; embed?: { type: string } | null; metadata?: Record<string, unknown> }>): { order: string[]; targets: Record<string, number> } {
  const base = { order: plan.order, targets: plan.targets };
  if (plan.order.includes(MIX_LANE.id)) return base;
  const have: Record<string, number> = {};
  for (const c of candidates) {
    // Songs only: a lane's videos ride on top of its song target.
    const id = c.category === 'music' && !isLaneVideo(c) ? laneTagOf(c)?.id : undefined;
    if (id) have[id] = (have[id] ?? 0) + 1;
  }
  if (!have[MIX_LANE.id]) return base;
  const filled = plan.order.reduce((s, id) => s + Math.min(plan.targets[id] ?? 0, have[id] ?? 0), 0);
  return { order: [...plan.order, MIX_LANE.id], targets: { ...plan.targets, [MIX_LANE.id]: Math.max(0, plan.total - filled) } };
}
