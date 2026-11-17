// Live sessions and music videos in music lanes. The pool (providers/youtube.ts liveSessionPool) holds
// recent uploads of well-known session channels; here each one is read from its title ("Artist: Tiny
// Desk Concert", "Artist - Song | A COLORS SHOW", "Artist live at … for Cercle") and matched to this
// refresh's lanes LOCALLY: titles never go to an AI model, and the names they are compared with are the
// curator's own words and the user's own library. Pure functions, no I/O.
import type { ContentItem, MusicLane, TasteProfile } from '../types.ts';
import { artistForm, artistFormsMatch, artistMatches, pickArtistForms, type ArtistForm } from '../providers/spotify.ts';
import { SESSION_CHANNEL_BY_KEY, SESSION_CHANNELS, sessionChannelOfTitle, type SessionChannel, type SessionVideo } from '../providers/youtube.ts';
import { dislikedArtistCheck, ENTITY_BY_LANE, LANE_BY_ID, LANE_VIDEO_PREFIX, laneTag, type SessionTag } from './lanes.ts';
import { blockedRegions, regionOfLane, regionOfLanguage } from './curator.ts';
import { normKey } from './text.ts';

export interface ParsedSession {
  /** The credit as the title gives it ("Anderson .Paak & The Free Nationals"). */
  artist: string;
  /**
   * The acts credited, split only where a credit names several acts ("A feat. B", "A b2b B", "A x B"):
   * "Mumford & Sons" and "Tyler, The Creator" stay whole. These are the lane item's creators, so ranking,
   * disliked artists, one-per-artist and play/skip feedback use the act's real name.
   */
  credits: string[];
  /** Every name in the credit, also split on "&", "+" and "," (at most 4): only for matching picks and library artists. */
  artists: string[];
  /** The song, when the title names one. */
  song?: string;
  kind: 'live' | 'video';
}

const DASH = String.raw`\s+[-–—]\s+`;
/** Words that join two acts in one credit ("A feat. B", "A b2b B", "A x B", "A with B"). */
const COLLAB_SPLIT = /\s+(?:x|×|b2b|with|feat\.?|ft\.?|featuring)\s+/i;
/** Every possible name: also "A & B", "A + B", "A, B" (never "and": "Mumford and Sons"). */
const CREDIT_SPLIT = /\s*,\s*|\s+(?:&|x|×|\+|b2b|with|feat\.?|ft\.?|featuring)\s+/i;

const splitCredit = (credit: string, re: RegExp) => [...new Set(credit.split(re).map((x) => x.trim()).filter((x) => x.length > 0 && x.length <= 60))].slice(0, 4);

/** Every name a credit may stand for ("Nova Lyric & The Night Band" → both), for matching only. */
export function creditNames(credit: string): string[] {
  return splitCredit(credit, CREDIT_SPLIT);
}

/** The acts of a credit: split on collaboration words only ("Mumford & Sons" is one act; "A b2b B" two). */
export function creditActs(credit: string): string[] {
  return splitCredit(credit, COLLAB_SPLIT);
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
export function parseSessionTitle(title: string, channel: string, opts: { generic?: boolean } = {}): ParsedSession | null {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t || NOT_A_SESSION.test(t)) return null;
  for (const p of [...(PARSERS[channel] ?? []), ...(opts.generic === false ? [] : GENERIC)]) {
    const r = p(t);
    if (!r) continue;
    const artist = clean(r.artist);
    if (!artist || artist.length > 80 || /^(npr|colors|kexp|audiotree|mahogany|cercle|boiler room|sofar)\b/i.test(artist)) return null;
    const artists = creditNames(artist);
    const credits = creditActs(artist);
    if (!artists.length || !credits.length) return null;
    const song = clean(r.song);
    return { artist, credits, artists, ...(song && !NOT_A_SONG.test(song) ? { song } : {}), kind: r.kind ?? 'live' };
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

/** Arabic script (Arabic, its supplements and presentation forms). */
const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** A session's regional scene from its own data: audio language, Arabic script in its title, French in its credit or song. */
export function sessionRegionOf(v: Pick<SessionVideo, 'title' | 'lang'>, p: Pick<ParsedSession, 'artist' | 'song'>): string | null {
  return regionOfLanguage(v.lang)
    ?? (ARABIC_SCRIPT.test(v.title) ? 'arabic-pop' : null)
    ?? (looksFrench([p.artist, p.song].filter(Boolean).join(' ')) ? 'french' : null);
}

export const laneVideoId = (videoId: string) => `${LANE_VIDEO_PREFIX}${videoId}`;

/** A pool video as a lane item (see the contract in lanes.ts). Per-lane / per-user fields are added by the caller. */
export function laneVideoItem(v: SessionVideo, parsed: ParsedSession, lane: Pick<MusicLane, 'id' | 'label' | 'genres'>, extra: Record<string, unknown> = {}): ContentItem {
  const ch = SESSION_CHANNEL_BY_KEY[v.channel];
  const venue = ch?.venue ?? 'YouTube';
  const session: SessionTag = { channel: v.channel, venue, prep: ch?.prep ?? 'on', artist: parsed.artist, label: parsed.song ?? ch?.session ?? venue };
  const genres = lane.genres?.length ? lane.genres.slice(0, 2) : (LANE_BY_ID[lane.id]?.descriptors ?? []).slice(0, 2);
  return {
    id: laneVideoId(v.videoId), category: 'music', kind: 'video', provider: 'youtube', externalId: v.videoId, title: v.title, creators: parsed.credits,
    description: `${parsed.kind === 'live' ? 'Live session' : 'Music video'}: ${parsed.artist}${parsed.song ? ` – ${parsed.song}` : ''} (${ch?.name ?? 'YouTube'})`,
    genres, tags: [parsed.kind === 'live' ? 'live session' : 'music video', venue], artworkUrl: v.thumb, durationSec: v.durationSec, language: v.lang,
    releaseDate: v.publishedAt?.slice(0, 10), externalUrl: `https://www.youtube.com/watch?v=${v.videoId}`, embed: { type: 'youtube', videoId: v.videoId },
    // fetchedAt: when YouTube returned this data (a pool copy may be days old), the 30-day clock of the stored row.
    metadata: { lane: laneTag(lane), video: true, videoKind: parsed.kind, session, channelTitle: ch?.name, fetchedAt: v.fetchedAt ?? new Date().toISOString(), ...extra },
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
 * recent one not shown lately) from a channel whose uploads usually fit it — outside language-neutral
 * lanes only with evidence that it isn't a French / Arabic recording (an English-language channel, or a
 * declared non-regional audio language on a channel that doesn't film French / Arabic acts while that
 * scene is off). Rules: never an excluded or recently shown video, nor another video of a session shown
 * lately (a channel posts each song of one session); never a disliked act (by its full credit or any
 * name in it). A French / Arabic session — its audio language, Arabic script in its title, French in
 * its credit or song, an artist the curator labelled so or whose song's ISRC says so, or a library
 * artist whose songs sit in that regional lane — never joins a lane where language marks a regional
 * recording, nor any lane while that scene is switched off. Each video joins at most one lane, one per
 * artist per lane, newest first within a match kind. Items carry metadata.videoMatch and aiOrder.
 * Names are compared in their folded forms, computed once per call (no per-comparison folding).
 */
export function matchLaneSessions(pool: SessionVideo[], ctx: SessionMatchContext): ContentItem[] {
  const channels = new Map((ctx.channels ?? SESSION_CHANNELS).map((c) => [c.key, c]));
  const lanes = ctx.lanes.filter((l) => LANE_BY_ID[l.id] && !l.regional);
  if (!lanes.length || !pool.length) return [];
  const laneIds = new Set(lanes.map((l) => l.id));
  const order = new Map(lanes.map((l, i) => [l.id, i]));
  const perLane = Math.max(1, ctx.perLane ?? 3);
  const blocked = new Set(blockedRegions(ctx.profile));
  const disliked = dislikedArtistCheck(ctx.profile);
  // Every pick / featured / regional name folded once.
  const pickForms = new Map(lanes.map((l) => [l.id, (ctx.picks?.[l.id] ?? []).flatMap((p) => [p.artist, ...(p.feat ?? [])].flatMap(pickArtistForms))]));
  const regionalForms = (ctx.regionalArtists ?? []).map((r) => ({ forms: pickArtistForms(r.artist), region: r.region }));
  const anyMatch = (ps: ArtistForm[], as: ArtistForm[]) => ps.some((p) => as.some((a) => artistFormsMatch(p, a)));
  const pickedIn = (laneId: string, forms: ArtistForm[]) => anyMatch(pickForms.get(laneId) ?? [], forms);
  const regionalArtist = (forms: ArtistForm[]) => regionalForms.find((r) => anyMatch(r.forms, forms))?.region ?? null;
  const libLane = (keys: string[]) => {
    for (const k of keys) {
      if (k.length >= 2 && (ctx.profile.creators[k] ?? 0) > LIBRARY_ARTIST_MIN && ctx.libraryArtistLanes?.get(k)) return ctx.libraryArtistLanes.get(k)!;
    }
    return null;
  };
  // A library artist whose songs sit in a regional lane is of that scene, whatever their weight.
  const libRegion = (keys: string[]) => {
    for (const k of keys) {
      const r = regionOfLane(ctx.libraryArtistLanes?.get(k));
      if (r) return r;
    }
    return null;
  };
  const knownLaneElsewhere = (keys: string[], forms: ArtistForm[], laneId: string) => {
    const l = libLane(keys);
    if (l && l !== laneId) return true;
    return lanes.some((x) => x.id !== laneId && pickedIn(x.id, forms));
  };

  // Each upload parsed once; a session (channel + act) counts as shown when any of its videos was.
  const sorted = [...pool].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
  const parsed = sorted.map((v) => ({ v, p: channels.has(v.channel) ? parseSessionTitle(v.title, v.channel) : null }));
  const sessionKey = (v: SessionVideo, p: ParsedSession) => `${v.channel}|${normKey(p.artist)}`;
  const shownSessions = new Set(parsed.filter((x) => x.p && ctx.excludeIds?.has(laneVideoId(x.v.videoId))).map((x) => sessionKey(x.v, x.p!)));

  type Cand = { v: SessionVideo; p: ParsedSession; lane: string; match: Match };
  const artistCands: Cand[] = [];
  const channelCands: Cand[] = [];
  for (const { v, p } of parsed) {
    const ch = channels.get(v.channel);
    if (!ch || !p || v.durationSec < 60 || ctx.excludeIds?.has(laneVideoId(v.videoId)) || shownSessions.has(sessionKey(v, p))) continue;
    const names = [...new Set([p.artist, ...p.credits, ...p.artists])];
    if (disliked(names)) continue;
    const forms = names.map(artistForm);
    const keys = names.map(normKey);
    // Regional scene of the session, if any: its own data, then what the curator and the library say about the artist.
    const region = sessionRegionOf(v, p) ?? regionalArtist(forms) ?? libRegion(keys);
    const laneOk = (id: string) => !region || (LANGUAGE_NEUTRAL.has(id) && !blocked.has(region));
    const served = ch.lanes.filter((id) => laneIds.has(id) && laneOk(id)).sort((a, b) => order.get(a)! - order.get(b)!);
    const byPick = served.find((id) => pickedIn(id, forms));
    const lib = libLane(keys);
    const byLib = lib && served.includes(lib) ? lib : undefined;
    if (byPick || byLib) {
      artistCands.push({ v, p, lane: (byPick ?? byLib)!, match: byPick ? 'pick' : 'library' });
      continue;
    }
    // Channel-only: nothing is known about the act, so outside language-neutral lanes the language must be.
    const languageKnown = (id: string) => LANGUAGE_NEUTRAL.has(id) || !!ch.english || (!!v.lang && !regionOfLanguage(v.lang) && !(ch.multilingual && blocked.size > 0));
    for (const id of ch.open) {
      if (served.includes(id) && languageKnown(id) && !knownLaneElsewhere(keys, forms, id)) {
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

/** Channels whose own title format is loose (Cercle's "X live at Y"): tried last when the uploader is unknown. */
const LOOSE_FORMATS = new Set(['cercle']);

/**
 * A stored lane video refreshed from a fresh videos.list answer (YouTube's 30-day policy): YouTube's own
 * fields are updated, the lane-item shape (id, category, artists, session) is kept. A row the daily
 * cleanup already stripped (no metadata, no credits) gets its artists and session back from the fresh
 * title: read in the format of the channel that uploaded it (its channel title), or, when that channel
 * isn't a known session channel, only in a channel's own distinctive format (never the generic ones,
 * which would credit the wrong venue).
 */
export function refreshedLaneVideo(stored: ContentItem, fresh: ContentItem): ContentItem {
  const meta: Record<string, unknown> = { ...(stored.metadata ?? {}), fetchedAt: new Date().toISOString(), stale: false };
  let creators = stored.creators;
  if (!meta.session || !creators.length) {
    const uploader = sessionChannelOfTitle(typeof fresh.metadata?.channelTitle === 'string' ? fresh.metadata.channelTitle : '');
    const tries: Array<[string, boolean]> = uploader
      ? [[uploader.key, true]]
      : [...SESSION_CHANNELS].sort((a, b) => Number(LOOSE_FORMATS.has(a.key)) - Number(LOOSE_FORMATS.has(b.key))).map((c) => [c.key, false]);
    for (const [key, generic] of tries) {
      const p = parseSessionTitle(fresh.title, key, { generic });
      if (!p) continue;
      const c = SESSION_CHANNEL_BY_KEY[key];
      creators = p.credits;
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
