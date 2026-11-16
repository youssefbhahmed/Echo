import { blockUntil, createHttp, MemoryCache } from '@shared/providers/http.ts';
import { lbSpotifyIds, LB_SPOTIFY_MAPPING_URL } from '@shared/providers/listenbrainz.ts';
import { artistMatches, resolveKey, resolveSpotifyPicks, titleMatches, type SpotifyPick } from '@shared/providers/spotify.ts';
import { laneReject } from '@shared/engine/lanes.ts';
import { emptyProfile } from '@shared/engine/profile.ts';

const id = (n: number) => `TRK${String(n).padStart(19, '0')}`;
interface FakeTrack { name: string; artist: string; date: string; playable?: boolean; isrc?: string; albumType?: string }

/** Fake Spotify + ListenBrainz: `lb` maps "artist|track" → ids, `tracks` holds single-track lookups. */
function fakeNet(opts: { lb: Record<string, string[]>; tracks: Record<string, FakeTrack>; search?: (q: string) => Response }) {
  const log: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    const url = String(u);
    log.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
    if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    if (url === LB_SPOTIFY_MAPPING_URL) {
      const rows = JSON.parse(String(init?.body)) as Array<{ artist_name: string; release_name: string; track_name: string }>;
      return new Response(JSON.stringify(rows.map((r) => ({ ...r, spotify_track_ids: opts.lb[`${r.artist_name}|${r.track_name}`] ?? [] }))));
    }
    const m = /\/v1\/tracks\/([A-Za-z0-9]+)/.exec(url);
    if (m) {
      const t = opts.tracks[m[1]];
      if (!t) return new Response('{"error":"not found"}', { status: 404 });
      return new Response(JSON.stringify({
        id: m[1], name: t.name, artists: [{ id: 'a', name: t.artist }], album: { id: 'al', name: 'Album', images: [], release_date: t.date, album_type: t.albumType ?? 'album' },
        duration_ms: 200000, external_urls: { spotify: `https://open.spotify.com/track/${m[1]}` }, is_playable: t.playable ?? true, external_ids: { isrc: t.isrc },
      }));
    }
    if (url.includes('/v1/search')) return opts.search ? opts.search(new URL(url).searchParams.get('q') ?? '') : new Response('{}', { status: 500 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, log };
}

const env = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b' } as Record<string, string>)[n];

describe('resolving curator picks', () => {
  const picks: SpotifyPick[] = [
    { artist: 'Nova Lane', track: 'Glass Coast', laneId: 'melodic-house' },
    { artist: 'Old Masters', track: 'Desert Song', laneId: 'maghreb-fusion' },
    { artist: 'Real Artist', track: 'Real Song', laneId: 'melodic-house' },
    { artist: 'Ghost Band', track: 'Not Real', laneId: 'melodic-house' },
    { artist: 'Search Only', track: 'Deep Track', laneId: 'melodic-house' },
  ];
  const net = () => fakeNet({
    lb: { 'Nova Lane|Glass Coast': [id(1)], 'Old Masters|Desert Song': [id(2)], 'Real Artist|Real Song': [id(3)] },
    tracks: {
      [id(1)]: { name: 'Glass Coast', artist: 'Nova Lane', date: '2019-04-01' },
      [id(2)]: { name: 'Desert Song', artist: 'Old Masters', date: '1976-01-01' },
      // LB mapped to a song by someone else: rejected on artist mismatch.
      [id(3)]: { name: 'Real Song', artist: 'Somebody Else', date: '2020-01-01' },
    },
  });
  const lanes = { 'melodic-house': { regional: false, era: { from: 2011 } }, 'maghreb-fusion': { regional: true, era: { from: 2015 } } } as const;
  const accept = (excludeIds = new Set<string>()) => (item: import('@shared/types.ts').ContentItem, pk: SpotifyPick) => laneReject(item, lanes[pk.laneId as keyof typeof lanes], { profile: emptyProfile(), excludeIds });

  it('maps via ListenBrainz + single-track lookups, checks artists and era, never searches while blocked', async () => {
    const { fetchImpl, log } = net();
    const res = await resolveSpotifyPicks(picks, { http: createHttp(new MemoryCache(), fetchImpl), env }, { allowSearch: false, accept: accept() });
    expect(res.items.map((r) => r.item.title)).toEqual(['Glass Coast']);
    expect(res.items[0]).toMatchObject({ via: 'listenbrainz', pick: { laneId: 'melodic-house' }, item: { id: `spotify:track:${id(1)}`, releaseDate: '2019-04-01', embed: { type: 'spotify', uri: `spotify:track:${id(1)}` } } });
    expect(res.stats.rejected).toEqual({ era: 1 });
    expect(log.filter((c) => c.url.includes('/v1/search'))).toEqual([]);
    const lb = log.filter((c) => c.url === LB_SPOTIFY_MAPPING_URL);
    expect(lb).toHaveLength(1);
    expect(lb[0].method).toBe('POST');
    expect(log.filter((c) => c.url.includes('/v1/tracks/')).every((c) => c.url.includes('market=US'))).toBe(true);
    expect(res.rateLimitedSec).toBeUndefined();
  });

  it('caches resolutions per pick: a repeat refresh makes no ListenBrainz or Spotify calls', async () => {
    const { fetchImpl, log } = net();
    const http = createHttp(new MemoryCache(), fetchImpl);
    await resolveSpotifyPicks(picks.slice(0, 1), { http, env }, { allowSearch: false, accept: accept() });
    const before = log.length;
    const again = await resolveSpotifyPicks(picks.slice(0, 1), { http, env }, { allowSearch: false, accept: accept() });
    expect(again.items[0]).toMatchObject({ via: 'cache', item: { title: 'Glass Coast' } });
    expect(log.length).toBe(before);
  });

  it('filters exclusions, honours per-lane needs, and searches only the unresolved (max 8, stop on 429)', async () => {
    const searches: string[] = [];
    const { fetchImpl } = fakeNet({
      lb: { 'Nova Lane|Glass Coast': [id(1)] },
      tracks: { [id(1)]: { name: 'Glass Coast', artist: 'Nova Lane', date: '2019-04-01' } },
      search: (q) => {
        searches.push(q);
        if (q.includes('Deep Track')) return new Response(JSON.stringify({ tracks: { items: [{ id: id(9), name: 'Deep Track - Radio Edit', artists: [{ id: 'x', name: 'Search Only' }], album: { id: 'al', name: 'A', images: [], release_date: '2021-02-02' }, duration_ms: 1, external_urls: { spotify: 'https://open.spotify.com/track/x' } }] } }));
        return new Response(JSON.stringify({ tracks: { items: [] } }));
      },
    });
    const many: SpotifyPick[] = [...picks, ...Array.from({ length: 12 }, (_, i) => ({ artist: `Nobody ${i}`, track: `Nothing ${i}`, laneId: 'melodic-house' }))];
    const res = await resolveSpotifyPicks(many, { http: createHttp(new MemoryCache(), fetchImpl), env }, { allowSearch: true, accept: accept(new Set([`spotify:track:${id(1)}`])) });
    expect(res.items.map((r) => r.item.title)).toEqual(['Deep Track - Radio Edit']);
    expect(res.stats.rejected.excluded).toBe(1);
    expect(searches.length).toBe(8);
    expect(searches.some((q) => q.includes('Nova Lane'))).toBe(false); // resolved via ListenBrainz (then excluded): no search
    expect(searches[0]).toBe('track:"Desert Song" artist:"Old Masters"');

    // Per-lane need: once a lane has enough, the rest of its picks are not resolved.
    const { fetchImpl: f2, log } = net();
    const need = await resolveSpotifyPicks(picks, { http: createHttp(new MemoryCache(), f2), env }, { allowSearch: false, need: { 'melodic-house': 1, 'maghreb-fusion': 0 }, accept: accept(), concurrency: 1 });
    expect(need.items).toHaveLength(1);
    expect(log.filter((c) => c.url.includes('/v1/tracks/')).length).toBe(1);
  });

  it('stops at the first 429 and surfaces Retry-After', async () => {
    const searches: string[] = [];
    const { fetchImpl } = fakeNet({ lb: {}, tracks: {}, search: (q) => (searches.push(q), new Response('rate limited', { status: 429, headers: { 'retry-after': '68195' } })) });
    const res = await resolveSpotifyPicks(picks, { http: createHttp(new MemoryCache(), fetchImpl), env }, { allowSearch: true });
    expect(searches).toHaveLength(1);
    expect(res.rateLimitedSec).toBe(68195);
    expect(res.items).toEqual([]);
  });

  it('rejects unplayable tracks and compilation reissues', async () => {
    const { fetchImpl } = fakeNet({
      lb: { 'A|One': [id(4)], 'B|Two': [id(5)] },
      tracks: { [id(4)]: { name: 'One', artist: 'A', date: '2020-01-01', playable: false }, [id(5)]: { name: 'Two', artist: 'B', date: '2018-01-01', albumType: 'compilation' } },
    });
    const res = await resolveSpotifyPicks([{ artist: 'A', track: 'One', laneId: 'melodic-house' }, { artist: 'B', track: 'Two', laneId: 'melodic-house' }], { http: createHttp(new MemoryCache(), fetchImpl), env }, { allowSearch: false, accept: accept() });
    expect(res.items).toEqual([]);
    expect(res.stats.rejected).toEqual({ unplayable: 1, compilation: 1 });
  });
});

describe('rate limits and cache-only resolution', () => {
  const lanes = { 'melodic-house': { regional: false, era: { from: 2011 } } } as const;
  const accept = (item: import('@shared/types.ts').ContentItem, pk: SpotifyPick) => laneReject(item, lanes[pk.laneId as keyof typeof lanes], { profile: emptyProfile() });

  it('a 429 on single-track lookups is reported as a lookup limit (not a search limit) and stops all Spotify calls', async () => {
    const { fetchImpl, log } = fakeNet({ lb: { 'A|One': [id(11)], 'B|Two': [id(12)], 'C|Three': [id(13)] }, tracks: {} });
    const limited = (async (u: string, init?: RequestInit) => {
      if (String(u).includes('/v1/tracks/')) {
        log.push({ url: String(u), method: 'GET' });
        return new Response('slow down', { status: 429 });
      }
      return fetchImpl(u, init);
    }) as unknown as typeof fetch;
    const picks: SpotifyPick[] = [{ artist: 'A', track: 'One', laneId: 'melodic-house' }, { artist: 'B', track: 'Two', laneId: 'melodic-house' }, { artist: 'C', track: 'Three', laneId: 'melodic-house' }];
    const res = await resolveSpotifyPicks(picks, { http: createHttp(new MemoryCache(), limited), env }, { allowSearch: true, accept, concurrency: 1 });
    expect(res.lookupLimitedSec).toBe(60); // no Retry-After header → 60 s
    expect(res.rateLimitedSec).toBeUndefined(); // the 'spotify' (search) block is left alone
    expect(log.filter((c) => c.url.includes('/v1/tracks/'))).toHaveLength(1);
    expect(log.filter((c) => c.url.includes('/v1/search'))).toEqual([]);
  });

  it('while lookups are blocked, resolves from cached resolutions only: no token, ListenBrainz or Spotify call', async () => {
    const { fetchImpl, log } = fakeNet({ lb: { 'Nova Lane|Glass Coast': [id(1)] }, tracks: { [id(1)]: { name: 'Glass Coast', artist: 'Nova Lane', date: '2019-04-01' } } });
    const http = createHttp(new MemoryCache(), fetchImpl);
    const warm: SpotifyPick[] = [{ artist: 'Nova Lane', track: 'Glass Coast', laneId: 'melodic-house' }];
    await resolveSpotifyPicks(warm, { http, env }, { allowSearch: false, accept });
    log.length = 0;
    const res = await resolveSpotifyPicks([...warm, { artist: 'Never Seen', track: 'New Song', laneId: 'melodic-house' }], { http, env }, { allowSearch: true, allowLookups: false, accept });
    expect(res.items.map((r) => [r.item.title, r.via])).toEqual([['Glass Coast', 'cache']]);
    expect(res.stats.unresolved).toBe(1);
    expect(log).toEqual([]);
  });
});

describe('non-Latin names and alternate releases', () => {
  const accept = (item: import('@shared/types.ts').ContentItem) => laneReject(item, { regional: false, era: { from: 2011 } }, { profile: emptyProfile() });

  it('keys Arabic-script picks apart, so each one is mapped and checked on its own', async () => {
    const a1 = { artist: 'فنان أول', track: 'أغنية الليل', laneId: 'arabic-pop' };
    const a2 = { artist: 'فنان ثاني', track: 'أغنية البحر', laneId: 'arabic-pop' };
    expect(resolveKey(a1)).not.toBe(resolveKey(a2));
    expect(resolveKey(a1)).not.toMatch(/:\|$/);
    // A Latin-script artist with Arabic-script titles: one key per song, not "artist|".
    expect(resolveKey({ artist: 'Nova Lane', track: 'أغنية الليل' })).not.toBe(resolveKey({ artist: 'Nova Lane', track: 'أغنية البحر' }));
    const { fetchImpl, log } = fakeNet({
      lb: { [`${a1.artist}|${a1.track}`]: [id(21)], [`${a2.artist}|${a2.track}`]: [id(22)] },
      tracks: { [id(21)]: { name: a1.track, artist: a1.artist, date: '2021-01-01' }, [id(22)]: { name: a2.track, artist: a2.artist, date: '2022-01-01' } },
    });
    const http = createHttp(new MemoryCache(), fetchImpl);
    const first = await resolveSpotifyPicks([a1], { http, env }, { allowSearch: false, accept });
    expect(first.items.map((r) => r.item.title)).toEqual([a1.track]);
    // The second pick is a different song: it goes to ListenBrainz instead of reusing the first one's cached id.
    const second = await resolveSpotifyPicks([a2], { http, env }, { allowSearch: false, accept });
    expect(second.items.map((r) => [r.item.title, r.via])).toEqual([[a2.track, 'listenbrainz']]);
    expect(log.filter((c) => c.url === LB_SPOTIFY_MAPPING_URL)).toHaveLength(2);
  });

  it('compares titles in any script and never accepts a title it cannot compare', () => {
    expect(titleMatches('أغنية الليل', 'أغنية الليل (feat. Someone)')).toBe(true);
    expect(titleMatches('أغنية الليل', 'أغنية البحر')).toBe(false);
    expect(titleMatches('Lil Song', 'أغنية الليل')).toBe(false); // different scripts: not verifiable
    expect(titleMatches('Glass Coast', 'Glass Coast - Radio Edit')).toBe(true);
    expect(artistMatches('فنان أول', ['فنان أول'])).toBe(true);
    expect(artistMatches('فنان أول', ['فنان ثاني'])).toBe(false);
    expect(artistMatches('Beyoncé', ['Beyonce'])).toBe(true);
  });

  it('drops a pick when ANY of its ListenBrainz ids is a song the user already has', async () => {
    const { fetchImpl, log } = fakeNet({
      lb: { 'Nova Lane|Glass Coast': [id(31), id(32)] },
      tracks: { [id(31)]: { name: 'Glass Coast', artist: 'Nova Lane', date: '2019-04-01' } },
    });
    // The user liked the album version (id 32); ListenBrainz lists the single (id 31) first.
    const res = await resolveSpotifyPicks([{ artist: 'Nova Lane', track: 'Glass Coast', laneId: 'melodic-house' }], { http: createHttp(new MemoryCache(), fetchImpl), env }, {
      allowSearch: false, accept, excludeIds: new Set([`spotify:track:${id(32)}`]),
    });
    expect(res.items).toEqual([]);
    expect(res.stats.rejected).toEqual({ excluded: 1 });
    expect(log.filter((c) => c.url.includes('/v1/tracks/'))).toEqual([]);
  });
});

describe('provider blocks', () => {
  it('never shortens an existing block (a short 429 elsewhere must not cut a 19 h penalty)', () => {
    const now = Date.UTC(2026, 10, 16, 12);
    const long = now + 19 * 3600_000;
    expect(blockUntil('spotify', now, 60, long)).toBe(long);
    expect(blockUntil('spotify', now, undefined, long)).toBe(long);
    expect(blockUntil('spotify', now, 68195, now + 60_000)).toBe(now + 68195_000);
    expect(blockUntil('spotify', now)).toBe(now + 120_000);
    expect(blockUntil('youtube', now)).toBe(now + 6 * 3600_000);
    expect(blockUntil('spotify', now, 10 * 86400)).toBe(now + 86400_000);
  });
});

describe('ListenBrainz mapping and matching helpers', () => {
  it('batches ≤ 25 rows per POST and tolerates a failing chunk', async () => {
    const bodies: number[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      const rows = JSON.parse(String(init?.body)) as unknown[];
      bodies.push(rows.length);
      if ((rows[0] as { artist_name: string }).artist_name === 'A25') return new Response('boom', { status: 500 });
      return new Response(JSON.stringify(rows.map(() => ({ spotify_track_ids: [id(7), 'bad id'] }))));
    }) as unknown as typeof fetch;
    const picks = Array.from({ length: 60 }, (_, i) => ({ artist: `A${i}`, track: `T${i}` }));
    const ids = await lbSpotifyIds(picks, createHttp(new MemoryCache(), fetchImpl));
    expect(bodies.sort((a, b) => b - a)).toEqual([25, 25, 10]);
    expect(ids.filter((x) => x.length).length).toBe(35);
    expect(ids[0]).toEqual([id(7)]);
  });

  it('matches artists and titles loosely but not across different artists', () => {
    expect(artistMatches('Beyonce & Jay-Z', ['JAY Z'])).toBe(true);
    expect(artistMatches('The Weeknd', ['Weeknd'])).toBe(true);
    expect(artistMatches('Mumford & Sons', ['Mumford and Sons'])).toBe(true);
    expect(artistMatches('Beyoncé', ['Beyonce'])).toBe(true);
    expect(artistMatches('Drake', ['Drake Bell'])).toBe(false);
    expect(artistMatches('Nova Lane', ['Somebody Else'])).toBe(false);
    expect(titleMatches('Glass Coast', 'Glass Coast (feat. Someone) - 2019 Remaster')).toBe(true);
    expect(titleMatches('Glass Coast', 'Paper Mountain')).toBe(false);
  });
});
