// HTTP + cache primitives shared by all provider adapters.

export interface CacheStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

export class MemoryCache implements CacheStore {
  private m = new Map<string, { v: unknown; exp: number }>();
  get(key: string) {
    const e = this.m.get(key);
    if (!e) return Promise.resolve(undefined);
    if (e.exp < Date.now()) {
      this.m.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(e.v);
  }
  set(key: string, value: unknown, ttlSeconds: number) {
    this.m.set(key, { v: value, exp: Date.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }
}

export type ProviderErrorKind = 'quota' | 'auth' | 'unavailable' | 'bad_request' | 'timeout' | 'error';

export class ProviderError extends Error {
  constructor(public provider: string, public kind: ProviderErrorKind, message: string, public status?: number, public retryAfterSec?: number) {
    super(`${provider}: ${message}`);
  }
}

export interface HttpClient {
  json<T = unknown>(url: string, opts?: { init?: RequestInit; cacheKey?: string; ttl?: number; timeoutMs?: number; provider?: string }): Promise<T>;
  /** Number of network calls made (cache hits excluded). */
  calls: number;
  cacheHits: number;
  /** The provider cache behind json(), for small derived entries (e.g. resolved song ids). */
  cache?: CacheStore;
}

export const USER_AGENT = 'ECHO-discovery/0.1 (+https://github.com/; personal discovery app)';

export function createHttp(cache: CacheStore, fetchImpl: typeof fetch = fetch): HttpClient {
  const client: HttpClient = {
    cache,
    calls: 0,
    cacheHits: 0,
    async json<T>(url: string, opts: { init?: RequestInit; cacheKey?: string; ttl?: number; timeoutMs?: number; provider?: string } = {}): Promise<T> {
      const provider = opts.provider ?? new URL(url).hostname;
      const key = opts.cacheKey;
      if (key) {
        const hit = await cache.get(key);
        if (hit !== undefined) {
          client.cacheHits++;
          return hit as T;
        }
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
      let res: Response;
      try {
        client.calls++;
        res = await fetchImpl(url, { ...opts.init, signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(opts.init?.headers ?? {}) } });
      } catch (e) {
        throw new ProviderError(provider, (e as Error).name === 'AbortError' ? 'timeout' : 'unavailable', (e as Error).message);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const kind: ProviderErrorKind =
          res.status === 429 || /quota|rateLimit|dailyLimit/i.test(body) ? 'quota' : res.status === 401 || res.status === 403 ? 'auth' : res.status >= 500 ? 'unavailable' : 'bad_request';
        const ra = Number(res.headers.get('retry-after'));
        throw new ProviderError(provider, kind, `HTTP ${res.status} ${body.slice(0, 200)}`, res.status, Number.isFinite(ra) && ra > 0 ? ra : undefined);
      }
      const data = (await res.json()) as T;
      if (key && opts.ttl) await cache.set(key, data, opts.ttl);
      return data;
    },
  };
  return client;
}

export async function hashKey(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

export function stripHtml(s: string | null | undefined): string {
  return (s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
