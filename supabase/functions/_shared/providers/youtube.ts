// YouTube Data API v3 — free quota (default 10,000 units/day; search.list = 100 units, videos.list = 1).
// https://developers.google.com/youtube/v3/getting-started — playback uses the official IFrame Player.
// Policy: API data is cached at most 30 days (we use 2 days for searches) and refreshed on access.
import type { ContentItem, DurationPref } from '../types.ts';
import { ProviderError } from './http.ts';
import { tagRetrieval, type Provider, type ProviderContext, type SearchParams } from './types.ts';

export const YT_CATEGORIES: Record<string, string> = {
  '1': 'Film & Animation', '2': 'Autos & Vehicles', '10': 'Music', '15': 'Pets & Animals', '17': 'Sports', '19': 'Travel & Events', '20': 'Gaming',
  '22': 'People & Blogs', '23': 'Comedy', '24': 'Entertainment', '25': 'News & Politics', '26': 'Howto & Style', '27': 'Education', '28': 'Science & Technology', '29': 'Nonprofits & Activism',
};

export function parseIsoDuration(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return undefined;
  return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3] ?? 0) * 60) + Number(m[4] ?? 0);
}

interface YTVideo {
  id: string;
  snippet: { title: string; description: string; channelTitle: string; publishedAt: string; tags?: string[]; categoryId?: string; defaultAudioLanguage?: string; defaultLanguage?: string; thumbnails?: Record<string, { url: string }> };
  contentDetails?: { duration?: string; regionRestriction?: { allowed?: string[]; blocked?: string[] } };
  statistics?: { viewCount?: string; likeCount?: string };
  status?: { embeddable?: boolean; privacyStatus?: string };
}

function decodeEntities(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export function mapYouTubeVideo(v: YTVideo): ContentItem {
  const t = v.snippet.thumbnails ?? {};
  const views = Number(v.statistics?.viewCount ?? 0);
  const likeRate = views ? Number(v.statistics?.likeCount ?? 0) / views : 0;
  const embeddable = v.status?.embeddable !== false;
  const lang = v.snippet.defaultAudioLanguage ?? v.snippet.defaultLanguage;
  return {
    id: `youtube:video:${v.id}`, category: 'youtube', kind: 'video', provider: 'youtube', externalId: v.id, title: decodeEntities(v.snippet.title),
    creators: [v.snippet.channelTitle], description: decodeEntities(v.snippet.description ?? '').slice(0, 1500),
    genres: v.snippet.categoryId && YT_CATEGORIES[v.snippet.categoryId] ? [YT_CATEGORIES[v.snippet.categoryId]] : [], tags: (v.snippet.tags ?? []).slice(0, 25),
    artworkUrl: (t.maxres ?? t.high ?? t.medium ?? t.default)?.url, durationSec: parseIsoDuration(v.contentDetails?.duration), language: lang?.slice(0, 2),
    releaseDate: v.snippet.publishedAt?.slice(0, 10), externalUrl: `https://www.youtube.com/watch?v=${v.id}`,
    embed: embeddable ? { type: 'youtube', videoId: v.id } : null,
    playbackNote: embeddable ? undefined : 'The uploader has disabled playback on other sites. Open it on YouTube instead.',
    // Reach × engagement: a like rate around 4%+ is strong on YouTube.
    popularity: views ? Math.min(1, (Math.log10(views + 1) / 7) * (0.6 + 0.4 * Math.min(1, likeRate / 0.04))) : undefined,
    metadata: { views, channelTitle: v.snippet.channelTitle, fetchedAt: new Date().toISOString() },
  };
}

const DURATION_PARAM: Record<DurationPref, string> = { short: 'short', medium: 'medium', long: 'long' };

async function searchYouTube(p: SearchParams, { http, env }: ProviderContext, asPodcast: boolean): Promise<ContentItem[]> {
  const key = env('YOUTUBE_API_KEY')!;
  // Podcasts: full episodes ("<topic> podcast", 20+ min, English by default).
  const query = asPodcast && !/podcast/i.test(p.query) ? `${p.query} podcast` : p.query;
  const params = new URLSearchParams({ part: 'snippet', type: 'video', q: query, maxResults: String(Math.min(Math.max(p.limit ?? 15, 20), 25)), videoEmbeddable: 'true', videoSyndicated: 'true', safeSearch: 'moderate' });
  const lang = p.language ?? (asPodcast ? (env('YOUTUBE_PODCAST_LANGUAGE') ?? 'en') : undefined);
  if (lang) params.set('relevanceLanguage', lang);
  if (env('YOUTUBE_REGION')) params.set('regionCode', env('YOUTUBE_REGION')!.toUpperCase());
  const dur = asPodcast ? (p.duration === 'short' ? 'medium' : 'long') : p.duration ?? (p.documentary ? 'long' : undefined);
  if (dur) params.set('videoDuration', DURATION_PARAM[dur]);
  const search = await http.json<{ items: Array<{ id: { videoId?: string } }> }>(`https://www.googleapis.com/youtube/v3/search?${params}&key=${key}`, {
    cacheKey: `yt:search:${params}`, ttl: 2 * 86400, provider: 'youtube',
  });
  const ids = (search.items ?? []).map((i) => i.id.videoId).filter(Boolean) as string[];
  if (!ids.length) return [];
  const vparams = new URLSearchParams({ part: 'snippet,contentDetails,statistics,status', id: ids.join(',') });
  const videos = await http.json<{ items: YTVideo[] }>(`https://www.googleapis.com/youtube/v3/videos?${vparams}&key=${key}`, {
    cacheKey: `yt:videos:${ids.join(',')}`, ttl: 2 * 86400, provider: 'youtube',
  });
  // Optional YOUTUBE_REGION (e.g. FR): skip videos that are geo-blocked there.
  const region = env('YOUTUBE_REGION')?.toUpperCase();
  const playable = (v: YTVideo) => {
    const r = v.contentDetails?.regionRestriction;
    if (!region || !r) return true;
    if (r.allowed && !r.allowed.includes(region)) return false;
    return !(r.blocked ?? []).includes(region);
  };
  // Quality floor: no Shorts or tiny clips; podcast episodes must be 15+ minutes.
  const minSec = asPodcast ? 900 : p.duration === 'short' ? 60 : 180;
  const substantial = (v: YTVideo) => (parseIsoDuration(v.contentDetails?.duration) ?? 0) >= minSec && !/#shorts?\b/i.test(`${v.snippet.title} ${v.snippet.description ?? ''}`);
  const langOk = (v: YTVideo) => {
    if (!asPodcast || !lang || lang === 'any') return true;
    const l = v.snippet.defaultAudioLanguage ?? v.snippet.defaultLanguage;
    return !l || l.toLowerCase().startsWith(lang);
  };
  const items = (videos.items ?? []).filter((v) => v.status?.privacyStatus !== 'private' && playable(v) && substantial(v) && langOk(v)).map(mapYouTubeVideo);
  return tagRetrieval(asPodcast ? items.map(asPodcastEpisode) : items, p);
}

/** A YouTube video re-labelled as a podcast episode (own id, so it never collides with the Videos category). */
export function asPodcastEpisode(i: ContentItem): ContentItem {
  return { ...i, id: `youtube:episode:${i.externalId}`, category: 'podcasts', kind: 'episode', genres: [...new Set([...i.genres, 'Podcast'])] };
}

export const youtube: Provider = {
  id: 'youtube',
  label: 'YouTube',
  categories: ['youtube', 'podcasts'],
  searchCost: 101,
  setup: 'Google Cloud Console → enable "YouTube Data API v3" → Credentials → API key (restrict it to that API), then set YOUTUBE_API_KEY as a Supabase secret.',
  configured: (env) => !!env('YOUTUBE_API_KEY'),
  search: (p, ctx) => searchYouTube(p, ctx, p.category === 'podcasts'),
};

/** Refresh metadata for stored videos (1 unit per 50 ids) — used to honour the 30-day storage policy. */
export async function refreshYouTube(ids: string[], ctx: { http: import('./http.ts').HttpClient; env: (n: string) => string | undefined }): Promise<ContentItem[]> {
  const key = ctx.env('YOUTUBE_API_KEY');
  if (!key || !ids.length) return [];
  const out: ContentItem[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const vparams = new URLSearchParams({ part: 'snippet,contentDetails,statistics,status', id: chunk.join(',') });
    const res = await ctx.http.json<{ items: YTVideo[] }>(`https://www.googleapis.com/youtube/v3/videos?${vparams}&key=${key}`, { provider: 'youtube' });
    out.push(...(res.items ?? []).map(mapYouTubeVideo));
  }
  return out;
}

// ───────────── live-session pool (music lanes) ─────────────
//
// Music lanes mix Spotify songs with live sessions from a fixed set of well-known session channels. No
// search.list (100 units) is ever spent on this: once a day the pool lists each channel's recent uploads
// (playlistItems.list, 1 unit per 50 items) and checks them (videos.list, 1 unit per 50 ids), and the
// result is cached for everyone in the shared provider cache. Channel ids → uploads playlists come from
// channels.list (1 unit for all known ids; 1 unit per handle that has to be resolved) and are cached for
// 30 days. Titles are matched to lanes locally (engine/sessions.ts): never sent to an AI model.

/** A session channel and the taste lanes (engine/lanes.ts ids) its uploads may join. */
export interface SessionChannel {
  /** Stable key stored with each pool video. */
  key: string;
  /** Channel name as shown on YouTube. */
  name: string;
  /** The channel's handle (verified against channels.list snippet.customUrl; used to resolve the id when unknown or wrong). */
  handle: string;
  /** The channel id, when known (still verified: a mismatch with the handle resolves the id by handle instead). */
  id?: string;
  /** How explanations name the place: "live at Tiny Desk", "live on COLORS". */
  venue: string;
  prep: 'at' | 'on' | 'for';
  /** What a session there is called when its title names no song ("Tiny Desk Concert"). */
  session: string;
  /** Lanes a session may join when its title names an artist of that lane (a curator pick or a library artist). */
  lanes: string[];
  /** Lanes a session may join on the channel alone (no artist match): where a recent upload most likely fits. */
  open: string[];
}

/**
 * The session channels. Ids marked "known" are public channel ids; every id is checked against its handle
 * on first use (channels.list snippet.customUrl) and resolved with channels.list?forHandle= when it is
 * missing or does not match.
 */
export const SESSION_CHANNELS: SessionChannel[] = [
  { key: 'tinydesk', name: 'NPR Music (Tiny Desk)', handle: '@nprmusic', id: 'UC4eYXhJI4-7wSWc8UNRwD4A', venue: 'Tiny Desk', prep: 'at', session: 'Tiny Desk Concert', lanes: ['hiphop-rnb', 'blues-soul', 'afro-latin', 'jazz-classical'], open: ['hiphop-rnb', 'blues-soul'] },
  { key: 'colors', name: 'COLORS', handle: '@COLORSxSTUDIOS', id: 'UC2Qw1dzXDBAZPwS7zm37g8g', venue: 'COLORS', prep: 'on', session: 'A COLORS SHOW', lanes: ['hiphop-rnb', 'blues-soul', 'afro-latin'], open: ['hiphop-rnb'] },
  { key: 'kexp', name: 'KEXP', handle: '@kexp', id: 'UC3I2GFN_F8WudD_2jUZbojA', venue: 'KEXP', prep: 'on', session: 'Live on KEXP', lanes: ['rock-metal', 'blues-soul'], open: ['rock-metal'] },
  { key: 'audiotree', name: 'Audiotree', handle: '@audiotreetv', venue: 'Audiotree', prep: 'on', session: 'Audiotree Live session', lanes: ['rock-metal', 'blues-soul'], open: ['rock-metal'] },
  { key: 'mahogany', name: 'Mahogany Sessions', handle: '@mahoganysessions', venue: 'Mahogany Sessions', prep: 'for', session: 'Mahogany Session', lanes: ['blues-soul'], open: ['blues-soul'] },
  { key: 'cercle', name: 'Cercle', handle: '@Cercle', id: 'UCPKT_csvP72boVX0XrMtagQ', venue: 'Cercle', prep: 'for', session: 'Live for Cercle', lanes: ['melodic-house', 'edm', 'afro-latin'], open: ['melodic-house'] },
  { key: 'boilerroom', name: 'Boiler Room', handle: '@boilerroom', id: 'UCGBpxWJr9FNOcFYA5GkKrMg', venue: 'Boiler Room', prep: 'at', session: 'Boiler Room set', lanes: ['melodic-house', 'edm', 'afro-latin'], open: ['edm'] },
  { key: 'sofar', name: 'Sofar Sounds', handle: '@SofarSounds', venue: 'Sofar Sounds', prep: 'at', session: 'Sofar Sounds session', lanes: ['blues-soul'], open: ['blues-soul'] },
];

export const SESSION_CHANNEL_BY_KEY: Record<string, SessionChannel> = Object.fromEntries(SESSION_CHANNELS.map((c) => [c.key, c]));

/** One checked upload of a session channel (embeddable, public, 60 s or longer, not a Short). Compact: no description. */
export interface SessionVideo {
  videoId: string;
  /** SessionChannel.key */
  channel: string;
  title: string;
  publishedAt: string;
  durationSec: number;
  thumb?: string;
  /** defaultAudioLanguage / defaultLanguage (two letters), when the uploader set one. */
  lang?: string;
}

/** Recent uploads read per channel (one playlistItems.list page). */
export const SESSION_UPLOADS = 50;
/** The checked pool is shared by every user for a day... */
export const SESSION_POOL_TTL = 86400;
/** ...and kept a week as the copy served while YouTube is out of quota (well inside the 30-day storage policy). */
export const SESSION_POOL_STALE_TTL = 7 * 86400;
/** Channel id → uploads playlist (never changes; re-checked monthly). */
export const SESSION_CHANNEL_TTL = 30 * 86400;

export const sessionPoolKey = (channels: SessionChannel[] = SESSION_CHANNELS) => `yt:sessions:v1:${channels.map((c) => c.key).join(',')}`;

/**
 * Quota units per day for the whole pool (shared by all users through the provider cache): one
 * playlistItems.list per channel, videos.list per 50 uploads, and the channel lookups spread over their
 * 30-day cache (one batched call for the known ids, one per handle to resolve). 8 channels ≈ 16.3 units/day.
 */
export function sessionPoolUnitsPerDay(channels: SessionChannel[] = SESSION_CHANNELS, perChannel = SESSION_UPLOADS): number {
  const lists = channels.length * Math.ceil(perChannel / 50);
  const details = Math.ceil((channels.length * perChannel) / 50);
  const lookups = (1 + channels.filter((c) => !c.id).length) / 30;
  return lists + details + lookups;
}

export interface SessionPoolResult {
  videos: SessionVideo[];
  /** cache = the shared day's pool; network = built now; stale = last week's copy (YouTube out of quota or failing); none = nothing. */
  source: 'cache' | 'network' | 'stale' | 'none';
  /** Quota units spent by this call (cache hits excluded). */
  units: number;
  /** YouTube answered "out of quota" while building the pool (the caller records the block). */
  quota?: ProviderError;
  detail: string;
}

interface YTChannel { id: string; snippet?: { customUrl?: string; title?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }

const sameHandle = (a: string | undefined, b: string) => !!a && a.replace(/^@/, '').toLowerCase() === b.replace(/^@/, '').toLowerCase();

/**
 * Recent uploads of the session channels, checked and cached (see above). `allowNetwork: false` (YouTube
 * blocked) serves the cached pool or last week's copy only. A channel that fails is skipped; an
 * out-of-quota answer stops the build and serves last week's copy.
 */
export async function liveSessionPool(ctx: ProviderContext, opts: { allowNetwork?: boolean; channels?: SessionChannel[]; perChannel?: number } = {}): Promise<SessionPoolResult> {
  const { http, env } = ctx;
  const channels = opts.channels ?? SESSION_CHANNELS;
  const perChannel = Math.max(1, Math.min(50, opts.perChannel ?? SESSION_UPLOADS));
  const key = sessionPoolKey(channels);
  const cache = http.cache;
  let units = 0;
  const fresh = (await cache?.get(key)) as SessionVideo[] | undefined;
  if (Array.isArray(fresh)) return { videos: fresh, source: 'cache', units: 0, detail: `${fresh.length} sessions (cached)` };
  const stale = async (why: string, quota?: ProviderError): Promise<SessionPoolResult> => {
    const old = (await cache?.get(`${key}:stale`)) as SessionVideo[] | undefined;
    return Array.isArray(old)
      ? { videos: old, source: 'stale', units, quota, detail: `${old.length} sessions from the last good pool (${why})` }
      : { videos: [], source: 'none', units, quota, detail: `no sessions (${why})` };
  };
  const apiKey = env('YOUTUBE_API_KEY');
  if (!apiKey) return stale('YouTube not configured');
  if (opts.allowNetwork === false) return stale('YouTube quota reached today');
  /** One API call (1 unit) unless the provider cache already holds its answer. */
  const call = async <T>(path: string, params: URLSearchParams, cacheKey: string, ttl: number): Promise<T> => {
    const hit = await cache?.get(cacheKey);
    if (hit !== undefined) return hit as T;
    units++;
    return http.json<T>(`https://www.googleapis.com/youtube/v3/${path}?${params}&key=${apiKey}`, { cacheKey, ttl, provider: 'youtube' });
  };
  const notes: string[] = [];
  try {
    // 1. Uploads playlists: known ids in one call (verified by handle), the rest resolved by handle.
    const uploads = new Map<string, string>();
    const known = channels.filter((c) => c.id);
    if (known.length) {
      const ids = known.map((c) => c.id!).join(',');
      const r = await call<{ items?: YTChannel[] }>('channels', new URLSearchParams({ part: 'snippet,contentDetails', id: ids, maxResults: '50' }), `yt:channels:${ids}`, SESSION_CHANNEL_TTL);
      for (const c of known) {
        const ch = (r.items ?? []).find((x) => x.id === c.id);
        const up = ch?.contentDetails?.relatedPlaylists?.uploads;
        // An id whose channel carries another handle is wrong: resolved by handle below.
        if (up && (!ch?.snippet?.customUrl || sameHandle(ch.snippet.customUrl, c.handle))) uploads.set(c.key, up);
      }
    }
    for (const c of channels.filter((x) => !uploads.has(x.key))) {
      try {
        const r = await call<{ items?: YTChannel[] }>('channels', new URLSearchParams({ part: 'snippet,contentDetails', forHandle: c.handle }), `yt:channel-handle:${c.handle.toLowerCase()}`, SESSION_CHANNEL_TTL);
        const up = r.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (up) uploads.set(c.key, up);
        else notes.push(`${c.handle} not found`);
      } catch (e) {
        if (e instanceof ProviderError && e.kind === 'quota') throw e;
        notes.push(`${c.handle} lookup failed`);
      }
    }
    // 2. Recent uploads per channel (newest first).
    const recent: Array<{ videoId: string; channel: string }> = [];
    await Promise.all(channels.filter((c) => uploads.has(c.key)).map(async (c) => {
      const pl = uploads.get(c.key)!;
      try {
        const r = await call<{ items?: Array<{ contentDetails?: { videoId?: string } }> }>('playlistItems', new URLSearchParams({ part: 'contentDetails', playlistId: pl, maxResults: String(perChannel) }), `yt:uploads:${pl}:${perChannel}`, SESSION_POOL_TTL);
        for (const it of r.items ?? []) if (it.contentDetails?.videoId) recent.push({ videoId: it.contentDetails.videoId, channel: c.key });
      } catch (e) {
        if (e instanceof ProviderError && e.kind === 'quota') throw e;
        notes.push(`${c.key} uploads failed`);
      }
    }));
    // 3. Details: embeddable, public, long enough, not geo-blocked in YOUTUBE_REGION (1 unit per 50 ids).
    const channelOf = new Map(recent.map((r) => [r.videoId, r.channel]));
    const ids = [...channelOf.keys()];
    const region = env('YOUTUBE_REGION')?.toUpperCase();
    const videos: SessionVideo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const r = await call<{ items?: YTVideo[] }>('videos', new URLSearchParams({ part: 'snippet,contentDetails,status', id: chunk.join(',') }), `yt:session-videos:${chunk.join(',')}`, SESSION_POOL_TTL);
      for (const v of r.items ?? []) {
        const sec = parseIsoDuration(v.contentDetails?.duration) ?? 0;
        const rr = v.contentDetails?.regionRestriction;
        const geoBlocked = !!region && !!rr && ((!!rr.allowed && !rr.allowed.includes(region)) || (rr.blocked ?? []).includes(region));
        if (v.status?.embeddable === false || (v.status?.privacyStatus && v.status.privacyStatus !== 'public') || geoBlocked) continue;
        if (sec < 60 || /#shorts?\b/i.test(v.snippet.title)) continue;
        const t = v.snippet.thumbnails ?? {};
        const lang = (v.snippet.defaultAudioLanguage ?? v.snippet.defaultLanguage)?.slice(0, 2).toLowerCase();
        videos.push({
          videoId: v.id, channel: channelOf.get(v.id)!, title: decodeEntities(v.snippet.title), publishedAt: v.snippet.publishedAt, durationSec: sec,
          ...((t.high ?? t.medium ?? t.default)?.url ? { thumb: (t.high ?? t.medium ?? t.default)!.url } : {}), ...(lang ? { lang } : {}),
        });
      }
    }
    videos.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
    if (cache && videos.length) {
      await cache.set(key, videos, SESSION_POOL_TTL);
      await cache.set(`${key}:stale`, videos, SESSION_POOL_STALE_TTL);
    }
    return { videos, source: 'network', units, detail: `${videos.length} sessions from ${uploads.size} channels (${units} quota units)${notes.length ? `; ${notes.join(', ')}` : ''}` };
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'quota') return stale('YouTube out of quota', e);
    return stale(`pool failed: ${String((e as Error)?.message ?? e).slice(0, 60)}`);
  }
}
