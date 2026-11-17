import { analyzeLibrary, applyLibraryImport, tracksFromCsv, trackToItem } from '@shared/importer.ts';
import { curatorCacheKey, curatorPrompt, llmMusicPicks, parseMusicPicks } from '@shared/engine/ai.ts';
import { createHttp, MemoryCache } from '@shared/providers/http.ts';
import { buildBrief, MAX_ASK, musicQuotaFor, planMusic, regionalLaneOfLanguage, requestRules, styleFitsLane } from '@shared/engine/curator.ts';
import { parseIntent } from '@shared/engine/intent.ts';
import { emptyProfile } from '@shared/engine/profile.ts';
import type { TasteProfile } from '@shared/types.ts';
import { syntheticCsv } from './library-fixture';

const NOW = new Date('2026-11-16T00:00:00Z');

function importedProfile(): { profile: TasteProfile; names: string[] } {
  const tracks = tracksFromCsv(syntheticCsv());
  const { dna, inferredGenres } = analyzeLibrary(tracks, NOW);
  const p = applyLibraryImport(emptyProfile(), tracks.map(trackToItem), tracks.map((t) => t.addedAt), NOW, { inferredGenres });
  return { profile: { ...p, music: dna }, names: [...tracks.map((t) => t.name), ...tracks.flatMap((t) => t.artists), ...tracks.map((t) => t.album ?? '')] };
}

const BANNED = /acclaimed|cult|lesser-known|outside the (obvious )?mainstream|mix eras|countries|hidden gems/i;

describe('music curator brief', () => {
  const { profile, names } = importedProfile();

  it('plans up to 3 lanes for a 48-pick feed and splits the music quota by share (min 3 each)', () => {
    const total = musicQuotaFor(['youtube', 'music', 'screen', 'books', 'podcasts'], 48, undefined, false);
    expect(total).toBe(10);
    const plan = planMusic(profile, { hasQuery: false, seed: 4, total, now: NOW })!;
    expect(plan.mode).toBe('lanes');
    expect(plan.lanes).toHaveLength(3);
    expect(plan.lanes.filter((l) => l.regional).length).toBeLessThanOrEqual(1);
    expect(Object.values(plan.targets).reduce((a, b) => a + b, 0)).toBe(10);
    for (const n of Object.values(plan.targets)) expect(n).toBeGreaterThanOrEqual(3);
    expect(planMusic(profile, { hasQuery: false, seed: 4, total: 3, now: NOW })!.lanes).toHaveLength(1);
  });

  it('sends generic lane words with the policy rules, never library track/artist names', () => {
    // Pick a seed whose rotation includes a regional lane, and one without.
    let regionalSeed = -1;
    for (let s = 0; s < 200 && regionalSeed < 0; s++) if (planMusic(profile, { hasQuery: false, seed: s, total: 10, now: NOW })!.lanes.some((l) => l.regional)) regionalSeed = s;
    expect(regionalSeed).toBeGreaterThanOrEqual(0);
    const plan = planMusic(profile, { hasQuery: false, seed: regionalSeed, total: 10, now: NOW })!;
    const { system, user } = curatorPrompt(buildBrief(plan, profile, { moods: ['melancholic'] }));
    const all = `${system}\n${user}`;
    for (const n of names) if (n) expect(all).not.toContain(n);
    for (const creator of Object.keys(profile.creators)) expect(all.toLowerCase()).not.toContain(creator);
    expect(all).not.toMatch(BANNED);
    // Policy constraints
    expect(system).toMatch(/with vocals/);
    expect(system).toMatch(/well known in their scene/);
    expect(system).toMatch(/Never obscure, avant-garde, experimental, ambient/);
    expect(system).toMatch(/One song per artist/);
    expect(system).toMatch(/smooth listening flow/);
    expect(system).toMatch(/no live, remix/);
    const reg = plan.lanes.find((l) => l.regional)!;
    expect(reg.era.from).toBeGreaterThanOrEqual(2015);
    expect(user).toContain(`modern only: released ${reg.era.from} or later, no traditional or classic-era songs`);
    for (const l of plan.lanes) expect(user).toContain(`lane "${l.id}" (${l.label})`);
    expect(user).toMatch(/\b(9|1[0-4]) songs/);
    expect(user).toMatch(/Session mood: melancholic/);
    // Lanes carry mood/energy from the library medians.
    expect(user).toMatch(/(melancholic|bittersweet|warm|upbeat)/);
  });

  it('only passes user-typed dislikes to the curator', () => {
    const p = { ...profile, explicit: { ...profile.explicit, dislikes: ['no christmas songs'] }, creators: { ...profile.creators, 'skipped artist': -1.2 } };
    const plan = planMusic(p, { hasQuery: false, seed: 1, total: 10, now: NOW })!;
    const { user } = curatorPrompt(buildBrief(plan, p));
    expect(user).toMatch(/Avoid: no christmas songs/);
    expect(user).not.toMatch(/skipped artist/);
  });

  it('keeps typed requests query-driven but applies era/vocal/familiarity rules unless asked otherwise', () => {
    const intent = parseIntent('upbeat moroccan rap for a road trip');
    const plan = planMusic(profile, { hasQuery: true, seed: 1, total: 12, text: intent.rawText, now: NOW })!;
    expect(plan).toMatchObject({ mode: 'request', order: ['request'], targets: { request: 12 } });
    const { system, user } = curatorPrompt(buildBrief(plan, profile, { intent }));
    expect(user).toMatch(/^Request: upbeat moroccan rap for a road trip/);
    expect(system).toMatch(/first released in or after 2005; French, Arabic or Maghreb songs only from 2015 on/);
    expect(system).toMatch(/with vocals/);
    expect(system).toMatch(/well known in their scene/);
    for (const n of names) if (n) expect(`${system}${user}`).not.toContain(n);

    expect(requestRules('old school 90s hip hop classics')).toMatchObject({ era: false });
    expect(requestRules('instrumental piano for focus')).toMatchObject({ vocals: false });
    expect(requestRules('obscure underground deep cuts')).toMatchObject({ familiar: false });
    const old = planMusic(profile, { hasQuery: true, seed: 1, total: 12, text: 'classic 70s soul', now: NOW })!;
    expect(curatorPrompt(buildBrief(old, profile, { intent: parseIntent('classic 70s soul') })).system).not.toMatch(/released in or after/);
  });

  it('cache key changes with every seed and is stable for the same seed and brief', async () => {
    const plan = planMusic(profile, { hasQuery: false, seed: 2, total: 10, now: NOW })!;
    const prompt = curatorPrompt(buildBrief(plan, profile));
    const a = await curatorCacheKey('m', prompt, 2);
    expect(await curatorCacheKey('m', prompt, 2)).toBe(a);
    expect(await curatorCacheKey('m', prompt, 3)).not.toBe(a);
    expect(await curatorCacheKey('m', prompt, 6)).not.toBe(a); // no seed % 4 reuse
  });

  it('parses curator JSON: artist + track required, one song per artist', () => {
    const picks = parseMusicPicks(JSON.stringify({ items: [{ artist: 'A', track: 'One', lane: 'Hiphop-RNB' }, { artist: 'a', track: 'Two', lane: 'edm' }, { artist: 'B' }, { artist: 'C', track: 'Three' }] }));
    expect(picks).toEqual([{ artist: 'A', track: 'One', lane: 'hiphop-rnb' }, { artist: 'C', track: 'Three' }]);
    expect(parseMusicPicks(JSON.stringify({ items: [{ artist: 'D', track: 'Four', lane: 'edm', genre: 'Tropical House' }] }))).toEqual([{ artist: 'D', track: 'Four', lane: 'edm', genre: 'Tropical House' }]);
    // Fenced, with chatter around it.
    expect(parseMusicPicks('Here you go:\n```json\n{"items":[{"artist":"E","track":"Five","lane":"edm"}]}\n```')).toEqual([{ artist: 'E', track: 'Five', lane: 'edm' }]);
    // Cut off mid-answer: every complete song survives.
    expect(parseMusicPicks('{"items":[{"artist":"F","track":"Six","lane":"edm"},{"artist":"G","track":"Seven","lane":"edm"},{"artist":"H","tra')).toEqual([
      { artist: 'F', track: 'Six', lane: 'edm' },
      { artist: 'G', track: 'Seven', lane: 'edm' },
    ]);
    expect(parseMusicPicks('sorry, no')).toEqual([]);
  });

  it('maps a lyrics language to its regional lane', () => {
    expect(regionalLaneOfLanguage('French')).toBe('french');
    expect(regionalLaneOfLanguage('français')).toBe('french');
    expect(regionalLaneOfLanguage('Arabic (Darija)')).toBe('arabic-pop');
    expect(regionalLaneOfLanguage('English')).toBeNull();
    expect(regionalLaneOfLanguage('Spanish')).toBeNull();
    expect(regionalLaneOfLanguage(undefined)).toBeNull();
    expect(parseMusicPicks('{"items":[{"artist":"J","track":"T","lane":"hiphop-rnb","genre":"rap","lang":"French"}]}')).toEqual([{ artist: 'J', track: 'T', lane: 'hiphop-rnb', genre: 'rap', lang: 'French' }]);
  });

  it("checks the curator's own style label against the lane", () => {
    expect(styleFitsLane('dance pop', 'afro-latin')).toBe(false);
    expect(styleFitsLane('pop', 'hiphop-rnb')).toBe(false);
    expect(styleFitsLane('electropop', 'edm')).toBe(false);
    expect(styleFitsLane('afrobeats', 'afro-latin')).toBe(true);
    expect(styleFitsLane('neo-soul', 'blues-soul')).toBe(true);
    expect(styleFitsLane('funk', 'blues-soul')).toBe(true);
    expect(styleFitsLane('house', 'melodic-house')).toBe(true);
    expect(styleFitsLane('alternative R&B', 'hiphop-rnb')).toBe(true);
    expect(styleFitsLane('indie rock', 'rock-metal')).toBe(true);
    expect(styleFitsLane('Moroccan rap', 'arabic-pop')).toBe(true);
  });

  it('a whole music page uses 4 lanes in one curator call of at most MAX_ASK songs', () => {
    const { profile } = importedProfile();
    const page = planMusic(profile, { hasQuery: false, seed: 2, total: 24, now: NOW })!;
    expect(page.lanes.length).toBe(Math.min(4, profile.music!.lanes!.length));
    const brief = buildBrief(page, profile);
    expect(brief.lanes!.reduce((n, l) => n + l.count, 0)).toBeLessThanOrEqual(MAX_ASK);
    expect(Math.min(...brief.lanes!.map((l) => l.count))).toBeGreaterThanOrEqual(9);
  });

  it('asks the curator for each song\'s own style and to keep lanes pure', () => {
    const { profile } = importedProfile();
    const plan = planMusic(profile, { hasQuery: false, seed: 3, total: 12, now: NOW })!;
    const { system } = curatorPrompt(buildBrief(plan, profile));
    expect(system).toMatch(/"genre"/);
    expect(system).toMatch(/squarely belong to its lane/);
    expect(system).toMatch(/never contain French-, Arabic- or Maghreb-language songs/);
  });
});

describe('featured artists in curator picks', () => {
  it('asks for the clean official title and a "feat" list in both the lane and the request prompts', () => {
    const lanes = curatorPrompt({ lanes: [{ id: 'edm', label: 'EDM', descriptors: ['edm'], fromYear: 2010, regional: false, count: 9 }] });
    const request = curatorPrompt({ request: { text: 'songs for a night drive', count: 10, vocals: true, familiar: true } });
    for (const p of [lanes, request]) {
      expect(p.system).toMatch(/"feat":\["<featured artist>"\]/);
      expect(p.system).toMatch(/"track" is the official song title WITHOUT any "\(feat\. …\)", "\(with …\)" or version part/);
      expect(p.system).toMatch(/"artist" is the main credited artist only/);
      expect(p.system).toMatch(/\[\] when none/);
    }
  });

  it('reads "feat" as an array or a string, at most 4 names, never the main artist; omitted when empty', () => {
    const picks = parseMusicPicks(JSON.stringify({ items: [
      { artist: 'A', track: 'One', feat: ['Guest X'], lane: 'edm' },
      { artist: 'B', track: 'Two', feat: 'Guest Y, Guest Z & Guest W', lane: 'edm' },
      { artist: 'C', track: 'Three', feat: [], lane: 'edm' },
      { artist: 'D', track: 'Four', feat: ['D', 'g1', 'G1', 'g2', 'g3', 'g4', 'g5', 7, ''], lane: 'edm' },
      { artist: 'E', track: 'Five', featuring: ['Guest V'] },
    ] }));
    expect(picks).toEqual([
      { artist: 'A', track: 'One', feat: ['Guest X'], lane: 'edm' },
      { artist: 'B', track: 'Two', feat: ['Guest Y', 'Guest Z', 'Guest W'], lane: 'edm' },
      { artist: 'C', track: 'Three', lane: 'edm' },
      { artist: 'D', track: 'Four', feat: ['g1', 'g2', 'g3', 'g4'], lane: 'edm' },
      { artist: 'E', track: 'Five', feat: ['Guest V'] },
    ]);
    // A cut-off answer keeps complete songs, arrays included.
    expect(parseMusicPicks('{"items":[{"artist":"F","track":"Six","feat":["Guest U"],"lane":"edm"},{"artist":"G","tra')).toEqual([{ artist: 'F', track: 'Six', feat: ['Guest U'], lane: 'edm' }]);
  });

  it('passes the featured artists on to the resolver (ListenBrainz needs the full credit)', async () => {
    const lbRows: string[] = [];
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{ artist: 'Main Act', track: 'Glass Coast', feat: ['Guest Star'], lane: 'edm', genre: 'edm' }] }) } }] }));
      if (url.includes('listenbrainz')) {
        for (const r of JSON.parse(String(init?.body)) as Array<{ artist_name: string; track_name: string }>) lbRows.push(`${r.artist_name}|${r.track_name}`);
        return new Response('[]');
      }
      if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const { curateMusic } = await import('@shared/engine/curator.ts');
    const { profile } = importedProfile();
    const plan = { ...planMusic(profile, { hasQuery: false, seed: 1, total: 3, now: NOW })! };
    const edm = { ...plan.lanes[0], id: 'edm', label: 'EDM & tropical house' };
    const one = { ...plan, lanes: [edm], order: ['edm'], targets: { edm: 3 } };
    const env = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b' } as Record<string, string>)[n];
    await curateMusic(one, { ai: { baseUrl: 'https://ai.test/v1', model: 'm' }, http: createHttp(new MemoryCache(), fetchImpl), env, profile, searchBlocked: true, now: NOW });
    expect(lbRows).toContain('Main Act feat. Guest Star|Glass Coast');
  });
});

describe('curator model handover', () => {
  it('uses the general model when the music model is over its per-minute limit', async () => {
    const models: string[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      models.push(body.model);
      if (body.model === 'music-model') return new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{ artist: 'A', track: 'One', lane: 'edm', genre: 'edm' }] }) } }] }));
    }) as unknown as typeof fetch;
    const picks = await llmMusicPicks({ lanes: [{ id: 'edm', label: 'EDM', descriptors: ['edm'], fromYear: 2010, regional: false, count: 9 }] }, { baseUrl: 'https://ai.test/v1', model: 'general-model', musicModel: 'music-model' }, createHttp(new MemoryCache(), fetchImpl), { seed: 1 });
    expect(models).toEqual(['music-model', 'general-model']);
    expect(picks).toEqual([{ artist: 'A', track: 'One', lane: 'edm', genre: 'edm' }]);
  });
});

describe('curator picks the lane rules turned down (live sessions)', () => {
  it('an artist whose song the ISRC guard rejected is a regional artist, not a lane pick: their session never joins the lane', async () => {
    const { curateMusic } = await import('@shared/engine/curator.ts');
    const { matchLaneSessions } = await import('@shared/engine/sessions.ts');
    const { LB_SPOTIFY_MAPPING_URL } = await import('@shared/providers/listenbrainz.ts');
    const tid = (n: number) => `TRK${String(n).padStart(19, '0')}`;
    const tracks: Record<string, { name: string; artist: string; isrc: string }> = {
      [tid(1)]: { name: 'Meuda', artist: 'Synth Rappeur', isrc: 'FRUM72300001' },
      [tid(2)]: { name: 'Flow', artist: 'US Rapper', isrc: 'USRC12300001' },
    };
    const lb: Record<string, string> = { 'Synth Rappeur|Meuda': tid(1), 'US Rapper|Flow': tid(2) };
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      // The curator mislabels a French rapper: "English, afro trap".
      if (url.includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [
        { artist: 'Synth Rappeur', track: 'Meuda', lane: 'hiphop-rnb', lang: 'English', genre: 'afro trap' },
        { artist: 'US Rapper', track: 'Flow', lane: 'hiphop-rnb', lang: 'English', genre: 'rap' },
      ] }) } }] }));
      if (url === LB_SPOTIFY_MAPPING_URL) {
        const rows = JSON.parse(String(init?.body)) as Array<{ artist_name: string; track_name: string }>;
        return new Response(JSON.stringify(rows.map((r) => ({ ...r, spotify_track_ids: lb[`${r.artist_name}|${r.track_name}`] ? [lb[`${r.artist_name}|${r.track_name}`]] : [] }))));
      }
      if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      const m = /\/v1\/tracks\/([A-Za-z0-9]+)/.exec(url);
      if (m && tracks[m[1]]) {
        const t = tracks[m[1]];
        return new Response(JSON.stringify({
          id: m[1], name: t.name, artists: [{ id: 'a', name: t.artist }], album: { id: 'al', name: 'Album', images: [], release_date: '2023-05-01', album_type: 'album' },
          duration_ms: 200000, external_urls: { spotify: `https://open.spotify.com/track/${m[1]}` }, is_playable: true, external_ids: { isrc: t.isrc },
        }));
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const { profile } = importedProfile();
    const frenchOff: TasteProfile = { ...profile, explicit: { ...profile.explicit, blockedFamilies: ['french-rap', 'french-chanson'] } };
    const base = planMusic(frenchOff, { hasQuery: false, seed: 1, total: 6, now: NOW })!;
    const hip = { ...base.lanes[0], id: 'hiphop-rnb', label: 'Hip-hop & R&B', regional: false, era: { from: 2010, to: 2026 } };
    const plan = { ...base, mode: 'lanes' as const, lanes: [hip], order: ['hiphop-rnb'], targets: { 'hiphop-rnb': 6 } };
    const env = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b' } as Record<string, string>)[n];
    const r = await curateMusic(plan, { ai: { baseUrl: 'https://ai.test/v1', model: 'm' }, http: createHttp(new MemoryCache(), fetchImpl), env, profile: frenchOff, searchBlocked: true, now: NOW });
    expect(r.items.map((i) => i.title)).toEqual(['Flow']);
    expect(r.detail).toMatch(/regional-language 1/);
    expect(r.lanePicks).toEqual({ 'hiphop-rnb': [{ artist: 'US Rapper' }] });
    expect(r.regionalArtists).toContainEqual({ artist: 'Synth Rappeur', region: 'french' });
    // Their COLORS session (no audio language, an English-looking title) stays out of the hip-hop lane.
    const pool = [{ videoId: 'vidSYNTH001', channel: 'colors', title: 'Synth Rappeur - Meuda | A COLORS SHOW', publishedAt: '2026-11-10T00:00:00Z', durationSec: 240 }];
    expect(matchLaneSessions(pool, { lanes: [hip], picks: r.lanePicks, regionalArtists: r.regionalArtists, profile: frenchOff })).toEqual([]);
  });
});
