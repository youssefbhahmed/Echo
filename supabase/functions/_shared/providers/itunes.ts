// Apple iTunes Search API — free, no key (~20 requests/minute guidance).
// https://performance-partners.apple.com/search-api
// Used for podcasts (shows + episodes with official Apple embeds / publisher audio)
// and as a keyless music fallback (30-second previews) when Spotify is not configured.
import type { ContentItem } from '../types.ts';
import { stripHtml } from './http.ts';
import { tagRetrieval, type Provider } from './types.ts';

interface ITunesResult {
  wrapperType?: string; kind?: string; collectionId?: number; trackId?: number; artistName?: string; collectionName?: string; trackName?: string;
  collectionViewUrl?: string; trackViewUrl?: string; artworkUrl600?: string; artworkUrl100?: string; artworkUrl160?: string; primaryGenreName?: string;
  genres?: Array<string | { name: string }>; releaseDate?: string; trackCount?: number; description?: string; shortDescription?: string; episodeUrl?: string;
  trackTimeMillis?: number; previewUrl?: string; country?: string; feedUrl?: string;
}

const genreNames = (g: ITunesResult['genres']) => (g ?? []).map((x) => (typeof x === 'string' ? x : x.name)).filter((x) => x && x !== 'Podcasts' && x !== 'Music');

export function mapITunes(r: ITunesResult): ContentItem | null {
  if (r.kind === 'podcast' && r.collectionId) {
    return {
      id: `itunes:podcast:${r.collectionId}`, category: 'podcasts', kind: 'podcast', provider: 'itunes', externalId: String(r.collectionId),
      title: r.collectionName ?? 'Untitled podcast', creators: r.artistName ? [r.artistName] : [], genres: [...new Set([r.primaryGenreName ?? '', ...genreNames(r.genres)].filter(Boolean))],
      tags: [], artworkUrl: r.artworkUrl600 ?? r.artworkUrl100, releaseDate: r.releaseDate?.slice(0, 10), externalUrl: r.collectionViewUrl ?? '',
      embed: { type: 'applepodcast', collectionId: String(r.collectionId) }, metadata: { episodes: r.trackCount, feedUrl: r.feedUrl },
    };
  }
  if ((r.kind === 'podcast-episode' || r.wrapperType === 'podcastEpisode') && r.trackId) {
    const desc = stripHtml(r.description ?? r.shortDescription);
    return {
      id: `itunes:episode:${r.trackId}`, category: 'podcasts', kind: 'episode', provider: 'itunes', externalId: String(r.trackId),
      title: r.trackName ?? 'Episode', creators: r.collectionName ? [r.collectionName] : [], description: desc.slice(0, 1500), genres: genreNames(r.genres),
      tags: [], artworkUrl: r.artworkUrl600 ?? r.artworkUrl160 ?? r.artworkUrl100, durationSec: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : undefined,
      releaseDate: r.releaseDate?.slice(0, 10), externalUrl: r.trackViewUrl ?? r.collectionViewUrl ?? '',
      embed: r.collectionId ? { type: 'applepodcast', collectionId: String(r.collectionId), episodeId: String(r.trackId) } : r.episodeUrl ? { type: 'audio', previewUrl: r.episodeUrl, label: 'Full episode from the publisher feed' } : null,
      metadata: { show: r.collectionName, audioUrl: r.episodeUrl },
    };
  }
  if (r.kind === 'song' && r.trackId) {
    return {
      id: `itunes:track:${r.trackId}`, category: 'music', kind: 'track', provider: 'itunes', externalId: String(r.trackId),
      title: r.trackName ?? 'Track', creators: r.artistName ? [r.artistName] : [], genres: r.primaryGenreName ? [r.primaryGenreName] : [], tags: r.collectionName ? [r.collectionName] : [],
      artworkUrl: (r.artworkUrl100 ?? '').replace('100x100bb', '600x600bb') || undefined, durationSec: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : undefined,
      releaseDate: r.releaseDate?.slice(0, 10), externalUrl: r.trackViewUrl ?? '',
      embed: r.previewUrl ? { type: 'audio', previewUrl: r.previewUrl, label: '30-second preview courtesy of Apple Music' } : null,
      playbackNote: 'Spotify is not connected on this server, so this is a 30-second Apple Music preview. Open the link for the full track.',
      metadata: { album: r.collectionName },
    };
  }
  return null;
}

export const itunes: Provider = {
  id: 'itunes',
  label: 'Apple Podcasts / iTunes Search',
  categories: ['podcasts', 'music'],
  searchCost: 1,
  setup: 'No key required.',
  configured: () => true,
  async search(p, { http }) {
    const entity = p.category === 'music' ? 'song' : p.kinds?.includes('episode') ? 'podcastEpisode' : 'podcast';
    const media = p.category === 'music' ? 'music' : 'podcast';
    const params = new URLSearchParams({ media, entity, term: p.query, limit: String(Math.min(p.limit ?? 20, 25)) });
    if (p.language && media === 'podcast') params.set('lang', p.language === 'en' ? 'en_us' : `${p.language}_${p.language}`);
    const data = await http.json<{ results: ITunesResult[] }>(`https://itunes.apple.com/search?${params}`, { cacheKey: `it:${params}`, ttl: 3 * 86400, provider: 'itunes' });
    return tagRetrieval((data.results ?? []).map(mapITunes).filter((x): x is ContentItem => !!x), p);
  },
  async resolve(title, { http }, category) {
    const media = category === 'music' ? 'music' : 'podcast';
    const params = new URLSearchParams({ media, term: title, limit: '3', entity: media === 'music' ? 'song' : 'podcast' });
    const data = await http.json<{ results: ITunesResult[] }>(`https://itunes.apple.com/search?${params}`, { cacheKey: `it:resolve:${params}`, ttl: 30 * 86400, provider: 'itunes' });
    const first = (data.results ?? []).map(mapITunes).find(Boolean);
    return first ?? null;
  },
};
