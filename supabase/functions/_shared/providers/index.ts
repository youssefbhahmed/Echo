import type { Category, ProviderId } from '../types.ts';
import { openLibrary } from './openlibrary.ts';
import { spotify } from './spotify.ts';
import { tmdbProvider } from './tmdb.ts';
import { tvmaze } from './tvmaze.ts';
import type { Env, Provider } from './types.ts';
import { youtube } from './youtube.ts';

export const PROVIDERS: Record<ProviderId, Provider | undefined> = {
  youtube,
  spotify,
  tmdb: tmdbProvider,
  tvmaze,
  openlibrary: openLibrary,
  podcastindex: undefined,
};

/**
 * Which providers serve a category, in priority order, given configuration.
 * Music and podcasts come from Spotify only; books (Open Library) and TV (TVmaze fallback) are keyless.
 */
export function providersFor(category: Category, env: Env): Provider[] {
  switch (category) {
    case 'youtube':
      return youtube.configured(env) ? [youtube] : [];
    case 'music':
      return spotify.configured(env) ? [spotify] : [];
    case 'screen':
      return tmdbProvider.configured(env) ? [tmdbProvider] : [tvmaze];
    case 'books':
      return [openLibrary];
    case 'podcasts':
      // Spotify shows/episodes + full-length YouTube podcast episodes.
      return [...(spotify.configured(env) ? [spotify] : []), ...(youtube.configured(env) ? [youtube] : [])];
  }
}

export function providerStatus(env: Env) {
  return (Object.values(PROVIDERS).filter(Boolean) as Provider[]).map((p) => ({ id: p.id, label: p.label, configured: p.configured(env), categories: p.categories, setup: p.setup }));
}

export type { Env, Provider };
