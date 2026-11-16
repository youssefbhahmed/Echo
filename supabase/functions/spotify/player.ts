// Pure helpers for Spotify Connect playback (no Deno APIs, no network): scopes, error mapping,
// device choice and player-state mapping. Unit-tested from tests/unit/ui/spotify-player.test.ts.

export const PLAYLIST_SCOPES = ['playlist-modify-private', 'playlist-modify-public'] as const;
export const PLAYBACK_SCOPES = ['user-modify-playback-state', 'user-read-playback-state', 'user-read-currently-playing'] as const;
export const SCOPES = [...PLAYLIST_SCOPES, ...PLAYBACK_SCOPES].join(' ');

/** Full-song playback needs the playback-control permission on the stored token. */
export function canPlayWith(scope: string | null | undefined): boolean {
  return (scope ?? '').split(/\s+/).includes('user-modify-playback-state');
}

/** Only tracks and episodes can be queued (Spotify ids are 22 base-62 characters). */
export const PLAYABLE_URI = /^spotify:(track|episode):[A-Za-z0-9]{22}$/;

export type PlayerErrorCode = 'no_device' | 'premium_required' | 'reconnect' | 'rate_limited' | 'restricted' | 'spotify_forbidden' | 'spotify_error';

export interface PlayerErrorInfo {
  /** HTTP status ECHO answers with. Never 401: the app treats 401 as "ECHO session expired". */
  status: number;
  code: PlayerErrorCode;
  message: string;
  /** Seconds to wait before calling Spotify again (rate limits only). */
  retryAfter?: number;
}

/** Spotify error bodies look like { error: { status, message, reason } } (or { error: 'invalid_grant' } for tokens). */
export function spotifyReason(body: unknown): { reason?: string; message?: string } {
  const err = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  if (typeof err === 'string') return { message: err };
  if (!err || typeof err !== 'object') return {};
  const e = err as { reason?: unknown; message?: unknown };
  return { reason: typeof e.reason === 'string' ? e.reason : undefined, message: typeof e.message === 'string' ? e.message : undefined };
}

/** Retry-After as seconds (number or HTTP date), bounded to a day; a short default when absent. */
export function retryAfterSeconds(header: string | null | undefined, now = Date.now(), fallback = 5): number {
  if (header == null || header.trim() === '') return fallback;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.max(1, Math.ceil(n)), 86400);
  const t = Date.parse(header);
  if (Number.isFinite(t)) return Math.min(Math.max(1, Math.ceil((t - now) / 1000)), 86400);
  return fallback;
}

/** Map a failed Spotify Web API player response to a stable ECHO error code. */
export function mapSpotifyError(status: number, body: unknown, retryAfter?: string | null, now = Date.now()): PlayerErrorInfo {
  const { reason, message } = spotifyReason(body);
  if (status === 429) return { status: 429, code: 'rate_limited', message: 'Spotify is busy right now. Try again in a moment.', retryAfter: retryAfterSeconds(retryAfter, now) };
  if (status === 401) return { status: 409, code: 'reconnect', message: 'Reconnect Spotify to keep playing full songs.' };
  if (status === 403) {
    if (reason === 'PREMIUM_REQUIRED' || /premium/i.test(message ?? '')) return { status: 403, code: 'premium_required', message: 'Full songs need Spotify Premium.' };
    if (/scope|permission/i.test(message ?? '')) return { status: 409, code: 'reconnect', message: 'Full songs need one more Spotify permission. Reconnect Spotify.' };
    if (reason) return { status: 409, code: 'restricted', message: 'Spotify did not allow that right now.' };
    return { status: 403, code: 'spotify_forbidden', message: 'Spotify refused: in Development Mode your Spotify account must be on the app’s user allowlist.' };
  }
  if (status === 404) return { status: 409, code: 'no_device', message: 'Open Spotify to start playing.' };
  return { status: 502, code: 'spotify_error', message: `Spotify error ${status}` };
}

export interface DeviceInfo {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
}

export function mapDevices(raw: unknown): DeviceInfo[] {
  const list = raw && typeof raw === 'object' ? (raw as { devices?: unknown }).devices : undefined;
  if (!Array.isArray(list)) return [];
  return list
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    .map((d) => ({
      id: typeof d.id === 'string' ? d.id : '',
      name: typeof d.name === 'string' && d.name ? d.name : 'Spotify',
      type: typeof d.type === 'string' ? d.type : '',
      isActive: d.is_active === true,
      isRestricted: d.is_restricted === true,
    }));
}

/** The device to wake for playback: the active one, else a phone, else a computer, else anything usable. */
export function pickDevice(devices: DeviceInfo[]): DeviceInfo | null {
  const rank = (d: DeviceInfo) => (d.isActive ? 0 : d.type.toLowerCase() === 'smartphone' ? 1 : d.type.toLowerCase() === 'computer' ? 2 : 3);
  const usable = devices.filter((d) => d.id && !d.isRestricted);
  return usable.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i)[0]?.d ?? null;
}

export interface PlayerTrack {
  uri: string;
  id: string;
  name: string;
  artists: string[];
  artworkUrl: string | null;
}

export interface PlayerState {
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  device: { id: string; name: string; type: string } | null;
  track: PlayerTrack | null;
}

export const IDLE_STATE: PlayerState = { isPlaying: false, progressMs: 0, durationMs: 0, device: null, track: null };

type Image = { url?: unknown; width?: unknown };

/** A small-but-sharp image (~300px) for a 56px thumbnail on high-density phone screens. */
export function pickImage(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  const valid = images.filter((i): i is Image => !!i && typeof i === 'object' && typeof (i as Image).url === 'string');
  if (!valid.length) return null;
  const width = (i: Image) => (typeof i.width === 'number' ? i.width : 0);
  const sharp = valid.filter((i) => width(i) >= 160).sort((a, b) => width(a) - width(b))[0];
  return (sharp ?? valid.sort((a, b) => width(b) - width(a))[0]).url as string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

/** GET /v1/me/player → ECHO's compact state. A 204 (nothing playing) arrives here as null. */
export function mapPlayerState(raw: unknown): PlayerState {
  if (!raw || typeof raw !== 'object') return IDLE_STATE;
  const r = raw as { is_playing?: unknown; progress_ms?: unknown; device?: Record<string, unknown> | null; item?: Record<string, unknown> | null };
  const item = r.item && typeof r.item === 'object' ? r.item : null;
  let track: PlayerTrack | null = null;
  if (item && typeof item.uri === 'string') {
    const album = item.album as { images?: unknown } | undefined;
    const show = item.show as { images?: unknown; name?: unknown } | undefined;
    const artists = Array.isArray(item.artists)
      ? (item.artists as Array<{ name?: unknown }>).map((a) => (typeof a?.name === 'string' ? a.name : '')).filter(Boolean)
      : typeof show?.name === 'string' ? [show.name] : [];
    track = {
      uri: item.uri,
      id: typeof item.id === 'string' ? item.id : (item.uri.split(':')[2] ?? ''),
      name: typeof item.name === 'string' ? item.name : '',
      artists,
      artworkUrl: pickImage(album?.images) ?? pickImage(item.images) ?? pickImage(show?.images),
    };
  }
  const d = r.device && typeof r.device === 'object' ? r.device : null;
  return {
    isPlaying: r.is_playing === true,
    progressMs: num(r.progress_ms),
    durationMs: num(item?.duration_ms),
    device: d ? { id: typeof d.id === 'string' ? d.id : '', name: typeof d.name === 'string' && d.name ? d.name : 'Spotify', type: typeof d.type === 'string' ? d.type : '' } : null,
    track,
  };
}
