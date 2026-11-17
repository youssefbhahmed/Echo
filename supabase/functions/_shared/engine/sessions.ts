// Live sessions and music videos in music lanes. The pool (providers/youtube.ts liveSessionPool) holds
// recent uploads of well-known session channels; here each one is read from its title ("Artist: Tiny
// Desk Concert", "Artist - Song | A COLORS SHOW", "Artist live at … for Cercle") and matched to this
// refresh's lanes LOCALLY: titles never go to an AI model, and the names they are compared with are the
// curator's own words and the user's own library. Pure functions, no I/O.
import type { ContentItem, MusicLane, TasteProfile } from '../types.ts';
import { artistMatches } from '../providers/spotify.ts';
import { SESSION_CHANNEL_BY_KEY, SESSION_CHANNELS, type SessionChannel, type SessionVideo } from '../providers/youtube.ts';
import { ENTITY_BY_LANE, isDislikedArtist, LANE_BY_ID, LANE_VIDEO_PREFIX, laneTag, type SessionTag } from './lanes.ts';
import { blockedRegions, regionOfLanguage } from './curator.ts';
import { normKey } from './text.ts';

export interface ParsedSession {
  /** The credit as the title gives it ("Anderson .Paak & The Free Nationals"). */
  artist: string;
  /** Each performing artist ("Anderson .Paak", "The Free Nationals"), at most 4. */
  artists: string[];
  /** The song, when the title names one. */
  song?: string;
  kind: 'live' | 'video';
}

const DASH = String.raw`\s+[-–—]\s+`;
/** "A & B", "A x B", "A b2b B", "A feat. B", "A, B" → each artist (never split on "and": "Mumford and Sons"). */
const CREDIT_SPLIT = /\s*,\s*|\s+(?:&|x|×|\+|b2b|with|feat\.?|ft\.?|featuring)\s+/i;

export function creditNames(credit: string): string[] {
  const parts = credit.split(CREDIT_SPLIT).map((x) => x.trim()).filter((x) => x.length > 0 && x.length <= 60);
  return [...new Set(parts)].slice(0, 4);
}

const clean = (x: string | undefined) => (x ?? '').replace(/^["“'‘\s]+|["”'’\s]+$/g, '').replace(/\s+/g, ' ').trim();

/** Titles that are about a channel's shows, not one artist's session ("Tiny Desk Contest", "Cercle Odyssey"). */
const NOT_A_SESSION = /\b(trailer|teaser|announc\w*|interview|behind the scenes|documentary|playlist|compilation|mix of the|best of|top \d+|livestream|stream|podcast|q\s?&\s?a|contest)\b/i;

type Parser = (t: string) => { artist: string; song?: string; kind?: 'live' | 'video' } | null;

const re = (src: string, flags = 'i') => new RegExp(src, flags);

/** Per-channel title formats. */
const PARSERS: Record<string, Parser[]> = {
  tinydesk: [
    (t) => { const m = re(String.raw`^(.+?)\s*[:|–—-]\s*(?:NPR Music\s+)?Tiny Desk\s+(?:\(?Home\)?\s+)?Concert\b`).exec(t); return m ? { artist: m[1] } : null; },
  ],
  colors: [
    (t) => { const m = re(String.raw`^(.+?)${DASH}(.+?)\s*\|\s*A COLORS (?:SHOW|ENCORE)\b`).exec(t); return m ? { artist: m[1], song: m[2] } : null; },
    (t) => { const m = re(String.raw`^(.+?)\s*\|\s*A COLORS (?:SHOW|ENCORE)\b`).exec(t); return m ? { artist: m[1] } : null; },
  ],
  kexp: [
    (t) => { const m = re(String.raw`^(.+?)${DASH}(.+?)\s*\(\s*Live (?:on|at) KEXP\b[^)]*\)`).exec(t); return m ? { artist: m[1], song: m[2] } : null; },
    (t) => { const m = re(String.raw`^(.+?)\s*\|\s*KEXP\b`).exec(t); return m ? { artist: m[1] } : null; },
  ],
  audiotree: [
    (t) => { const m = re(String.raw`^(.+?)\s+on Audiotree Live\b`).exec(t); return m ? { artist: m[1] } : null; },
    (t) => { const m = re(String.raw`^(.+?)${DASH}(.+?)\s*[(|]\s*(?:Audiotree Live|Live on Audiotree)\b`).exec(t); return m ? { artist: m[1], song: m[2] } : null; },
  ],
  mahogany: [
    (t) => { const m = re(String.raw`^(.+?)${DASH}(.+?)\s*[(|]\s*(?:A\s+)?Mahogany Sessions?\b`).exec(t); return m ? { artist: m[1], song: m[2] } : null; },
  ],
  cercle: [
    (t) => { const m = re(String.raw`^(.+?)\s+(?:live|dj set)\s+(?:@|at|from|in|on)\s+.+`).exec(t); return m && !/^cercle\b/i.test(m[1]) ? { artist: m[1] } : null; },
  ],
  boilerroom: [
    (t) => { const m = re(String.raw`^(.+?)\s*\|\s*Boiler Room\b`).exec(t); return m && !/^boiler room\b/i.test(m[1]) ? { artist: m[1] } : null; },
    (t) => { const m = re(String.raw`^(.+?)\s+(?:(?:DJ set|live)\s+)?(?:@|at\s+)?Boiler Room\b`).exec(t); return m && !/^boiler room\b/i.test(m[1]) ? { artist: m[1] } : null; },
  ],
  sofar: [
    (t) => { const m = re(String.raw`^(.+?)${DASH}(.+?)\s*\|\s*Sofar\b`).exec(t); return m ? { artist: m[1], song: m[2] } : null; },
  ],
};

/** Formats any channel may use: "Artist - Song (Official Video)", "Artist - Song (Live at …)". */
const GENERIC: Parser[] = [
  (t) => { const m = re(String.raw`^(.+?)${DASH}(.+?)\s*[([]\s*Official (?:Music )?Video\s*[)\]]`).exec(t); return m ? { artist: m[1], song: m[2], kind: 'video' } : null; },
  (t) => { const m = re(String.raw`^(.+?)${DASH}(.+?)\s*[([]\s*Live\b[^)\]]*[)\]]`).exec(t); return m ? { artist: m[1], song: m[2] } : null; },
];

/** "Full Performance", "Full Session #2" name the session, not a song. */
const NOT_A_SONG = /^(full (performance|session|set|concert)|live session|session|performance|concert)\b/i;

/**
 * The artist (and song) a session channel's upload is by, from its title; null when the title isn't one
 * artist's session (channel announcements, compilations, interviews, formats we don't know).
 */
export function parseSessionTitle(title: string, channel: string): ParsedSession | null {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t || NOT_A_SESSION.test(t)) return null;
  for (const p of [...(PARSERS[channel] ?? []), ...GENERIC]) {
    const r = p(t);
    if (!r) continue;
    const artist = clean(r.artist);
    if (!artist || artist.length > 80 || /^(npr|colors|kexp|audiotree|mahogany|cercle|boiler room|sofar)\b/i.test(artist)) return null;
    const artists = creditNames(artist);
    if (!artists.length) return null;
    const song = clean(r.song);
    return { artist, artists, ...(song && !NOT_A_SONG.test(song) ? { song } : {}), kind: r.kind ?? 'live' };
  }
  return null;
}

// Strongly French words (not Spanish/Italian/English homographs) and elisions ("c'est", "j'ai", "l'amour").
const FRENCH_WORDS = new Set([
  'les', 'des', 'une', 'est', 'suis', 'sont', 'fait', 'pour', 'avec', 'dans', 'et', 'mon', 'mes', 'ton', 'tes', 'nous', 'vous', 'je', 'il', 'elle', 'cette', 'qui', 'pas', 'sans',
  'toujours', 'jamais', 'rien', 'moi', 'toi', 'quand', 'comme', 'sur', 'du', 'au', 'aux', 'ça', 'mais', 'oui', 'encore', 'amour', 'cœur', 'coeur', 'nuit', 'jour', 'veux', 'peux',
]);
const ELISION = /^(?:c|j|l|d|n|qu|m|t|s)['’][a-zàâäéèêëîïôöùûüç]/;
const FRENCH_ACCENT = /[éèêàçùûôîœ]/i;

/** A song title in French: two French words, or one with a French accent or elision ("C'est la vie", "Pour toi", "Ça va"). */
export function looksFrench(text: string | undefined): boolean {
  if (!text) return false;
  const tokens = text.toLowerCase().split(/[^a-zàâäéèêëîïôöùûüçœ'’]+/).filter(Boolean);
  const hits = new Set(tokens.filter((w) => FRENCH_WORDS.has(w) || ELISION.test(w))).size;
  return hits >= 2 || (hits >= 1 && (FRENCH_ACCENT.test(text) || tokens.some((w) => ELISION.test(w))));
}

/** Lanes where lyrics language doesn't mark a recording as regional (DJ sets, instrumental music). */
const LANGUAGE_NEUTRAL = new Set(['melodic-house', 'edm', 'jazz-classical']);

export const laneVideoId = (videoId: string) => `${LANE_VIDEO_PREFIX}${videoId}`;

/** A pool video as a lane item (see the contract in lanes.ts). Per-lane / per-user fields are added by the caller. */
export function laneVideoItem(v: SessionVideo, parsed: ParsedSession, lane: Pick<MusicLane, 'id' | 'label' | 'genres'>, extra: Record<string, unknown> = {}): ContentItem {
  const ch = SESSION_CHANNEL_BY_KEY[v.channel];
  const venue = ch?.venue ?? 'YouTube';
  const session: SessionTag = { channel: v.channel, venue, prep: ch?.prep ?? 'on', artist: parsed.artist, label: parsed.song ?? ch?.session ?? venue };
  const genres = lane.genres?.length ? lane.genres.slice(0, 2) : (LANE_BY_ID[lane.id]?.descriptors ?? []).slice(0, 2);
  return {
    id: laneVideoId(v.videoId), category: 'music', kind: 'video', provider: 'youtube', externalId: v.videoId, title: v.title, creators: parsed.artists,
    description: `${parsed.kind === 'live' ? 'Live session' : 'Music video'}: ${parsed.artist}${parsed.song ? ` – ${parsed.song}` : ''} (${ch?.name ?? 'YouTube'})`,
    genres, tags: [parsed.kind === 'live' ? 'live session' : 'music video', venue], artworkUrl: v.thumb, durationSec: v.durationSec, language: v.lang,
    releaseDate: v.publishedAt?.slice(0, 10), externalUrl: `https://www.youtube.com/watch?v=${v.videoId}`, embed: { type: 'youtube', videoId: v.videoId },
    metadata: { lane: laneTag(lane), video: true, videoKind: parsed.kind, session, channelTitle: ch?.name, fetchedAt: new Date().toISOString(), ...extra },
  };
}

/** A curator pick's artist (its own words) for one lane. */
export interface LanePick {
  artist: string;
  feat?: string[];
}

export interface SessionMatchContext {
  /** This refresh's lanes, in shelf order (pseudo-lanes and regional lanes get no sessions). */
  lanes: Array<Pick<MusicLane, 'id' | 'label' | 'genres' | 'regional'>>;
  /** The curator's picks per lane (artist names in its own words). */
  picks?: Record<string, LanePick[]>;
  /** Artists the curator placed in a regional scene (its words; region 'french' | 'arabic-pop', see curator.ts pickRegion). */
  regionalArtists?: Array<{ artist: string; region: string }>;
  profile: TasteProfile;
  /** normKey(artist) → the lane most of their library songs are in (LibrarySongs.artistLanes). */
  libraryArtistLanes?: Map<string, string>;
  /** Item ids not to show: held back, and shown in the last 3 days (`youtube:music:<id>`). */
  excludeIds?: Set<string>;
  /** Most sessions offered per lane (the ranker places 1–3 of them). */
  perLane?: number;
  channels?: SessionChannel[];
}

/** A library artist counts with a real positive weight (one saved song ≈ 0.35). */
export const LIBRARY_ARTIST_MIN = 0.25;

type Match = 'pick' | 'library' | 'channel';
const MATCH_RANK: Record<Match, number> = { pick: 0, library: 1, channel: 2 };

/**
 * Sessions for this refresh's taste lanes. A session joins a lane when its channel serves the lane and
 * its title names an artist the curator picked for that lane (best) or a library artist whose songs
 * mostly sit in that lane; a lane with no such session may take one "channel-only" session (the most
 * recent one not shown lately) from a channel whose uploads usually fit it. Rules: never an excluded or
 * recently shown video, never a disliked artist; a French / Arabic session (its audio language, a French
 * title, or an artist the curator labelled so) never joins a lane where language marks a regional
 * recording, nor any lane while that scene is switched off. Each video joins at most one lane, one per
 * artist per lane, newest first within a match kind. Items carry metadata.videoMatch and aiOrder.
 */
export function matchLaneSessions(pool: SessionVideo[], ctx: SessionMatchContext): ContentItem[] {
  const channels = new Map((ctx.channels ?? SESSION_CHANNELS).map((c) => [c.key, c]));
  const lanes = ctx.lanes.filter((l) => LANE_BY_ID[l.id] && !l.regional);
  if (!lanes.length || !pool.length) return [];
  const laneIds = new Set(lanes.map((l) => l.id));
  const order = new Map(lanes.map((l, i) => [l.id, i]));
  const perLane = Math.max(1, ctx.perLane ?? 3);
  const blocked = new Set(blockedRegions(ctx.profile));
  const picks = ctx.picks ?? {};
  const pickedIn = (laneId: string, names: string[]) => (picks[laneId] ?? []).some((p) => artistMatches(p.artist, names) || (p.feat ?? []).some((f) => artistMatches(f, names)));
  const regionalArtist = (names: string[]) => {
    for (const r of ctx.regionalArtists ?? []) if (artistMatches(r.artist, names)) return r.region;
    return null;
  };
  const libLane = (names: string[]) => {
    for (const n of names) {
      const k = normKey(n);
      if (k.length >= 2 && (ctx.profile.creators[k] ?? 0) > LIBRARY_ARTIST_MIN && ctx.libraryArtistLanes?.get(k)) return ctx.libraryArtistLanes.get(k)!;
    }
    return null;
  };
  const knownLaneElsewhere = (names: string[], laneId: string) => {
    const l = libLane(names);
    if (l && l !== laneId) return true;
    return lanes.some((x) => x.id !== laneId && pickedIn(x.id, names));
  };

  type Cand = { v: SessionVideo; p: ParsedSession; lane: string; match: Match };
  const artistCands: Cand[] = [];
  const channelCands: Cand[] = [];
  const sorted = [...pool].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
  for (const v of sorted) {
    const ch = channels.get(v.channel);
    if (!ch || ctx.excludeIds?.has(laneVideoId(v.videoId)) || v.durationSec < 60) continue;
    const p = parseSessionTitle(v.title, v.channel);
    if (!p) continue;
    const names = [p.artist, ...p.artists];
    if (isDislikedArtist(p.artists, ctx.profile)) continue;
    // Regional scene of the session, if any: its audio language, a French title, or the curator's label for the artist.
    const region = regionOfLanguage(v.lang) ?? (looksFrench(p.song) ? 'french' : null) ?? regionalArtist(names);
    const laneOk = (id: string) => !region || (LANGUAGE_NEUTRAL.has(id) && !blocked.has(region));
    const served = ch.lanes.filter((id) => laneIds.has(id) && laneOk(id)).sort((a, b) => order.get(a)! - order.get(b)!);
    const byPick = served.find((id) => pickedIn(id, names));
    const lib = libLane(names);
    const byLib = lib && served.includes(lib) ? lib : undefined;
    if (byPick || byLib) {
      artistCands.push({ v, p, lane: (byPick ?? byLib)!, match: byPick ? 'pick' : 'library' });
      continue;
    }
    for (const id of ch.open) {
      if (served.includes(id) && !knownLaneElsewhere(names, id)) {
        channelCands.push({ v, p, lane: id, match: 'channel' });
        break;
      }
    }
  }

  const out: ContentItem[] = [];
  const usedVideos = new Set<string>();
  for (const lane of lanes) {
    const chosen: Cand[] = [];
    const artists = new Set<string>();
    const take = (c: Cand) => {
      const a = normKey(c.p.artists[0]);
      if (usedVideos.has(c.v.videoId) || artists.has(a)) return;
      usedVideos.add(c.v.videoId);
      artists.add(a);
      chosen.push(c);
    };
    for (const c of artistCands.filter((x) => x.lane === lane.id).sort((a, b) => MATCH_RANK[a.match] - MATCH_RANK[b.match])) {
      if (chosen.length >= perLane) break;
      take(c);
    }
    // No artist match: at most one session on the channel alone.
    if (!chosen.length) {
      const c = channelCands.find((x) => x.lane === lane.id && !usedVideos.has(x.v.videoId));
      if (c) take(c);
    }
    chosen.forEach((c, i) => out.push(laneVideoItem(c.v, c.p, lane, { videoMatch: c.match, aiOrder: 500 + i })));
  }
  return out;
}

/**
 * Sessions of a named artist for their own lane ("Eminem"): pool uploads whose title credits them, newest
 * first, at most `max`. The user named the artist: their scene's language rules don't apply (as for their songs).
 */
export function matchEntitySessions(pool: SessionVideo[], ctx: { name: string; lane: Pick<MusicLane, 'id' | 'label' | 'genres'>; excludeIds?: Set<string>; max?: number }): ContentItem[] {
  const out: ContentItem[] = [];
  const sorted = [...pool].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
  for (const v of sorted) {
    if (out.length >= (ctx.max ?? 2)) break;
    if (ctx.excludeIds?.has(laneVideoId(v.videoId)) || v.durationSec < 60) continue;
    const p = parseSessionTitle(v.title, v.channel);
    if (!p || !artistMatches(ctx.name, [p.artist, ...p.artists])) continue;
    const ch = SESSION_CHANNEL_BY_KEY[v.channel];
    out.push(laneVideoItem(v, p, ctx.lane, {
      videoMatch: 'entity', aiOrder: 500 + out.length,
      entity: { name: ctx.name, role: 'by', note: `${p.kind === 'live' ? 'live' : 'video'} ${ch?.prep ?? 'on'} ${ch?.venue ?? 'YouTube'}` },
    }));
  }
  return out;
}

/** Whether the lane plan has a lane some session channel serves (else the pool isn't worth reading). */
export function sessionsServe(laneIds: string[], channels: SessionChannel[] = SESSION_CHANNELS): boolean {
  return laneIds.some((id) => id === ENTITY_BY_LANE || channels.some((c) => c.lanes.includes(id)));
}

/**
 * A stored lane video refreshed from a fresh videos.list answer (YouTube's 30-day policy): YouTube's own
 * fields are updated, the lane-item shape (id, category, artists, session) is kept. A row the daily
 * cleanup already stripped (no metadata, no credits) gets its artists and session back from the fresh
 * title (its channel's format, or any known format).
 */
export function refreshedLaneVideo(stored: ContentItem, fresh: ContentItem): ContentItem {
  const meta: Record<string, unknown> = { ...(stored.metadata ?? {}), fetchedAt: new Date().toISOString(), stale: false };
  let creators = stored.creators;
  if (!meta.session || !creators.length) {
    const ch = typeof fresh.metadata?.channelTitle === 'string' ? (fresh.metadata.channelTitle as string).toLowerCase() : '';
    const keys = [...SESSION_CHANNELS].sort((a, b) => Number(!ch.includes(b.venue.toLowerCase())) - Number(!ch.includes(a.venue.toLowerCase()))).map((c) => c.key);
    for (const key of keys) {
      const p = parseSessionTitle(fresh.title, key);
      if (!p) continue;
      const c = SESSION_CHANNEL_BY_KEY[key];
      creators = p.artists;
      meta.video = true;
      meta.videoKind = p.kind;
      meta.session = { channel: key, venue: c.venue, prep: c.prep, artist: p.artist, label: p.song ?? c.session } satisfies SessionTag;
      break;
    }
  }
  return {
    ...stored, title: fresh.title, creators, artworkUrl: fresh.artworkUrl ?? stored.artworkUrl, durationSec: fresh.durationSec ?? stored.durationSec, embed: fresh.embed ?? null,
    playbackNote: fresh.playbackNote, metadata: meta,
  };
}
