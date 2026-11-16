import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AnalyzedItem, FeedbackType } from '@shared/types.ts';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { toast } from '../components/Toast';
import { conceptLabel } from '@shared/engine/concepts.ts';

export interface LibraryRow {
  item_id: string;
  saved: boolean;
  status: 'none' | 'want' | 'in_progress' | 'consumed';
  liked: boolean | null;
  rating: number | null;
  note: string | null;
  saved_at: string | null;
  consumed_at: string | null;
  updated_at: string;
  content_items: DbItem | null;
}

export interface DbItem {
  id: string; category: AnalyzedItem['category']; kind: AnalyzedItem['kind']; provider: AnalyzedItem['provider']; external_id: string; title: string; creators: string[];
  description: string | null; genres: string[]; tags: string[]; artwork_url: string | null; duration_sec: number | null; language: string | null; release_date: string | null;
  external_url: string; embed: AnalyzedItem['embed']; playback_note: string | null; rating: number | null; popularity: number | null; metadata: Record<string, unknown>; concepts: Record<string, number>; stale: boolean;
}

export function dbToItem(r: DbItem): AnalyzedItem {
  return {
    id: r.id, category: r.category, kind: r.kind, provider: r.provider, externalId: r.external_id, title: r.title, creators: r.creators ?? [], description: r.description ?? undefined,
    genres: r.genres ?? [], tags: r.tags ?? [], artworkUrl: r.artwork_url ?? undefined, durationSec: r.duration_sec ?? undefined, language: r.language ?? undefined,
    releaseDate: r.release_date ?? undefined, externalUrl: r.external_url, embed: r.embed, playbackNote: r.playback_note ?? undefined, rating: r.rating ?? undefined,
    popularity: r.popularity ?? undefined, metadata: { ...(r.metadata ?? {}), stale: r.stale }, concepts: r.concepts ?? {},
  };
}

export function useProfile() {
  const { session } = useAuth();
  return useQuery({ queryKey: ['profile'], queryFn: api.profile, enabled: !!session, staleTime: 30_000 });
}

export function useLibrary() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['library'],
    enabled: !!session,
    queryFn: async () => {
      // The API returns at most 1,000 rows per request, so page through the whole library.
      const all: LibraryRow[] = [];
      for (let from = 0; from < 20000; from += 1000) {
        const { data, error } = await supabase.from('library_items').select('*, content_items(*)').order('updated_at', { ascending: false }).range(from, from + 999);
        if (error) throw error;
        all.push(...((data ?? []) as LibraryRow[]));
        if (!data || data.length < 1000) break;
      }
      return all;
    },
    staleTime: 15_000,
  });
}

const mapCache = new WeakMap<LibraryRow[], Map<string, LibraryRow>>();
const EMPTY: LibraryRow[] = [];

/** Library rows by item id. Built once per library snapshot and shared by every card. */
export function useLibraryMap() {
  const rows = useLibrary().data ?? EMPTY;
  let map = mapCache.get(rows);
  if (!map) {
    map = new Map(rows.map((r) => [r.item_id, r]));
    mapCache.set(rows, map);
  }
  return map;
}

export function useCollections() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['collections'],
    enabled: !!session,
    queryFn: async () => {
      const { data, error } = await supabase.from('collections').select('id, name, description, created_at, collection_items(item_id)').order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as Array<{ id: string; name: string; description: string | null; created_at: string; collection_items: Array<{ item_id: string }> }>;
    },
  });
}

export function useRecent() {
  const { session } = useAuth();
  return useQuery({
    queryKey: ['recent'],
    enabled: !!session,
    queryFn: async () => {
      const { data, error } = await supabase.from('recommendation_events').select('item_id, created_at, explanation, content_items(*)').order('created_at', { ascending: false }).limit(60);
      if (error) throw error;
      const seen = new Set<string>();
      return (data ?? []).filter((r) => !seen.has(r.item_id) && seen.add(r.item_id)).slice(0, 16) as unknown as Array<{ item_id: string; created_at: string; explanation: string; content_items: DbItem | null }>;
    },
  });
}

/** Send feedback: optimistic library update, then server-side learning. */
export function useFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { item: AnalyzedItem; type: FeedbackType; rating?: number; source?: 'feed' | 'chat' | 'library' }) =>
      api.feedback({ itemId: v.item.id, type: v.type, rating: v.rating, context: { source: v.source } }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['library'] });
      const prev = qc.getQueryData<LibraryRow[]>(['library']);
      const patch: Partial<LibraryRow> | null =
        v.type === 'like' ? { liked: true } : v.type === 'dislike' ? { liked: false, saved: false } : v.type === 'save' ? { saved: true } : v.type === 'unsave' ? { saved: false } : v.type === 'rate' ? { rating: v.rating ?? null } : v.type === 'consumed' ? { status: 'consumed' } : null;
      if (patch && prev) {
        const exists = prev.some((r) => r.item_id === v.item.id);
        qc.setQueryData<LibraryRow[]>(['library'], exists ? prev.map((r) => (r.item_id === v.item.id ? { ...r, ...patch } : r)) : prev);
      }
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['library'], ctx.prev);
      toast((e as Error).message, 'error');
    },
    onSuccess: (res, v) => {
      qc.invalidateQueries({ queryKey: ['library'] });
      qc.invalidateQueries({ queryKey: ['profile'] });
      const learned = res.learned.filter((l) => Math.abs(l.to - l.from) > 0.02).slice(0, 2);
      const verb: Record<string, string> = { like: 'Liked', dislike: 'Noted — fewer like this', save: 'Saved to your library', consumed: 'Marked as finished', rate: 'Rated', skip: 'Skipped' };
      if (verb[v.type]) toast(`${verb[v.type]}${learned.length ? ` · learning: ${learned.map((l) => `${conceptLabel(l.concept).toLowerCase()} ${l.to > l.from ? '↑' : '↓'}`).join(', ')}` : ''}`);
    },
  });
}
