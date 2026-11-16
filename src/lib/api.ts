import type { Category, DiscoverResponse, FeedbackType, Intent } from '@shared/types.ts';
import type { TasteInsights } from '@shared/engine/insights.ts';
import type { ProfileEdit } from '@shared/engine/profile.ts';
import type { AnalyzedItem, TasteProfile } from '@shared/types.ts';
import { functionsUrl, supabase } from './supabase';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function call<T>(name: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError(401, 'Please sign in.', 'unauthenticated');
  let res: Response;
  try {
    res = await fetch(`${functionsUrl}/${name}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, navigator.onLine ? 'ECHO’s server could not be reached.' : 'You are offline. Saved items are still available.', 'network');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? `Request failed (${res.status})`, json.code);
  return json as T;
}

export interface ServerInfo {
  providers: Array<{ id: string; label: string; configured: boolean; categories: Category[]; setup?: string }>;
  ai: { enabled: boolean; model?: string };
  embeddings: boolean;
}

export interface ProfileResponse {
  account: { email?: string; display_name?: string; onboarded_at?: string | null; settings?: Record<string, unknown>; created_at?: string };
  model: Omit<TasteProfile, 'embedding'>;
  insights: TasteInsights;
  stats: { library: number; interactions: number };
  server: ServerInfo;
}

export interface ChatResponse extends DiscoverResponse {
  sessionId: string;
}

export const api = {
  discover: (body: { query?: string; categories?: Category[]; moods?: string[]; exploration?: number; limit?: number; exclude?: string[]; seed?: number; intentHint?: Partial<Intent>; mix?: Partial<Record<Category, number>> }) =>
    call<DiscoverResponse>('discover', body),
  chat: (body: { message: string; sessionId?: string; categories?: Category[]; exploration?: number; intentHint?: Record<string, unknown> }) => call<ChatResponse>('chat', body),
  feedback: (body: { itemId: string; type: FeedbackType; rating?: number; context?: { source?: 'feed' | 'chat' | 'library' | 'onboarding'; query?: string; exploration?: number } }) =>
    call<{ ok: true; learned: Array<{ concept: string; from: number; to: number }>; interactionCount: number; library: unknown }>('feedback', body),
  profile: () => call<ProfileResponse>('profile', undefined, 'GET'),
  editProfile: (edit: ProfileEdit) => call<{ model: TasteProfile; insights: TasteInsights }>('profile', { action: 'edit', edit }),
  resetProfile: () => call<{ model: TasteProfile }>('profile', { action: 'reset' }),
  onboarding: (body: { displayName?: string; categories?: Category[]; interests?: string[]; description?: string; exploration?: number; favorites?: string[] }) =>
    call<{ model: TasteProfile; insights: TasteInsights }>('profile', { action: 'onboarding', ...body }),
  lookup: (query: string, category?: Category) => call<{ items: AnalyzedItem[] }>('catalog', { action: 'lookup', query, category }),
  trailer: (itemId: string) => call<{ videoId: string | null }>('catalog', { action: 'trailer', itemId }),
  refresh: (itemIds: string[]) => call<{ refreshed: number }>('catalog', { action: 'refresh', itemIds }),
  importSpotifyLiked: (tracks: unknown[]) => call<{ imported: number; topStyles: string[]; topArtists: string[] }>('import', { source: 'spotify-liked-csv', tracks }),
  exportData: () => call<Record<string, unknown>>('account', { action: 'export' }),
  deleteAccount: () => call<{ deleted: true }>('account', { action: 'delete', confirm: 'DELETE' }),
  spotifyStatus: () => call<{ connected: boolean; scope: string | null; since: string | null }>('spotify', { action: 'status' }),
  spotifyAuthorize: (redirectTo: string) => call<{ url: string }>('spotify', { action: 'authorize', redirectTo }),
  spotifyDisconnect: () => call<{ connected: false }>('spotify', { action: 'disconnect' }),
  spotifyPlaylist: (name: string, itemIds: string[]) => call<{ playlistUrl: string; added: number }>('spotify', { action: 'create-playlist', name, itemIds }),
};
