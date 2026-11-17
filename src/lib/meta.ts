import type { Category, ContentKind } from '@shared/types.ts';
import { BookOpen, Clapperboard, Mic2, Music2, PlaySquare, type LucideIcon } from 'lucide-react';

export const CATEGORY_META: Record<Category, { label: string; short: string; color: string; icon: LucideIcon }> = {
  youtube: { label: 'Videos', short: 'Video', color: 'var(--color-coral)', icon: PlaySquare },
  music: { label: 'Music', short: 'Music', color: 'var(--color-tide)', icon: Music2 },
  screen: { label: 'Film & TV', short: 'Screen', color: 'var(--color-amber)', icon: Clapperboard },
  books: { label: 'Books', short: 'Book', color: 'var(--color-paper)', icon: BookOpen },
  podcasts: { label: 'Podcasts', short: 'Podcast', color: 'var(--color-iris)', icon: Mic2 },
};

export const KIND_LABEL: Record<ContentKind, string> = {
  video: 'Video', track: 'Song', album: 'Album', artist: 'Artist', playlist: 'Playlist', movie: 'Film', series: 'Series', book: 'Book', podcast: 'Podcast', episode: 'Episode',
};

export const PROVIDER_LABEL: Record<string, string> = {
  youtube: 'YouTube', spotify: 'Spotify', tmdb: 'TMDB', tvmaze: 'TVmaze', openlibrary: 'Open Library', podcastindex: 'Podcast Index',
};

export function formatDuration(sec?: number): string | null {
  if (!sec) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m >= 10) return `${m} min`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * YouTube titles carry channel/SEO suffixes ("Title | British Short Film | Sci-Fi"): show the real title.
 * A live session in a music lane shows its song, or what the session is called ("Tiny Desk Concert"),
 * next to the artist (its credit).
 */
export function displayTitle(item: { title: string; provider: string; metadata?: Record<string, unknown> | null }): string {
  if (item.provider !== 'youtube') return item.title;
  const label = (item.metadata?.session as { label?: unknown } | undefined)?.label;
  if (typeof label === 'string' && label.trim()) return label.trim();
  const first = item.title.split(/\s+[|•]\s+|\s+[-–—]\s+(?=[A-Z0-9])/)[0].trim();
  return first.length >= 3 ? first : item.title;
}

export function year(d?: string): string | null {
  return d ? d.slice(0, 4) : null;
}
