// ListenBrainz labs metadata → Spotify id mapping (keyless).
// https://labs.api.listenbrainz.org/spotify-id-from-metadata — POST a JSON array of
// {artist_name, release_name, track_name}; each answer row carries spotify_track_ids (partial coverage).
// Used to resolve curator picks without Spotify's rate-limited search endpoint.
//
// The mapping matches the FULL artist credit as MusicBrainz writes it: "Eminem" + "Stan" finds nothing,
// "Eminem feat. Dido" (or "Eminem, Dido") + "Stan" finds it. So each pick is sent as a few variants
// (as given, full credits, title without featuring/version parts, the other apostrophe) and the ids
// found are merged per pick.
import { hashKey, type HttpClient } from './http.ts';
import { fold, splitArtist, splitTitle } from '../engine/text.ts';

export const LB_SPOTIFY_MAPPING_URL = 'https://labs.api.listenbrainz.org/spotify-id-from-metadata/json';
export const LB_CHUNK = 25;
export const LB_TIMEOUT_MS = 8000;
/** Query variants per pick. */
export const LB_MAX_VARIANTS = 4;
/** Candidate ids kept per pick (merged across its variants). */
export const LB_MAX_IDS = 4;

interface LbRow {
  artist_name?: string;
  release_name?: string;
  track_name?: string;
  spotify_track_ids?: unknown;
}

export interface LbPick {
  /** Main artist (a full credit like "A feat. B" also works). */
  artist: string;
  track: string;
  /** Officially credited featured artists, when the curator listed them. */
  feat?: string[];
}

export interface LbQuery {
  artist: string;
  track: string;
}

// Any script survives (an Arabic-script name must not fold to '' and collide with every other one).
const key = (artist: string, track: string) => `${fold(artist) || artist.trim().toLowerCase()}|${fold(track) || track.trim().toLowerCase()}`;
const exact = (artist: string, track: string) => `${artist}\u0000${track}`;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

/** "A", "A & B", "A, B & C". */
const joinNames = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`);

/** The same text with the other apostrophe (' ↔ ’), or null when it has none. */
export function otherApostrophe(x: string): string | null {
  if (x.includes('’')) return x.replace(/’/g, "'");
  if (x.includes("'")) return x.replace(/'/g, '’');
  return null;
}

/** Full credits for a main artist and its featured names, in the forms MusicBrainz uses most. */
export function creditVariants(main: string, feat: string[]): string[] {
  if (!feat.length) return [];
  if (feat.length === 1) return [`${main} feat. ${feat[0]}`, `${main} & ${feat[0]}`];
  return [`${main} feat. ${joinNames(feat)}`, `${main}, ${joinNames(feat)}`];
}

/**
 * Query rows for one pick, best first, deduped, at most `max`: as given; full credits with the clean
 * title; the same with the other apostrophe; the main artist with the clean title. Featured names come
 * from pick.feat, a "feat." in the artist, or a "(feat. …)"/"(with …)" part of the title.
 */
export function lbVariants(pick: LbPick, max = LB_MAX_VARIANTS): LbQuery[] {
  const given = { artist: pick.artist.trim(), track: pick.track.trim() };
  const a = splitArtist(given.artist);
  const t = splitTitle(given.track);
  const seenNames = new Set([fold(a.main)]);
  const feat: string[] = [];
  for (const n of [...(pick.feat ?? []), ...a.feat, ...t.feat]) {
    const k = fold(n);
    if (!k || seenNames.has(k)) continue;
    seenNames.add(k);
    feat.push(n.trim());
  }
  const credits = creditVariants(a.main, feat.slice(0, 3));
  const alt = otherApostrophe(t.title);
  const altGiven = otherApostrophe(given.track);
  const candidates: LbQuery[] = [
    given,
    ...credits.map((c) => ({ artist: c, track: t.title })),
    ...(alt ? credits.map((c) => ({ artist: c, track: alt })) : []),
    { artist: a.main, track: t.title },
    ...(alt ? [{ artist: a.main, track: alt }] : []),
    ...(altGiven ? [{ artist: given.artist, track: altGiven }] : []),
  ];
  const out: LbQuery[] = [];
  const seen = new Set<string>();
  for (const q of candidates) {
    const k = exact(q.artist, q.track);
    if (!q.artist || !q.track || seen.has(k)) continue;
    seen.add(k);
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}

/** Ids per pick from its variants' ids, in variant order, deduped, at most `max`. */
export function mergeVariantIds(perVariant: string[][], max = LB_MAX_IDS): string[] {
  const out: string[] = [];
  for (const ids of perVariant) {
    for (const id of ids) {
      if (out.length >= max) return out;
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * Candidate Spotify track ids per pick (same order as `picks`; [] when unmapped), from up to
 * LB_MAX_VARIANTS query rows per pick. Rows go in batched POSTs of ≤ 25 (chunks in parallel, 8 s
 * timeout, cached per chunk); a failing chunk only leaves its rows unmapped.
 */
export async function lbSpotifyIds(picks: LbPick[], http: HttpClient, opts: { chunk?: number; timeoutMs?: number; variants?: number } = {}): Promise<string[][]> {
  const size = Math.max(1, Math.min(LB_CHUNK, opts.chunk ?? LB_CHUNK));
  const rows: Array<LbQuery & { pick: number; variant: number }> = [];
  picks.forEach((p, i) => lbVariants(p, opts.variants ?? LB_MAX_VARIANTS).forEach((q, v) => rows.push({ ...q, pick: i, variant: v })));
  const found: string[][][] = picks.map(() => []);
  for (const r of rows) found[r.pick][r.variant] = [];
  const chunks: Array<typeof rows> = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  await Promise.all(chunks.map(async (chunk) => {
    const body = chunk.map((r) => ({ artist_name: r.artist, release_name: '', track_name: r.track }));
    let res: LbRow[];
    try {
      const raw = await http.json<unknown>(LB_SPOTIFY_MAPPING_URL, {
        init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        timeoutMs: opts.timeoutMs ?? LB_TIMEOUT_MS,
        provider: 'listenbrainz',
        cacheKey: `lb:spotify-map:${await hashKey(JSON.stringify(body))}`,
        ttl: 7 * 86400,
      });
      res = Array.isArray(raw) ? (raw as LbRow[]) : [];
    } catch {
      return; // best effort: these picks fall through to the next resolver step
    }
    const ids = (r: LbRow | undefined) => (Array.isArray(r?.spotify_track_ids) ? (r!.spotify_track_ids as unknown[]).filter((x): x is string => typeof x === 'string' && SPOTIFY_ID.test(x)).slice(0, 3) : []);
    // Rows come back in request order; fall back to matching the echoed names when the counts differ.
    if (res.length === chunk.length) {
      chunk.forEach((r, j) => (found[r.pick][r.variant] = ids(res[j])));
      return;
    }
    const byExact = new Map(res.map((r) => [exact(r.artist_name ?? '', r.track_name ?? ''), r]));
    const byName = new Map(res.map((r) => [key(r.artist_name ?? '', r.track_name ?? ''), r]));
    for (const r of chunk) found[r.pick][r.variant] = ids(byExact.get(exact(r.artist, r.track)) ?? byName.get(key(r.artist, r.track)));
  }));
  return found.map((perVariant) => mergeVariantIds(perVariant));
}
