// Live sessions in music lanes: title parsing per channel format, local lane matching (curator picks,
// library artists, channel-only), and the owner's rules (French off, repeats, shorts, disliked artists).
// Synthetic artists and titles only.
import { describe, expect, it } from 'vitest';
import { creditNames, looksFrench, matchEntitySessions, matchLaneSessions, parseSessionTitle, refreshedLaneVideo } from '@shared/engine/sessions.ts';
import { isLaneVideo, LANE_VIDEO_PREFIX, librarySongIndex, sessionTagOf, withoutPerUser } from '@shared/engine/lanes.ts';
import { emptyProfile } from '@shared/engine/profile.ts';
import type { SessionVideo } from '@shared/providers/youtube.ts';
import type { MusicLane, TasteProfile } from '@shared/types.ts';

describe('session titles, per channel format', () => {
  it.each([
    ['tinydesk', 'Nova Lyric & The Night Band: NPR Music Tiny Desk Concert', { artist: 'Nova Lyric & The Night Band', artists: ['Nova Lyric', 'The Night Band'] }],
    ['tinydesk', 'Velvet Static: Tiny Desk Concert', { artist: 'Velvet Static', artists: ['Velvet Static'] }],
    ['tinydesk', 'Velvet Static: Tiny Desk (Home) Concert', { artist: 'Velvet Static' }],
    ['colors', 'Nova Lyric - Night Letter | A COLORS SHOW', { artist: 'Nova Lyric', song: 'Night Letter' }],
    ['colors', 'Amber Coast | A COLORS SHOW', { artist: 'Amber Coast' }],
    ['colors', 'Amber Coast - Tidal | A COLORS ENCORE', { artist: 'Amber Coast', song: 'Tidal' }],
    ['kexp', 'Loud Band - Full Performance (Live on KEXP)', { artist: 'Loud Band' }],
    ['kexp', 'Loud Band - Iron Sky (Live on KEXP)', { artist: 'Loud Band', song: 'Iron Sky' }],
    ['kexp', 'Grey Harbour | KEXP', { artist: 'Grey Harbour' }],
    ['audiotree', 'Grey Harbour on Audiotree Live (Full Session)', { artist: 'Grey Harbour' }],
    ['audiotree', 'Grey Harbour - Lantern (Audiotree Live Version)', { artist: 'Grey Harbour', song: 'Lantern' }],
    ['mahogany', 'Willow Lane - Holloway | Mahogany Session', { artist: 'Willow Lane', song: 'Holloway' }],
    ['cercle', 'Deep Meridian live at Château de Sable, France for Cercle', { artist: 'Deep Meridian' }],
    ['cercle', 'Deep Meridian live @ Cercle', { artist: 'Deep Meridian' }],
    ['boilerroom', 'Pulse Theory | Boiler Room: London', { artist: 'Pulse Theory' }],
    ['boilerroom', 'Pulse Theory b2b Night Owl | Boiler Room x Festival', { artist: 'Pulse Theory b2b Night Owl', artists: ['Pulse Theory', 'Night Owl'] }],
    ['boilerroom', 'Pulse Theory Boiler Room Berlin DJ Set', { artist: 'Pulse Theory' }],
    ['sofar', 'Willow Lane - Tomorrow | Sofar London', { artist: 'Willow Lane', song: 'Tomorrow' }],
  ])('%s: %s', (channel, title, want) => {
    expect(parseSessionTitle(title, channel)).toMatchObject({ kind: 'live', ...want });
  });

  it('a music video on any channel is a video, not a live session', () => {
    expect(parseSessionTitle('Amber Coast - Tidal (Official Music Video)', 'colors')).toMatchObject({ artist: 'Amber Coast', song: 'Tidal', kind: 'video' });
  });

  it('channel announcements, interviews and unknown formats are not sessions', () => {
    for (const [ch, t] of [
      ['tinydesk', 'Tiny Desk Contest 2026: how to enter'],
      ['kexp', 'Loud Band - Interview (Live on KEXP)'],
      ['cercle', 'Cercle Odyssey live at the Desert'],
      ['boilerroom', 'Boiler Room x Festival: highlights'],
      ['colors', 'COLORS - a year in review'],
      ['sofar', 'What is Sofar Sounds?'],
    ]) expect(parseSessionTitle(t, ch)).toBeNull();
  });

  it('splits credits on &, x, b2b, feat. — never on "and" (band names)', () => {
    expect(creditNames('Nova Lyric feat. Amber Coast')).toEqual(['Nova Lyric', 'Amber Coast']);
    expect(creditNames('Salt and Pepper Club')).toEqual(['Salt and Pepper Club']);
  });

  it('French song titles', () => {
    for (const t of ["C'est la vie", 'Pour toi', 'Ça va', 'Je ne sais pas', 'Les nuits sans toi']) expect(looksFrench(t)).toBe(true);
    for (const t of ['Night Letter', 'La Bamba', 'Holloway', undefined, 'Tu amor']) expect(looksFrench(t)).toBe(false);
  });
});

const lane = (id: string, label: string, regional = false): MusicLane => ({
  id, label, share: 0.3, descriptors: [], era: { from: 2005, to: 2026 }, energy: NaN, danceability: NaN, valence: NaN, popularity: { p25: NaN, p50: NaN, p75: NaN }, regional, genres: [], source: 'library',
});
const HIP = lane('hiphop-rnb', 'Hip-hop & R&B');
const SOUL = lane('blues-soul', 'Blues, soul & Americana');
const ROCK = lane('rock-metal', 'Rock & metal');
const HOUSE = lane('melodic-house', 'Afro & melodic house');

let n = 0;
const video = (channel: string, title: string, over: Partial<SessionVideo> = {}): SessionVideo => {
  n++;
  return { videoId: `vid${String(n).padStart(8, '0')}`, channel, title, publishedAt: new Date(Date.UTC(2026, 10, 15) - n * 3600_000).toISOString(), durationSec: 900, ...over };
};
const profileWith = (o: { creators?: Record<string, number>; frenchOff?: boolean; dislikes?: string[] } = {}): TasteProfile => {
  const p = emptyProfile();
  return { ...p, creators: o.creators ?? {}, explicit: { ...p.explicit, dislikes: o.dislikes ?? [], blockedFamilies: o.frenchOff ? ['french-rap', 'french-chanson'] : [] } };
};
const titles = (xs: Array<{ title: string }>) => xs.map((x) => x.title);

describe('matching sessions to lanes, locally', () => {
  it('a curator pick for the lane wins; a library artist joins the lane their songs are in; one per artist', () => {
    const pool = [
      video('colors', 'Nova Lyric - Night Letter | A COLORS SHOW'),
      video('colors', 'Nova Lyric - Second Take | A COLORS SHOW'), // same artist again
      video('tinydesk', 'Velvet Static: Tiny Desk Concert'),
    ];
    const lib = librarySongIndex([{ id: 'spotify:track:L1', title: 'Old Favourite', creators: ['Velvet Static'], genres: ['soul', 'retro soul'] }]);
    const out = matchLaneSessions(pool, {
      lanes: [HIP, SOUL], picks: { 'hiphop-rnb': [{ artist: 'Nova Lyric' }] }, profile: profileWith({ creators: { 'velvet static': 1.1 } }), libraryArtistLanes: lib.artistLanes,
    });
    expect(out.map((v) => [v.title, (v.metadata?.lane as { id: string }).id, v.metadata?.videoMatch])).toEqual([
      ['Nova Lyric - Night Letter | A COLORS SHOW', 'hiphop-rnb', 'pick'],
      ['Velvet Static: Tiny Desk Concert', 'blues-soul', 'library'],
    ]);
    // The lane-item contract: a music item with its own id, the performing artists as creators.
    const v = out[0];
    expect(isLaneVideo(v)).toBe(true);
    expect(v).toMatchObject({ id: `${LANE_VIDEO_PREFIX}${pool[0].videoId}`, category: 'music', kind: 'video', provider: 'youtube', creators: ['Nova Lyric'], embed: { type: 'youtube', videoId: pool[0].videoId } });
    expect(v.metadata).toMatchObject({ video: true, videoKind: 'live' });
    expect(sessionTagOf(v)).toEqual({ channel: 'colors', venue: 'COLORS', prep: 'on', artist: 'Nova Lyric', label: 'Night Letter' });
    // The match kind is per user: never stored in the shared catalog row.
    expect(withoutPerUser(v.metadata)).not.toHaveProperty('videoMatch');
  });

  it('a library artist whose songs sit in another lane is not placed here', () => {
    const lib = librarySongIndex([{ title: 'Riff', creators: ['Velvet Static'], genres: ['hard rock'] }]);
    const out = matchLaneSessions([video('tinydesk', 'Velvet Static: Tiny Desk Concert')], { lanes: [SOUL], profile: profileWith({ creators: { 'velvet static': 1 } }), libraryArtistLanes: lib.artistLanes });
    // Not a soul artist; as a channel-only pick it would be guessing against what the library says.
    expect(out).toEqual([]);
  });

  it('without an artist match, at most one channel-only session: the most recent one not shown lately', () => {
    const newest = video('kexp', 'Loud Band - Full Performance (Live on KEXP)');
    const next = video('kexp', 'Grey Harbour | KEXP');
    const older = video('audiotree', 'Iron Coast on Audiotree Live (Full Session)');
    const all = matchLaneSessions([older, next, newest], { lanes: [ROCK], profile: profileWith() });
    expect(titles(all)).toEqual([newest.title]);
    expect(all[0].metadata?.videoMatch).toBe('channel');
    // Shown in the last 3 days → the next one.
    const again = matchLaneSessions([older, next, newest], { lanes: [ROCK], profile: profileWith(), excludeIds: new Set([`${LANE_VIDEO_PREFIX}${newest.videoId}`]) });
    expect(titles(again)).toEqual([next.title]);
  });

  it('up to 3 artist matches per lane, picks before library artists', () => {
    const pool = [
      video('colors', 'Amber Coast | A COLORS SHOW'),
      video('tinydesk', 'Nova Lyric: Tiny Desk Concert'),
      video('colors', 'Rhyme Engine - Verse | A COLORS SHOW'),
      video('colors', 'Fourth Voice - Song | A COLORS SHOW'),
    ];
    const lib = librarySongIndex([{ title: 'x', creators: ['Amber Coast'], genres: ['rap'] }]);
    const out = matchLaneSessions(pool, {
      lanes: [HIP], picks: { 'hiphop-rnb': [{ artist: 'Nova Lyric' }, { artist: 'Rhyme Engine' }, { artist: 'Fourth Voice' }] },
      profile: profileWith({ creators: { 'amber coast': 0.8 } }), libraryArtistLanes: lib.artistLanes,
    });
    expect(out).toHaveLength(3);
    expect(out.map((v) => v.metadata?.videoMatch)).toEqual(['pick', 'pick', 'pick']);
  });

  it('French off: no French session (title, audio language, or an artist the curator labelled French) in any lane', () => {
    const french = video('colors', "Zoé Nuit - C'est la nuit | A COLORS SHOW");
    const frAudio = video('colors', 'Lune Rouge - Moon | A COLORS SHOW', { lang: 'fr' });
    const labelled = video('tinydesk', 'Rap Maison: Tiny Desk Concert');
    const english = video('colors', 'Nova Lyric - Night Letter | A COLORS SHOW');
    const picks = { 'hiphop-rnb': ['Zoé Nuit', 'Lune Rouge', 'Rap Maison', 'Nova Lyric'].map((artist) => ({ artist })) };
    const out = matchLaneSessions([french, frAudio, labelled, english], {
      lanes: [HIP], picks, regionalArtists: [{ artist: 'Rap Maison', region: 'french' }], profile: profileWith({ frenchOff: true }),
    });
    expect(titles(out)).toEqual([english.title]);
  });

  it('a French DJ set may join a language-neutral lane only while French is on', () => {
    const set = video('cercle', 'Deep Meridian live at the Old Harbour for Cercle', { lang: 'fr' });
    const on = matchLaneSessions([set], { lanes: [HOUSE], picks: { 'melodic-house': [{ artist: 'Deep Meridian' }] }, profile: profileWith() });
    expect(titles(on)).toEqual([set.title]);
    const off = matchLaneSessions([set], { lanes: [HOUSE], picks: { 'melodic-house': [{ artist: 'Deep Meridian' }] }, profile: profileWith({ frenchOff: true }) });
    expect(off).toEqual([]);
  });

  it('no shorts, no disliked artists, nothing for regional or pseudo lanes', () => {
    const short = video('colors', 'Nova Lyric - Clip | A COLORS SHOW', { durationSec: 40 });
    const disliked = video('colors', 'Bad Act - Song | A COLORS SHOW');
    const picks = { 'hiphop-rnb': [{ artist: 'Nova Lyric' }, { artist: 'Bad Act' }] };
    expect(matchLaneSessions([short, disliked], { lanes: [HIP], picks, profile: profileWith({ dislikes: ['bad act'] }) })).toEqual([]);
    const ok = video('colors', 'Nova Lyric - Song | A COLORS SHOW');
    expect(matchLaneSessions([ok], { lanes: [lane('french', 'French pop & rap', true), lane('mix', 'Fresh picks')], picks: { french: [{ artist: 'Nova Lyric' }] }, profile: profileWith() })).toEqual([]);
  });

  it('each video joins one lane only', () => {
    const v = video('tinydesk', 'Nova Lyric: Tiny Desk Concert');
    const out = matchLaneSessions([v], { lanes: [HIP, SOUL], picks: { 'hiphop-rnb': [{ artist: 'Nova Lyric' }], 'blues-soul': [{ artist: 'Nova Lyric' }] }, profile: profileWith() });
    expect(out).toHaveLength(1);
    expect((out[0].metadata?.lane as { id: string }).id).toBe('hiphop-rnb');
  });
});

describe('a named artist’s own lane', () => {
  it('takes up to the cap of their sessions from any channel, newest first, tagged for the entity', () => {
    const pool = [
      video('kexp', 'Nova Lyric - Iron Sky (Live on KEXP)'),
      video('tinydesk', 'Nova Lyric: Tiny Desk Concert'),
      video('colors', 'Someone Else | A COLORS SHOW'),
      video('colors', 'Nova Lyric - Third | A COLORS SHOW'),
    ];
    const by = { id: 'entity-by', label: 'Nova Lyric', genres: [] };
    const out = matchEntitySessions(pool, { name: 'Nova Lyric', lane: by, max: 2 });
    expect(titles(out)).toEqual(['Nova Lyric - Iron Sky (Live on KEXP)', 'Nova Lyric: Tiny Desk Concert']);
    expect(out[0].metadata).toMatchObject({ lane: { id: 'entity-by', label: 'Nova Lyric' }, videoMatch: 'entity', entity: { name: 'Nova Lyric', role: 'by', note: 'live on KEXP' } });
  });
});

describe('library artist lanes and catalog refresh', () => {
  it('each library artist goes to the lane most of their songs are in', () => {
    const lib = librarySongIndex([
      { title: 'a', creators: ['Split Artist'], genres: ['rap'] },
      { title: 'b', creators: ['Split Artist'], genres: ['trap'] },
      { title: 'c', creators: ['Split Artist'], genres: ['soul'] },
      { title: 'd', creators: ['No Genres'] },
    ]);
    expect(lib.artistLanes?.get('split artist')).toBe('hiphop-rnb');
    expect(lib.artistLanes?.has('no genres')).toBe(false);
  });

  it('a stored lane video refreshed from YouTube keeps its lane-item shape', () => {
    const [v] = matchLaneSessions([video('colors', 'Nova Lyric - Song | A COLORS SHOW')], { lanes: [HIP], picks: { 'hiphop-rnb': [{ artist: 'Nova Lyric' }] }, profile: profileWith() });
    const fresh = { ...v, id: `youtube:video:${v.externalId}`, category: 'youtube' as const, title: 'Nova Lyric - Song | A COLORS SHOW (new title)', creators: ['COLORS'], embed: null, playbackNote: 'disabled' };
    const r = refreshedLaneVideo(v, fresh);
    expect(r).toMatchObject({ id: v.id, category: 'music', creators: ['Nova Lyric'], title: fresh.title, embed: null });
    expect(r.metadata?.session).toEqual(v.metadata?.session);
    // A row the daily 30-day cleanup stripped gets its artists and session back from the fresh title.
    const stripped = { ...v, title: 'YouTube video', creators: [], metadata: {} };
    const back = refreshedLaneVideo(stripped, { ...fresh, title: 'Nova Lyric - Song | A COLORS SHOW', metadata: { channelTitle: 'COLORS' } });
    expect(back).toMatchObject({ id: v.id, category: 'music', creators: ['Nova Lyric'], metadata: { video: true, videoKind: 'live', session: { channel: 'colors', venue: 'COLORS', artist: 'Nova Lyric', label: 'Song' } } });
  });
});
