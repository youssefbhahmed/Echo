// Entity-aware search: the interpreter's named entities, the rules fallback, resolution by kind, the
// curator's entity sub-modes (an artist's own songs + artists like them), the items around an entity in
// other media, explanations and the reply. Synthetic artist, songs and library; all network mocked.
import { runPipeline, requestLimit } from '@shared/engine/pipeline.ts';
import { applyUnderstanding, nameInText, sanitizeUnderstanding } from '@shared/engine/understand.ts';
import { candidateEntity, parseIntent, refineIntent } from '@shared/engine/intent.ts';
import { entityReply, entityRoute, isArtistEntity, mentions, plausibleMatch, resolveEntity, workMatches } from '@shared/engine/entities.ts';
import { askedRegions, blockedRegions, entityTargets, majorityRegion, offLanguages, planMusic, regionalPicks } from '@shared/engine/curator.ts';
import { CHAT_ENTITY_LIMIT, CHAT_LIMIT, chatPayloadRecs, chatRequest, restoreChatRec } from '@shared/engine/chat.ts';
import { withoutPerUser } from '@shared/engine/lanes.ts';
import { emptyProfile } from '@shared/engine/profile.ts';
import { createHttp, MemoryCache } from '@shared/providers/http.ts';
import { LB_SPOTIFY_MAPPING_URL } from '@shared/providers/listenbrainz.ts';
import type { Entity, Intent, TasteProfile } from '@shared/types.ts';

const NOW = new Date('2026-11-16T00:00:00Z');

describe('understanding: named entities', () => {
  it('keeps entities the user actually wrote, normalising kind, want and works', () => {
    const u = sanitizeUnderstanding({
      categories: ['music'],
      entities: [
        { name: 'Nova Lyric', kind: 'rapper', want: 'all', works: [
          { title: 'Lyric Road', kind: 'movie', year: 2004, by: 'Some Director', note: 'the film based on his early life' },
          { title: 'My Lyric Life', kind: 'memoir', year: '2009' },
          { title: 'Bad Kind', kind: 'album' },
          { title: 'Five', kind: 'book' }, { title: 'Six', kind: 'book' }, { title: 'Seven', kind: 'book' },
        ] },
        { name: 'Invented Person', kind: 'author', want: 'by' },
        { name: 'nova lyric', kind: 'artist' },
      ],
    }, 'nova lyric');
    expect(u.entities).toHaveLength(1);
    const e = u.entities[0];
    expect(e).toMatchObject({ name: 'Nova Lyric', kind: 'artist', want: 'all', source: 'llm' });
    expect(e.works).toEqual([
      { title: 'Lyric Road', kind: 'film', year: 2004, by: 'Some Director', note: 'the film based on his early life' },
      { title: 'My Lyric Life', kind: 'book', year: 2009 },
      { title: 'Five', kind: 'book' },
      { title: 'Six', kind: 'book' },
    ]);
  });

  it('accepts a corrected spelling of what the user typed, never a name they did not write', () => {
    expect(nameInText('Kendrick Lamar', 'kendrik lamar')).toBe(true);
    expect(nameInText('Eminem', 'eminem')).toBe(true);
    expect(nameInText('Drake', 'eminem')).toBe(false);
    expect(sanitizeUnderstanding({ entities: [{ name: 'Drake', kind: 'artist' }] }, 'songs like eminem').entities).toEqual([]);
    // Unknown want → all; unknown kind → other.
    expect(sanitizeUnderstanding({ entities: [{ name: 'Dune', kind: 'thing', want: 'everything' }] }, 'dune').entities[0]).toMatchObject({ kind: 'other', want: 'all' });
  });

  it('a bare name shows the entity in its own medium plus the media that tell its story; a stated medium wins', () => {
    const bare = applyUnderstanding(parseIntent('nova lyric'), sanitizeUnderstanding({ categories: ['music'], entities: [{ name: 'Nova Lyric', kind: 'artist', want: 'all' }], references: ['nova lyric'] }, 'nova lyric'), null);
    expect(bare.categories).toEqual(['music', 'screen', 'books', 'youtube']);
    expect(bare.entities?.[0].name).toBe('Nova Lyric');
    expect(bare.vague).toBe(false);
    const songs = applyUnderstanding(parseIntent('songs like nova lyric'), sanitizeUnderstanding({ categories: ['music'], entities: [{ name: 'Nova Lyric', kind: 'artist', want: 'like' }] }, 'songs like nova lyric'), null);
    expect(songs.categories).toEqual(['music']);
    expect(songs.intent).toBe('similar');
    const doc = applyUnderstanding(parseIntent('nova lyric documentary'), sanitizeUnderstanding({ categories: ['screen', 'youtube'], entities: [{ name: 'Nova Lyric', kind: 'artist', want: 'about' }] }, 'nova lyric documentary'), null);
    expect(doc.categories).toEqual(['screen', 'youtube']);
  });

  it('entities flow through a follow-up ("only books") with the interpreter and with the rules', () => {
    const first = applyUnderstanding(parseIntent('nova lyric'), sanitizeUnderstanding({ entities: [{ name: 'Nova Lyric', kind: 'artist', want: 'all' }] }, 'nova lyric'), null);
    const next = applyUnderstanding(parseIntent('only books'), sanitizeUnderstanding({ categories: ['books'], followUp: true }, 'only books'), first);
    expect(next.categories).toEqual(['books']);
    expect(next.entities?.[0].name).toBe('Nova Lyric');
    const rules = refineIntent(first, parseIntent('only books'));
    expect(rules.categories).toEqual(['books']);
    expect(rules.entities?.[0].name).toBe('Nova Lyric');
    // A new request is not a follow-up: no entity carried over.
    const fresh = applyUnderstanding(parseIntent('calm piano music'), sanitizeUnderstanding({ categories: ['music'], concepts: { calm: 0.9 } }, 'calm piano music'), first);
    expect(fresh.entities).toBeUndefined();
  });
});

describe('rules fallback (AI unavailable): a short unread query is a candidate entity', () => {
  it('"eminem" and "kendrick lamar" become entities of unknown kind, everything about them', () => {
    for (const q of ['eminem', 'kendrick lamar', 'Nova Lyric!']) {
      const i = parseIntent(q);
      expect(i.entities).toEqual([{ name: q.replace('!', ''), kind: 'other', want: 'all', source: 'rules' }]);
      expect(i.vague).toBe(false);
    }
  });
  it('never for small talk, concept/genre/mood words, media, platforms or refinements', () => {
    for (const q of ['hmm', 'hello', 'thanks', 'melancholic jazz', 'youtube podcasts', 'only books', 'shorter', 'more like the first one', 'surprise me', 'chill', 'documentaries', 'what is this?', 'a b c d e f']) {
      expect(parseIntent(q).entities).toBeUndefined();
    }
    expect(parseIntent('hmm').vague).toBe(true);
    expect(candidateEntity('play something')).toBeNull();
  });
  it('a candidate entity in a follow-up starts a fresh request', () => {
    const prev = parseIntent('calm piano music');
    const next = refineIntent(prev, parseIntent('nova lyric'));
    expect(next.entities?.[0].name).toBe('nova lyric');
    expect(next.categories).toEqual([]);
  });
});

describe('resolution by kind', () => {
  it('routes each kind to its own media; an artist only ever to music', () => {
    expect(entityRoute({ kind: 'artist' }, [])).toEqual(['music']);
    expect(entityRoute({ kind: 'artist' }, ['books'])).toEqual(['music']);
    expect(entityRoute({ kind: 'author' }, [])).toEqual(['books']);
    expect(entityRoute({ kind: 'director' }, [])).toEqual(['screen']);
    expect(entityRoute({ kind: 'creator' }, [])).toEqual(['youtube']);
    expect(entityRoute({ kind: 'podcast' }, [])).toEqual(['podcasts']);
    // An unknown name is never looked up by a Spotify song search; a music-only request doesn't look it up as a work at all.
    expect(entityRoute({ kind: 'other' }, [])).toEqual(['screen', 'books']);
    expect(entityRoute({ kind: 'other' }, ['music'])).toEqual([]);
    expect(entityRoute({ kind: 'other' }, ['music', 'books'])).toEqual(['books', 'screen']);
    expect(entityRoute({ kind: 'other' }, ['podcasts'])).toEqual(['podcasts', 'screen', 'books']);
    expect(isArtistEntity({ kind: 'other' }, ['music', 'books'])).toBe(true);
    expect(isArtistEntity({ kind: 'other' }, ['books'])).toBe(false);
  });

  it('an artist is never looked up in a catalog (no Open Library "book" for a rapper)', async () => {
    const log: string[] = [];
    const fetchImpl = (async (u: string) => {
      log.push(String(u));
      return new Response(JSON.stringify({ docs: [{ key: '/works/OL1W', title: 'Nova Lyric', author_name: ['A Biographer'] }] }));
    }) as unknown as typeof fetch;
    const r = await resolveEntity({ name: 'Nova Lyric', kind: 'artist', want: 'all' }, ['music', 'books'], { env: () => undefined, http: createHttp(new MemoryCache(), fetchImpl) });
    expect(r.item).toBeNull();
    expect(r.detail).toMatch(/artist: music curator/);
    expect(log).toEqual([]);
  });

  it('an unknown name is never classified by a Spotify song search; something merely about it leaves it a name', async () => {
    const log: string[] = [];
    const fetchImpl = (async (u: string) => {
      const url = String(u);
      log.push(url);
      if (url.includes('tvmaze.com/singlesearch')) return new Response(JSON.stringify({ id: 7, url: 'https://tvmaze.com/7', name: 'Unrelated Show' }));
      if (url.includes('openlibrary.org')) return new Response(JSON.stringify({ docs: [{ key: '/works/OL2W', title: 'The Nova Lyric Story', author_name: ['A Biographer'] }] }));
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const env = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b' } as Record<string, string>)[n];
    // Spotify search is NOT blocked here: an unread name still never spends a /v1/search call.
    const r = await resolveEntity({ name: 'nova lyric', kind: 'other', want: 'all' }, [], { env, http: createHttp(new MemoryCache(), fetchImpl) });
    expect(log.some((u) => u.includes('spotify.com'))).toBe(false);
    expect(log.findIndex((u) => u.includes('tvmaze'))).toBeLessThan(log.findIndex((u) => u.includes('openlibrary')));
    // A book ABOUT the name doesn't make the name a book: it stays a name (things about it come from the extras).
    expect(r).toMatchObject({ item: null, provider: null });
    expect(r.kind).toBeUndefined();
    expect(plausibleMatch({ title: 'Unrelated Show', creators: [] }, 'nova lyric')).toBe(false);
  });

  it('an unknown name a catalog knows as a work of exactly that title takes the work\'s kind (never an artist)', async () => {
    const fetchImpl = (async (u: string) => {
      const url = String(u);
      if (url.includes('/search/multi')) return new Response(JSON.stringify({ results: [{ id: 5, media_type: 'movie', title: 'Velvet Harbour', release_date: '2019-02-01' }] }));
      if (url.includes('/movie/5/keywords')) return new Response(JSON.stringify({ keywords: [] }));
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const env = (n: string) => ({ TMDB_READ_TOKEN: 'x' } as Record<string, string>)[n];
    const r = await resolveEntity({ name: 'velvet harbour', kind: 'other', want: 'all' }, [], { env, http: createHttp(new MemoryCache(), fetchImpl) });
    expect(r).toMatchObject({ kind: 'film', provider: 'tmdb' });
    expect(r.item?.title).toBe('Velvet Harbour');
    expect(isArtistEntity({ kind: r.kind! }, ['music', 'screen'])).toBe(false);
    // In a music-only request the name is never looked up as a work.
    const none = await resolveEntity({ name: 'velvet harbour', kind: 'other', want: 'all' }, ['music'], { env, http: createHttp(new MemoryCache(), fetchImpl) });
    expect(none).toMatchObject({ item: null });
  });

  it('a related work matches on title, and on year/author when both sides know them', () => {
    const film = { title: 'Lyric Road', creators: [], releaseDate: '2004-11-08', kind: 'movie' as const };
    expect(workMatches(film, { title: 'Lyric Road', kind: 'film', year: 2004 })).toBe(true);
    expect(workMatches(film, { title: 'Lyric Road', kind: 'film', year: 1979 })).toBe(false);
    expect(workMatches({ ...film, kind: 'series' as const }, { title: 'Lyric Road', kind: 'film' })).toBe(false);
    expect(workMatches({ title: 'My Lyric Life', creators: ['Nova Lyric'], releaseDate: '2009', kind: 'book' }, { title: 'My Lyric Life', kind: 'book', by: 'Nova Lyric' })).toBe(true);
    expect(workMatches({ title: 'My Lyric Life', creators: ['Someone Else'], releaseDate: '2009', kind: 'book' }, { title: 'My Lyric Life', kind: 'book', by: 'Nova Lyric' })).toBe(false);
    expect(mentions({ title: 'Nova Lyric breaks down his first album', creators: ['Channel'], tags: [], description: '' }, 'Nova Lyric')).toBe(true);
  });
});

describe('regional rules for typed requests (curator language + style labels)', () => {
  const frenchOff: TasteProfile = { ...emptyProfile(), explicit: { ...emptyProfile().explicit, blockedFamilies: ['french-chanson', 'french-rap'] } };
  it('knows which scenes are off and which the request asks for', () => {
    expect(blockedRegions(frenchOff)).toEqual(['french']);
    expect([...askedRegions('rap français récent')]).toEqual(['french']);
    expect([...askedRegions('moroccan rap')]).toEqual(['arabic-pop']);
    expect([...askedRegions('sad songs, no french pop please')]).toEqual([]);
    expect([...askedRegions('chill music', 'fr')]).toEqual(['french']);
    expect(offLanguages(frenchOff, 'songs like nova lyric')).toEqual(['French']);
    expect(offLanguages(frenchOff, 'rap français')).toEqual([]);
  });
  it('drops switched-off languages unless asked or the named artist is from that scene, and caps the rest', () => {
    const picks = [
      { artist: 'A', track: '1', lang: 'English', lane: 'hip hop' },
      { artist: 'B', track: '2', lang: 'French', lane: 'afropop' },
      { artist: 'C', track: '3', lane: 'rap francais' },
      { artist: 'D', track: '4', lang: 'Arabic', lane: 'arabic pop' },
      { artist: 'E', track: '5', lang: 'Darija', lane: 'moroccan rap' },
    ];
    const r = regionalPicks(picks, { blocked: ['french'], asked: new Set(), cap: 1 });
    expect(r.kept.map((p) => p.artist)).toEqual(['A', 'D']);
    expect(r.dropped).toBe(3);
    expect(regionalPicks(picks, { blocked: ['french'], asked: new Set(['french']), cap: 1 }).kept.map((p) => p.artist)).toEqual(['A', 'B', 'C', 'D']);
    expect(regionalPicks(picks, { blocked: ['french'], asked: new Set(), named: 'french', cap: 1 }).kept.map((p) => p.artist)).toEqual(['A', 'B', 'C', 'D']);
    expect(majorityRegion([{ lang: 'French' }, { lang: 'French' }, { lang: 'English' }])).toBe('french');
    expect(majorityRegion([{ lang: 'French' }, { lang: 'English' }])).toBeNull();
  });
});

describe('entity music plan', () => {
  it('splits ~50/50 (at least 6 each) for a bare name, one lane for by/like', () => {
    expect(entityTargets('all', 14)).toEqual({ by: 7, like: 7 });
    expect(entityTargets('all', 10)).toEqual({ by: 6, like: 6 });
    expect(entityTargets('by', 20)).toEqual({ by: 16, like: 0 });
    expect(entityTargets('like', 20)).toEqual({ by: 0, like: 16 });
    const plan = planMusic(emptyProfile(), { hasQuery: true, seed: 1, total: 14, text: 'nova lyric', now: NOW, entity: { name: 'Nova Lyric', want: 'all' } })!;
    expect(plan).toMatchObject({ mode: 'request', entity: { name: 'Nova Lyric', want: 'all' }, order: ['entity-by', 'entity-like'], targets: { 'entity-by': 7, 'entity-like': 7 } });
    expect(plan.lanes.map((l) => l.label)).toEqual(['Nova Lyric', 'Artists like Nova Lyric']);
  });
  it('chat limit: 20 when the message names an entity, 12 otherwise', () => {
    const req = chatRequest({ message: 'nova lyric' });
    expect(req).toMatchObject({ limit: CHAT_LIMIT, entityLimit: CHAT_ENTITY_LIMIT });
    expect(CHAT_LIMIT).toBe(12);
    expect(CHAT_ENTITY_LIMIT).toBe(20);
    expect(requestLimit(req, { entities: [{ name: 'Nova Lyric', kind: 'artist', want: 'all' }] })).toBe(20);
    expect(requestLimit(req, {})).toBe(12);
    expect(requestLimit({ limit: 24 }, { entities: [{ name: 'X', kind: 'other', want: 'all' }] })).toBe(24);
  });
});

// ───────────── end to end: "nova lyric" in chat ─────────────

const ARTIST = 'Nova Lyric';
type Song = { artist: string; track: string; year: number; feat?: string[]; lang?: string; lane?: string; why?: string };
const BY: Song[] = [
  { artist: ARTIST, track: 'Signature One', year: 2002 },
  { artist: ARTIST, track: 'Library Favourite', year: 2004 },
  { artist: ARTIST, track: 'Night Letter', year: 2000, feat: ['Guest Singer'] },
  { artist: ARTIST, track: 'Deep Cut', year: 1999 },
  { artist: 'Other Producer', track: 'Not Theirs', year: 1999 }, // not the named artist: dropped
  { artist: ARTIST, track: 'Late Single', year: 2013 },
  { artist: ARTIST, track: 'Skit Interlude', year: 2002 }, // a skit: dropped
  { artist: ARTIST, track: 'Comeback', year: 2018 },
  { artist: ARTIST, track: 'Album Track', year: 2009 },
];
const LIKE: Song[] = [
  { artist: 'Peer One', track: 'Peer Song', year: 2003, lane: 'hip hop', lang: 'English', why: 'storytelling rap with rapid-fire flow' },
  { artist: ARTIST, track: 'Self Song', year: 2005, lang: 'English', why: 'same artist' }, // the named artist: dropped
  { artist: 'Chanteuse FR', track: 'Chanson Rap', year: 2021, lane: 'afropop', lang: 'French', why: 'catchy hooks' }, // French is off: dropped
  { artist: 'Peer Two', track: 'Peer Hit', year: 2005, lane: 'west coast hip hop', lang: 'English', why: 'cinematic beats from the same era' },
  { artist: 'Old Arabic', track: 'Old Arabic Song', year: 2010, lane: 'arabic hip hop', lang: 'Arabic', why: 'raw delivery' }, // regional before 2015: era
  { artist: 'Peer Three', track: 'Peer Track', year: 2011, lane: 'hip hop', lang: 'English', why: 'confessional lyrics over hard drums' },
  { artist: 'Peer Four', track: 'Peer Four Song', year: 2001, lane: 'hip hop', lang: 'English', why: 'shock-value humour and wordplay' },
  { artist: 'Peer Five', track: 'Peer Five Song', year: 2014, lane: 'pop rap', lang: 'English', why: 'melodic hooks on rap verses' },
  { artist: 'Peer Six', track: 'Peer Six Song', year: 2008, lane: 'hip hop', lang: 'English', why: 'battle-rap energy' },
  { artist: 'Peer Seven', track: 'Peer Seven Song', year: 2016, lane: 'hip hop', lang: 'English', why: 'technical multisyllabic rhymes' },
  { artist: 'Peer Eight', track: 'Peer Eight Song', year: 2006, lane: 'hip hop', lang: 'English', why: 'dark, introspective storytelling' },
];
const ALL = [...BY, ...LIKE];
const tid = (i: number) => `ENT${String(i).padStart(19, '0')}`;
const UNDERSTANDING = {
  categories: ['music'], references: ['nova lyric'], search: { music: 'Nova Lyric' }, concepts: { 'music-culture': 0.6 },
  entities: [{ name: ARTIST, kind: 'artist', want: 'all', works: [
    { title: 'Lyric Road', kind: 'film', year: 2004, by: 'Some Director', note: 'the film based on his early life' },
    { title: 'My Lyric Life', kind: 'book', year: 2009, by: ARTIST, note: 'his illustrated memoir' },
  ] }],
};

function entityFetch(log: string[], prompts: { by?: string; like?: string; understand?: string }) {
  return (async (u: string, init?: RequestInit) => {
    const url = String(u);
    log.push(url);
    if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
    if (url.includes('/chat/completions')) {
      const body = JSON.parse(String(init?.body));
      const system = body.messages[0].content as string;
      const user = body.messages[1].content as string;
      const answer = (x: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(x) } }] }));
      if (system.includes('request interpreter')) {
        prompts.understand = `${system}\n${user}`;
        return answer(UNDERSTANDING);
      }
      if (/List \d+ real, officially released songs by/.test(system)) {
        prompts.by = `${system}\n---\n${user}`;
        return answer({ items: BY.map(({ artist, track, feat }) => ({ artist, track, feat: feat ?? [], lane: 'hip hop', lang: 'English' })) });
      }
      if (/DIFFERENT artists closely related to/.test(system)) {
        prompts.like = `${system}\n---\n${user}`;
        return answer({ items: LIKE.map(({ artist, track, lane, lang, why }) => ({ artist, track, feat: [], lane, lang, why })) });
      }
      return answer({});
    }
    if (url === LB_SPOTIFY_MAPPING_URL) {
      const rows = JSON.parse(String(init?.body)) as Array<{ artist_name: string; track_name: string }>;
      return new Response(JSON.stringify(rows.map((r) => {
        const i = ALL.findIndex((s) => s.track === r.track_name);
        return { ...r, spotify_track_ids: i >= 0 ? [tid(i)] : [] };
      })));
    }
    const m = /\/v1\/tracks\/(ENT\d+)/.exec(url);
    if (m) {
      const s = ALL[Number(m[1].slice(3))];
      return new Response(JSON.stringify({
        id: m[1], name: s.track, artists: [{ id: 'a', name: s.artist }, ...(s.feat ?? []).map((f) => ({ id: 'f', name: f }))], album: { id: 'al', name: 'Album', images: [], release_date: `${s.year}-06-01`, album_type: 'album' },
        duration_ms: 200000, external_urls: { spotify: `https://open.spotify.com/track/${m[1]}` }, is_playable: true,
      }));
    }
    if (url.includes('api.themoviedb.org/3/search/multi')) return new Response(JSON.stringify({ results: [{ id: 99, media_type: 'movie', title: 'Lyric Road', release_date: '2004-11-08', overview: 'A young rapper fights his way up.', vote_average: 7.2, vote_count: 900 }] }));
    if (url.includes('api.themoviedb.org/3/movie/99/keywords')) return new Response(JSON.stringify({ keywords: [{ name: 'hip-hop' }] }));
    if (url.includes('openlibrary.org/search.json')) {
      const q = new URL(url).searchParams;
      if (q.get('title') === 'My Lyric Life') return new Response(JSON.stringify({ docs: [{ key: '/works/OL10W', title: 'My Lyric Life', author_name: [ARTIST], first_publish_year: 2009 }] }));
      if (q.get('q') === ARTIST) return new Response(JSON.stringify({ docs: [
        { key: '/works/OL10W', title: 'My Lyric Life', author_name: [ARTIST], first_publish_year: 2009 },
        { key: '/works/OL11W', title: 'Nova Lyric: The Biography', author_name: ['A Biographer'], first_publish_year: 2012 },
        { key: '/works/OL12W', title: 'Unrelated Poetry', author_name: ['Poet'], first_publish_year: 1990 },
      ] }));
      return new Response(JSON.stringify({ docs: [] }));
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

const env = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b', AI_BASE_URL: 'https://ai.test/v1', AI_MODEL: 'm', TMDB_READ_TOKEN: 'tmdb', YOUTUBE_API_KEY: 'yt' } as Record<string, string>)[n];
const frenchOff: TasteProfile = { ...emptyProfile(), explicit: { ...emptyProfile().explicit, blockedFamilies: ['french-chanson', 'french-rap'] } };

describe('"nova lyric" in chat, end to end (search blocked, YouTube out of quota)', () => {
  // The library has one of their songs; the same song id was liked (so it is in the exclusion set).
  const libraryId = `spotify:track:${tid(1)}`;
  const library = { isrcs: new Set<string>(), songs: new Set(['novalyric|libraryfavourite']), ids: new Set([libraryId]) };
  const storedVideos = [
    { id: 'youtube:video:AAAAAAAAAAA', category: 'youtube' as const, kind: 'video' as const, provider: 'youtube' as const, externalId: 'AAAAAAAAAAA', title: 'Nova Lyric breaks down his first album', creators: ['Music Channel'], genres: ['Music'], tags: [], externalUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', embed: { type: 'youtube' as const, videoId: 'AAAAAAAAAAA' } },
    { id: 'youtube:video:BBBBBBBBBBB', category: 'youtube' as const, kind: 'video' as const, provider: 'youtube' as const, externalId: 'BBBBBBBBBBB', title: 'Cooking pasta at home', creators: ['Food Channel'], genres: [], tags: [], externalUrl: 'https://www.youtube.com/watch?v=BBBBBBBBBBB', embed: { type: 'youtube' as const, videoId: 'BBBBBBBBBBB' } },
  ];

  async function run() {
    const log: string[] = [];
    const prompts: { by?: string; like?: string; understand?: string } = {};
    const res = await runPipeline(chatRequest({ message: 'nova lyric' }), {
      env, http: createHttp(new MemoryCache(), entityFetch(log, prompts)), profile: frenchOff, library, excludeIds: new Set([libraryId]), shownIds: new Set(),
      blockedProviders: new Set(['spotify', 'youtube']), catalogFallback: async (provider) => (provider === 'youtube' ? storedVideos : []), seed: 3, now: NOW,
      // Library evidence that must never be cited for an entity answer.
      evidence: [{ id: 'spotify:track:LIBEVIDENCE', title: 'Some Liked Song', category: 'music', kind: 'track', concepts: { 'music-culture': 0.8, joyful: 0.6 } }],
    });
    return { res, log, prompts };
  }

  it('answers with the artist\'s songs, then artists like them, then things about them — under the owner\'s rules', async () => {
    const { res, log, prompts } = await run();
    // Never Spotify search, never the artist as a book title.
    expect(log.some((u) => u.includes('/v1/search'))).toBe(false);
    expect(log.some((u) => /search\.json\?title=Nova/i.test(u))).toBe(false);
    expect(res.pipeline.find((p) => p.step === 'references')?.detail).toMatch(/Nova Lyric → artist: music curator/);
    expect(res.pipeline.find((p) => p.step === 'references')?.detail).not.toMatch(/openlibrary/);
    // Only the user's words and the normalised name went to the curators.
    expect(prompts.by).toMatch(/Artist: Nova Lyric\nRequest: nova lyric$/);
    expect(prompts.like).toMatch(/No French-language songs: the listener switched them off \(unless Nova Lyric is a French-language artist\)/);

    const recs = res.recommendations;
    expect(recs.length).toBeGreaterThan(CHAT_LIMIT);
    expect(recs.length).toBeLessThanOrEqual(CHAT_ENTITY_LIMIT);
    const lane = (i: number) => (recs[i].item.metadata?.lane as { id: string } | undefined)?.id ?? recs[i].item.category;
    const order = recs.map((_, i) => lane(i));
    // By lane first, then the like lane, then the items around them.
    const lastBy = order.lastIndexOf('entity-by');
    const firstLike = order.indexOf('entity-like');
    const lastLike = order.lastIndexOf('entity-like');
    expect(order[0]).toBe('entity-by');
    expect(lastBy).toBeLessThan(firstLike);
    expect(order.slice(lastLike + 1).every((c) => c !== 'entity-by' && c !== 'entity-like')).toBe(true);

    const by = recs.filter((r) => (r.item.metadata?.lane as { id: string } | undefined)?.id === 'entity-by');
    expect(by).toHaveLength(7);
    expect(by.every((r) => r.item.creators.includes(ARTIST))).toBe(true);
    expect(by.map((r) => r.item.title)).not.toContain('Not Theirs');
    expect(by.map((r) => r.item.title)).not.toContain('Skit Interlude');
    // The library song is allowed here, ranked last and flagged.
    expect(by[by.length - 1].item.title).toBe('Library Favourite');
    expect(by[by.length - 1].item.metadata?.inLibrary).toBe(true);
    expect(by[by.length - 1].explanation.text).toMatch(/^Nova Lyric — in your library\./);
    expect(by[0].explanation.text).toBe('Nova Lyric — not in your library yet. Released 2002.');
    expect(by.slice(0, -1).every((r) => r.item.metadata?.inLibrary === false)).toBe(true);
    expect(by.map((r) => r.item.title).slice(0, 2)).toEqual(['Signature One', 'Night Letter']);

    const like = recs.filter((r) => (r.item.metadata?.lane as { id: string } | undefined)?.id === 'entity-like');
    expect(like).toHaveLength(7);
    const likeTitles = like.map((r) => r.item.title);
    expect(likeTitles).not.toContain('Self Song'); // the named artist
    expect(likeTitles).not.toContain('Chanson Rap'); // French is switched off
    expect(likeTitles).not.toContain('Old Arabic Song'); // regional before 2015
    expect(new Set(like.map((r) => r.item.creators[0])).size).toBe(like.length);
    expect(like[0].explanation.text).toBe('Like Nova Lyric: storytelling rap with rapid-fire flow. Released 2003.');

    const extras = recs.filter((r) => r.item.category !== 'music');
    expect(extras.map((r) => r.item.title)).toEqual(['Lyric Road', 'My Lyric Life', 'Nova Lyric: The Biography', 'Nova Lyric breaks down his first album']);
    expect(extras[0].explanation.text).toMatch(/^Lyric Road — the film based on his early life\./);
    expect(extras[2].explanation.text).toBe('Nova Lyric: The Biography — a book about Nova Lyric.');
    expect(extras[3].explanation.text).toBe('Nova Lyric breaks down his first album — a video about Nova Lyric from Music Channel.');
    // No explanation cites an unrelated library song.
    for (const r of recs) expect(r.explanation.text).not.toMatch(/Some Liked Song|which you liked/);

    expect(res.reply).toBe("Here's Nova Lyric: 7 songs by Nova Lyric (6 you haven't saved), 7 artists in the same lane and 4 things about Nova Lyric: Lyric Road, My Lyric Life, Nova Lyric: The Biography and 1 more.");
  });

  it('the chat payload keeps each pick\'s lane, library flag and entity tag; the shared catalog row does not', async () => {
    const { res } = await run();
    const payload = chatPayloadRecs(res.recommendations);
    const fav = payload.find((p) => p.meta?.inLibrary);
    expect(fav?.meta).toMatchObject({ lane: { id: 'entity-by', label: ARTIST }, inLibrary: true, entity: { name: ARTIST, role: 'by' } });
    const item = res.recommendations.find((r) => r.item.id === fav!.itemId)!.item;
    const stored = withoutPerUser(item.metadata);
    expect(stored.lane).toBeUndefined();
    expect(stored.inLibrary).toBeUndefined();
    expect(stored.entity).toBeUndefined();
    // Restoring from the catalog row + payload gives back the same lane.
    const restored = restoreChatRec({ ...item, metadata: { ...stored, lane: { id: 'hiphop-rnb', label: 'Other answer' } } }, fav!);
    expect(restored.metadata).toMatchObject({ lane: { id: 'entity-by', label: ARTIST }, inLibrary: true });
  });
});

describe('curator prompts for "eminem"', () => {
  it('builds an own-songs prompt and an artists-like prompt from the user\'s words only', async () => {
    const prompts: { by?: string; like?: string } = {};
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('/chat/completions')) {
        const body = JSON.parse(String(init?.body));
        const system = body.messages[0].content as string;
        const text = `${system}\n---\n${body.messages[1].content}`;
        if (system.includes('request interpreter')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ categories: ['music'], entities: [{ name: 'Eminem', kind: 'artist', want: 'all' }] }) } }] }));
        // The first request of each kind (an empty answer triggers one smaller retry, not checked here).
        if (/songs by Eminem/.test(system)) prompts.by ??= text;
        else prompts.like ??= text;
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }));
      }
      if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      return new Response(JSON.stringify({ docs: [] }));
    }) as unknown as typeof fetch;
    const envNoYt = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b', AI_BASE_URL: 'https://ai.test/v1', AI_MODEL: 'm' } as Record<string, string>)[n];
    const profile: TasteProfile = { ...frenchOff, explicit: { ...frenchOff.explicit, dislikes: ['christmas songs'] }, creators: { 'library artist': 2 } };
    await runPipeline(chatRequest({ message: 'eminem' }), { env: envNoYt, http: createHttp(new MemoryCache(), fetchImpl), profile, blockedProviders: new Set(['spotify']), seed: 1, now: NOW });
    expect(prompts.by).toBe([
      'You are ECHO\'s music curator. Return ONLY JSON: {"items":[{"artist":"<main artist>","track":"<official title>","feat":["<featured artist>"],"lane":"<the song\'s style, 1-3 words>","lang":"<main language of the lyrics>"}]}.',
      '- List 14 real, officially released songs by Eminem that are on Spotify: their signature songs and biggest hits plus fan-favourite deeper cuts and album tracks, from any era of their career.',
      '- Eminem is the main credited artist of every song.',
      '- Original studio versions only: no live, remix, sped-up, slowed, cover, karaoke, instrumental, skit or interlude tracks, and no compilations or "best of" collections.',
      '- Order them for a good first listen: a few signature songs first, then deeper cuts, alternating eras and energy.',
      '- Never invent a title: give fewer songs rather than one you are not sure exists.',
      '- "artist" is the main credited artist only; "track" is the official song title WITHOUT any "(feat. …)", "(with …)" or version part; "feat" lists the officially credited featured artists ([] when none).',
      '- "lang" is the main language of the lyrics (e.g. English, French, Arabic, Spanish).',
      '---',
      'Artist: Eminem',
      'Request: eminem',
    ].join('\n'));
    expect(prompts.like).toBe([
      'You are ECHO\'s music curator. Return ONLY JSON: {"items":[{"artist":"<main artist>","track":"<official title>","feat":["<featured artist>"],"lane":"<the song\'s own style, 1-3 words>","lang":"<main language of the lyrics>","why":"<3-8 words: what it shares with Eminem>"}]}.',
      '- Give 14 real, officially released songs that are on Spotify, by 14 DIFFERENT artists closely related to Eminem in sound, style, scene and era: peers, collaborators, artists Eminem influenced or was influenced by.',
      '- Never a song by Eminem or featuring Eminem.',
      '- "why" is 3-8 plain words on what the song shares with Eminem (e.g. "storytelling rap with rapid-fire flow"), never a list of names.',
      '- Songs with vocals, in their original studio version: no live, remix, sped-up, slowed, cover, karaoke or instrumental versions.',
      '- French, Arabic or Maghreb songs only from 2015 on (modern, never traditional or classic-era recordings).',
      '- No French-language songs: the listener switched them off (unless Eminem is a French-language artist).',
      '- Familiar like the listener\'s own library: artists well known in that scene and their best-known songs, a couple of bigger hits; never obscure, avant-garde or experimental.',
      '- One song per artist; never an artist or style listed under "avoid".',
      '- Order them for a smooth listening flow.',
      '- Never novelty, meme, comedy, parody, children\'s, sleep, meditation, relaxation, study, frequency or stock music, and no compilations or "best of" collections.',
      '- "artist" is the main credited artist only; "track" is the official song title WITHOUT any "(feat. …)", "(with …)" or version part; "feat" lists the officially credited featured artists ([] when none).',
      '- "lang" is the main language of the lyrics (e.g. English, French, Arabic, Spanish).',
      '---',
      'Artist: Eminem',
      'Request: eminem',
      'Avoid: christmas songs',
    ].join('\n'));
    // Never library or taste data beyond user-typed dislikes.
    expect(`${prompts.by}${prompts.like}`).not.toMatch(/library artist/i);
  });
});

describe('entity reply', () => {
  const e: Entity = { name: 'Some Film', kind: 'film', want: 'all' };
  const item = (title: string, category: 'screen' | 'books', role: 'by' | 'like' | 'about', kind: 'movie' | 'book' = 'movie') => ({
    item: { id: `x:${title}`, title, category, kind, provider: 'tmdb', externalId: title, creators: [], genres: [], tags: [], externalUrl: 'https://example.org', concepts: {}, metadata: { entity: { name: 'Some Film', role } } },
  }) as unknown as Parameters<typeof entityReply>[1][number];
  it('describes a work: itself, picks like it, things about it', () => {
    expect(entityReply(e, [item('Some Film', 'screen', 'by'), item('Like A', 'screen', 'like'), item('Like B', 'screen', 'like'), item('The Novel', 'books', 'about', 'book')]))
      .toBe("Here's Some Film: the film itself, 2 picks like it and 1 thing about Some Film: The Novel.");
    // Nothing shown answers the entity itself: no entity reply (the pipeline describes the other picks).
    expect(entityReply(e, [])).toBeNull();
    // Other picks shown alongside are counted.
    const other = { item: { ...item('Unrelated', 'books', 'by', 'book').item, metadata: {} } } as unknown as Parameters<typeof entityReply>[1][number];
    expect(entityReply(e, [item('Some Film', 'screen', 'by'), other, other])).toBe("Here's Some Film: the film itself, plus 2 other picks.");
  });
});

describe('ordinary requests are unchanged', () => {
  it('"youtube podcasts" and mood requests carry no entity', () => {
    const i: Intent = parseIntent('youtube podcasts');
    expect(i.entities).toBeUndefined();
    expect(parseIntent('music that starts melancholic and becomes uplifting').entities).toBeUndefined();
  });
});

describe('typed music requests follow the owner\'s language and style rules (curator labels)', () => {
  it('drops a French-language pick and a blocked-style pick when French is switched off', async () => {
    const picks = [
      { artist: 'Runner One', track: 'Run Fast', lane: 'hip hop', lang: 'English', year: 2019 },
      { artist: 'Chanteur Pop', track: 'Courir', lane: 'afropop', lang: 'French', year: 2021 }, // French lyrics, non-French label
      { artist: 'Rappeur', track: 'Vite', lane: 'rap francais', lang: 'English', year: 2020 }, // French style label
      { artist: 'Runner Two', track: 'Keep Going', lane: 'pop rap', lang: 'English', year: 2018 },
    ];
    const prompts: string[] = [];
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      if (url.includes('/chat/completions')) {
        const body = JSON.parse(String(init?.body));
        const system = body.messages[0].content as string;
        if (system.includes('request interpreter')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ categories: ['music'], concepts: { energetic: 0.9 } }) } }] }));
        prompts.push(system);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: picks.map(({ artist, track, lane, lang }) => ({ artist, track, lane, lang })) }) } }] }));
      }
      if (url === LB_SPOTIFY_MAPPING_URL) {
        const rows = JSON.parse(String(init?.body)) as Array<{ track_name: string }>;
        return new Response(JSON.stringify(rows.map((r) => ({ ...r, spotify_track_ids: [tid(100 + picks.findIndex((p) => p.track === r.track_name))] }))));
      }
      const m = /\/v1\/tracks\/(ENT\d+)/.exec(url);
      if (m) {
        const p = picks[Number(m[1].slice(3)) - 100];
        return new Response(JSON.stringify({ id: m[1], name: p.track, artists: [{ id: 'a', name: p.artist }], album: { id: 'al', name: 'Album', images: [], release_date: `${p.year}-01-01` }, duration_ms: 200000, external_urls: { spotify: 'https://open.spotify.com/track/x' }, is_playable: true }));
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const envMusic = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b', AI_BASE_URL: 'https://ai.test/v1', AI_MODEL: 'm' } as Record<string, string>)[n];
    const res = await runPipeline(chatRequest({ message: 'hip hop for running' }), { env: envMusic, http: createHttp(new MemoryCache(), fetchImpl), profile: frenchOff, blockedProviders: new Set(['spotify']), seed: 2, now: NOW });
    const titles = res.recommendations.map((r) => r.item.title);
    expect(titles).toEqual(['Run Fast', 'Keep Going']);
    expect(res.recommendations).toHaveLength(2); // no entity: the 12-pick chat limit and the request lane
    expect(res.recommendations[0].item.metadata?.lane).toEqual({ id: 'request', label: 'For your request' });
    expect(prompts[0]).toMatch(/No French-language songs: the listener switched them off\./);
    expect(res.pipeline.find((p) => p.step === 'music-ai')?.detail).toMatch(/regional language 2/);
  });
});

describe('non-artist entities: their works, things like them, things about them (bounded)', () => {
  it('an author: their books, books on the subjects of their best-known one, at most 4 provider calls', async () => {
    const log: string[] = [];
    const fetchImpl = (async (u: string) => {
      const url = String(u);
      log.push(url);
      const q = new URL(url).searchParams;
      if (q.get('author') === 'Ann Writer') return new Response(JSON.stringify({ docs: [
        { key: '/works/OL1W', title: 'First Novel', author_name: ['Ann Writer'], subject: ['Desert planets', 'Fiction'], edition_count: 90 },
        { key: '/works/OL2W', title: 'Second Novel', author_name: ['Ann Writer'], edition_count: 40 },
        { key: '/works/OL3W', title: 'Not Hers', author_name: ['Someone Else'], edition_count: 30 },
      ] }));
      if (q.get('q') === 'subject:"Desert planets"') return new Response(JSON.stringify({ docs: [
        { key: '/works/OL1W', title: 'First Novel', author_name: ['Ann Writer'] },
        { key: '/works/OL9W', title: 'Sand Saga', author_name: ['Other Author'] },
      ] }));
      return new Response(JSON.stringify({ docs: [] }));
    }) as unknown as typeof fetch;
    const { entityExtras } = await import('@shared/engine/entities.ts');
    const r = await entityExtras({ name: 'Ann Writer', kind: 'author', want: 'all' }, { env: () => undefined, http: createHttp(new MemoryCache(), fetchImpl), categories: ['books', 'screen', 'youtube'], cap: 8 });
    expect(r.items.map((i) => [i.title, (i.metadata?.entity as { role: string }).role])).toEqual([['First Novel', 'by'], ['Second Novel', 'by'], ['Sand Saga', 'like']]);
    expect(r.calls).toBeLessThanOrEqual(4);
    expect(log.length).toBe(2);
  });

  it('a film: the film itself, similar films, and the book it comes from', async () => {
    const fetchImpl = (async (u: string) => {
      const url = String(u);
      if (url.includes('/search/multi') && url.includes('query=Dune+Saga')) return new Response(JSON.stringify({ results: [{ id: 5, media_type: 'movie', title: 'Dune Saga', release_date: '2021-09-15' }] }));
      if (url.includes('/movie/5/keywords')) return new Response(JSON.stringify({ keywords: [{ name: 'desert' }] }));
      if (url.includes('/movie/5/recommendations')) return new Response(JSON.stringify({ results: [{ id: 6, title: 'Sand Sequel', release_date: '2024-03-01' }, { id: 7, title: 'Space Epic', release_date: '2014-11-05' }] }));
      if (url.includes('openlibrary.org') && new URL(url).searchParams.get('title') === 'Dune Saga') return new Response(JSON.stringify({ docs: [{ key: '/works/OL5W', title: 'Dune Saga', author_name: ['Ann Writer'], first_publish_year: 1965 }] }));
      return new Response(JSON.stringify({ results: [], docs: [] }));
    }) as unknown as typeof fetch;
    const envTmdb = (n: string) => (n === 'TMDB_READ_TOKEN' ? 'x' : undefined);
    const http = createHttp(new MemoryCache(), fetchImpl);
    const e: Entity = { name: 'Dune Saga', kind: 'film', want: 'all', works: [{ title: 'Dune Saga', kind: 'book', year: 1965, by: 'Ann Writer', note: 'the novel it adapts' }] };
    const resolved = await resolveEntity(e, ['screen', 'books', 'youtube'], { env: envTmdb, http });
    expect(resolved.item?.title).toBe('Dune Saga');
    const { entityExtras } = await import('@shared/engine/entities.ts');
    const r = await entityExtras(e, { env: envTmdb, http, categories: ['screen', 'books', 'youtube'], resolved: resolved.item, cap: 8 });
    expect(r.items.map((i) => [i.category, i.title, (i.metadata?.entity as { role: string }).role])).toEqual([
      ['screen', 'Dune Saga', 'by'], ['books', 'Dune Saga', 'about'], ['screen', 'Sand Sequel', 'like'], ['screen', 'Space Epic', 'like'],
    ]);
    expect(r.calls).toBeLessThanOrEqual(4);
    expect(entityReply(e, r.items.map((item) => ({ item: { ...item, concepts: {} } })))).toBe("Here's Dune Saga: the film itself, 2 picks like it and 1 thing about Dune Saga: Dune Saga.");
  });
});

describe('things about an artist on YouTube (quota available)', () => {
  it('one search, keeping only videos that name them', async () => {
    const searches: string[] = [];
    const video = (id: string, title: string, channel: string) => ({
      id, snippet: { title, description: '', channelTitle: channel, publishedAt: '2020-01-01T00:00:00Z', categoryId: '10' }, contentDetails: { duration: 'PT12M' }, statistics: { viewCount: '100000', likeCount: '5000' }, status: { embeddable: true, privacyStatus: 'public' },
    });
    const fetchImpl = (async (u: string) => {
      const url = String(u);
      if (url.includes('youtube/v3/search')) {
        searches.push(new URL(url).searchParams.get('q') ?? '');
        return new Response(JSON.stringify({ items: [{ id: { videoId: 'V1V1V1V1V1V' } }, { id: { videoId: 'V2V2V2V2V2V' } }] }));
      }
      if (url.includes('youtube/v3/videos')) return new Response(JSON.stringify({ items: [video('V1V1V1V1V1V', 'Nova Lyric: the full interview', 'Talk Show'), video('V2V2V2V2V2V', 'Top 10 rap verses', 'Lists')] }));
      return new Response(JSON.stringify({ docs: [] }));
    }) as unknown as typeof fetch;
    const { entityExtras } = await import('@shared/engine/entities.ts');
    const r = await entityExtras({ name: ARTIST, kind: 'artist', want: 'about' }, { env: (n) => (n === 'YOUTUBE_API_KEY' ? 'k' : undefined), http: createHttp(new MemoryCache(), fetchImpl), categories: ['youtube'], cap: 8 });
    expect(searches).toEqual(['Nova Lyric interview|documentary|breakdown']);
    expect(r.items.map((i) => i.title)).toEqual(['Nova Lyric: the full interview']);
    expect(r.items[0].metadata?.entity).toEqual({ name: ARTIST, role: 'about', note: 'a video about Nova Lyric from Talk Show' });
  });
});
