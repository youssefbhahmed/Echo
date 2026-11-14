import type { Category, ProviderId } from '../types.ts';
import { itunes } from './itunes.ts';
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
  itunes,
  podcastindex: undefined,
};

/**
 * Which providers serve a category, in priority order, given configuration.
 * Keyless fallbacks keep every category usable with zero configuration except YouTube.
 */
export function providersFor(category: Category, env: Env): Provider[] {
  switch (category) {
    case 'youtube':
      return youtube.configured(env) ? [youtube] : [];
    case 'music':
      return spotify.configured(env) ? [spotify] : [itunes];
    case 'screen':
      return tmdbProvider.configured(env) ? [tmdbProvider] : [tvmaze];
    case 'books':
      return [openLibrary];
    case 'podcasts':
      return spotify.configured(env) ? [itunes, spotify] : [itunes];
  }
}

export function providerStatus(env: Env) {
  return (Object.values(PROVIDERS).filter(Boolean) as Provider[]).map((p) => ({ id: p.id, label: p.label, configured: p.configured(env), categories: p.categories, setup: p.setup }));
}

export type { Env, Provider };
