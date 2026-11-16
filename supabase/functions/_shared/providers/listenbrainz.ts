// ListenBrainz labs metadata → Spotify id mapping (keyless).
// https://labs.api.listenbrainz.org/spotify-id-from-metadata — POST a JSON array of
// {artist_name, release_name, track_name}; each answer row carries spotify_track_ids (partial coverage).
// Used to resolve curator picks without Spotify's rate-limited search endpoint.
import { hashKey, type HttpClient } from './http.ts';

export const LB_SPOTIFY_MAPPING_URL = 'https://labs.api.listenbrainz.org/spotify-id-from-metadata/json';
export const LB_CHUNK = 25;
export const LB_TIMEOUT_MS = 8000;

interface LbRow {
  artist_name?: string;
  release_name?: string;
  track_name?: string;
  spotify_track_ids?: unknown;
}

const key = (artist: string, track: string) => `${artist}|${track}`.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9|]/g, '');
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

/**
 * Candidate Spotify track ids per pick (same order as `picks`; [] when unmapped).
 * Chunks of ≤ 25 rows, 8 s timeout each; a failing chunk only leaves its picks unmapped.
 */
export async function lbSpotifyIds(picks: Array<{ artist: string; track: string }>, http: HttpClient, opts: { chunk?: number; timeoutMs?: number } = {}): Promise<string[][]> {
  const size = Math.max(1, Math.min(LB_CHUNK, opts.chunk ?? LB_CHUNK));
  const out: string[][] = picks.map(() => []);
  const chunks: number[][] = [];
  for (let i = 0; i < picks.length; i += size) chunks.push(picks.slice(i, i + size).map((_, j) => i + j));
  await Promise.all(chunks.map(async (idx) => {
    const body = idx.map((i) => ({ artist_name: picks[i].artist, release_name: '', track_name: picks[i].track }));
    let rows: LbRow[];
    try {
      const res = await http.json<unknown>(LB_SPOTIFY_MAPPING_URL, {
        init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        timeoutMs: opts.timeoutMs ?? LB_TIMEOUT_MS,
        provider: 'listenbrainz',
        cacheKey: `lb:spotify-map:${await hashKey(JSON.stringify(body))}`,
        ttl: 7 * 86400,
      });
      rows = Array.isArray(res) ? (res as LbRow[]) : [];
    } catch {
      return; // best effort: these picks fall through to the next resolver step
    }
    const ids = (r: LbRow | undefined) => (Array.isArray(r?.spotify_track_ids) ? (r!.spotify_track_ids as unknown[]).filter((x): x is string => typeof x === 'string' && SPOTIFY_ID.test(x)).slice(0, 3) : []);
    // Rows come back in request order; fall back to matching the echoed names when the counts differ.
    if (rows.length === idx.length) {
      idx.forEach((i, j) => (out[i] = ids(rows[j])));
      return;
    }
    const byName = new Map(rows.map((r) => [key(r.artist_name ?? '', r.track_name ?? ''), r]));
    for (const i of idx) out[i] = ids(byName.get(key(picks[i].artist, picks[i].track)));
  }));
  return out;
}
