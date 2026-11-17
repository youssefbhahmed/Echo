// The live-session pool (providers/youtube.ts liveSessionPool): channels.list → playlistItems.list →
// videos.list, cached for everyone, with every quota unit counted. Mocked fetch, synthetic titles only;
// no real YouTube key or channel data is used.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttp, MemoryCache } from '@shared/providers/http.ts';
import { liveSessionPool, SESSION_CHANNELS, SESSION_POOL_BACKOFF_TTL, SESSION_POOL_RETRY_TTL, sessionPoolKey, sessionPoolUnitsPerDay, sessionVideoOf, staleSessionPool, type SessionChannel, type SessionVideo } from '@shared/providers/youtube.ts';

const env = (k: string) => (k === 'YOUTUBE_API_KEY' ? 'test-key' : undefined);
const DAY = 86400_000;

interface World {
  /** Uploads per channel key (videoId → overrides). */
  uploads: number;
  /** Handles whose id lookup returns another channel's handle (a wrong id). */
  wrongId?: Set<string>;
  /** Endpoints answering "quota exceeded". */
  quota?: Set<string>;
  /** A transient failure (HTTP status) for this call, or null. */
  fail?: (endpoint: string, params: URLSearchParams) => number | null;
}

/** A synthetic YouTube Data API: per-channel uploads with session-style titles, plus a few that must be filtered out. */
function fakeYouTube(world: World, log: string[]) {
  const vid = (ch: string, i: number) => `${ch.slice(0, 4)}${String(i).padStart(7, '0')}`;
  const byId = new Map<string, Record<string, unknown>>();
  for (const c of SESSION_CHANNELS) {
    for (let i = 0; i < world.uploads; i++) {
      const id = vid(c.key, i);
      // Upload 1 is a Short, upload 2 private, upload 3 not embeddable, upload 4 an upcoming stream (0 s),
      // upload 6 a 95-second vertical Short without #shorts (portrait player).
      const dur = i === 1 ? 'PT45S' : i === 4 ? 'P0D' : i === 6 ? 'PT1M35S' : 'PT14M10S';
      // Upload 5 has no maxres thumbnail.
      const thumbs = { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }, medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` }, ...(i === 5 ? {} : { maxres: { url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg` } }) };
      byId.set(id, {
        id, snippet: { title: `Synthetic Artist ${i} - Song ${i} | ${c.venue}`, channelTitle: c.name, publishedAt: new Date(Date.UTC(2026, 10, 15) - i * DAY).toISOString(), thumbnails: thumbs },
        contentDetails: { duration: dur }, status: { embeddable: i !== 3, privacyStatus: i === 2 ? 'private' : 'public' },
        player: i === 6 ? { embedWidth: '360', embedHeight: '640' } : { embedWidth: '640', embedHeight: '360' },
      });
    }
  }
  return (async (input: string) => {
    const url = new URL(String(input));
    log.push(String(input));
    const endpoint = url.pathname.split('/').pop()!;
    if (world.quota?.has(endpoint)) return new Response('{"error":{"errors":[{"reason":"quotaExceeded"}]}}', { status: 403 });
    const p = url.searchParams;
    const status = world.fail?.(endpoint, p);
    if (status) return new Response('backend error', { status });
    if (endpoint === 'channels' && p.get('id')) {
      const ids = p.get('id')!.split(',');
      return Response.json({
        items: SESSION_CHANNELS.filter((c) => c.id && ids.includes(c.id)).map((c) => ({
          id: c.id, snippet: { customUrl: world.wrongId?.has(c.handle) ? '@somebodyelse' : c.handle.toLowerCase() }, contentDetails: { relatedPlaylists: { uploads: `UU${c.key}` } },
        })),
      });
    }
    if (endpoint === 'channels' && p.get('forHandle')) {
      const c = SESSION_CHANNELS.find((x) => x.handle === p.get('forHandle'))!;
      return Response.json({ items: [{ id: `UCresolved${c.key}`, snippet: { customUrl: c.handle.toLowerCase() }, contentDetails: { relatedPlaylists: { uploads: `UU${c.key}` } } }] });
    }
    if (endpoint === 'playlistItems') {
      const key = p.get('playlistId')!.slice(2);
      const n = Math.min(world.uploads, Number(p.get('maxResults')));
      return Response.json({ items: Array.from({ length: n }, (_, i) => ({ contentDetails: { videoId: vid(key, i) } })) });
    }
    if (endpoint === 'videos') return Response.json({ items: p.get('id')!.split(',').map((id) => byId.get(id)).filter(Boolean) });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const count = (log: string[], endpoint: string) => log.filter((u) => new URL(u).pathname.endsWith(`/${endpoint}`)).length;

afterEach(() => {
  vi.useRealTimers();
});

describe('live-session pool', () => {
  it('builds the pool with channels → uploads → details, filters what can’t play, and counts every unit', async () => {
    const log: string[] = [];
    const http = createHttp(new MemoryCache(), fakeYouTube({ uploads: 7 }, log));
    const r = await liveSessionPool({ http, env });
    // Only the fields the pool reads, and the player's aspect ratio (part=player + maxWidth: same quota).
    const details = new URL(log.find((u) => new URL(u).pathname.endsWith('/videos'))!).searchParams;
    expect(details.get('part')).toBe('snippet,contentDetails,status,player');
    expect(details.get('maxWidth')).toBe('640');
    expect(details.get('fields')).toMatch(/player\(embedWidth,embedHeight\)/);
    // Known ids in one channels.list call; the three channels without a known id resolved by handle.
    expect(count(log, 'channels')).toBe(1 + SESSION_CHANNELS.filter((c) => !c.id).length);
    expect(log.filter((u) => u.includes('forHandle=')).map((u) => new URL(u).searchParams.get('forHandle'))).toEqual(SESSION_CHANNELS.filter((c) => !c.id).map((c) => c.handle));
    expect(count(log, 'playlistItems')).toBe(SESSION_CHANNELS.length);
    expect(count(log, 'videos')).toBe(SESSION_CHANNELS.length); // one call per channel's (up to 50) uploads
    expect(count(log, 'search')).toBe(0); // never search.list (100 units)
    expect(r.source).toBe('network');
    expect(r.units).toBe(log.length);
    expect(r.units).toBe(4 + 8 + 8);
    // Shorts (under a minute, or a portrait player), private, non-embeddable and upcoming streams are out: 2 of 7 per channel remain.
    expect(r.videos).toHaveLength(SESSION_CHANNELS.length * 2);
    expect(r.videos.every((v) => v.durationSec >= 60)).toBe(true);
    // Newest first, compact (no description), channel key kept.
    const times = r.videos.map((v) => v.publishedAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(r.videos[0]).toEqual(expect.objectContaining({ channel: expect.any(String), title: expect.stringContaining('Synthetic Artist'), thumb: expect.stringContaining('ytimg') }));
    expect(r.videos[0]).not.toHaveProperty('description');
  });

  it('is shared through the provider cache for a day: a second request spends nothing', async () => {
    const log: string[] = [];
    const cache = new MemoryCache();
    await liveSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 3 }, log)), env });
    const before = log.length;
    const again = await liveSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 3 }, log)), env });
    expect(log.length).toBe(before);
    expect(again).toMatchObject({ source: 'cache', units: 0 });
    expect(again.videos.length).toBeGreaterThan(0);
  });

  it('a full day costs about 16 units for the whole pool, well under 40 (channel lookups cached a month)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T08:00:00Z'));
    const log: string[] = [];
    const cache = new MemoryCache();
    const day1 = await liveSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 50 }, log)), env });
    // 4 channel lookups + 8 upload pages + 400 ids / 50 = 8 detail calls.
    expect(day1.units).toBe(4 + 8 + 8);
    vi.setSystemTime(new Date('2026-11-17T08:30:00Z'));
    log.length = 0;
    const day2 = await liveSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 50 }, log)), env });
    expect(day2.source).toBe('network');
    expect(count(log, 'channels')).toBe(0);
    expect(day2.units).toBe(8 + 8);
    expect(count(log, 'search')).toBe(0);
    expect(sessionPoolUnitsPerDay()).toBeLessThan(17);
    expect(sessionPoolUnitsPerDay()).toBeLessThan(40);
  });

  it('a known id that belongs to another handle is resolved by handle instead', async () => {
    const log: string[] = [];
    const colors = SESSION_CHANNELS.find((c) => c.key === 'colors')!;
    const r = await liveSessionPool({ http: createHttp(new MemoryCache(), fakeYouTube({ uploads: 3, wrongId: new Set([colors.handle]) }, log)), env });
    expect(log.some((u) => new URL(u).searchParams.get('forHandle') === colors.handle)).toBe(true);
    expect(r.videos.some((v) => v.channel === 'colors')).toBe(true);
  });

  it('out of quota: last week’s copy is served and the quota error is handed back (no partial pool cached)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T08:00:00Z'));
    const cache = new MemoryCache();
    const good = await liveSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 3 }, [])), env });
    vi.setSystemTime(new Date('2026-11-17T09:00:00Z')); // the day's pool expired, the stale copy hasn't
    const log: string[] = [];
    const r = await liveSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 3, quota: new Set(['playlistItems']) }, log)), env });
    expect(r.source).toBe('stale');
    expect(r.quota?.kind).toBe('quota');
    expect(r.videos).toEqual(good.videos);
    expect(await cache.get(sessionPoolKey())).toBeUndefined();
  });

  it('YouTube blocked for the day: cache or stale copy only, zero calls', async () => {
    const log: string[] = [];
    const http = createHttp(new MemoryCache(), fakeYouTube({ uploads: 3 }, log));
    const r = await liveSessionPool({ http, env }, { allowNetwork: false });
    expect(log).toHaveLength(0);
    expect(r).toMatchObject({ source: 'none', units: 0, videos: [] });
  });

  it('a custom channel list gets its own cache entry', () => {
    const one: SessionChannel[] = [SESSION_CHANNELS[0]];
    expect(sessionPoolKey(one)).not.toBe(sessionPoolKey());
  });

  it('Shorts of any length are out (a portrait player); thumbnails are true 16:9 (maxres, else medium: no letterbox bars)', async () => {
    const r = await liveSessionPool({ http: createHttp(new MemoryCache(), fakeYouTube({ uploads: 7 }, [])), env });
    const kexp = r.videos.filter((v) => v.channel === 'kexp');
    expect(kexp.map((v) => v.videoId)).toEqual(['kexp0000000', 'kexp0000005']);
    expect(kexp[0].thumb).toMatch(/maxresdefault\.jpg$/);
    expect(kexp[1].thumb).toMatch(/mqdefault\.jpg$/);
    const base = { id: 'x', snippet: { title: 'Act - Song | A COLORS SHOW', description: '', channelTitle: 'COLORS', publishedAt: '2026-11-01T00:00:00Z' }, contentDetails: { duration: 'PT2M50S' }, status: { embeddable: true, privacyStatus: 'public' } };
    expect(sessionVideoOf({ ...base, player: { embedWidth: 360, embedHeight: 640 } }, 'colors', undefined, 'now')).toBeNull();
    expect(sessionVideoOf({ ...base, player: { embedWidth: 480, embedHeight: 480 } }, 'colors', undefined, 'now')).toBeNull();
    expect(sessionVideoOf({ ...base, player: { embedWidth: 640, embedHeight: 360 } }, 'colors', undefined, '2026-11-17T08:00:00.000Z')).toMatchObject({ videoId: 'x', durationSec: 170, fetchedAt: '2026-11-17T08:00:00.000Z' });
  });

  it('YouTube failing for every channel: the last good copy, and no calls at all for a while (no quota spent on a broken day)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T08:00:00Z'));
    const cache = new MemoryCache();
    const good = await liveSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 3 }, [])), env });
    vi.setSystemTime(new Date('2026-11-17T08:30:00Z')); // the day's pool expired, the stale copy hasn't
    const log: string[] = [];
    const down = fakeYouTube({ uploads: 3, fail: (endpoint) => (endpoint === 'playlistItems' ? 503 : null) }, log);
    const r = await liveSessionPool({ http: createHttp(cache, down), env });
    expect(r.source).toBe('stale');
    expect(r.videos).toEqual(good.videos);
    expect(count(log, 'playlistItems')).toBe(SESSION_CHANNELS.length);
    // The next requests serve the same copy without calling YouTube...
    log.length = 0;
    for (let i = 0; i < 3; i++) expect((await liveSessionPool({ http: createHttp(cache, down), env })).source).toBe('stale');
    expect(log).toHaveLength(0);
    // ...until the back-off ends.
    vi.setSystemTime(new Date(Date.parse('2026-11-17T08:30:00Z') + SESSION_POOL_BACKOFF_TTL * 1000 + 1000));
    await liveSessionPool({ http: createHttp(cache, down), env });
    expect(count(log, 'playlistItems')).toBe(SESSION_CHANNELS.length);
  });

  it('some channels failing: their videos come from the last good copy, the pool is retried soon, the good copy never shrinks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T08:00:00Z'));
    const cache = new MemoryCache();
    const good = await liveSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 3 }, [])), env });
    expect(new Set(good.videos.map((v) => v.channel)).size).toBe(SESSION_CHANNELS.length);
    vi.setSystemTime(new Date('2026-11-17T08:30:00Z'));
    // Every channel but KEXP fails (a blip or an 8 s timeout).
    const flaky = (endpoint: string, p: URLSearchParams) => (endpoint === 'playlistItems' && p.get('playlistId') !== 'UUkexp' ? 503 : null);
    const r = await liveSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 3, fail: flaky }, [])), env });
    expect(r.source).toBe('network');
    expect(new Set(r.videos.map((v) => v.channel)).size).toBe(SESSION_CHANNELS.length);
    expect(r.detail).toMatch(/1\/8 channels answered/);
    // The failed channels keep their last good videos (with the time YouTube returned them).
    const tiny = r.videos.filter((v) => v.channel === 'tinydesk');
    expect(tiny).toEqual(good.videos.filter((v) => v.channel === 'tinydesk'));
    expect(tiny[0].fetchedAt).toBe('2026-11-16T08:00:00.000Z');
    expect(((await cache.get(`${sessionPoolKey()}:stale`)) as SessionVideo[]).length).toBe(good.videos.length);
    // Retried within the hour, not tomorrow: only the failed channels' uploads are asked again.
    vi.setSystemTime(new Date(Date.parse('2026-11-17T08:30:00Z') + SESSION_POOL_RETRY_TTL * 1000 + 1000));
    const log: string[] = [];
    const again = await liveSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 3 }, log)), env });
    expect(again.source).toBe('network');
    expect(count(log, 'playlistItems')).toBe(SESSION_CHANNELS.length - 1);
    expect(again.detail).toMatch(/8\/8 channels answered/);
    // Complete again: cached for the day.
    expect(await cache.get(sessionPoolKey())).toEqual(again.videos);
  });

  it('a pool being built by another request: the last good copy is served, nothing is built twice', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T08:00:00Z'));
    const cache = new MemoryCache();
    await liveSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 3 }, [])), env });
    vi.setSystemTime(new Date('2026-11-17T08:30:00Z'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const log: string[] = [];
    const inner = fakeYouTube({ uploads: 3 }, log);
    const slow = (async (u: string) => {
      await gate;
      return inner(u);
    }) as unknown as typeof fetch;
    const first = liveSessionPool({ http: createHttp(cache, slow), env });
    await new Promise((r) => setTimeout(r, 0));
    const log2: string[] = [];
    const second = await liveSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 3 }, log2)), env });
    expect(second).toMatchObject({ source: 'stale', units: 0 });
    expect(log2).toHaveLength(0);
    release();
    expect((await first).source).toBe('network');
  });

  it('a copy is never served once its data is a week old; the last good copy can be read without calling YouTube', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T08:00:00Z'));
    const cache = new MemoryCache();
    const good = await liveSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 3 }, [])), env });
    vi.setSystemTime(new Date('2026-11-17T08:30:00Z'));
    const log: string[] = [];
    const read = await staleSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 3 }, log)) });
    expect(read).toMatchObject({ source: 'stale', units: 0 });
    expect(read.videos).toEqual(good.videos);
    expect(log).toHaveLength(0);
    // A copy whose videos were fetched over a week ago (kept by a later partial build) is not served.
    await cache.set(`${sessionPoolKey()}:stale`, good.videos.map((v) => ({ ...v, fetchedAt: '2026-11-09T08:00:00.000Z' })), 86400);
    expect((await staleSessionPool({ http: createHttp(cache, fakeYouTube({ uploads: 3 }, [])) })).videos).toEqual([]);
  });
});
