// Server-side helpers for ECHO Edge Functions (Deno). Never imported by the frontend.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AnalyzedItem, ContentItem, TasteProfile } from './types.ts';
import { hydrateProfile } from './engine/profile.ts';
import type { CacheStore } from './providers/http.ts';
import type { EvidenceItem } from './engine/rank.ts';

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
    rating: i.rating ?? null, popularity: i.popularity ?? null, metadata: i.metadata ?? {}, concepts: i.concepts, stale: false, fetched_at: new Date().toISOString(),
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

/** Items the user disliked or finished — never recommend them again. */
export async function excludedIds(db: SupabaseClient, userId: string): Promise<Set<string>> {
  const [inter, lib] = await Promise.all([
    db.from('interactions').select('item_id').eq('user_id', userId).in('type', ['dislike']).limit(1000),
    db.from('library_items').select('item_id').eq('user_id', userId).or('status.eq.consumed,saved.eq.true,liked.eq.true').limit(2000),
  ]);
  return new Set([...(inter.data ?? []), ...(lib.data ?? [])].map((r) => r.item_id as string));
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

export async function blockedProviders(): Promise<Set<import('./types.ts').ProviderId>> {
  const { data } = await serviceClient().from('provider_status').select('provider, blocked_until').gt('blocked_until', new Date().toISOString());
  return new Set((data ?? []).map((r) => r.provider as import('./types.ts').ProviderId));
}

export async function markQuota(providers: string[]) {
  if (!providers.length) return;
  // YouTube quotas reset at midnight Pacific time; block for a conservative window.
  const until = new Date(Date.now() + 6 * 3600_000).toISOString();
  await serviceClient().from('provider_status').upsert(providers.map((p) => ({ provider: p, blocked_until: until, last_error: 'quota', updated_at: new Date().toISOString() })));
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
