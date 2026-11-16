import { runPipeline } from '@shared/engine/pipeline.ts';
import { rankCandidates } from '@shared/engine/rank.ts';
import { parseIntent } from '@shared/engine/intent.ts';
import { applyFeedback, emptyProfile, MUSIC_DISLIKE_ARTIST, MUSIC_SKIP_ARTIST } from '@shared/engine/profile.ts';
import { laneReject } from '@shared/engine/lanes.ts';
import { createHttp, MemoryCache } from '@shared/providers/http.ts';
import { LB_SPOTIFY_MAPPING_URL } from '@shared/providers/listenbrainz.ts';
import type { AnalyzedItem, MusicLane, TasteProfile } from '@shared/types.ts';
import { make } from './fixtures';

const laneSong = (title: string, artist: string, lane: { id: string; label: string }, aiOrder: number, extra: Partial<AnalyzedItem> = {}) =>
  make({ title, category: 'music', provider: 'spotify', creators: [artist], genres: ['indie'], releaseDate: '2020-01-01', metadata: { lane, aiPick: true, aiOrder, laneEra: { from: 2010, to: 2025 } }, ...extra });

const HIP = { id: 'hiphop-rnb', label: 'Hip-hop & R&B' };
const HOUSE = { id: 'melodic-house', label: 'Afro & melodic house' };
const ROCK = { id: 'rock-metal', label: 'Rock & metal' };

describe('feed assembly with music lanes', () => {
  it('keeps each lane contiguous in curator order, one song per artist, lane sizes from the plan', () => {
    // Curator output interleaves lanes and repeats an artist across lanes.
    const songs = [
      laneSong('H1', 'Artist A', HIP, 0), laneSong('M1', 'Artist B', HOUSE, 1), laneSong('H2', 'Artist C', HIP, 2), laneSong('R1', 'Artist D', ROCK, 3),
      laneSong('M2', 'Artist A', HOUSE, 4), laneSong('H3', 'Artist E', HIP, 5), laneSong('M3', 'Artist F', HOUSE, 6), laneSong('R2', 'Artist G', ROCK, 7),
      laneSong('M4', 'Artist H', HOUSE, 8), laneSong('R3', 'Artist I', ROCK, 9), laneSong('H4', 'Artist J', HIP, 10), laneSong('R4', 'Artist K', ROCK, 11),
      // A song in a lane outside this refresh's plan never sneaks in.
      laneSong('X1', 'Artist L', { id: 'edm', label: 'EDM & tropical house' }, 12),
    ];
    const others = [
      make({ title: 'Book One', category: 'books', creators: ['W1'], description: 'a story about memory and loss' }),
      make({ title: 'Film One', category: 'screen', creators: ['D1'], description: 'a tense mystery thriller' }),
      make({ title: 'Book Two', category: 'books', creators: ['W2'], description: 'philosophy of mind' }),
      // A non-lane song by an artist already in a lane: the per-artist cap removes it.
      make({ title: 'Search Song', category: 'music', provider: 'spotify', creators: ['Artist C'], genres: ['pop'] }),
    ];
    const plan = { order: ['melodic-house', 'hiphop-rnb', 'rock-metal'], targets: { 'melodic-house': 3, 'hiphop-rnb': 4, 'rock-metal': 3 } };
    const recs = rankCandidates([...others, ...songs].reverse(), parseIntent(''), emptyProfile(), { exploration: 0.4, hasQuery: false, limit: 14, musicLanes: plan });
    const music = recs.map((r, i) => ({ r, i })).filter(({ r }) => r.item.category === 'music');
    // Contiguous block…
    expect(music[music.length - 1].i - music[0].i).toBe(music.length - 1);
    // …lane by lane in plan order, each in the curator's order, at most the planned sizes. Artist A
    // appears in two lanes: the earlier shelf keeps it, so the hip-hop lane has one song fewer.
    expect(music.map(({ r }) => r.item.title)).toEqual(['M1', 'M2', 'M3', 'H2', 'H3', 'H4', 'R1', 'R2', 'R3']);
    const artists = music.map(({ r }) => r.item.creators[0]);
    expect(new Set(artists).size).toBe(artists.length);
    expect(recs.map((r) => r.item.title)).not.toContain('Search Song');
    expect(recs.map((r) => r.item.title)).not.toContain('X1');
    // Grounded explanation: lane + a checkable era reason.
    expect(music[0].r.explanation.text).toBe('From your Afro & melodic house lane. Released 2020, inside the 2010–2025 span of your saves in this lane.');
  });

  it('skips lane songs under a hard penalty (blocked style family)', () => {
    const p: TasteProfile = { ...emptyProfile(), explicit: { ...emptyProfile().explicit, blockedFamilies: ['rock'] } };
    const songs = [laneSong('R1', 'A', ROCK, 0, { genres: ['hard rock'] }), laneSong('R2', 'B', ROCK, 1, { genres: ['indie'] })];
    const recs = rankCandidates(songs, parseIntent(''), p, { exploration: 0.4, hasQuery: false, limit: 5, musicLanes: { order: ['rock-metal'], targets: { 'rock-metal': 3 } } });
    expect(recs.map((r) => r.item.title)).toEqual(['R2']);
  });
});

describe('lane feed end to end (mocked AI, ListenBrainz and Spotify; search blocked)', () => {
  const lane = (id: string, label: string, share: number, regional: boolean, from: number, genres: string[]): MusicLane => ({
    id, label, share, descriptors: [...genres, 'bittersweet but danceable', 'mid-energy'], era: { from, to: 2025 }, energy: 0.6, danceability: 0.7, valence: 0.4, popularity: { p25: 35, p50: 50, p75: 65 }, regional, genres, source: 'library',
  });
  const profile: TasteProfile = {
    ...emptyProfile(),
    creators: { 'library artist': 1.4, 'skipped twice': -0.66 },
    music: {
      tracks: 100, distinctArtists: 80, styles: ['rap'], recentStyles: [], decades: ['2010s'], languages: ['English'], mood: { valence: 0.4, energy: 0.6, danceability: 0.7, topQuadrant: 'bittersweet & mellow' }, importedAt: '2026-11-01T00:00:00Z',
      policy: { regionalShare: 0.12, regionalMinYear: 2015, familiarity: 'library' },
      lanes: [lane('hiphop-rnb', 'Hip-hop & R&B', 0.5, false, 2008, ['rap', 'hip-hop']), lane('melodic-house', 'Afro & melodic house', 0.38, false, 2012, ['afro house']), lane('french', 'French pop & rap', 0.12, true, 2015, ['pop urbaine'])],
    },
  };
  const picks = [
    { artist: 'Hip One', track: 'Song H1', lane: 'hiphop-rnb', year: 2016 },
    { artist: 'Skipped Twice', track: 'Song H2', lane: 'hiphop-rnb', year: 2018 },
    { artist: 'Hip Three', track: 'Song H3', lane: 'hiphop-rnb', year: 2019 },
    { artist: 'Hip Four', track: 'Song H4', lane: 'hiphop-rnb', year: 2021 },
    { artist: 'House One', track: 'Song M1', lane: 'melodic-house', year: 2020 },
    { artist: 'House Two', track: 'Song M2', lane: 'melodic-house', year: 2022 },
    { artist: 'House Three', track: 'Song M3', lane: 'melodic-house', year: 2023 },
    { artist: 'Chanson Old', track: 'Song F1', lane: 'french', year: 1972 },
    { artist: 'French One', track: 'Song F2', lane: 'french', year: 2019 },
    { artist: 'French Two', track: 'Song F3', lane: 'french', year: 2021 },
    { artist: 'French Three', track: 'Song F4', lane: 'french', year: 2023 },
  ];
  const tid = (i: number) => `LANE${String(i).padStart(18, '0')}`;

  it('serves resolved picks grouped by lane, filtering era and disliked artists, without touching search', async () => {
    const log: string[] = [];
    let prompt = '';
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      log.push(url);
      if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      if (url.includes('/chat/completions')) {
        const body = JSON.parse(String(init?.body));
        prompt = body.messages.map((m: { content: string }) => m.content).join('\n');
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: picks.map(({ artist, track, lane }) => ({ artist, track, lane })) }) } }] }));
      }
      if (url === LB_SPOTIFY_MAPPING_URL) {
        const rows = JSON.parse(String(init?.body)) as Array<{ artist_name: string; track_name: string }>;
        return new Response(JSON.stringify(rows.map((r) => ({ ...r, spotify_track_ids: [tid(picks.findIndex((p) => p.track === r.track_name))] }))));
      }
      const m = /\/v1\/tracks\/(LANE\d+)/.exec(url);
      if (m) {
        const p = picks[Number(m[1].slice(4))];
        return new Response(JSON.stringify({ id: m[1], name: p.track, artists: [{ id: 'a', name: p.artist }], album: { id: 'al', name: 'Album', images: [], release_date: `${p.year}-06-01` }, duration_ms: 200000, external_urls: { spotify: `https://open.spotify.com/track/${m[1]}` }, is_playable: true }));
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const env = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b', AI_BASE_URL: 'https://ai.test/v1', AI_MODEL: 'm' } as Record<string, string>)[n];
    const res = await runPipeline({ categories: ['music'], limit: 9 }, { env, http: createHttp(new MemoryCache(), fetchImpl), profile, blockedProviders: new Set(['spotify']), seed: 1 });

    expect(log.some((u) => u.includes('/v1/search'))).toBe(false);
    // The brief names lanes and rules, never the library's artists.
    expect(prompt).toMatch(/lane "french" \(French pop & rap\)/);
    expect(prompt).not.toMatch(/library artist|skipped twice/i);

    const titles = res.recommendations.map((r) => r.item.title);
    expect(titles).not.toContain('Song F1'); // regional lane: 1972 fails the 2015+ rule
    expect(titles).not.toContain('Song H2'); // artist skipped twice (≤ -0.5) is filtered
    const lanes = res.recommendations.map((r) => (r.item.metadata?.lane as { id: string }).id);
    // Contiguous lanes in plan order (strongest share first), 3 songs each, curator order inside.
    expect(lanes).toEqual(['hiphop-rnb', 'hiphop-rnb', 'hiphop-rnb', 'melodic-house', 'melodic-house', 'melodic-house', 'french', 'french', 'french']);
    expect(titles).toEqual(['Song H1', 'Song H3', 'Song H4', 'Song M1', 'Song M2', 'Song M3', 'Song F2', 'Song F3', 'Song F4']);
    for (const r of res.recommendations) {
      expect(r.item.metadata).toMatchObject({ aiPick: true, lane: { label: expect.any(String) } });
      expect(r.item.releaseDate).toMatch(/^20\d\d-06-01$/);
      expect(r.explanation.text).toMatch(/^From your .+ lane\. /);
    }
    expect(res.pipeline.find((p) => p.step === 'music-ai')?.detail).toMatch(/search 0 blocked/);
  });
  it("drops songs whose own style doesn't fit their lane, and moves a song filed under the wrong lane", async () => {
    // The curator's own style label per song: H3 is really house (moves), M2 is plain dance-pop (dropped).
    // M3 is labelled French rap: a regional song never stays in another lane, even when "rap" would fit it.
    const genre: Record<string, string> = { 'Song H1': 'hip-hop', 'Song H3': 'deep house', 'Song H4': 'neo-soul', 'Song M1': 'afro house', 'Song M2': 'dance pop', 'Song M3': 'French rap', 'Song F2': 'pop urbaine', 'Song F3': 'French rap', 'Song F4': 'chanson' };
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      if (url.includes('/chat/completions')) {
        // H4 is sung in French: it can only be a French-lane song, whatever its style label says.
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: picks.map(({ artist, track, lane }) => ({ artist, track, lane, ...(genre[track] ? { genre: genre[track] } : {}), lang: track === 'Song H4' ? 'French' : 'English' })) }) } }] }));
      }
      if (url === LB_SPOTIFY_MAPPING_URL) {
        const rows = JSON.parse(String(init?.body)) as Array<{ artist_name: string; track_name: string }>;
        return new Response(JSON.stringify(rows.map((r) => ({ ...r, spotify_track_ids: [tid(picks.findIndex((p) => p.track === r.track_name))] }))));
      }
      const m = /\/v1\/tracks\/(LANE\d+)/.exec(url);
      if (m) {
        const p = picks[Number(m[1].slice(4))];
        return new Response(JSON.stringify({ id: m[1], name: p.track, artists: [{ id: 'a', name: p.artist }], album: { id: 'al', name: 'Album', images: [], release_date: `${p.year}-06-01` }, duration_ms: 200000, external_urls: { spotify: `https://open.spotify.com/track/${m[1]}` }, is_playable: true }));
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const env = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b', AI_BASE_URL: 'https://ai.test/v1', AI_MODEL: 'm' } as Record<string, string>)[n];
    const res = await runPipeline({ categories: ['music'], limit: 9 }, { env, http: createHttp(new MemoryCache(), fetchImpl), profile, blockedProviders: new Set(['spotify']), seed: 1 });
    const byLane = (id: string) => res.recommendations.filter((r) => (r.item.metadata?.lane as { id: string }).id === id).map((r) => r.item.title);
    expect(res.recommendations.map((r) => r.item.title)).not.toContain('Song M2');
    expect(byLane('melodic-house')).toContain('Song H3');
    expect(byLane('hiphop-rnb')).toEqual(['Song H1']);
    expect(byLane('french')).toContain('Song H4');
    expect(byLane('melodic-house')).not.toContain('Song M3');
    expect(res.pipeline.find((p) => p.step === 'music-ai')?.detail).toMatch(/off-lane style 1/);
  });
});

describe('music outside the curator still follows the lane contract and rules', () => {
  const spotifyTrack = (id: string, name: string, artist: string, date: string) => ({
    id: id.padEnd(22, '0'), name, artists: [{ id: 'a', name: artist }], album: { id: 'al', name: 'Album', images: [], release_date: date }, duration_ms: 200000, external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  });
  const searchOnly = (tracks: unknown[], log: string[] = []) => (async (u: string) => {
    const url = String(u);
    log.push(url);
    if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    if (url.includes('/v1/search')) return new Response(JSON.stringify({ tracks: { items: tracks }, albums: { items: [] } }));
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const spotifyEnv = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b' } as Record<string, string>)[n];

  it('a typed request: searched songs get the request lane and pass the regional/era, library and taste rules', async () => {
    const profile: TasteProfile = { ...emptyProfile(), creators: { 'disliked rapper': -1.2 } };
    const tracks = [
      spotifyTrack('NEW', 'Modern Track', 'New Rapper', '2021-03-01'),
      spotifyTrack('OLD', 'Classic Track', 'Old Master', '1978-01-01'),
      spotifyTrack('PRE', 'Early Track', 'Early Rapper', '2012-01-01'), // fine for a 2005+ request, not for a Moroccan one
      spotifyTrack('BAD', 'Another Track', 'Disliked Rapper', '2022-01-01'),
      spotifyTrack('LIB', 'Liked Track - Single', 'Fan Favourite', '2023-01-01'),
    ];
    const stored = [
      make({ title: 'Stored New', category: 'music', provider: 'spotify', creators: ['Stored Artist'], genres: ['rap marocain'], releaseDate: '2020-01-01', metadata: { lane: { id: 'arabic-pop', label: 'Arabic rap & pop' }, aiPick: true, aiOrder: 4, laneEra: { from: 2019, to: 2025 }, lastShownAt: '2026-10-01' } }),
      make({ title: 'Stored Old', category: 'music', provider: 'spotify', creators: ['Stored Old Artist'], genres: ['chaabi'], releaseDate: '1980-01-01', metadata: { lane: { id: 'maghreb-fusion', label: 'Maghreb fusion' } } }),
    ].map((i) => ({ ...i, embed: { type: 'spotify' as const, uri: `spotify:track:${i.id}`, kind: 'track' as const } }));
    const library = { isrcs: new Set<string>(), songs: new Set(['fanfavourite|likedtrack']) };
    const res = await runPipeline({ query: 'moroccan rap', categories: ['music'], limit: 8 }, {
      env: spotifyEnv, http: createHttp(new MemoryCache(), searchOnly(tracks)), profile, library, catalogFallback: async () => stored, now: new Date('2026-11-16T00:00:00Z'),
    });
    const titles = res.recommendations.map((r) => r.item.title);
    expect(titles).toContain('Modern Track');
    expect(titles).toContain('Stored New');
    for (const t of ['Classic Track', 'Early Track', 'Another Track', 'Liked Track - Single', 'Stored Old']) expect(titles).not.toContain(t);
    for (const r of res.recommendations) expect(r.item.metadata?.lane).toEqual({ id: 'request', label: 'For your request' });
    // Fresh search results first, stored songs after them, as one contiguous block.
    expect(titles.indexOf('Modern Track')).toBeLessThan(titles.indexOf('Stored New'));
    const stor = res.recommendations.find((r) => r.item.title === 'Stored New')!.item.metadata!;
    expect(stor).toMatchObject({ aiPick: false, fallback: true });
    expect(stor.lastShownAt).toBeUndefined();
    expect(stor.laneEra).toBeUndefined();
  });

  it('an open feed without the AI curator: searched songs form a "Fresh picks" lane after the taste lanes', async () => {
    const lane: MusicLane = { id: 'hiphop-rnb', label: 'Hip-hop & R&B', share: 1, descriptors: ['rap'], era: { from: 2010, to: 2025 }, energy: 0.6, danceability: 0.7, valence: 0.4, popularity: { p25: 30, p50: 50, p75: 70 }, regional: false, genres: ['rap'], source: 'library' };
    const profile: TasteProfile = { ...emptyProfile(), music: { tracks: 10, distinctArtists: 10, styles: ['rap'], recentStyles: [], decades: ['2010s'], languages: [], mood: { valence: 0.4, energy: 0.6, danceability: 0.7, topQuadrant: '' }, importedAt: '', lanes: [lane] } };
    const tracks = [spotifyTrack('S1', 'Search One', 'Artist One', '2019-01-01'), spotifyTrack('S2', 'Search Two', 'Artist Two', '2020-01-01'), spotifyTrack('S3', 'Search Old', 'Artist Three', '1991-01-01')];
    const res = await runPipeline({ categories: ['music'], moods: ['melancholic'], limit: 6 }, { env: spotifyEnv, http: createHttp(new MemoryCache(), searchOnly(tracks)), profile, seed: 1, now: new Date('2026-11-16T00:00:00Z') });
    const titles = res.recommendations.map((r) => r.item.title);
    expect(titles).toEqual(expect.arrayContaining(['Search One', 'Search Two']));
    expect(titles).not.toContain('Search Old');
    for (const r of res.recommendations) expect(r.item.metadata).toMatchObject({ lane: { id: 'mix', label: 'Fresh picks' }, aiPick: false });
  });

  it('a 429 on track lookups is reported apart from search, so it never shortens the search block', async () => {
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      if (url.includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{ artist: 'A', track: 'One' }, { artist: 'B', track: 'Two' }] }) } }] }));
      if (url === LB_SPOTIFY_MAPPING_URL) return new Response(JSON.stringify((JSON.parse(String(init?.body)) as unknown[]).map((_, i) => ({ spotify_track_ids: [`LOOK${String(i).padStart(18, '0')}`] }))));
      if (url.includes('/v1/tracks/')) return new Response('slow down', { status: 429, headers: { 'retry-after': '120' } });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const env = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b', AI_BASE_URL: 'https://ai.test/v1', AI_MODEL: 'm' } as Record<string, string>)[n];
    const res = await runPipeline({ categories: ['music'], limit: 6 }, { env, http: createHttp(new MemoryCache(), fetchImpl), profile: emptyProfile(), blockedProviders: new Set(['spotify']), seed: 1 });
    expect(res.spotifyLookupLimitedSec).toBe(120);
    expect(res.quotaErrors).not.toContain('spotify');
    expect(res.quotaRetryAfter.spotify).toBeUndefined();
  });
});

describe('learning from music feedback', () => {
  const song = make({ title: 'Song', category: 'music', provider: 'spotify', creators: ['Some Artist'], genres: ['afro house'], metadata: { lane: HOUSE } });
  it('skip = -0.35 on the artist and a small negative on its genres', () => {
    const p = applyFeedback(emptyProfile(), song, 'skip');
    expect(p.creators['some artist']).toBeCloseTo(MUSIC_SKIP_ARTIST, 5);
    expect(p.genres['afro house']).toBeLessThan(0);
    expect(p.genres['afro house']).toBeGreaterThan(-0.1);
    expect(p.laneFeedback?.['melodic-house']).toBeLessThan(0);
    // One skip doesn't ban the artist; a second one does.
    const ctx = { profile: p };
    const resolved = { ...song, releaseDate: '2020-01-01' };
    expect(laneReject(resolved, { regional: false }, ctx)).toBeNull();
    expect(laneReject(resolved, { regional: false }, { profile: applyFeedback(p, song, 'skip') })).toBe('disliked');
  });
  it('dislike = artist strongly negative (≤ -1.2) and genres negative, even for a library favourite', () => {
    const fav = { ...emptyProfile(), creators: { 'some artist': 2 }, interactionCount: 500 };
    const p = applyFeedback(fav, song, 'dislike');
    expect(p.creators['some artist']).toBeLessThanOrEqual(MUSIC_DISLIKE_ARTIST);
    expect(p.genres['afro house']).toBeLessThanOrEqual(-0.25);
    expect(laneReject({ ...song, releaseDate: '2020-01-01' }, { regional: false }, { profile: p })).toBe('disliked');
  });
  it('like and play-to-end are positive', () => {
    const liked = applyFeedback(emptyProfile(), song, 'like');
    expect(liked.creators['some artist']).toBeGreaterThan(0);
    expect(liked.laneFeedback?.['melodic-house']).toBeGreaterThan(0);
    const finished = applyFeedback(emptyProfile(), song, 'consumed');
    expect(finished.creators['some artist']).toBeGreaterThan(0);
  });
});
