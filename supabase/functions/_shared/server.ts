// Server-side helpers for ECHO Edge Functions (Deno). Never imported by the frontend.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';
import type { AnalyzedItem, ContentItem, ProviderId, TasteProfile } from './types.ts';
import { hydrateProfile } from './engine/profile.ts';
import { blockUntil, hashKey, type CacheStore } from './providers/http.ts';
import { SPOTIFY_LOOKUP_BLOCK } from './providers/spotify.ts';
import type { EvidenceItem } from './engine/rank.ts';
import { isEngineLane, laneTagOf, librarySongIndex, withoutPerUser, type LibrarySongs } from './engine/lanes.ts';
import { FEED_MAX_MS, parseFeedSession, type FeedSession } from './engine/session.ts';

/** Read an env var; empty strings count as unset. */
export const env = (name: string): string | undefined => Deno.env.get(name) || undefined;

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error') {
    super(message);
  }
}

function allowedOrigin(req: Request): string {
  const origin = req.headers.get('Origin') ?? '';
  const list = (env('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return '*'; // bearer-token auth (no cookies), so wildcard is not a CSRF vector
  return list.includes(origin) ? origin : list[0];
}

export function corsHeaders(req: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': allowedOrigin(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/** Wrap a handler with CORS preflight + uniform error responses (no stack traces leak). */
export function serve(handler: (req: Request) => Promise<Response>) {
  const wrapped = async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return json(req, { error: e.message, code: e.code }, e.status);
      if (e && typeof e === 'object' && 'issues' in e) return json(req, { error: 'Invalid request', code: 'validation', issues: (e as { issues: unknown }).issues }, 400);
      console.error('[echo] unhandled', e);
      return json(req, { error: 'Something went wrong on our side.', code: 'internal' }, 500);
    }
  };
  // Local dev router (scripts/dev-functions.ts) collects handlers instead of binding a port.
  // deno-lint-ignore no-explicit-any
  const registry = (globalThis as any).__ECHO_ROUTER__ as ((h: (req: Request) => Promise<Response>) => void) | undefined;
  if (registry) registry(wrapped);
  else Deno.serve(wrapped);
}

const url = () => env('SUPABASE_URL')!;
const publicKey = () => env('SUPABASE_ANON_KEY') ?? env('SUPABASE_PUBLISHABLE_KEY')!;
const serviceKey = () => env('ECHO_SERVICE_KEY') ?? env('SUPABASE_SERVICE_ROLE_KEY') ?? env('SUPABASE_SECRET_KEY')!;

let _service: SupabaseClient | null = null;
export function serviceClient(): SupabaseClient {
  if (!_service) _service = createClient(url(), serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  return _service;
}

export interface AuthContext {
  userId: string;
  email?: string;
  /** Client bound to the caller's JWT: every query is subject to RLS. */
  db: SupabaseClient;
}

export async function requireUser(req: Request): Promise<AuthContext> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token || token === publicKey()) throw new HttpError(401, 'Sign in required', 'unauthenticated');
  const { data, error } = await serviceClient().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Your session has expired. Please sign in again.', 'unauthenticated');
  const db = createClient(url(), publicKey(), { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  return { userId: data.user.id, email: data.user.email ?? undefined, db };
}

export async function rateLimit(userId: string, bucket: string, max: number, windowSeconds: number) {
  const { data, error } = await serviceClient().rpc('check_rate_limit', { p_user: userId, p_bucket: bucket, p_max: max, p_window_seconds: windowSeconds });
  if (error) {
    console.error('[echo] rate limit check failed', error.message);
    return; // fail open on infrastructure errors, but log
  }
  if (data === false) throw new HttpError(429, 'Slow down a little — too many requests. Try again in a minute.', 'rate_limited');
}

/** Provider response cache backed by Postgres (service role only). */
export class DbCache implements CacheStore {
  private local = new Map<string, unknown>();
  async get(key: string) {
    if (this.local.has(key)) return this.local.get(key);
    const { data } = await serviceClient().from('provider_cache').select('value, expires_at').eq('key', key).maybeSingle();
    if (!data || new Date(data.expires_at).getTime() < Date.now()) return undefined;
    this.local.set(key, data.value);
    return data.value;
  }
  async set(key: string, value: unknown, ttlSeconds: number) {
    this.local.set(key, value);
    const { error } = await serviceClient().from('provider_cache').upsert({ key, value, expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString() });
    if (error) console.error('[echo] cache write failed', error.message);
  }
}

// ───────────── persistence ─────────────

export async function loadProfile(db: SupabaseClient, userId: string): Promise<TasteProfile> {
  const { data } = await db.from('taste_profiles').select('model').eq('user_id', userId).maybeSingle();
  return hydrateProfile((data?.model as Partial<TasteProfile>) ?? null);
}

export async function saveProfile(db: SupabaseClient, userId: string, profile: TasteProfile) {
  const { embedding, ...model } = profile;
  const row: Record<string, unknown> = { user_id: userId, model, updated_at: new Date().toISOString() };
  if (embedding?.length) row.embedding = JSON.stringify(embedding);
  const { error } = await db.from('taste_profiles').upsert(row);
  if (error) throw new HttpError(500, `Could not save taste profile: ${error.message}`);
}

export function itemToRow(i: AnalyzedItem) {
  const row: Record<string, unknown> = {
    id: i.id, category: i.category, kind: i.kind, provider: i.provider, external_id: i.externalId, title: i.title.slice(0, 500), creators: i.creators.slice(0, 10),
    description: i.description?.slice(0, 4000) ?? null, genres: i.genres.slice(0, 20), tags: i.tags.slice(0, 50), artwork_url: i.artworkUrl ?? null, duration_sec: i.durationSec ?? null,
    language: i.language ?? null, release_date: i.releaseDate ?? null, external_url: i.externalUrl, embed: i.embed ?? null, playback_note: i.playbackNote ?? null,
    // content_items is a shared catalog readable by every signed-in user: per-user fields (last shown,
    // the user's lane era/mood, feed order) never go in. The lane tag and aiPick stay (fallback + feedback use them).
    rating: i.rating ?? null, popularity: i.popularity ?? null, metadata: withoutPerUser(i.metadata), concepts: i.concepts, stale: false, fetched_at: new Date().toISOString(),
  };
  if (i.embedding?.length) row.embedding = JSON.stringify(i.embedding);
  return row;
}

export function rowToItem(r: Record<string, unknown>): AnalyzedItem {
  let embedding: number[] | null = null;
  if (typeof r.embedding === 'string') {
    try {
      embedding = JSON.parse(r.embedding);
    } catch {
      embedding = null;
    }
  } else if (Array.isArray(r.embedding)) embedding = r.embedding as number[];
  return {
    id: r.id as string, category: r.category as ContentItem['category'], kind: r.kind as ContentItem['kind'], provider: r.provider as ContentItem['provider'],
    externalId: r.external_id as string, title: r.title as string, creators: (r.creators as string[]) ?? [], description: (r.description as string) ?? undefined,
    genres: (r.genres as string[]) ?? [], tags: (r.tags as string[]) ?? [], artworkUrl: (r.artwork_url as string) ?? undefined, durationSec: (r.duration_sec as number) ?? undefined,
    language: (r.language as string) ?? undefined, releaseDate: (r.release_date as string) ?? undefined, externalUrl: r.external_url as string, embed: (r.embed as ContentItem['embed']) ?? null,
    playbackNote: (r.playback_note as string) ?? undefined, rating: (r.rating as number) ?? undefined, popularity: (r.popularity as number) ?? undefined,
    metadata: { ...((r.metadata as Record<string, unknown>) ?? {}), stale: r.stale ?? false }, concepts: (r.concepts as Record<string, number>) ?? {}, embedding,
  };
}

export const ITEM_COLUMNS = 'id,category,kind,provider,external_id,title,creators,description,genres,tags,artwork_url,duration_sec,language,release_date,external_url,embed,playback_note,rating,popularity,metadata,concepts,stale';

export async function upsertItems(items: AnalyzedItem[]) {
  if (!items.length) return;
  const rows = items.map(itemToRow);
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await serviceClient().from('content_items').upsert(rows.slice(i, i + 100));
    if (error) console.error('[echo] catalog upsert failed', error.message);
  }
}

export async function getItems(ids: string[]): Promise<AnalyzedItem[]> {
  if (!ids.length) return [];
  const { data, error } = await serviceClient().from('content_items').select(ITEM_COLUMNS).in('id', ids.slice(0, 200));
  if (error) throw new HttpError(500, error.message);
  const map = new Map((data ?? []).map((r) => [r.id as string, rowToItem(r as Record<string, unknown>)]));
  return ids.map((id) => map.get(id)).filter((x): x is AnalyzedItem => !!x);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Read up to `max` rows through PostgREST's 1,000-row page size (supabase/config.toml max_rows). */
async function pagedRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null }>, max: number): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const want = Math.min(1000, max - from);
    const { data } = await page(from, from + want - 1);
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < want) break;
  }
  return out;
}

/**
 * Stored items from one provider, minus what this user was shown lately (2 days; 3 for music, as of
 * `asOf`: when the feed being re-fetched was first served) and what they liked/saved/finished or
 * disliked.
 * Music: only songs ECHO's lane engine already recommended to THIS user in the last 90 days (rows
 * carrying an engine lane tag) — never other users' picks, the old curator's picks, imported libraries
 * or raw search filler. Each song carries metadata.lastShownAt so lanes prefer songs not shown lately.
 */
export function catalogFallbackFn(userId: string, opts: { asOf?: number } = {}) {
  return async (provider: string, categories: string[]): Promise<AnalyzedItem[]> => {
    const db = serviceClient();
    const music = categories.includes('music');
    const asOf = opts.asOf ?? Date.now();
    const cutoff = asOf - (music ? 3 : 2) * 86400_000;
    const base = () => db.from('content_items').select(ITEM_COLUMNS).eq('provider', provider).in('category', categories).not('embed', 'is', null).eq('stale', false);
    const [shownRows, excluded, history] = await Promise.all([
      // Exclusion window: everything shown since the cutoff (paged: one 48-item feed is 48 rows).
      pagedRows<{ item_id: string }>((f, t) =>
        db.from('recommendation_events').select('item_id').eq('user_id', userId).gte('created_at', iso(cutoff)).lt('created_at', iso(asOf)).order('created_at', { ascending: false }).order('id', { ascending: false }).range(f, t), 3000),
      excludedIds(db, userId),
      // Music candidates + last-shown ranking: songs recommended to this user over 90 days.
      music
        ? pagedRows<{ item_id: string; created_at: string }>((f, t) =>
          db.from('recommendation_events').select('item_id, created_at').eq('user_id', userId).like('item_id', 'spotify:track:%').gte('created_at', iso(asOf - 90 * 86400_000)).lt('created_at', iso(asOf))
            .order('created_at', { ascending: false }).order('id', { ascending: false }).range(f, t), 3000)
        : Promise.resolve([] as Array<{ item_id: string; created_at: string }>),
    ]);
    const shown = new Set(shownRows.map((r) => r.item_id));
    const skip = (id: string) => excluded.has(id) || shown.has(id);
    if (!music) {
      const { data } = await base().order('updated_at', { ascending: false }).limit(1000);
      return (data ?? []).map((r) => rowToItem(r as Record<string, unknown>)).filter((i) => !skip(i.id)).slice(0, 150);
    }
    const lastShown = new Map<string, string>();
    for (const r of history) if (!lastShown.has(r.item_id)) lastShown.set(r.item_id, r.created_at);
    // Newest first: keep the 900 shown longest ago (the fallback prefers songs not shown lately).
    const ids = [...lastShown.keys()].filter((id) => !skip(id)).slice(-900);
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 150) chunks.push(ids.slice(i, i + 150));
    const rows = (await Promise.all(chunks.map((c) => base().in('id', c)))).flatMap((r) => (r.data ?? []) as Array<Record<string, unknown>>);
    return rows
      .map((r) => rowToItem(r))
      .filter((i) => i.category === 'music' && !i.metadata?.imported && isEngineLane(laneTagOf(i)?.id))
      .map((i) => ({ ...i, metadata: { ...(i.metadata ?? {}), lastShownAt: lastShown.get(i.id) } }));
  };
}

/**
 * Songs not to serve again yet: music shown to this user in the `days` days before `asOf` (so a
 * refresh doesn't repeat), and songs they skipped in the last two weeks. `asOf` is when the feed being
 * fetched was first served (engine/session.ts), so re-fetching it never excludes its own songs.
 */
export async function recentMusic(userId: string, opts: { asOf?: number; days?: number } = {}): Promise<{ shown: Set<string>; skipped: Set<string> }> {
  const db = serviceClient();
  const now = Date.now();
  const asOf = opts.asOf ?? now;
  const isMusic = (id: string) => id.startsWith('spotify:track:') || id.startsWith('spotify:album:');
  const [shown, skipped] = await Promise.all([
    pagedRows<{ item_id: string }>((f, t) =>
      db.from('recommendation_events').select('item_id').eq('user_id', userId).like('item_id', 'spotify:%').gte('created_at', iso(asOf - (opts.days ?? 3) * 86400_000)).lt('created_at', iso(asOf))
        .order('created_at', { ascending: false }).order('id', { ascending: false }).range(f, t), 3000),
    db.from('interactions').select('item_id').eq('user_id', userId).eq('type', 'skip').like('item_id', 'spotify:%').gte('created_at', iso(now - 14 * 86400_000)).limit(1000),
  ]);
  return {
    shown: new Set(shown.map((r) => r.item_id).filter(isMusic)),
    skipped: new Set((skipped.data ?? []).map((r) => r.item_id as string).filter(isMusic)),
  };
}

/**
 * The user's liked/saved/finished songs by recording identity (ISRC from the export, artist|title), so
 * a liked song resolved under another id (single vs album vs deluxe) isn't served as a discovery.
 */
export async function librarySongs(db: SupabaseClient, userId: string): Promise<LibrarySongs> {
  type Row = { content_items: { title?: string; creators?: string[]; metadata?: Record<string, unknown> } | null };
  const rows = await pagedRows<Row>((f, t) =>
    db.from('library_items').select('item_id, content_items(title, creators, metadata)').eq('user_id', userId).like('item_id', 'spotify:track:%').or('status.eq.consumed,saved.eq.true,liked.eq.true')
      .order('item_id').range(f, t) as unknown as PromiseLike<{ data: Row[] | null }>, 10_000);
  return librarySongIndex(rows.map((r) => r.content_items).filter((c): c is NonNullable<Row['content_items']> => !!c).map((c) => ({ title: c.title, creators: c.creators, isrc: c.metadata?.isrc })));
}

/** Items the user disliked or finished — never recommend them again. */
export async function excludedIds(db: SupabaseClient, userId: string): Promise<Set<string>> {
  // Paged: an imported library alone is over the API's 1,000-row page size.
  const lib: Array<{ item_id: unknown }> = [];
  const libraryPage = (from: number) =>
    db.from('library_items').select('item_id').eq('user_id', userId).or('status.eq.consumed,saved.eq.true,liked.eq.true').order('item_id').range(from, from + 999);
  const [inter, first] = await Promise.all([db.from('interactions').select('item_id').eq('user_id', userId).in('type', ['dislike']).limit(1000), libraryPage(0)]);
  lib.push(...(first.data ?? []));
  for (let from = 1000; from < 10_000 && (first.data?.length ?? 0) === 1000 && lib.length === from; from += 1000) {
    const { data } = await libraryPage(from);
    lib.push(...(data ?? []));
  }
  return new Set([...(inter.data ?? []), ...lib].map((r) => r.item_id as string));
}

/** Recently liked/saved items, used for grounded "because you liked X" explanations. */
export async function evidenceItems(db: SupabaseClient, userId: string): Promise<EvidenceItem[]> {
  const { data } = await db
    .from('library_items')
    .select('item_id, content_items(id,title,category,kind,concepts)')
    .eq('user_id', userId)
    .or('liked.eq.true,saved.eq.true,rating.gte.4')
    .order('updated_at', { ascending: false })
    .limit(60);
  return (data ?? [])
    .map((r) => (r as unknown as { content_items: { id: string; title: string; category: EvidenceItem['category']; kind: EvidenceItem['kind']; concepts: Record<string, number> } | null }).content_items)
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c) => ({ id: c.id, title: c.title, category: c.category, kind: c.kind, concepts: c.concepts ?? {} }));
}

export interface ProviderBlocks {
  /** Providers whose search is blocked ('spotify' = Spotify search). */
  providers: Set<ProviderId>;
  /** Spotify single-track lookups are blocked (own key: Spotify rate-limits endpoints separately). */
  spotifyLookup: boolean;
}

export async function providerBlocks(): Promise<ProviderBlocks> {
  const { data } = await serviceClient().from('provider_status').select('provider, blocked_until').gt('blocked_until', new Date().toISOString());
  const keys = new Set((data ?? []).map((r) => r.provider as string));
  const spotifyLookup = keys.delete(SPOTIFY_LOOKUP_BLOCK);
  return { providers: keys as Set<ProviderId>, spotifyLookup };
}

/**
 * Record quota blocks. A block only ever grows: a short 429 (or one without Retry-After) on one call
 * never replaces a longer block already in place, e.g. Spotify's ~19 h search penalty.
 */
export async function markQuota(providers: string[], retryAfter: Partial<Record<string, number>> = {}) {
  const keys = [...new Set(providers)];
  if (!keys.length) return;
  const now = Date.now();
  const db = serviceClient();
  const { data } = await db.from('provider_status').select('provider, blocked_until').in('provider', keys);
  const current = new Map((data ?? []).map((r) => [r.provider as string, r.blocked_until ? new Date(r.blocked_until as string).getTime() : undefined]));
  const { error } = await db.from('provider_status').upsert(keys.map((p) => ({ provider: p, blocked_until: iso(blockUntil(p, now, retryAfter[p], current.get(p))), last_error: 'quota', updated_at: iso(now) })));
  if (error) console.error('[echo] provider status write failed', error.message);
}

/** Blocks from one pipeline run: provider quotas plus Spotify's separately limited single-track lookups. */
export async function markPipelineQuota(r: { quotaErrors: string[]; quotaRetryAfter: Partial<Record<string, number>>; spotifyLookupLimitedSec?: number }) {
  const lookup = r.spotifyLookupLimitedSec;
  await markQuota([...r.quotaErrors, ...(lookup !== undefined ? [SPOTIFY_LOOKUP_BLOCK] : [])], { ...r.quotaRetryAfter, ...(lookup !== undefined ? { [SPOTIFY_LOOKUP_BLOCK]: lookup } : {}) });
}

// ───────────── feed sessions (engine/session.ts) ─────────────

const feedSessionKey = async (userId: string, filterKey: string) => `feed-session:${userId}:${await hashKey(filterKey)}`;

export async function loadFeedSession(userId: string, filterKey: string): Promise<FeedSession | null> {
  try {
    return parseFeedSession(await new DbCache().get(await feedSessionKey(userId, filterKey)));
  } catch {
    return null;
  }
}

export async function saveFeedSession(userId: string, filterKey: string, session: FeedSession) {
  try {
    await new DbCache().set(await feedSessionKey(userId, filterKey), session, Math.ceil(FEED_MAX_MS / 1000));
  } catch (e) {
    console.error('[echo] feed session write failed', (e as Error).message);
  }
}

export function collaborativeFn(db: SupabaseClient) {
  return async (ids: string[]) => {
    const { data, error } = await db.rpc('cf_scores', { candidate_ids: ids.slice(0, 300), min_community: Number(env('ECHO_CF_MIN_USERS') ?? 20) });
    if (error) return new Map<string, number>();
    return new Map<string, number>(((data ?? []) as Array<{ item_id: string; score: number }>).map((r) => [r.item_id, r.score]));
  };
}

/** Supabase Edge Runtime's built-in gte-small model (free, no external API). Opt-in via ECHO_EMBEDDINGS=on. */
export function embedder(): ((texts: string[]) => Promise<number[][]>) | undefined {
  if (env('ECHO_EMBEDDINGS') !== 'on') return undefined;
  // deno-lint-ignore no-explicit-any
  const ai = (globalThis as any).Supabase?.ai;
  if (!ai?.Session) return undefined;
  const session = new ai.Session('gte-small');
  return async (texts: string[]) => {
    const out: number[][] = [];
    for (const t of texts) out.push(Array.from((await session.run(t.slice(0, 1000), { mean_pool: true, normalize: true })) as number[]));
    return out;
  };
}

export async function storedEmbeddings(ids: string[]): Promise<Map<string, number[]>> {
  const { data } = await serviceClient().from('content_items').select('id, embedding').in('id', ids.slice(0, 300)).not('embedding', 'is', null);
  const m = new Map<string, number[]>();
  for (const r of data ?? []) {
    try {
      m.set(r.id as string, typeof r.embedding === 'string' ? JSON.parse(r.embedding) : (r.embedding as number[]));
    } catch {
      /* ignore */
    }
  }
  return m;
}

export async function readJson<T>(req: Request, max = 20_000): Promise<T> {
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, 'Request too large');
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}
