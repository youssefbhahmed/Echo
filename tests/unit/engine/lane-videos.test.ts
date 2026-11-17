// Mixing live sessions into music lanes: positions and caps in the lane block (Everything 1, Music page 2,
// a short lane up to 3), explanations, the entity reply, and the whole pipeline with a cached pool (no
// YouTube call, no search.list, never in the Videos shelf). Synthetic songs, artists and titles only.
import { describe, expect, it, vi } from 'vitest';
import { parseIntent } from '@shared/engine/intent.ts';
import { emptyProfile } from '@shared/engine/profile.ts';
import { assembleLaneBlock, interleaveVideos, rankCandidates, videoExplanation } from '@shared/engine/rank.ts';
import { entityReply } from '@shared/engine/entities.ts';
import { laneVideoItem, parseSessionTitle } from '@shared/engine/sessions.ts';
import { isLaneVideo, librarySongIndex } from '@shared/engine/lanes.ts';
import { analyzeItem } from '@shared/engine/analyze.ts';
import { laneVideosPerLane, POOL_WAIT_MS, runPipeline } from '@shared/engine/pipeline.ts';
import { createHttp, MemoryCache } from '@shared/providers/http.ts';
import { sessionPoolKey, type SessionVideo } from '@shared/providers/youtube.ts';
import type { AnalyzedItem, MusicDna, MusicLane, Recommendation, TasteProfile } from '@shared/types.ts';
import { make } from './fixtures';

const HIP = { id: 'hiphop-rnb', label: 'Hip-hop & R&B' };
const NOW = new Date('2026-11-16T12:00:00Z');
const tid = (n: number) => `spotify:track:LV${String(n).padStart(20, '0')}`;

const song = (n: number, o: { artist?: string; lane?: { id: string; label: string } } = {}): AnalyzedItem => make({
  id: tid(n), title: `Lane Song ${n}`, category: 'music', provider: 'spotify', kind: 'track', creators: [o.artist ?? `Song Artist ${n}`], genres: ['rap'], releaseDate: '2020-01-01',
  embed: { type: 'spotify', uri: tid(n), kind: 'track' }, metadata: { lane: o.lane ?? HIP, aiPick: true, aiOrder: n },
});

let vn = 0;
const pv = (channel: string, title: string, over: Partial<SessionVideo> = {}): SessionVideo => {
  vn++;
  return { videoId: `lv${String(vn).padStart(9, '0')}`, channel, title, publishedAt: new Date(Date.UTC(2026, 10, 14) - vn * 3600_000).toISOString(), durationSec: 840, ...over };
};
const vid = (channel: string, title: string, match: string, i: number, lane = HIP): AnalyzedItem => {
  const v = pv(channel, title);
  return analyzeItem(laneVideoItem(v, parseSessionTitle(v.title, v.channel)!, { ...lane, genres: ['rap'] }, { videoMatch: match, aiOrder: 500 + i }));
};
const scoreOf = (item: AnalyzedItem) => ({ item, score: { query: 0, deep: 0, surface: 0, novelty: 0, context: 0, quality: 0, collaborative: 0, semantic: 0, penalty: 0, total: 0.5 } });
const plan = (target: number) => ({ order: [HIP.id], targets: { [HIP.id]: target } });
const kinds = (xs: Array<{ item: AnalyzedItem }>) => xs.map((x) => (isLaneVideo(x.item) ? 'V' : 's')).join('');

describe('lane block with videos', () => {
  const songs = [1, 2, 3, 4, 5, 6].map((n) => song(n));
  const videos = [
    vid('colors', 'Nova Lyric - Night Letter | A COLORS SHOW', 'pick', 0),
    vid('tinydesk', 'Velvet Static: Tiny Desk Concert', 'library', 1),
    vid('colors', 'Amber Coast | A COLORS SHOW', 'pick', 2),
  ];
  const items = [...songs, ...videos].map(scoreOf);

  it('Everything: one video after the 2nd song; Music page: two, after the 2nd and 4th songs', () => {
    expect(kinds(assembleLaneBlock(items, plan(6), 48, { videosPerLane: 1 }))).toBe('ssVssss');
    expect(kinds(assembleLaneBlock(items, plan(6), 24, { videosPerLane: 2 }))).toBe('ssVssVss');
    expect(laneVideosPerLane(['music'], false)).toBe(2);
    expect(laneVideosPerLane(['music', 'books', 'youtube'], false)).toBe(1);
    expect(laneVideosPerLane(['music', 'books'], true)).toBe(2);
  });

  it('a lane short of songs lets videos fill its empty slots, at most 3', () => {
    const short = [song(1), song(2), ...videos].map(scoreOf);
    expect(kinds(assembleLaneBlock(short, plan(6), 24, { videosPerLane: 1 }))).toBe('ssVVV');
    expect(kinds(assembleLaneBlock([song(1), ...videos].map(scoreOf), plan(2), 24, { videosPerLane: 1 }))).toBe('sVV');
  });

  it('without the video option nothing is mixed in; videos never count against the song limit', () => {
    expect(kinds(assembleLaneBlock(items, plan(6), 48))).toBe('ssssss');
    expect(kinds(assembleLaneBlock(items, plan(6), 4, { videosPerLane: 1 }))).toBe('ssVss');
    expect(interleaveVideos(['a', 'b', 'c'], ['X', 'Y'])).toEqual(['a', 'b', 'X', 'c', 'Y']);
    // A second lane the song limit cut off entirely shows no videos on their own.
    const SOUL = { id: 'blues-soul', label: 'Blues, soul & Americana' };
    const soulSongs = [7, 8].map((n) => song(n, { lane: SOUL }));
    const soulVideo = vid('mahogany', 'Willow Lane - Holloway | Mahogany Session', 'pick', 0, SOUL);
    const two = { order: [HIP.id, SOUL.id], targets: { [HIP.id]: 6, [SOUL.id]: 2 } };
    expect(kinds(assembleLaneBlock([...items, ...soulSongs.map(scoreOf), scoreOf(soulVideo)], two, 6, { videosPerLane: 1 }))).toBe('ssVssss');
  });

  it('a video by an artist already playing in the lane comes after the others', () => {
    const withArtist = [song(1, { artist: 'Nova Lyric' }), song(2), song(3), song(4)];
    const block = assembleLaneBlock([...withArtist, ...videos].map(scoreOf), plan(4), 24, { videosPerLane: 1 });
    expect(block.filter((b) => isLaneVideo(b.item)).map((b) => b.item.creators[0])).toEqual(['Velvet Static']);
  });

  it('in a mixed feed the videos ride on top: the other shelves keep all their slots, and never get a video', () => {
    const books = [1, 2, 3, 4, 5, 6].map((n) => make({ title: `Book ${n}`, category: 'books', creators: [`Writer ${n}`], genres: ['Philosophy'] }));
    const base = { exploration: 0.4, hasQuery: false, limit: 10, musicLanes: plan(4) };
    const without = rankCandidates([...songs.slice(0, 4), ...books], parseIntent(''), emptyProfile(), base);
    const withV = rankCandidates([...songs.slice(0, 4), ...videos, ...books], parseIntent(''), emptyProfile(), { ...base, laneVideos: { perLane: 1 } });
    expect(withV.filter((r) => r.item.category === 'books')).toHaveLength(without.filter((r) => r.item.category === 'books').length);
    expect(withV.filter((r) => isLaneVideo(r.item))).toHaveLength(1);
    expect(withV.filter((r) => r.item.category === 'youtube')).toHaveLength(0);
  });
});

describe('why a video is in the lane', () => {
  it('names the session and the lane, the user’s own artist first', () => {
    const lib = vid('colors', 'Velvet Static - Song | A COLORS SHOW', 'library', 0);
    expect(videoExplanation(lib)!.slice(0, 2).map((r) => r.detail)).toEqual(['Velvet Static, whom you listen to, live on COLORS', 'From your Hip-hop & R&B lane']);
    const ch = vid('tinydesk', 'Random Act: Tiny Desk Concert', 'channel', 0);
    expect(videoExplanation(ch)![0].detail).toBe('Live session at Tiny Desk — from your Hip-hop & R&B lane');
    const pick = vid('kexp', 'Loud Band - Full Performance (Live on KEXP)', 'pick', 0, { id: 'rock-metal', label: 'Rock & metal' });
    expect(videoExplanation(pick)![0].detail).toBe('Loud Band live on KEXP — from your Rock & metal lane');
    // The ranker uses it as the card's text.
    const [r] = rankCandidates([lib], parseIntent(''), emptyProfile(), { exploration: 0.4, hasQuery: false, limit: 3, musicLanes: plan(1), laneVideos: { perLane: 1 } });
    expect(r.explanation.text).toBe('Velvet Static, whom you listen to, live on COLORS. From your Hip-hop & R&B lane.');
    expect(videoExplanation(song(1))).toBeNull();
  });

  it('an artist’s own lane counts their sessions apart from their songs', () => {
    const by = { id: 'entity-by', label: 'Nova Lyric' };
    const s = (n: number) => ({ item: song(n, { artist: 'Nova Lyric', lane: by }) });
    const v = { item: { ...vid('tinydesk', 'Nova Lyric: Tiny Desk Concert', 'entity', 0, by), metadata: { ...vid('tinydesk', 'Nova Lyric: Tiny Desk Concert', 'entity', 0, by).metadata, entity: { name: 'Nova Lyric', role: 'by' } } } };
    const reply = entityReply({ name: 'Nova Lyric', kind: 'artist', want: 'by' }, [s(1), s(2), v] as Array<Pick<Recommendation, 'item'>>);
    expect(reply).toBe("Here's Nova Lyric: 2 songs by Nova Lyric (none of them in your library yet) and 1 live session.");
  });
});

describe('pipeline: sessions from the cached pool join the lanes', () => {
  const HIP_LANE: MusicLane = {
    ...HIP, share: 1, descriptors: ['rap'], era: { from: 2010, to: 2026 }, energy: 0.6, danceability: 0.7, valence: 0.4, popularity: { p25: 30, p50: 50, p75: 70 }, regional: false, genres: ['rap'], source: 'library',
  };
  const dna: MusicDna = {
    tracks: 100, distinctArtists: 40, styles: ['rap'], recentStyles: ['rap'], decades: ['2020s'], languages: ['en'], mood: { valence: 0.4, energy: 0.6, danceability: 0.7, topQuadrant: 'x' }, importedAt: NOW.toISOString(),
    lanes: [HIP_LANE],
  };
  const profile: TasteProfile = { ...emptyProfile(), music: dna, creators: { 'velvet static': 1.2, 'amber coast': 0.9 } };
  const library = librarySongIndex([
    { id: 'spotify:track:LIB1', title: 'Saved A', creators: ['Velvet Static'], genres: ['rap'] },
    { id: 'spotify:track:LIB2', title: 'Saved B', creators: ['Amber Coast'], genres: ['trap'] },
  ]);
  const stored = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => song(100 + n));
  const pool: SessionVideo[] = [
    pv('tinydesk', 'Velvet Static: Tiny Desk Concert'),
    pv('colors', 'Amber Coast - Tidal | A COLORS SHOW'),
    pv('colors', 'Stranger Act - Song | A COLORS SHOW'),
  ];

  async function run(categories: Array<'music' | 'books'>, excludeIds = new Set<string>()) {
    const log: string[] = [];
    const cache = new MemoryCache();
    await cache.set(sessionPoolKey(), pool, 86400);
    const http = createHttp(cache, (async (u: string) => (log.push(String(u)), new Response('{}', { status: 404 }))) as unknown as typeof fetch);
    const env = (k: string) => (k === 'YOUTUBE_API_KEY' ? 'test-key' : undefined);
    const res = await runPipeline({ categories, limit: categories.length === 1 ? 12 : 16 }, {
      env, http, profile, library, blockedProviders: new Set(['spotify']), excludeIds, catalogFallback: async (p) => (p === 'spotify' ? stored : []), seed: 1, now: NOW,
    });
    return { res, log };
  }

  it('Music page: the library artists’ sessions sit in their lane after the 2nd and 4th songs; no YouTube call at all', async () => {
    const { res, log } = await run(['music']);
    expect(log.filter((u) => u.includes('googleapis'))).toEqual([]);
    const lane = res.recommendations.filter((r) => r.item.category === 'music');
    expect(kinds(lane)).toBe('ssVssVssss');
    expect(lane.filter((r) => isLaneVideo(r.item)).map((r) => r.item.creators[0]).sort()).toEqual(['Amber Coast', 'Velvet Static']);
    expect(lane.every((r) => (r.item.metadata?.lane as { id: string }).id === HIP.id)).toBe(true);
    expect(res.recommendations.some((r) => r.item.category === 'youtube')).toBe(false);
    expect(res.pipeline.find((p) => p.step === 'music-videos')?.detail).toMatch(/cached.*2 offered to the lanes \(library 2\)/);
  });

  it('Everything: one per lane; a session shown in the last 3 days is not shown again', async () => {
    const { res } = await run(['music', 'books']);
    const vids = res.recommendations.filter((r) => isLaneVideo(r.item));
    expect(vids).toHaveLength(1);
    const again = await run(['music', 'books'], new Set([vids[0].item.id]));
    const next = again.res.recommendations.filter((r) => isLaneVideo(r.item));
    expect(next).toHaveLength(1);
    expect(next[0].item.id).not.toBe(vids[0].item.id);
  });

  it('a pool still being built when the songs are ready doesn’t hold the answer up: the last good copy is used', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const cache = new MemoryCache();
      await cache.set(`${sessionPoolKey()}:stale`, pool, 7 * 86400);
      // YouTube hangs (the day's pool has expired and is being rebuilt).
      const hang = (async (u: string) => (String(u).includes('googleapis') ? new Promise<Response>(() => undefined) : new Response('{}', { status: 404 }))) as unknown as typeof fetch;
      const env = (k: string) => (k === 'YOUTUBE_API_KEY' ? 'test-key' : undefined);
      const p = runPipeline({ categories: ['music'], limit: 12 }, {
        env, http: createHttp(cache, hang), profile, library, blockedProviders: new Set(['spotify']), catalogFallback: async (pr) => (pr === 'spotify' ? stored : []), seed: 1, now: NOW,
      });
      await vi.advanceTimersByTimeAsync(POOL_WAIT_MS + 100);
      const res = await p;
      expect(res.recommendations.filter((r) => isLaneVideo(r.item)).length).toBe(2);
      expect(res.pipeline.find((x) => x.step === 'music-videos')?.detail).toMatch(/last good pool \(the day’s pool is still being built\)/);
    } finally {
      vi.useRealTimers();
    }
  });
});
