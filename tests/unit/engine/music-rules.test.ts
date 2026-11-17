// Owner rules for music, the edge cases: a scene the request asks for (or the named artist's own) is
// allowed by style as well as by language, a name is never a request for its scene, the named artist's
// scene comes from their own songs (or the interpreter), lyrics languages stored with songs keep the
// stored fallback honest, shared rows keep their lanes, repeats say so, held-back library songs stay
// out of an artist's own lane, and parallel resolutions share one stop. Synthetic songs; network mocked.
import { runPipeline } from '@shared/engine/pipeline.ts';
import { askedRegions, curateMusic, laneFallback, laneLooseMusic, offLanguages, planMusic, withoutNames } from '@shared/engine/curator.ts';
import { allowScenes, LANE_BY_ID, mergeCatalogMetadata, withoutPerUser } from '@shared/engine/lanes.ts';
import { laneExplanation } from '@shared/engine/rank.ts';
import { chatRequest } from '@shared/engine/chat.ts';
import { emptyProfile } from '@shared/engine/profile.ts';
import { aiConfig } from '@shared/engine/ai.ts';
import { createHttp, MemoryCache } from '@shared/providers/http.ts';
import { LB_SPOTIFY_MAPPING_URL } from '@shared/providers/listenbrainz.ts';
import { resolveSpotifyPicks, type SpotifyPick } from '@shared/providers/spotify.ts';
import type { AnalyzedItem, ContentItem, MusicLane, TasteProfile } from '@shared/types.ts';

const NOW = new Date('2026-11-16T00:00:00Z');
const frenchOff: TasteProfile = { ...emptyProfile(), explicit: { ...emptyProfile().explicit, blockedFamilies: ['french-chanson', 'french-rap'] } };
const env = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b', AI_BASE_URL: 'https://ai.test/v1', AI_MODEL: 'm' } as Record<string, string>)[n];

type Song = { artist: string; track: string; year: number; lane?: string; lang?: string; why?: string };
const tid = (i: number) => `MUS${String(i).padStart(19, '0')}`;

/** Curator answers by prompt kind; ListenBrainz maps every song by title; /v1/tracks returns it. */
function musicNet(answers: { request?: Song[]; by?: Song[]; like?: Song[]; understand?: unknown }, prompts: string[] = []) {
  const all = [...(answers.request ?? []), ...(answers.by ?? []), ...(answers.like ?? [])];
  const log: string[] = [];
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    const url = String(u);
    log.push(url);
    if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    if (url.includes('/chat/completions')) {
      const body = JSON.parse(String(init?.body));
      const system = body.messages[0].content as string;
      prompts.push(system);
      const items = (xs: Song[] = []) => ({ items: xs.map(({ artist, track, lane, lang, why }) => ({ artist, track, feat: [], lane, lang, why })) });
      const content = system.includes('request interpreter') ? answers.understand ?? {}
        : /officially released songs by/.test(system) ? items(answers.by)
          : /DIFFERENT artists closely related/.test(system) ? items(answers.like) : items(answers.request);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    }
    if (url === LB_SPOTIFY_MAPPING_URL) {
      const rows = JSON.parse(String(init?.body)) as Array<{ track_name: string }>;
      return new Response(JSON.stringify(rows.map((r) => ({ ...r, spotify_track_ids: [tid(all.findIndex((s) => s.track === r.track_name))] }))));
    }
    const m = /\/v1\/tracks\/(MUS\d+)/.exec(url);
    if (m) {
      const s = all[Number(m[1].slice(3))];
      return new Response(JSON.stringify({ id: m[1], name: s.track, artists: [{ id: 'a', name: s.artist }], album: { id: 'al', name: 'Album', images: [], release_date: `${s.year}-03-01`, album_type: 'album' }, duration_ms: 200000, external_urls: { spotify: 'https://open.spotify.com/track/x' }, is_playable: true }));
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, log };
}

describe('a scene the request asks for is allowed by style as well as by language', () => {
  const picks: Song[] = [
    { artist: 'Rappeur Un', track: 'Titre Un', year: 2021, lane: 'french rap', lang: 'French' },
    { artist: 'Rappeur Deux', track: 'Titre Deux', year: 2022, lane: 'rap français', lang: 'French' },
    { artist: 'Chanteuse Trois', track: 'Titre Trois', year: 2020, lane: 'pop urbaine', lang: 'French' },
    { artist: 'Rappeur Quatre', track: 'Titre Quatre', year: 2023, lane: 'drill', lang: 'French' },
  ];

  it('"rap français récent" with French switched off: every verified pick is served', async () => {
    const { fetchImpl } = musicNet({ request: picks, understand: { categories: ['music'], concepts: {} } });
    const res = await runPipeline(chatRequest({ message: 'rap français récent' }), { env, http: createHttp(new MemoryCache(), fetchImpl), profile: frenchOff, blockedProviders: new Set(['spotify']), seed: 1, now: NOW });
    expect(res.recommendations.map((r) => r.item.title).sort()).toEqual(['Titre Deux', 'Titre Quatre', 'Titre Trois', 'Titre Un']);
    expect(res.pipeline.find((p) => p.step === 'music-ai')?.detail).not.toMatch(/blocked \d/);
  });

  it('without the request asking, the same picks are dropped (the switch-off holds)', async () => {
    const { fetchImpl } = musicNet({ request: picks, understand: { categories: ['music'], concepts: { energetic: 0.8 } } });
    const res = await runPipeline(chatRequest({ message: 'rap for running' }), { env, http: createHttp(new MemoryCache(), fetchImpl), profile: frenchOff, blockedProviders: new Set(['spotify']), seed: 1, now: NOW });
    expect(res.recommendations).toHaveLength(0);
  });

  it('the named artist\'s own scene: "artists like" a French rapper keeps French-labelled peers', async () => {
    const by: Song[] = [
      { artist: 'Rappeur Nova', track: 'Son Un', year: 2019, lane: 'french rap', lang: 'French' },
      { artist: 'Rappeur Nova', track: 'Son Deux', year: 2021, lane: 'french rap', lang: 'French' },
      { artist: 'Rappeur Nova', track: 'Son Trois', year: 2022, lane: 'french rap', lang: 'French' },
    ];
    const like: Song[] = [
      { artist: 'Pair Un', track: 'Pair Titre Un', year: 2020, lane: 'french rap', lang: 'French', why: 'same punchlines' },
      { artist: 'Pair Deux', track: 'Pair Titre Deux', year: 2021, lane: 'pop urbaine', lang: 'French', why: 'same hooks' },
      { artist: 'Pair Trois', track: 'Pair Titre Trois', year: 2012, lane: 'french rap', lang: 'French', why: 'old school' }, // regional before 2015: still dropped
    ];
    const { fetchImpl } = musicNet({ by, like, understand: { categories: ['music'], entities: [{ name: 'Rappeur Nova', kind: 'artist', want: 'all' }] } });
    const res = await runPipeline(chatRequest({ message: 'rappeur nova' }), { env, http: createHttp(new MemoryCache(), fetchImpl), profile: frenchOff, blockedProviders: new Set(['spotify', 'youtube']), seed: 1, now: NOW });
    const likeLane = res.recommendations.filter((r) => (r.item.metadata?.lane as { id?: string } | undefined)?.id === 'entity-like').map((r) => r.item.title);
    expect(likeLane.sort()).toEqual(['Pair Titre Deux', 'Pair Titre Un']);
    // The per-request scene flag never goes into the shared catalog row.
    const item = res.recommendations.find((r) => r.item.title === 'Pair Titre Un')!.item;
    expect(item.metadata?.wantedScene).toBe('french');
    expect(withoutPerUser(item.metadata)).not.toHaveProperty('wantedScene');
  });

  it('allowScenes lifts only that scene\'s families', () => {
    const p: TasteProfile = { ...frenchOff, explicit: { ...frenchOff.explicit, blockedFamilies: ['french-rap', 'french-chanson', 'maghreb', 'rock'] } };
    expect(allowScenes(p, ['french']).explicit.blockedFamilies).toEqual(['maghreb', 'rock']);
    expect(allowScenes(p, ['arabic-pop']).explicit.blockedFamilies).toEqual(['french-rap', 'french-chanson', 'rock']);
    expect(allowScenes(p, [])).toBe(p);
  });
});

describe('a name is never a request for its scene', () => {
  it('"French Montana" or "Arab Strap" asks for no scene; "rap français" does', () => {
    expect([...askedRegions('french montana', undefined, ['French Montana'])]).toEqual([]);
    expect([...askedRegions('songs like arab strap', undefined, ['Arab Strap'])]).toEqual([]);
    expect([...askedRegions('rap français like french montana', undefined, ['French Montana'])]).toEqual(['french']);
    expect(offLanguages(frenchOff, 'songs like french montana', undefined, ['French Montana'])).toEqual(['French']);
    expect(withoutNames('Songs like French Montana!', ['French Montana'])).toBe('songs like');
  });

  it('the "artists like" prompt keeps the off-language rule, and the lane drops French picks', async () => {
    const prompts: string[] = [];
    const like: Song[] = [
      { artist: 'Peer One', track: 'Peer Song', year: 2018, lane: 'hip hop', lang: 'English', why: 'coke-rap swagger' },
      { artist: 'Chanteur FR', track: 'Chanson FR', year: 2021, lane: 'afro trap', lang: 'French', why: 'catchy hooks' },
    ];
    const { fetchImpl } = musicNet({ like, understand: { categories: ['music'], entities: [{ name: 'French Montana', kind: 'artist', want: 'like' }] } }, prompts);
    const res = await runPipeline(chatRequest({ message: 'songs like french montana' }), { env, http: createHttp(new MemoryCache(), fetchImpl), profile: frenchOff, blockedProviders: new Set(['spotify']), seed: 1, now: NOW });
    expect(prompts.find((p) => /DIFFERENT artists closely related/.test(p))).toMatch(/No French-language songs: the listener switched them off/);
    expect(res.recommendations.map((r) => r.item.title)).toEqual(['Peer Song']);
  });
});

describe('the named artist\'s scene comes from their own songs or the interpreter, never from the picks being judged', () => {
  const like: Song[] = Array.from({ length: 9 }, (_, i) => ({ artist: `Peer ${i}`, track: `Peer Track ${i}`, year: 2020, lane: 'afropop', lang: i < 5 ? 'French' : 'English', why: 'warm afro grooves' }));
  async function likeOnly(lang?: string) {
    const { fetchImpl } = musicNet({ like });
    const plan = planMusic(frenchOff, { hasQuery: true, seed: 1, total: 9, text: 'artists like synth afro star', now: NOW, entity: { name: 'Synth Afro Star', want: 'like', ...(lang ? { lang } : {}) } })!;
    return curateMusic(plan, { ai: aiConfig(env)!, http: createHttp(new MemoryCache(), fetchImpl), env, profile: frenchOff, searchBlocked: true, now: NOW, intent: { rawText: 'artists like synth afro star' } as never });
  }
  it('a curator ignoring the off-language rule for most picks does not wave them through', async () => {
    const r = await likeOnly();
    expect(r.items.map((i) => i.title)).toEqual(['Peer Track 5', 'Peer Track 6', 'Peer Track 7', 'Peer Track 8']);
    expect(r.detail).toMatch(/regional language 5/);
  });
  it('an artist the interpreter says sings in French: French peers are theirs to show', async () => {
    const r = await likeOnly('French');
    expect(r.items).toHaveLength(9);
  });
});

describe('lyrics languages stored with songs keep the stored fallback honest', () => {
  const lane = (id: string): MusicLane => ({ ...(LANE_BY_ID[id] as unknown as MusicLane), id, label: LANE_BY_ID[id].label, share: 1, descriptors: [], era: { from: 2010, to: 2026 }, energy: NaN, danceability: NaN, valence: NaN, popularity: { p25: NaN, p50: NaN, p75: NaN }, regional: LANE_BY_ID[id].regional, genres: [], source: 'library' });
  const song = (n: number, meta: Record<string, unknown>, genres: string[] = ['drill'], year = 2019): ContentItem => ({
    id: `spotify:track:${tid(n)}`, category: 'music', kind: 'track', provider: 'spotify', externalId: tid(n), title: `Stored ${n}`, creators: [`Artist ${n}`], genres, tags: [],
    externalUrl: 'https://open.spotify.com/track/x', embed: { type: 'spotify', uri: `spotify:track:${tid(n)}`, kind: 'track' }, releaseDate: `${year}-01-01`, metadata: { fallbackTier: 1, aiPick: true, ...meta },
  });

  it('a French song labelled "drill" never fills a hip-hop lane when French is switched off', () => {
    const plan = { ...planMusic(frenchOff, { hasQuery: false, seed: 1, total: 6, now: NOW })!, mode: 'lanes' as const, lanes: [lane('hiphop-rnb')], order: ['hiphop-rnb'], targets: { 'hiphop-rnb': 3 } };
    const out = laneFallback([song(1, { lane: { id: 'request', label: 'For your request' }, lyricsLang: 'French' }), song(2, { lane: { id: 'request', label: 'For your request' }, lyricsLang: 'English' })], plan, { profile: frenchOff, now: NOW });
    expect(out.map((s) => s.title)).toEqual(['Stored 2']);
    // A request's stored songs follow it too.
    const req = planMusic(frenchOff, { hasQuery: true, seed: 1, total: 6, text: 'rap', now: NOW })!;
    expect(laneLooseMusic([song(3, { lyricsLang: 'French' }), song(4, { lyricsLang: 'English' })], req, { profile: frenchOff, now: NOW, order: 2000 }).map((s) => s.title)).toEqual(['Stored 4']);
  });

  it('the curator\'s lyrics language is stored with the song (not a per-user field)', async () => {
    const { fetchImpl } = musicNet({ request: [{ artist: 'Runner', track: 'Run', year: 2020, lane: 'hip hop', lang: 'English' }], understand: { categories: ['music'], concepts: { energetic: 0.8 } } });
    const res = await runPipeline(chatRequest({ message: 'hip hop for running' }), { env, http: createHttp(new MemoryCache(), fetchImpl), profile: emptyProfile(), blockedProviders: new Set(['spotify']), seed: 1, now: NOW });
    expect(withoutPerUser(res.recommendations[0].item.metadata)).toMatchObject({ lyricsLang: 'English' });
  });
});

describe('the shared catalog row keeps its lane', () => {
  it('an answer with no lane for a song (an entity lane) or only a request lane never wipes the lane another answer gave it', () => {
    const stored = { lane: { id: 'hiphop-rnb', label: 'Hip-hop & R&B' }, aiPick: true, lyricsLang: 'English' };
    expect(mergeCatalogMetadata(stored, { lane: { id: 'entity-by', label: 'Nova Lyric' }, aiPick: true, inLibrary: true, entity: { name: 'Nova Lyric', role: 'by' } }))
      .toEqual({ lane: { id: 'hiphop-rnb', label: 'Hip-hop & R&B' }, aiPick: true, lyricsLang: 'English' });
    expect(mergeCatalogMetadata(stored, { lane: { id: 'request', label: 'For your request' } }).lane).toEqual({ id: 'hiphop-rnb', label: 'Hip-hop & R&B' });
    expect(mergeCatalogMetadata(stored, { lane: { id: 'afro-latin', label: 'Afro, Latin & Caribbean' } }).lane).toEqual({ id: 'afro-latin', label: 'Afro, Latin & Caribbean' });
    expect(mergeCatalogMetadata({ lane: { id: 'request', label: 'For your request' } }, { lane: { id: 'entity-like', label: 'Artists like X' } }).lane).toEqual({ id: 'request', label: 'For your request' });
    expect(mergeCatalogMetadata(null, { lane: { id: 'entity-by', label: 'X' }, fallbackTier: 3 })).toEqual({});
  });
});

describe('a song shown again says so', () => {
  it('tier-3 songs explain they were shown in the last few days', () => {
    const item = { id: 'spotify:track:x', category: 'music', kind: 'track', provider: 'spotify', externalId: 'x', title: 'Again', creators: ['A'], genres: [], tags: [], externalUrl: '', releaseDate: '2020-01-01', concepts: {}, metadata: { lane: { id: 'hiphop-rnb', label: 'Hip-hop & R&B' }, fallbackTier: 3 } } as AnalyzedItem;
    expect(laneExplanation(item, NOW).map((r) => r.detail).slice(0, 2)).toEqual(['Shown again: ECHO showed you this song in the last few days', 'From your Hip-hop & R&B lane']);
    expect(laneExplanation({ ...item, metadata: { ...item.metadata, fallbackTier: 1 } }, NOW)[0].detail).toBe('From your Hip-hop & R&B lane');
  });
});

describe('a named artist\'s own lane never brings back a held-back library song', () => {
  it('a library song skipped or disliked lately stays out; one only in the library comes back flagged', async () => {
    const by: Song[] = [
      { artist: 'Nova Lyric', track: 'Fresh One', year: 2010 },
      { artist: 'Nova Lyric', track: 'Owned Song', year: 2008 },
      { artist: 'Nova Lyric', track: 'Skipped Owned', year: 2009 },
    ];
    const libraryIds = [`spotify:track:${tid(1)}`, `spotify:track:${tid(2)}`];
    const library = { isrcs: new Set<string>(), songs: new Set(['novalyric|ownedsong', 'novalyric|skippedowned']), ids: new Set(libraryIds) };
    const { fetchImpl } = musicNet({ by, understand: { categories: ['music'], entities: [{ name: 'Nova Lyric', kind: 'artist', want: 'by' }] } });
    const res = await runPipeline(chatRequest({ message: 'songs by nova lyric' }), {
      env, http: createHttp(new MemoryCache(), fetchImpl), profile: emptyProfile(), library, excludeIds: new Set(libraryIds),
      // Skipped (or disliked) lately: held back for a reason other than the library.
      shownIds: new Set([libraryIds[1]]), blockedProviders: new Set(['spotify']), seed: 1, now: NOW,
    });
    const lane = res.recommendations.filter((r) => (r.item.metadata?.lane as { id?: string } | undefined)?.id === 'entity-by');
    expect(lane.map((r) => [r.item.title, r.item.metadata?.inLibrary])).toEqual([['Fresh One', false], ['Owned Song', true]]);
  });
});

describe('resolutions running in parallel share one stop; an artist\'s own lane stops at its songs', () => {
  const fakeNet = (searchStatus = 429) => {
    const log: string[] = [];
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      log.push(url);
      if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      if (url === LB_SPOTIFY_MAPPING_URL) {
        const rows = JSON.parse(String(init?.body)) as Array<{ track_name: string }>;
        return new Response(JSON.stringify(rows.map((r) => ({ ...r, spotify_track_ids: r.track_name.startsWith('Mapped') ? [`TRK${r.track_name.slice(-1).padStart(19, '0')}`] : [] }))));
      }
      const m = /\/v1\/tracks\/(TRK\d+)/.exec(url);
      if (m) return new Response(JSON.stringify({ id: m[1], name: `Mapped ${Number(m[1].slice(3))}`, artists: [{ id: 'a', name: 'Nova Lyric' }], album: { id: 'al', name: 'A', images: [], release_date: '2010-01-01', album_type: 'album' }, duration_ms: 1, external_urls: { spotify: 'x' }, is_playable: true }));
      if (url.includes('/v1/search')) return new Response('{}', { status: searchStatus, headers: { 'Retry-After': '600' } });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, log };
  };
  const envS = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b' } as Record<string, string>)[n];

  it('after one resolution\'s search 429, the other makes no search call at all', async () => {
    const { fetchImpl, log } = fakeNet();
    const http = createHttp(new MemoryCache(), fetchImpl);
    const stop = { search: false, lookups: false };
    const unmapped = (n: number, lane: string): SpotifyPick => ({ artist: 'Nova Lyric', track: `Unmapped ${n}`, laneId: lane });
    const first = await resolveSpotifyPicks([unmapped(1, 'a'), unmapped(2, 'a')], { http, env: envS }, { allowSearch: true, maxSearches: 4, stop });
    expect(first.rateLimitedSec).toBe(600);
    expect(stop.search).toBe(true);
    const before = log.filter((u) => u.includes('/v1/search')).length;
    await resolveSpotifyPicks([unmapped(3, 'b'), unmapped(4, 'b')], { http, env: envS }, { allowSearch: true, maxSearches: 4, stop });
    expect(before).toBe(1);
    expect(log.filter((u) => u.includes('/v1/search'))).toHaveLength(1);
  });

  it('a lane with `need` stops resolving once it has its songs; songs the user owns don\'t count toward it', async () => {
    const { fetchImpl, log } = fakeNet(200);
    const picks: SpotifyPick[] = [1, 2, 3, 4, 5, 6].map((n) => ({ artist: 'Nova Lyric', track: `Mapped ${n}`, laneId: 'entity-by' }));
    const owned = new Set(['Mapped 1', 'Mapped 2']);
    const res = await resolveSpotifyPicks([...picks, { artist: 'Nova Lyric', track: 'Unmapped 9', laneId: 'entity-by' }], { http: createHttp(new MemoryCache(), fetchImpl), env: envS }, {
      allowSearch: true, maxSearches: 4, concurrency: 1, need: { 'entity-by': 2 }, counts: (item) => !owned.has(item.title),
    });
    expect(res.items.map((r) => r.item.title)).toEqual(['Mapped 1', 'Mapped 2', 'Mapped 3', 'Mapped 4']);
    expect(log.filter((u) => u.includes('/v1/tracks/'))).toHaveLength(4);
    // The lane is full: no search for the unmapped pick.
    expect(log.filter((u) => u.includes('/v1/search'))).toHaveLength(0);
  });
});
