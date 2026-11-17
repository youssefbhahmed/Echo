// Named entities, the edge cases: song/album titles, names the model expanded or only echoed, the rules
// fallback's guesses (never a refinement word), stored intents, names that are works, the items around an
// entity (budget order, quota fallbacks, stored lookups by name), tags surviving general search, an
// author's own works, an artist asked about in other media, replies, and quota stops within a request.
// Synthetic names and catalogs; all network mocked.
import { runPipeline } from '@shared/engine/pipeline.ts';
import { applyUnderstanding, nameInText, sanitizeStoredIntent, sanitizeUnderstanding } from '@shared/engine/understand.ts';
import { parseIntent, refineIntent } from '@shared/engine/intent.ts';
import { entityExtras, extrasCap, mentions } from '@shared/engine/entities.ts';
import { chatRequest } from '@shared/engine/chat.ts';
import { emptyProfile } from '@shared/engine/profile.ts';
import { createHttp, MemoryCache } from '@shared/providers/http.ts';
import { LB_SPOTIFY_MAPPING_URL } from '@shared/providers/listenbrainz.ts';
import type { ContentItem, Entity, Intent } from '@shared/types.ts';

const NOW = new Date('2026-11-16T00:00:00Z');

type Route = (url: string, init?: RequestInit) => Response | undefined;
const json = (x: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(x), { status, headers });
function net(routes: Route[]) {
  const log: string[] = [];
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    const url = String(u);
    log.push(url);
    for (const r of routes) {
      const res = r(url, init);
      if (res) return res;
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, log };
}
/** The AI endpoint: `answer` gets the system and user prompts and returns the JSON content (or a Response). */
const aiRoute = (answer: (system: string, user: string) => unknown): Route => (url, init) => {
  if (!url.includes('/chat/completions')) return undefined;
  const body = JSON.parse(String(init?.body));
  const out = answer(body.messages[0].content as string, body.messages[1].content as string);
  return out instanceof Response ? out : json({ choices: [{ message: { content: JSON.stringify(out) } }] });
};
const spotifyToken: Route = (url) => (url.includes('accounts.spotify.com') ? json({ access_token: 't', expires_in: 3600 }) : undefined);
const makeEnv = (vars: Record<string, string>) => (n: string) => vars[n];
const AI = { AI_BASE_URL: 'https://ai.test/v1', AI_MODEL: 'm' };
const SPOTIFY = { SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b' };

describe('understanding: song and album titles, fuller names, echoed names', () => {
  it('a song or album the interpreter names is a reference for the curator, never an (artist) entity', () => {
    const u = sanitizeUnderstanding({ categories: ['music'], entities: [{ name: 'Velvet Harbour', kind: 'song', want: 'like' }] }, 'songs like velvet harbour');
    expect(u.entities).toEqual([]);
    expect(u.musicWorks).toEqual(['Velvet Harbour']);
    expect(u.references).toEqual(['Velvet Harbour']);
    const i = applyUnderstanding(parseIntent('songs like velvet harbour'), u, null);
    expect(i.entities).toBeUndefined();
    expect(i.intent).toBe('similar');
    expect(i.references).toEqual(['Velvet Harbour']);
    // A bare title the model reads as an album: the rules' guess that it is a name doesn't come back either.
    const bare = applyUnderstanding(parseIntent('velvet harbour'), sanitizeUnderstanding({ entities: [{ name: 'Velvet Harbour', kind: 'album', want: 'all' }] }, 'velvet harbour'), null);
    expect(bare.entities).toBeUndefined();
  });

  it('a fuller form of what the user typed is the name they meant; an unrelated name is still never accepted', () => {
    expect(nameInText('Kendrick Lamar', 'kendrick')).toBe(true);
    expect(nameInText('The Beatles', 'beatles')).toBe(true);
    expect(nameInText('Tupac Shakur', 'songs like tupac')).toBe(true);
    expect(nameInText('Kanye West', 'west coast rap')).toBe(false);
    expect(nameInText('Drake', 'songs like eminem')).toBe(false);
    const u = sanitizeUnderstanding({ entities: [{ name: 'The Beatles', kind: 'band', want: 'all' }] }, 'beatles');
    const i = applyUnderstanding(parseIntent('beatles'), u, null);
    expect(i.entities?.[0]).toMatchObject({ name: 'The Beatles', kind: 'artist' });
    expect(i.vague).toBe(false);
  });

  it('the rules\' guess stands when the model only echoed it as a reference; not when the model read the message otherwise', () => {
    const echoed = applyUnderstanding(parseIntent('zorblax'), sanitizeUnderstanding({ references: ['Zorblax'] }, 'zorblax'), null);
    expect(echoed.entities).toEqual([{ name: 'Zorblax', kind: 'other', want: 'all', source: 'rules' }]);
    const otherwise = applyUnderstanding(parseIntent('zorblax'), sanitizeUnderstanding({ concepts: { calm: 0.8 } }, 'zorblax'), null);
    expect(otherwise.entities).toBeUndefined();
  });

  it('keeps the interpreter\'s language for an artist (their scene, for "artists like them")', () => {
    const u = sanitizeUnderstanding({ entities: [{ name: 'Rappeur Nova', kind: 'artist', want: 'like', lang: 'French' }, { name: 'Some Film', kind: 'film', lang: 'French' }] }, 'rappeur nova, some film');
    expect(u.entities[0].lang).toBe('French');
    expect(u.entities[1].lang).toBeUndefined();
  });
});

describe('rules fallback (AI unavailable): refinements are never names', () => {
  it('comparatives, descriptors, uses, genres, languages and French refinements', () => {
    for (const q of ['darker', 'happier', 'faster', 'slower', 'newer', 'calmer', 'sadder', 'older stuff', 'darker please', 'acoustic', 'instrumental', 'underground',
      'deeper cuts', 'live versions', 'English only', 'not this', 'perfect', 'Plus calme', 'quelque chose de triste', 'focus', 'reggaeton', 'k-pop', 'afrobeats', 'salut ça va', 'en anglais']) {
      expect(parseIntent(q).entities, q).toBeUndefined();
    }
    // Names still are, including ones made of common words.
    for (const q of ['eminem', 'kendrick lamar', 'Deep Purple', 'Usher', 'Massive Attack', 'The Weeknd']) expect(parseIntent(q).entities?.[0].name, q).toBe(q);
    expect(parseIntent('reggaeton').genres).toEqual(['reggaeton']);
  });

  it('a follow-up refinement refines the previous request; a single unknown word after a name is another name', () => {
    const sad = parseIntent('sad songs');
    const darker = refineIntent(sad, parseIntent('darker'));
    expect(darker.categories).toEqual(['music']);
    expect(darker.target.melancholic).toBeGreaterThan(0);
    expect(darker.entities).toBeUndefined();
    expect(darker.keywords).toContain('darker');
    // An unknown single word after a described request merges like a refinement (its word a keyword)…
    const word = refineIntent(sad, parseIntent('zorblax'));
    expect(word.categories).toEqual(['music']);
    expect(word.entities).toBeUndefined();
    expect(word.keywords).toContain('zorblax');
    // …after a name, it is a new name; two words or more always are.
    expect(refineIntent(parseIntent('eminem'), parseIntent('zorblax')).entities?.[0].name).toBe('zorblax');
    expect(refineIntent(sad, parseIntent('nova lyric')).entities?.[0].name).toBe('nova lyric');
  });
});

describe('a stored previous intent is re-checked when loaded (the row is user-writable)', () => {
  it('at most 3 entities and references, enum kinds, known concepts, bounded text', () => {
    const raw = {
      ...parseIntent('only music'),
      entities: [...Array.from({ length: 2000 }, (_, i) => ({ name: `x${i}`, kind: 'other', want: 'all', works: Array.from({ length: 9 }, (_, j) => ({ title: `w${j}`, kind: 'film' })) })), { name: 'bad', kind: 'wizard', want: 'nope' }],
      references: Array.from({ length: 50 }, (_, i) => `ref ${i}`),
      keywords: Array.from({ length: 40 }, (_, i) => `k${i}`),
      target: { calm: 0.9, bogus: 5, melancholic: Number.POSITIVE_INFINITY, uplifting: 7 },
      categories: ['music', 'nope'],
      rawText: 'x'.repeat(5000),
      statements: [{ polarity: 1, subject: 'something', concepts: [] }],
      intent: 'hack',
      source: 'evil',
    };
    const s = sanitizeStoredIntent(raw)!;
    expect(s.entities).toHaveLength(3);
    expect(s.entities![0].works).toHaveLength(4);
    expect(s.references).toHaveLength(3);
    expect(s.keywords).toHaveLength(8);
    expect(s.target).toEqual({ calm: 0.9, uplifting: 1.5 });
    expect(s.categories).toEqual(['music']);
    expect(s.rawText).toHaveLength(1000);
    expect(s.statements).toEqual([]);
    expect(s.intent).toBe('discover');
    expect(s.source).toBe('rules');
    expect(sanitizeStoredIntent('nope')).toBeNull();
    expect(sanitizeStoredIntent([1, 2])).toBeNull();
    const kinds = sanitizeStoredIntent({ entities: [{ name: 'A', kind: 'wizard', want: 'nope' }] })!.entities!;
    expect(kinds[0]).toMatchObject({ kind: 'other', want: 'all' });
  });

  it('a tampered conversation makes at most one rate-limited Spotify search in a request, and the block is recorded', async () => {
    const prev = { ...parseIntent('calm music'), references: Array.from({ length: 50 }, (_, i) => `Title ${i}`) } as Intent;
    const { fetchImpl, log } = net([
      spotifyToken,
      (url) => (url.includes('/v1/search') ? json({ error: { status: 429 } }, 429, { 'Retry-After': '70000' }) : undefined),
      (url) => (url.includes('tvmaze') ? new Response('null', { status: 404 }) : undefined),
      (url) => (url.includes('openlibrary.org') ? json({ docs: [] }) : undefined),
    ]);
    const res = await runPipeline(chatRequest({ message: 'only music' }), {
      env: makeEnv(SPOTIFY), http: createHttp(new MemoryCache(), fetchImpl), profile: emptyProfile(), previousIntent: sanitizeStoredIntent(prev), useLlm: false, now: NOW,
    });
    expect(log.filter((u) => u.includes('/v1/search'))).toHaveLength(1);
    expect(res.quotaErrors).toContain('spotify');
    expect(res.quotaRetryAfter.spotify).toBe(70000);
    expect(log.filter((u) => u.includes('openlibrary.org')).length).toBeLessThanOrEqual(3);
  });
});

describe('a guessed name that is a work is answered as the work (AI unavailable)', () => {
  it('"inception": the film itself and things like it, the usual searches, never "songs by inception"', async () => {
    const prompts: string[] = [];
    const { fetchImpl, log } = net([
      aiRoute((system) => {
        prompts.push(system);
        return json({ error: 'unavailable' }, 503);
      }),
      (url) => (url.includes('/search/multi') && /query=inception(&|$)/i.test(url) ? json({ results: [{ id: 9, media_type: 'movie', title: 'Inception', release_date: '2010-07-15', overview: 'A thief who steals secrets through dreams.' }] }) : undefined),
      (url) => (url.includes('/movie/9/keywords') ? json({ keywords: [{ name: 'dream' }] }) : undefined),
      (url) => (url.includes('/movie/9/recommendations') ? json({ results: [{ id: 10, title: 'Dream Heist', release_date: '2012-01-01' }] }) : undefined),
      (url) => (url.includes('themoviedb.org') ? json({ results: [] }) : undefined),
      (url) => (url.includes('openlibrary.org') ? json({ docs: [] }) : undefined),
      spotifyToken,
    ]);
    const res = await runPipeline(chatRequest({ message: 'inception' }), {
      env: makeEnv({ ...AI, ...SPOTIFY, TMDB_READ_TOKEN: 'x' }), http: createHttp(new MemoryCache(), fetchImpl), profile: emptyProfile(), blockedProviders: new Set(['spotify']), now: NOW,
    });
    expect(res.intent.entities?.[0]).toMatchObject({ name: 'inception', kind: 'film' });
    expect(prompts.some((p) => /officially released songs by|DIFFERENT artists closely related/.test(p))).toBe(false);
    expect(res.pipeline.find((p) => p.step === 'retrieval')?.detail).toMatch(/^[1-9]\d* queries/);
    expect(log.filter((u) => u.includes('/v1/search'))).toEqual([]);
    const film = res.recommendations.find((r) => r.item.title === 'Inception');
    expect(film?.item.metadata?.entity).toMatchObject({ role: 'by' });
    expect(res.reply).toMatch(/^Here's inception: the film itself/);
  });
});

describe('the items around an entity', () => {
  it('an author\'s own books and the books like them come before their film adaptations (budget order)', async () => {
    const log: string[] = [];
    const fetchImpl = (async (u: string) => {
      const url = String(u);
      log.push(url);
      const q = url.includes('openlibrary.org') ? new URL(url).searchParams : null;
      if (q?.get('author') === 'Ann Writer') return json({ docs: [{ key: '/works/OL1W', title: 'First Novel', author_name: ['Ann Writer'], subject: ['Desert planets'] }, { key: '/works/OL2W', title: 'Second Novel', author_name: ['Ann Writer'] }] });
      if (q?.get('q') === 'subject:"Desert planets"') return json({ docs: [{ key: '/works/OL9W', title: 'Sand Saga', author_name: ['Other Author'] }] });
      if (url.includes('/search/multi')) return json({ results: [{ id: 5, media_type: 'movie', title: url.includes('Hotel') ? 'Shining Hotel' : 'Clown Town', release_date: '1990-01-01' }] });
      if (url.includes('/keywords')) return json({ keywords: [] });
      if (url.includes('youtube/v3/search')) return json({ items: [{ id: { videoId: 'V1V1V1V1V1V' } }] });
      if (url.includes('youtube/v3/videos')) return json({ items: [{ id: 'V1V1V1V1V1V', snippet: { title: 'Ann Writer: the interview', description: '', channelTitle: 'Books Talk', publishedAt: '2020-01-01T00:00:00Z' }, contentDetails: { duration: 'PT20M' }, statistics: { viewCount: '9000' }, status: { embeddable: true, privacyStatus: 'public' } }] });
      return json({ docs: [], results: [] });
    }) as unknown as typeof fetch;
    const e: Entity = { name: 'Ann Writer', kind: 'author', want: 'all', works: [{ title: 'Shining Hotel', kind: 'film', note: 'the film of her novel' }, { title: 'Clown Town', kind: 'film', note: 'a series of her book' }] };
    const r = await entityExtras(e, { env: makeEnv({ TMDB_READ_TOKEN: 'x', YOUTUBE_API_KEY: 'k' }), http: createHttp(new MemoryCache(), fetchImpl), categories: ['books', 'screen', 'youtube'], cap: 8 });
    const roles = r.items.map((i) => [i.title, (i.metadata?.entity as { role: string }).role]);
    expect(roles).toEqual(expect.arrayContaining([['First Novel', 'by'], ['Second Novel', 'by'], ['Sand Saga', 'like'], ['Ann Writer: the interview', 'about']]));
    expect(log.some((u) => u.includes('author=Ann+Writer'))).toBe(true);
    expect(r.calls).toBeLessThanOrEqual(5);
    // What is left of the budget goes to one adaptation (a TMDB lookup costs 2), never the second.
    expect(log.filter((u) => u.includes('/search/multi'))).toHaveLength(1);
  });

  it('YouTube out of quota mid-request: the stored videos naming them instead, looked up by name, and the quota reported', async () => {
    const fetchImpl = (async (u: string) => {
      const url = String(u);
      if (url.includes('youtube/v3/search')) return json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403);
      return json({ docs: [] });
    }) as unknown as typeof fetch;
    const quota: string[] = [];
    const asked: string[] = [];
    const storedVideo: ContentItem = { id: 'youtube:video:AAAAAAAAAAA', category: 'youtube', kind: 'video', provider: 'youtube', externalId: 'AAAAAAAAAAA', title: 'Nova Lyric breaks down his first album', creators: ['Music Channel'], genres: [], tags: [], externalUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', embed: { type: 'youtube', videoId: 'AAAAAAAAAAA' } };
    const blocked = new Set<'youtube'>();
    const r = await entityExtras({ name: 'Nova Lyric', kind: 'artist', want: 'about' }, {
      env: makeEnv({ YOUTUBE_API_KEY: 'k' }), http: createHttp(new MemoryCache(), fetchImpl), categories: ['youtube'], blocked, cap: 8,
      storedNamed: async (_p, _c, name) => (asked.push(name), [storedVideo]), onQuota: (p) => quota.push(p),
    });
    expect(r.items.map((i) => i.title)).toEqual(['Nova Lyric breaks down his first album']);
    expect(asked).toEqual(['Nova Lyric']);
    expect(quota).toEqual(['youtube']);
    expect(blocked.has('youtube')).toBe(true);
  });

  it('names match as whole words: no "Nas" in NASA, no "Future" in prose; two-letter names count', () => {
    const v = (title: string, description = '') => ({ title, creators: ['Some Channel'], tags: [], description });
    expect(mentions(v('NASA Artemis launch'), 'Nas')).toBe(false);
    expect(mentions(v('The Ming Dynasty'), 'Nas')).toBe(false);
    expect(mentions(v('Urban asphalt'), 'Nas')).toBe(false);
    expect(mentions(v('Nas: the interview'), 'Nas')).toBe(true);
    expect(mentions(v('How AI will change everything', 'the future of artificial intelligence'), 'Future')).toBe(false);
    expect(mentions(v('Future on his new album'), 'Future')).toBe(true);
    expect(mentions(v('U2 live at Red Rocks documentary'), 'U2')).toBe(true);
    expect(mentions(v('MØ documentary'), 'MØ')).toBe(true);
    expect(mentions(v('Jay-Z interview'), 'Jay-Z')).toBe(true);
    expect(mentions(v('A long talk', 'with Nova Lyric about his first album'), 'Nova Lyric')).toBe(true);
  });

  it('a request for a maker\'s own works is answered by those works (up to the request limit, less a few)', () => {
    expect(extrasCap({ name: 'Ann Writer', kind: 'author', want: 'by' }, ['books'], 20)).toBe(16);
    expect(extrasCap({ name: 'Ann Writer', kind: 'author', want: 'all' }, ['books'], 20)).toBe(8);
    expect(extrasCap({ name: 'Nova Lyric', kind: 'artist', want: 'all' }, ['music', 'books'], 20)).toBe(6);
  });
});

describe('"books by ann writer" in chat', () => {
  const works = Array.from({ length: 14 }, (_, i) => ({ key: `/works/OL${100 + i}W`, title: `Ann Book ${i + 1}`, author_name: ['Ann Writer'], first_publish_year: 1980 + i }));
  const others = Array.from({ length: 10 }, (_, i) => ({ key: `/works/OL${300 + i}W`, title: `Horror Book ${i + 1}`, author_name: [`Other ${i}`], first_publish_year: 1990 + i, subject: ['Horror'] }));
  async function run(understanding: unknown) {
    const { fetchImpl } = net([
      aiRoute((system) => (system.includes('request interpreter') ? understanding : { items: [] })),
      (url) => {
        if (!url.includes('openlibrary.org')) return undefined;
        const q = new URL(url).searchParams;
        // The author search and the general search for her name return the SAME works (same ids).
        if (q.get('author') === 'Ann Writer' || q.get('q') === 'Ann Writer') return json({ docs: works });
        return json({ docs: others });
      },
    ]);
    return runPipeline(chatRequest({ message: 'books by ann writer' }), { env: makeEnv(AI), http: createHttp(new MemoryCache(), fetchImpl), profile: emptyProfile(), now: NOW });
  }

  it('her books, tagged as hers although the general search found them too, and the reply says so', async () => {
    const res = await run({ categories: ['books'], search: { books: 'Ann Writer' }, concepts: { horror: 0.7 }, entities: [{ name: 'Ann Writer', kind: 'author', want: 'by' }] });
    const hers = res.recommendations.filter((r) => r.item.creators.includes('Ann Writer'));
    expect(hers.length).toBeGreaterThanOrEqual(12);
    expect(hers.every((r) => (r.item.metadata?.entity as { role?: string } | undefined)?.role === 'by')).toBe(true);
    expect(hers[0].explanation.text).toMatch(/^By Ann Writer/);
    expect(res.reply).toMatch(/^Here's Ann Writer: \d+ works by Ann Writer/);
    expect(res.reply).not.toMatch(/couldn't find/);
  });
});

describe('an artist asked about in other media', () => {
  it('"nova lyric documentary": the documentaries a search for them finds, not just the few items around them', async () => {
    const docs = Array.from({ length: 6 }, (_, i) => ({ id: 400 + i, media_type: 'movie', title: `Nova Lyric: Portrait ${i + 1}`, release_date: `201${i}-01-01`, genre_ids: [99] }));
    const searched: string[] = [];
    const { fetchImpl } = net([
      aiRoute((system) => (system.includes('request interpreter')
        ? { categories: ['screen', 'youtube'], search: { screen: 'Nova Lyric documentary', youtube: 'Nova Lyric documentary' }, entities: [{ name: 'Nova Lyric', kind: 'artist', want: 'about' }] }
        : { items: [] })),
      (url) => {
        if (!url.includes('themoviedb.org')) return undefined;
        if (url.includes('/search/multi')) searched.push(new URL(url).searchParams.get('query') ?? '');
        return url.includes('/search/multi') && url.includes('documentary') ? json({ results: docs }) : json({ results: [] });
      },
    ]);
    const res = await runPipeline(chatRequest({ message: 'nova lyric documentary' }), {
      env: makeEnv({ ...AI, ...SPOTIFY, TMDB_READ_TOKEN: 'x' }), http: createHttp(new MemoryCache(), fetchImpl), profile: emptyProfile(), blockedProviders: new Set(['spotify', 'youtube']), now: NOW,
    });
    expect(searched).toContain('Nova Lyric documentary');
    expect(res.recommendations.filter((r) => r.item.title.startsWith('Nova Lyric: Portrait')).length).toBeGreaterThanOrEqual(4);
  });

  it('a follow-up "only books" after "nova lyric": a book search for them', async () => {
    const prev = applyUnderstanding(parseIntent('nova lyric'), sanitizeUnderstanding({ entities: [{ name: 'Nova Lyric', kind: 'artist', want: 'all' }] }, 'nova lyric'), null);
    const queries: string[] = [];
    const books = Array.from({ length: 6 }, (_, i) => ({ key: `/works/OL${500 + i}W`, title: `Nova Lyric Book ${i + 1}`, author_name: ['A Biographer'], first_publish_year: 2010 + i }));
    const { fetchImpl } = net([
      aiRoute((system) => (system.includes('request interpreter') ? { categories: ['books'], followUp: true } : { items: [] })),
      (url) => {
        if (!url.includes('openlibrary.org')) return undefined;
        queries.push(new URL(url).searchParams.get('q') ?? '');
        return json({ docs: new URL(url).searchParams.get('q') === 'Nova Lyric' ? books : [] });
      },
    ]);
    const res = await runPipeline(chatRequest({ message: 'only books' }), { env: makeEnv(AI), http: createHttp(new MemoryCache(), fetchImpl), profile: emptyProfile(), previousIntent: prev, now: NOW });
    expect(queries).toContain('Nova Lyric');
    expect(res.recommendations.filter((r) => r.item.category === 'books').length).toBeGreaterThanOrEqual(4);
  });
});

describe('replies when the named thing itself is not found', () => {
  it('a film no catalog has (no TMDB): the picks found are described, never "couldn\'t find" alone above them', async () => {
    const { fetchImpl } = net([
      aiRoute((system) => (system.includes('request interpreter') ? { categories: ['screen', 'books'], search: { books: 'desert planet saga' }, entities: [{ name: 'Dune Saga', kind: 'film', want: 'all' }] } : { items: [] })),
      (url) => (url.includes('openlibrary.org') ? json({ docs: [{ key: '/works/OL7W', title: 'Desert Planet Chronicles', author_name: ['Some Author'], first_publish_year: 1970 }, { key: '/works/OL8W', title: 'Sand Empire', author_name: ['Other Author'], first_publish_year: 1980 }] }) : undefined),
      (url) => (url.includes('tvmaze') ? json([]) : undefined),
    ]);
    const res = await runPipeline(chatRequest({ message: 'dune saga' }), { env: makeEnv(AI), http: createHttp(new MemoryCache(), fetchImpl), profile: emptyProfile(), now: NOW });
    expect(res.recommendations.length).toBeGreaterThan(0);
    expect(res.reply).toMatch(/^I read this as|^Here (are|is)/);
    expect(res.reply).toMatch(/I couldn't find Dune Saga itself in the connected catalogs right now, so these are the closest picks I found\./);
  });
});

describe('quota within one request', () => {
  it('an entity lookup out of quota is recorded as a block and that provider is not called again in the request', async () => {
    const { fetchImpl, log } = net([
      aiRoute((system) => (system.includes('request interpreter')
        ? { categories: ['screen'], entities: [{ name: 'Film One', kind: 'film', want: 'all' }, { name: 'Film Two', kind: 'film', want: 'all' }] }
        : { items: [] })),
      (url) => (url.includes('themoviedb.org') ? json({ status_message: 'rate limit' }, 429, { 'Retry-After': '30' }) : undefined),
      (url) => (url.includes('tvmaze') ? json([]) : undefined),
    ]);
    const res = await runPipeline(chatRequest({ message: 'film one and film two' }), {
      env: makeEnv({ ...AI, TMDB_READ_TOKEN: 'x' }), http: createHttp(new MemoryCache(), fetchImpl), profile: emptyProfile(), now: NOW,
    });
    expect(res.quotaErrors).toContain('tmdb');
    expect(res.quotaRetryAfter.tmdb).toBe(30);
    expect(log.filter((u) => u.includes('themoviedb.org'))).toHaveLength(1);
  });
});

describe('a named artist\'s own lane when the curator comes back short', () => {
  it('ListenBrainz down: stored songs crediting them fill their lane (never anyone else\'s)', async () => {
    const stored = (n: number, artist: string, title: string): ContentItem => ({
      id: `spotify:track:ST${String(n).padStart(20, '0')}`, category: 'music', kind: 'track', provider: 'spotify', externalId: `ST${n}`, title, creators: [artist], genres: [], tags: [],
      externalUrl: 'https://open.spotify.com/track/x', embed: { type: 'spotify', uri: `spotify:track:ST${n}`, kind: 'track' }, releaseDate: '2005-01-01', metadata: { lane: { id: 'hiphop-rnb', label: 'Hip-hop & R&B' } },
    });
    const byName: string[] = [];
    const { fetchImpl } = net([
      spotifyToken,
      aiRoute((system) => {
        if (system.includes('request interpreter')) return { categories: ['music'], entities: [{ name: 'Nova Lyric', kind: 'artist', want: 'by' }] };
        return { items: [{ artist: 'Nova Lyric', track: 'Unmapped One', feat: [], lane: 'hip hop', lang: 'English' }] };
      }),
      (url) => (url === LB_SPOTIFY_MAPPING_URL ? new Response('unavailable', { status: 503 }) : undefined),
    ]);
    const res = await runPipeline(chatRequest({ message: 'songs by nova lyric' }), {
      env: makeEnv({ ...AI, ...SPOTIFY }), http: createHttp(new MemoryCache(), fetchImpl), profile: emptyProfile(), blockedProviders: new Set(['spotify']), now: NOW,
      catalogByName: async (provider, _cats, name) => {
        byName.push(`${provider}:${name}`);
        return [stored(1, 'Nova Lyric', 'Stored Hit'), stored(2, 'Someone Else', 'Not Theirs'), stored(3, 'Nova Lyric', 'Stored Hit - Live'), stored(4, 'Nova Lyric', 'Second Stored')];
      },
    });
    expect(byName).toEqual(['spotify:Nova Lyric']);
    const lane = res.recommendations.filter((r) => (r.item.metadata?.lane as { id?: string } | undefined)?.id === 'entity-by');
    expect(lane.map((r) => r.item.title)).toEqual(['Stored Hit', 'Second Stored']);
    expect(res.reply).toMatch(/^Here's Nova Lyric: 2 songs by Nova Lyric/);
  });
});
