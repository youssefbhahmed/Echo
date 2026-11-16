// YouTube Data API v3 — free quota (default 10,000 units/day; search.list = 100 units, videos.list = 1).
// https://developers.google.com/youtube/v3/getting-started — playback uses the official IFrame Player.
// Policy: API data is cached at most 30 days (we use 2 days for searches) and refreshed on access.
import type { ContentItem, DurationPref } from '../types.ts';
import { tagRetrieval, type Provider } from './types.ts';

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
    popularity: views ? Math.min(1, Math.log10(views + 1) / 8) : undefined,
    metadata: { views, channelTitle: v.snippet.channelTitle, fetchedAt: new Date().toISOString() },
  };
}

const DURATION_PARAM: Record<DurationPref, string> = { short: 'short', medium: 'medium', long: 'long' };

export const youtube: Provider = {
  id: 'youtube',
  label: 'YouTube',
  categories: ['youtube'],
  searchCost: 101,
  setup: 'Google Cloud Console → enable "YouTube Data API v3" → Credentials → API key (restrict it to that API), then set YOUTUBE_API_KEY as a Supabase secret.',
  configured: (env) => !!env('YOUTUBE_API_KEY'),
  async search(p, { http, env }) {
    const key = env('YOUTUBE_API_KEY')!;
    const params = new URLSearchParams({ part: 'snippet', type: 'video', q: p.query, maxResults: String(Math.min(p.limit ?? 15, 25)), videoEmbeddable: 'true', safeSearch: 'moderate' });
    if (p.language) params.set('relevanceLanguage', p.language);
    if (env('YOUTUBE_REGION')) params.set('regionCode', env('YOUTUBE_REGION')!.toUpperCase());
    const dur = p.duration ?? (p.documentary ? 'long' : undefined);
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
    return tagRetrieval((videos.items ?? []).filter((v) => v.status?.privacyStatus !== 'private' && playable(v)).map(mapYouTubeVideo), p);
  },
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
