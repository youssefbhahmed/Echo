import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapOpenLibraryDoc } from '@shared/providers/openlibrary.ts';
import { mapTvShow } from '@shared/providers/tvmaze.ts';
import { mapYouTubeVideo, parseIsoDuration } from '@shared/providers/youtube.ts';
import { mapSpotify } from '@shared/providers/spotify.ts';
import { mapTmdb } from '@shared/providers/tmdb.ts';
import { createHttp, MemoryCache, ProviderError } from '@shared/providers/http.ts';
import { providersFor } from '@shared/providers/index.ts';
import { analyzeItem } from '@shared/engine/analyze.ts';

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));

describe('provider normalisation (recorded real responses)', () => {
  it('Open Library → books with subjects and covers', () => {
    const items = fx('openlibrary.json').docs.map(mapOpenLibraryDoc);
    expect(items[0]).toMatchObject({ category: 'books', kind: 'book', provider: 'openlibrary' });
    expect(items[0].id).toMatch(/^openlibrary:book:OL\d+W$/);
    expect(items[0].externalUrl).toMatch(/^https:\/\/openlibrary\.org\/works\//);
    expect(items[0].tags.length).toBeGreaterThan(3);
    expect(analyzeItem(items[0]).concepts.existential).toBeGreaterThan(0.5);
  });
  it('TVmaze → series with ratings, html stripped', () => {
    const s = mapTvShow(fx('tvmaze.json')[0].show);
    expect(s).toMatchObject({ kind: 'series', title: 'Dark', language: 'de', rating: 0.82 });
    expect(s.description).not.toMatch(/<p>/);
  });
  it('YouTube → embeddable video with duration; respects embedding restrictions', () => {
    const base = { id: 'abc123', snippet: { title: 'Origins of Civilization &amp; Writing', description: 'A documentary about Sumer', channelTitle: 'History Ch', publishedAt: '2024-01-01T00:00:00Z', categoryId: '27', thumbnails: { high: { url: 'https://i.ytimg.com/x.jpg' } } }, contentDetails: { duration: 'PT1H2M3S' }, statistics: { viewCount: '1000000' }, status: { embeddable: true } };
    const v = mapYouTubeVideo(base);
    expect(v).toMatchObject({ title: 'Origins of Civilization & Writing', durationSec: 3723, genres: ['Education'], embed: { type: 'youtube', videoId: 'abc123' } });
    const blocked = mapYouTubeVideo({ ...base, status: { embeddable: false } });
    expect(blocked.embed).toBeNull();
    expect(blocked.playbackNote).toMatch(/disabled/);
    expect(parseIsoDuration('PT4M')).toBe(240);
  });
  it('Spotify → official embed URIs', () => {
    const t = mapSpotify('track', { id: 't1', name: 'Song', artists: [{ id: 'a', name: 'Artist' }], album: { id: 'al', name: 'Album', images: [{ url: 'https://i.scdn.co/x' }] }, duration_ms: 200000, external_urls: { spotify: 'https://open.spotify.com/track/t1' } })!;
    expect(t.embed).toEqual({ type: 'spotify', uri: 'spotify:track:t1', kind: 'track' });
    expect(mapSpotify('playlist', null)).toBeNull();
    const show = mapSpotify('show', { id: 's1', name: 'Philosophize This!', description: '<p>Stoicism, existentialism and ethics</p>', images: [{ url: 'https://i.scdn.co/s' }], external_urls: { spotify: 'https://open.spotify.com/show/s1' } })!;
    expect(show).toMatchObject({ category: 'podcasts', kind: 'podcast', embed: { type: 'spotify', uri: 'spotify:show:s1', kind: 'show' } });
    expect(show.description).not.toMatch(/<p>/);
  });
  it('TMDB → films with genre names and ratings only when enough votes', () => {
    const m = mapTmdb({ id: 157336, title: 'Interstellar', overview: 'explorers travel through a wormhole in space', genre_ids: [12, 18, 878], vote_average: 8.4, vote_count: 30000, poster_path: '/p.jpg', original_language: 'en' }, 'movie')!;
    expect(m).toMatchObject({ id: 'tmdb:movie:157336', genres: ['Adventure', 'Drama', 'Science Fiction'] });
    expect(m.rating).toBeCloseTo(0.84);
    expect(mapTmdb({ id: 1, title: 'x', vote_average: 9, vote_count: 3 }, 'movie')!.rating).toBeUndefined();
  });
});

describe('http layer', () => {
  it('caches responses and classifies quota errors', async () => {
    let calls = 0;
    const fake = (async (url: string) => {
      calls++;
      if (String(url).includes('quota')) return new Response('{"error":{"errors":[{"reason":"quotaExceeded"}]}}', { status: 403 });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const http = createHttp(new MemoryCache(), fake);
    await http.json('https://x.test/a', { cacheKey: 'a', ttl: 60 });
    await http.json('https://x.test/a', { cacheKey: 'a', ttl: 60 });
    expect(calls).toBe(1);
    expect(http.cacheHits).toBe(1);
    await expect(http.json('https://x.test/quota')).rejects.toMatchObject({ kind: 'quota' });
    await expect(http.json('https://x.test/quota')).rejects.toBeInstanceOf(ProviderError);
  });
  it('selects keyless fallbacks when keys are missing', () => {
    const none = () => undefined;
    expect(providersFor('music', none)).toEqual([]);
    expect(providersFor('podcasts', none)).toEqual([]);
    expect(providersFor('screen', none).map((p) => p.id)).toEqual(['tvmaze']);
    expect(providersFor('youtube', none)).toEqual([]);
    const all = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b', TMDB_API_KEY: 'c', YOUTUBE_API_KEY: 'd' } as Record<string, string>)[n];
    expect(providersFor('music', all).map((p) => p.id)).toEqual(['spotify']);
    expect(providersFor('podcasts', all).map((p) => p.id)).toEqual(['spotify']);
    expect(providersFor('screen', all).map((p) => p.id)).toEqual(['tmdb']);
  });
});
