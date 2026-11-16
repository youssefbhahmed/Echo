import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPipeline } from '@shared/engine/pipeline.ts';
import { createHttp, MemoryCache } from '@shared/providers/http.ts';
import { emptyProfile, applyFeedback } from '@shared/engine/profile.ts';
import { sanitizeHint } from '@shared/engine/ai.ts';

const fx = (n: string) => readFileSync(join(__dirname, '..', 'providers', 'fixtures', n), 'utf8');

function fakeFetch(log: string[]) {
  return (async (input: string) => {
    const url = String(input);
    log.push(url);
    if (url.includes('openlibrary.org')) return new Response(fx('openlibrary.json'));
    if (url.includes('tvmaze.com/singlesearch')) return new Response(JSON.stringify(JSON.parse(fx('tvmaze.json'))[0].show));
    if (url.includes('tvmaze.com')) return new Response(fx('tvmaze.json'));
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('runPipeline (keyless providers, mocked network)', () => {
  it('keeps the Videos shelf alive from the stored catalog when YouTube is out of quota', async () => {
    const { make } = await import('./fixtures');
    const stored = [
      make({ title: 'Deep Ocean Life', category: 'youtube', creators: ['BBC Earth'], description: 'Nature documentary about the deep ocean' }),
      make({ title: 'History of Rome', category: 'youtube', creators: ['Kings and Generals'], description: 'Documentary about the Roman empire' }),
    ].map((i) => ({ ...i, embed: { type: 'youtube' as const, videoId: 'abcdefghijk' } }));
    const env = (k: string) => (k === 'YOUTUBE_API_KEY' ? 'test' : undefined);
    const res = await runPipeline({ categories: ['youtube'], limit: 4 }, {
      env, http: createHttp(new MemoryCache(), fakeFetch([])), profile: emptyProfile(),
      blockedProviders: new Set(['youtube']), catalogFallback: async () => stored,
    });
    expect(res.recommendations.map((r) => r.item.title).sort()).toEqual(['Deep Ocean Life', 'History of Rome']);
    expect(res.pipeline.some((p) => p.step === 'fallback')).toBe(true);
  });

  it('runs all steps for a conversational request and returns grounded, real-catalog items', async () => {
    const log: string[] = [];
    const http = createHttp(new MemoryCache(), fakeFetch(log));
    const res = await runPipeline({ query: 'existential philosophy books and tv series', limit: 6 }, { env: () => undefined, http, profile: emptyProfile() });
    expect(res.pipeline.map((p) => p.step)).toEqual(['intent', 'retrieval', 'analysis', 'ranking']);
    expect(res.recommendations.length).toBeGreaterThan(0);
    expect(new Set(res.recommendations.map((r) => r.item.category))).toEqual(new Set(['books', 'screen']));
    for (const r of res.recommendations) {
      expect(r.item.externalUrl).toMatch(/^https:\/\//);
      expect(r.explanation.text.length).toBeGreaterThan(10);
    }
    expect(res.reply).toMatch(/existential/);
    expect(log.every((u) => !u.includes('googleapis') && !u.includes('spotify'))).toBe(true);
  });

  it('reports Spotify as unconfigured for music instead of using another source', async () => {
    const http = createHttp(new MemoryCache(), fakeFetch([]));
    const res = await runPipeline({ query: 'melancholic piano music', categories: ['music', 'podcasts'] }, { env: () => undefined, http, profile: emptyProfile() });
    expect(res.recommendations).toEqual([]);
    expect(res.providers.find((p) => p.id === 'spotify')?.status).toBe('unconfigured');
  });

  it('feed mode personalises with the profile and caches provider calls', async () => {
    const log: string[] = [];
    const http = createHttp(new MemoryCache(), fakeFetch(log));
    const first = await runPipeline({ categories: ['books'], limit: 3 }, { env: () => undefined, http, profile: emptyProfile() });
    const liked = first.recommendations[first.recommendations.length - 1].item;
    const profile = applyFeedback(emptyProfile(), liked, 'like');
    const calls = log.length;
    const second = await runPipeline({ categories: ['books'], limit: 3 }, { env: () => undefined, http, profile, excludeIds: new Set([liked.id]) });
    expect(second.recommendations.map((r) => r.item.id)).not.toContain(liked.id);
    expect(second.intent.intent).toBe('discover');
    expect(log.length - calls).toBeLessThanOrEqual(calls); // cache reuse
  });

  it('asks a clarifying question when the request is vague but still returns picks', async () => {
    const http = createHttp(new MemoryCache(), fakeFetch([]));
    const res = await runPipeline({ query: 'hmm', categories: ['books'], limit: 3 }, { env: () => undefined, http, profile: emptyProfile() });
    expect(res.clarifyingQuestion?.options.length).toBeGreaterThan(1);
    expect(res.recommendations.length).toBeGreaterThan(0);
  });

  it('reports YouTube as unconfigured instead of inventing results', async () => {
    const http = createHttp(new MemoryCache(), fakeFetch([]));
    const res = await runPipeline({ query: 'documentary about ancient egypt', categories: ['youtube'] }, { env: () => undefined, http, profile: emptyProfile() });
    expect(res.recommendations).toEqual([]);
    expect(res.providers.find((p) => p.id === 'youtube')?.status).toBe('unconfigured');
  });
});

describe('sanitizeHint', () => {
  it('drops unknown ids and references not present in the text', () => {
    const h = sanitizeHint({ categories: ['music', 'hacking'], concepts: { existential: 2, bogus: 1 }, references: ['Interstellar', 'Inception'], trajectory: { from: 'melancholic', to: 'uplifting' } }, 'like Interstellar');
    expect(h.categories).toEqual(['music']);
    expect(h.concepts).toEqual({ existential: 1 });
    expect(h.references).toEqual(['Interstellar']);
    expect(h.trajectory).toEqual({ from: 'melancholic', to: 'uplifting' });
  });
});

describe('mergeHint guards against model guesses', () => {
  it('keeps "doesn\'t have to be" relaxed and drops unsupported fields', async () => {
    const { parseIntent } = await import('@shared/engine/intent.ts');
    const { mergeHint } = await import('@shared/engine/ai.ts');
    const base = parseIntent("Something with the same existential feeling as Interstellar, but it doesn't have to be science fiction");
    const merged = mergeHint(base, sanitizeHint({ concepts: { awe: 0.9 }, excludes: ['sci-fi'], trajectory: { from: 'awe', to: 'contemplative' }, duration: 'long', language: 'en', exploration: 0.5 }, base.rawText), 'rules+llm');
    expect(merged.target['sci-fi']).toBeUndefined();
    expect(merged.excludes).not.toContain('sci-fi');
    expect(merged.trajectory).toBeUndefined();
    expect(merged.duration).toBeUndefined();
    expect(merged.language).toBeUndefined();
    expect(merged.exploration).toBeUndefined();
    expect(merged.target.awe).toBeGreaterThan(0);
  });
});

describe('AI music picks', () => {
  it('stops calling Spotify on a long rate-limit penalty, reports Retry-After and falls back to stored songs', async () => {
    const searches: string[] = [];
    const fake = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      if (url.includes('/chat/completions')) {
        const body = JSON.parse(String(init?.body));
        const items = Array.from({ length: 16 }, (_, i) => ({ artist: `Artist ${i}`, track: `Song ${i}` }));
        return new Response(JSON.stringify({ choices: [{ message: { content: /curator/.test(body.messages[0].content) ? JSON.stringify({ items }) : '{}' } }] }));
      }
      if (url.includes('/v1/search')) {
        searches.push(url);
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '68195' } });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const { make } = await import('./fixtures');
    // Stored songs must fit a lane and pass the era rules to be used as fallback.
    const asStored = (i: ReturnType<typeof make>) => ({ ...i, provider: 'spotify' as const, embed: { type: 'spotify' as const, uri: `spotify:track:${i.id}`, kind: 'track' as const } });
    const stored = [
      make({ title: 'Stored Song', category: 'music', creators: ['Someone'], genres: ['indie rock'], releaseDate: '2019-03-01' }),
      make({ title: 'Old Stored Song', category: 'music', creators: ['Old Timer'], genres: ['indie rock'], releaseDate: '1976-01-01' }),
      make({ title: 'Untyped Stored Song', category: 'music', creators: ['Nobody'], genres: [], releaseDate: '2020-01-01' }),
    ].map(asStored);
    const env = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b', AI_BASE_URL: 'https://ai.test/v1', AI_MODEL: 'm' } as Record<string, string>)[n];
    const res = await runPipeline({ categories: ['music'], limit: 5 }, { env, http: createHttp(new MemoryCache(), fake), profile: emptyProfile(), catalogFallback: async () => stored });
    // Search stops at the first 429 (no retries that lengthen Spotify's penalty).
    expect(searches.length).toBe(1);
    expect(res.quotaErrors).toContain('spotify');
    expect(res.quotaRetryAfter.spotify).toBe(68195);
    const titles = res.recommendations.map((r) => r.item.title);
    expect(titles).toContain('Stored Song');
    expect(titles).not.toContain('Old Stored Song'); // fails the era rule
    expect(titles).not.toContain('Untyped Stored Song'); // fits no lane
    expect(res.recommendations[0].item.metadata?.lane).toEqual({ id: 'mix', label: 'Fresh picks' });
  });

  it('only shows LLM music picks that verify on Spotify, and filters stock music', async () => {
    const calls: string[] = [];
    const fake = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      calls.push(url);
      if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      if (url.includes('/chat/completions')) {
        const body = JSON.parse(String(init?.body));
        if (/curator/.test(body.messages[0].content)) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{ artist: 'Bon Iver', track: 'Holocene' }, { artist: 'Imaginary Band', track: 'Fake Song' }] }) } }] }));
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
      }
      if (url.includes('/v1/search')) {
        const q = new URL(url).searchParams.get('q') ?? '';
        const track = (id: string, name: string, artist: string) => ({ id, name, artists: [{ id: 'a', name: artist }], album: { id: 'al', name: 'Album', images: [] }, duration_ms: 200000, external_urls: { spotify: `https://open.spotify.com/track/${id}` } });
        if (q.includes('Holocene')) return new Response(JSON.stringify({ tracks: { items: [track('h1', 'Holocene', 'Bon Iver')] } }));
        if (q.includes('Fake Song')) return new Response(JSON.stringify({ tracks: { items: [track('x', 'Fake Song', 'Someone Else')] } }));
        return new Response(JSON.stringify({ tracks: { items: [track('s1', 'Deep Sleep 432Hz Frequencies', 'Relaxing Sleep Music'), track('s2', 'Melancholy Hill', 'Gorillaz')] }, albums: { items: [] } }));
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const env = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b', AI_BASE_URL: 'https://ai.test/v1', AI_MODEL: 'm' } as Record<string, string>)[n];
    const res = await runPipeline({ categories: ['music'], moods: ['melancholic'], limit: 5 }, { env, http: createHttp(new MemoryCache(), fake), profile: emptyProfile() });
    const titles = res.recommendations.map((r) => r.item.title);
    expect(titles).toContain('Holocene');
    expect(titles).not.toContain('Fake Song');
    // With the curator on, Spotify mood-word searches (stock "sleep" filler) aren't even made.
    expect(titles).not.toContain('Deep Sleep 432Hz Frequencies');
    expect(calls.filter((u) => u.includes('/v1/search') && !/Holocene|Fake|Bon|Imaginary/.test(decodeURIComponent(u)))).toEqual([]);
    const holo = res.recommendations.find((r) => r.item.title === 'Holocene')!;
    expect(holo.explanation.text).toMatch(/AI curator.*verified on Spotify/);
    expect(holo.item.metadata).toMatchObject({ aiPick: true, lane: { id: 'mix' } });
    expect(res.pipeline.find((p) => p.step === 'music-ai')?.detail).toMatch(/1\/2/);
    // No "any song by this artist" fallback: the unverifiable pick costs exactly one exact search.
    expect(calls.filter((u) => u.includes('/v1/search') && /Imaginary/.test(decodeURIComponent(u)))).toHaveLength(1);
  });
});
