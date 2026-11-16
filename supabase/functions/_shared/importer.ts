// Import a user's own Spotify "Liked Songs" export (Exportify-style CSV) into ECHO.
// Pure functions: parse → normalise to ContentItems → bulk-learn the taste profile.
// The data stays in ECHO's deterministic engine; track/artist names are never sent to AI models.
import type { AnalyzedItem, ConceptVector, ContentItem, MusicDna, MusicLane, MusicPolicy, TasteProfile } from './types.ts';
import { genreHints } from './engine/analyze.ts';
import { applyLanePolicy, decadeLabel, DEFAULT_MIN_YEAR, DEFAULT_POLICY, LANE_BY_ID, laneOfGenre, laneOfGenres, moodPhrase, tempoWord, yearOf } from './engine/lanes.ts';
import { CAP } from './engine/profile.ts';
import { normKey, round } from './engine/text.ts';

export interface ImportedTrack {
  id: string; // Spotify track id
  name: string;
  album?: string;
  artists: string[];
  releaseDate?: string;
  durationMs?: number;
  genres: string[];
  valence?: number;
  energy?: number;
  danceability?: number;
  acousticness?: number;
  speechiness?: number;
  instrumentalness?: number;
  tempo?: number;
  loudness?: number;
  /** Spotify popularity 0..100 at export time. */
  popularity?: number;
  addedAt?: string;
  /** Recording identity across single/album/deluxe ids (so a liked song isn't served back under another id). */
  isrc?: string;
}

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

/** Map an Exportify/Spotify CSV into tracks. Accepts English column names (case-insensitive). */
export function tracksFromCsv(text: string): ImportedTrack[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const idx = (...names: string[]) => header.findIndex((h) => names.some((n) => h.trim().toLowerCase() === n));
  const iUri = idx('track uri', 'spotify uri', 'uri');
  const iName = idx('track name', 'name');
  const iAlbum = idx('album name', 'album');
  const iArtists = idx('artist name(s)', 'artist names', 'artists', 'artist');
  const iRel = idx('release date', 'album release date');
  const iDur = idx('duration (ms)', 'duration_ms');
  const iGenres = idx('genres', 'artist genres');
  const iVal = idx('valence');
  const iEn = idx('energy');
  const iDance = idx('danceability');
  const iAc = idx('acousticness');
  const iSp = idx('speechiness');
  const iIn = idx('instrumentalness');
  const iTempo = idx('tempo');
  const iLoud = idx('loudness');
  const iPop = idx('popularity');
  const iAdded = idx('added at');
  const iIsrc = idx('isrc');
  if (iUri < 0 || iName < 0) throw new Error('This CSV has no "Track URI" / "Track Name" columns. Export Liked Songs with Exportify (exportify.app).');
  const out: ImportedTrack[] = [];
  for (const r of rows) {
    const m = /spotify:track:([A-Za-z0-9]{22})/.exec(r[iUri] ?? '') ?? /track\/([A-Za-z0-9]{22})/.exec(r[iUri] ?? '');
    if (!m || !r[iName]) continue;
    const num = (i: number) => (i >= 0 && r[i] !== '' && isFinite(Number(r[i])) ? Number(r[i]) : undefined);
    out.push({
      id: m[1],
      name: r[iName].slice(0, 300),
      album: iAlbum >= 0 ? r[iAlbum]?.slice(0, 300) : undefined,
      artists: (iArtists >= 0 ? r[iArtists] ?? '' : '').split(/;|,(?=\S)/).map((a) => a.trim()).filter(Boolean).slice(0, 6),
      releaseDate: iRel >= 0 ? r[iRel] : undefined,
      durationMs: num(iDur),
      genres: (iGenres >= 0 ? r[iGenres] ?? '' : '').split(',').map((g) => g.trim()).filter(Boolean).slice(0, 12),
      valence: num(iVal),
      energy: num(iEn),
      danceability: num(iDance),
      acousticness: num(iAc),
      speechiness: num(iSp),
      instrumentalness: num(iIn),
      tempo: num(iTempo),
      loudness: num(iLoud),
      popularity: num(iPop),
      addedAt: iAdded >= 0 ? r[iAdded] : undefined,
      ...(iIsrc >= 0 && /^[A-Za-z0-9-]{12,15}$/.test((r[iIsrc] ?? '').trim()) ? { isrc: r[iIsrc].trim().toUpperCase() } : {}),
    });
  }
  const seen = new Set<string>();
  return out.filter((t) => !seen.has(t.id) && seen.add(t.id));
}

/** Track → analysed catalog item. Audio mood features add grounded mood concepts. */
export function trackToItem(t: ImportedTrack): AnalyzedItem {
  const item: ContentItem = {
    id: `spotify:track:${t.id}`, category: 'music', kind: 'track', provider: 'spotify', externalId: t.id, title: t.name, creators: t.artists,
    genres: t.genres, tags: t.album ? [t.album] : [], durationSec: t.durationMs ? Math.round(t.durationMs / 1000) : undefined, releaseDate: t.releaseDate,
    externalUrl: `https://open.spotify.com/track/${t.id}`, embed: { type: 'spotify', uri: `spotify:track:${t.id}`, kind: 'track' },
    metadata: { album: t.album, imported: 'spotify-liked', valence: t.valence, energy: t.energy, ...(t.isrc ? { isrc: t.isrc } : {}) },
  };
  // Song titles are not descriptions ("All Of The Lights", "Power"), so imported songs are analysed
  // only from their genres and audio mood data.
  const c: ConceptVector = { ...genreHints(t.genres) };
  const a: AnalyzedItem = { ...item, concepts: c };
  const bump = (k: string, v: number) => (c[k] = round(Math.max(c[k] ?? 0, v)));
  if (t.valence !== undefined) {
    if (t.valence <= 0.3) bump('melancholic', 0.5);
    if (t.valence >= 0.7) bump('joyful', 0.5);
  }
  if (t.energy !== undefined) {
    if (t.energy >= 0.75) bump('energetic', 0.5);
    if (t.energy <= 0.3) bump('calm', 0.5);
  }
  return { ...a, concepts: c };
}

/**
 * Learn from a library in one pass (instead of 1,000 sequential updates whose learning rate decays).
 * Recently added songs weigh more; weights are bounded like normal feedback.
 * `inferredGenres` (per item) are the lane genres of untagged songs (see analyzeLibrary): they count at
 * half weight so mostly-untagged English mainstream songs are represented next to tagged ones.
 */
export function applyLibraryImport(input: TasteProfile, items: AnalyzedItem[], addedAt: Array<string | undefined>, now = new Date(), opts: { inferredGenres?: Array<string[] | undefined> } = {}): TasteProfile {
  if (!items.length) return input;
  // Re-import replaces the previous import's contribution instead of stacking on top of it.
  const profile = removeImportContribution(input);
  const recency = (iso?: string) => {
    if (!iso) return 1;
    const days = (now.getTime() - new Date(iso).getTime()) / 86_400_000;
    return days < 90 ? 1.5 : days < 365 ? 1.15 : 1;
  };
  const conceptSum: ConceptVector = {};
  const genreCount: Record<string, number> = {};
  const artistCount: Record<string, number> = {};
  let wTotal = 0;
  items.forEach((it, i) => {
    const w = recency(addedAt[i]);
    wTotal += w;
    for (const [k, v] of Object.entries(it.concepts)) conceptSum[k] = (conceptSum[k] ?? 0) + v * w;
    for (const g of it.genres) genreCount[normKey(g)] = (genreCount[normKey(g)] ?? 0) + w;
    if (!it.genres.length) for (const g of opts.inferredGenres?.[i] ?? []) genreCount[normKey(g)] = (genreCount[normKey(g)] ?? 0) + w * 0.5;
    for (const a of it.creators) artistCount[normKey(a)] = (artistCount[normKey(a)] ?? 0) + w;
  });
  const clamp = (x: number) => Math.max(-CAP, Math.min(CAP, x));
  const concepts = { ...profile.concepts };
  const musicConcepts = { ...(profile.conceptsByCategory.music ?? {}) };
  for (const [k, sum] of Object.entries(conceptSum)) {
    const share = sum / wTotal; // average presence across the library (0..1)
    if (share < 0.03) continue;
    const add = round(Math.min(1.6, share * 4));
    musicConcepts[k] = round(clamp((musicConcepts[k] ?? 0) + add));
  }
  const genres = { ...profile.genres };
  for (const [g, n] of Object.entries(genreCount)) if (n >= 2) genres[g] = round(clamp((genres[g] ?? 0) + 2 * Math.tanh(n / 12)));
  const creators = { ...profile.creators };
  for (const [a, n] of Object.entries(artistCount)) creators[a] = round(clamp((creators[a] ?? 0) + (n >= 2 ? 1.2 * Math.tanh(n / 3) + 0.3 : 0.35)));
  const trim = (m: Record<string, number>, n: number) => Object.fromEntries(Object.entries(m).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, n));
  const diff = (after: Record<string, number>, before: Record<string, number>) =>
    Object.fromEntries(Object.entries(after).map(([k, v]) => [k, round(v - (before[k] ?? 0))]).filter(([, d]) => Math.abs(d as number) > 0.001));
  const next = {
    ...profile,
    concepts,
    conceptsByCategory: { ...profile.conceptsByCategory, music: musicConcepts },
    genres: trim(genres, 300),
    creators: trim(creators, 600),
    categories: { ...profile.categories, music: round(clamp((profile.categories.music ?? 0) + 1.2)) },
    interactionCount: profile.interactionCount + Math.min(items.length, 60),
    updatedAt: now.toISOString(),
  };
  const contribution: ImportContribution = {
    concepts: diff(next.concepts, profile.concepts),
    musicConcepts: diff(musicConcepts, profile.conceptsByCategory.music ?? {}),
    genres: diff(next.genres, profile.genres),
    creators: diff(next.creators, profile.creators),
    music: round((next.categories.music ?? 0) - (profile.categories.music ?? 0)),
    interactions: Math.min(items.length, 60),
  };
  return { ...next, importContribution: contribution } as TasteProfile;
}

interface ImportContribution {
  concepts: Record<string, number>;
  musicConcepts: Record<string, number>;
  genres: Record<string, number>;
  creators: Record<string, number>;
  music: number;
  interactions: number;
}

export function removeImportContribution(p: TasteProfile): TasteProfile {
  const c = (p as TasteProfile & { importContribution?: ImportContribution }).importContribution;
  if (!c) return p;
  const sub = (m: Record<string, number>, d: Record<string, number>) => {
    const out = { ...m };
    for (const [k, v] of Object.entries(d)) {
      const nv = round((out[k] ?? 0) - v);
      if (Math.abs(nv) < 0.01) delete out[k];
      else out[k] = nv;
    }
    return out;
  };
  const { importContribution: _drop, ...rest } = p as TasteProfile & { importContribution?: ImportContribution };
  return {
    ...rest,
    concepts: sub(p.concepts, c.concepts),
    conceptsByCategory: { ...p.conceptsByCategory, music: sub(p.conceptsByCategory.music ?? {}, c.musicConcepts) },
    genres: sub(p.genres, c.genres),
    creators: sub(p.creators, c.creators),
    categories: { ...p.categories, music: round((p.categories.music ?? 0) - c.music) },
    interactionCount: Math.max(0, p.interactionCount - c.interactions),
  };
}

/** Styles the user loves most, as plain genre words (used to brief the music curator). */
export function topStyles(profile: TasteProfile, n = 8): string[] {
  return Object.entries(profile.genres).filter(([, w]) => w > 0.3).sort((a, b) => b[1] - a[1]).slice(0, n).map(([g]) => g);
}

const FRENCH = /fran(c|ç)ais|chanson|vari(e|é)t(e|é)|qu(e|é)b(e|é)cois|belge/i;
const ARABIC = /arabe|marocain|gnaoui|gnawa|ra(i|ï)\b|cha(a|â)bi|khali|alg(e|é)rien|tunisien|(e|é)gyptien|maghreb|andalou|mahraganat/i;

// ───────────── taste lanes ─────────────

/** Audio features used to place untagged songs (tempo scaled to ~0..1; everything is standardised anyway). */
const FEATURES: Array<(t: ImportedTrack) => number | undefined> = [
  (t) => t.energy, (t) => t.danceability, (t) => t.valence, (t) => t.acousticness, (t) => t.speechiness, (t) => t.instrumentalness,
  (t) => (t.tempo !== undefined ? t.tempo / 200 : undefined), (t) => t.loudness,
];
const KNN_K = 7;
const MIN_FEATURES = 5;
const HALF_LIFE_DAYS = 365;

export interface LaneAssignment {
  lane: string | null;
  /** 'tags' = majority vote of the song's genres; 'knn' = nearest tagged songs by sound. */
  via: 'tags' | 'knn' | null;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Lane of every song. Tagged songs vote with their genres. Untagged songs (43% of a typical export,
 * mostly English mainstream) take the majority lane of their 7 nearest tagged neighbours over
 * standardised audio features. Regional lanes are never kNN targets: French or Arabic can't be
 * told from audio alone, and guessing them inflated those lanes.
 */
export function assignLibraryLanes(tracks: ImportedTrack[], k = KNN_K): LaneAssignment[] {
  const tagged = tracks.map((t) => laneOfGenres(t.genres));
  const raw = tracks.map((t) => FEATURES.map((f) => f(t)));
  const stats = FEATURES.map((_, j) => {
    const xs = raw.map((r) => r[j]).filter(isNum);
    const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : 1;
    return { mean, sd: sd || 1 };
  });
  const z = raw.map((r) => r.map((x, j) => (isNum(x) ? (x - stats[j].mean) / stats[j].sd : undefined)));
  const known = (v: Array<number | undefined>) => v.filter((x) => x !== undefined).length;
  const refs = tracks.map((_, i) => i).filter((i) => tagged[i] && !LANE_BY_ID[tagged[i]!]?.regional && known(z[i]) >= MIN_FEATURES);
  const dist = (a: Array<number | undefined>, b: Array<number | undefined>) => {
    let s = 0;
    let n = 0;
    for (let j = 0; j < a.length; j++) {
      const x = a[j];
      const y = b[j];
      if (x === undefined || y === undefined) continue;
      s += (x - y) ** 2;
      n++;
    }
    return n >= MIN_FEATURES - 1 ? s / n : Infinity;
  };
  return tracks.map((_, i): LaneAssignment => {
    if (tagged[i]) return { lane: tagged[i], via: 'tags' };
    if (!refs.length || known(z[i]) < MIN_FEATURES) return { lane: null, via: null };
    const near = refs.map((r) => ({ lane: tagged[r]!, d: dist(z[i], z[r]) })).filter((x) => Number.isFinite(x.d)).sort((a, b) => a.d - b.d).slice(0, k);
    if (!near.length) return { lane: null, via: null };
    const votes = new Map<string, { n: number; d: number }>();
    for (const x of near) {
      const v = votes.get(x.lane) ?? { n: 0, d: 0 };
      votes.set(x.lane, { n: v.n + 1, d: v.d + x.d });
    }
    // Majority; ties go to the lane whose neighbours are closer.
    const [lane] = [...votes.entries()].sort((a, b) => b[1].n - a[1].n || a[1].d - b[1].d)[0];
    return { lane, via: 'knn' };
  });
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Recency weight of a song by its Added At date (half-life 12 months). */
export function recencyWeight(addedAt: string | undefined, now = new Date()): number {
  const t = addedAt ? new Date(addedAt).getTime() : NaN;
  if (!Number.isFinite(t)) return 1;
  const days = Math.max(0, (now.getTime() - t) / 86_400_000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

/** Generic descriptors of a lane: its top sub-genres, mood, tempo/energy and era words. */
export function laneDescriptors(l: MusicLane, tempo?: number): string[] {
  const def = LANE_BY_ID[l.id];
  const genres = l.genres.length >= 2 ? l.genres.slice(0, 4) : [...new Set([...l.genres, ...(def?.descriptors ?? [])])].slice(0, 4);
  const from = decadeLabel(l.era.from);
  const to = decadeLabel(Math.max(l.era.from, l.era.to));
  const era = l.regional ? `${l.era.from}+ releases` : from === to ? `${from} releases` : `${from}–${to} releases`;
  return [...genres, ...moodPhrase(l).split(/,\s*/).filter(Boolean), tempoWord(tempo), era].filter(Boolean);
}

/** Taste lanes of a library: recency-weighted shares, audio medians, era, popularity — then the owner policy. */
export function computeLanes(tracks: ImportedTrack[], assignments: LaneAssignment[], now = new Date(), policy: MusicPolicy = DEFAULT_POLICY): MusicLane[] {
  const groups = new Map<string, number[]>();
  assignments.forEach((a, i) => {
    if (a.lane) groups.set(a.lane, [...(groups.get(a.lane) ?? []), i]);
  });
  const weights = tracks.map((t) => recencyWeight(t.addedAt, now));
  const total = [...groups.values()].flat().reduce((s, i) => s + weights[i], 0) || 1;
  const tempos = new Map<string, number>();
  const lanes: MusicLane[] = [...groups.entries()].map(([id, idx]) => {
    const def = LANE_BY_ID[id];
    const rows = idx.map((i) => tracks[i]);
    const med = (f: (t: ImportedTrack) => number | undefined) => round(quantile(rows.map(f).filter(isNum), 0.5), 3);
    const years = rows.map((t) => yearOf(t.releaseDate)).filter(isNum);
    const pops = rows.map((t) => t.popularity).filter(isNum);
    // Sub-genres: the lane's own labels among its tagged songs, recency-weighted.
    const gw = new Map<string, number>();
    for (const i of idx) for (const g of tracks[i].genres) if (laneOfGenre(g) === id) gw.set(g, (gw.get(g) ?? 0) + weights[i]);
    tempos.set(id, quantile(rows.map((t) => t.tempo).filter(isNum), 0.5));
    return {
      id,
      label: def?.label ?? id,
      share: idx.reduce((s, i) => s + weights[i], 0) / total,
      descriptors: [],
      era: years.length ? { from: Math.round(quantile(years, 0.1)), to: Math.round(quantile(years, 0.9)) } : { from: DEFAULT_MIN_YEAR, to: now.getUTCFullYear() },
      energy: med((t) => t.energy),
      danceability: med((t) => t.danceability),
      valence: med((t) => t.valence),
      popularity: pops.length ? { p25: Math.round(quantile(pops, 0.25)), p50: Math.round(quantile(pops, 0.5)), p75: Math.round(quantile(pops, 0.75)) } : { p25: 0, p50: 0, p75: 0 },
      regional: !!def?.regional,
      genres: [...gw.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g]) => g),
      source: 'library' as const,
    };
  });
  return applyLanePolicy(lanes, policy).map((l) => ({ ...l, share: round(l.share, 4), descriptors: laneDescriptors(l, tempos.get(l.id)) }));
}

export interface LibraryAnalysis {
  dna: MusicDna;
  assignments: LaneAssignment[];
  /** Lane genres for songs placed by sound (untagged), used as half-weight genre evidence. */
  inferredGenres: Array<string[] | undefined>;
}

/** Everything ECHO learns from an export, in one pass. Generic words only — no track or artist names. */
export function analyzeLibrary(tracks: ImportedTrack[], now = new Date()): LibraryAnalysis {
  const assignments = assignLibraryLanes(tracks);
  const lanes = computeLanes(tracks, assignments, now);
  // Lane vocabulary for untagged songs (from every lane, including ones the policy later drops).
  const laneGenres = new Map<string, string[]>();
  for (const id of new Set(assignments.map((a) => a.lane).filter((x): x is string => !!x))) {
    const c = new Map<string, number>();
    assignments.forEach((a, i) => {
      if (a.lane === id && a.via === 'tags') for (const g of tracks[i].genres) if (laneOfGenre(g) === id) c.set(g, (c.get(g) ?? 0) + 1);
    });
    laneGenres.set(id, [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g));
  }
  const inferredGenres = assignments.map((a, i) => (a.via === 'knn' && !tracks[i].genres.length ? laneGenres.get(a.lane!) : undefined));
  return { dna: musicDna(tracks, now, lanes, inferredGenres), assignments, inferredGenres };
}

/** A compact, generic description of a music library ("music DNA"), lanes included. Contains no track or artist names. */
export function computeMusicDna(tracks: ImportedTrack[], now = new Date()): MusicDna {
  return analyzeLibrary(tracks, now).dna;
}

function musicDna(tracks: ImportedTrack[], now: Date, lanes: MusicLane[], inferredGenres: Array<string[] | undefined>): MusicDna {
  // Styles count every song once: tagged songs spread over their own genres, untagged songs over the
  // genres of the lane they were placed in — so regional styles are no longer inflated by tag coverage.
  const count = (rows: number[]) => {
    const c: Record<string, number> = {};
    for (const i of rows) {
      const gs = tracks[i].genres.length ? tracks[i].genres : inferredGenres[i] ?? [];
      for (const g of gs) c[g] = (c[g] ?? 0) + 1 / gs.length;
    }
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  };
  const all = tracks.map((_, i) => i);
  const recentCut = new Date(now.getTime() - 200 * 86_400_000).toISOString();
  const recent = all.filter((i) => (tracks[i].addedAt ?? '') >= recentCut);
  const styles = count(all).slice(0, 12).map(([g]) => g);
  const recentStyles = count(recent).filter(([, n]) => n >= 1).slice(0, 8).map(([g]) => g);
  const dec: Record<string, number> = {};
  for (const t of tracks) {
    const y = Number((t.releaseDate ?? '').slice(0, 4));
    if (y > 1900) dec[`${Math.floor(y / 10) * 10}s`] = (dec[`${Math.floor(y / 10) * 10}s`] ?? 0) + 1;
  }
  const decades = Object.entries(dec).sort((a, b) => b[1] - a[1]).filter(([, n]) => n >= tracks.length * 0.08).map(([d]) => d);
  const fr =tracks.filter((t) => FRENCH.test(t.genres.join(' '))).length;
  const ar = tracks.filter((t) => ARABIC.test(t.genres.join(' '))).length;
  const languages = ['English', ...(fr >= tracks.length * 0.04 ? ['French'] : []), ...(ar >= tracks.length * 0.04 ? ['Arabic (incl. Darija)'] : [])];
  const mean = (k: 'valence' | 'energy' | 'danceability') => {
    const v = tracks.map((t) => t[k]).filter((x): x is number => typeof x === 'number');
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : 0.5;
  };
  const q: Record<string, number> = {};
  for (const t of tracks) {
    if (t.valence === undefined || t.energy === undefined) continue;
    const k = `${t.valence >= 0.5 ? 'upbeat' : 'bittersweet'} & ${t.energy >= 0.6 ? 'energetic' : 'mellow'}`;
    q[k] = (q[k] ?? 0) + 1;
  }
  return {
    tracks: tracks.length,
    distinctArtists: new Set(tracks.flatMap((t) => t.artists.map((a) => a.toLowerCase()))).size,
    styles,
    recentStyles,
    decades,
    languages,
    mood: { valence: mean('valence'), energy: mean('energy'), danceability: mean('danceability'), topQuadrant: Object.entries(q).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'mixed' },
    importedAt: now.toISOString(),
    lanes,
    policy: { ...DEFAULT_POLICY },
  };
}

/** Background for the AI music curator built only from generic taste words (no names, no novelty push). */
export function musicBrief(dna: MusicDna, opts: { styles?: boolean } = {}): string {
  return [
    opts.styles === false ? '' : `loves ${dna.styles.slice(0, 10).join(', ')}`,
    opts.styles === false ? '' : dna.recentStyles.length ? `lately also into ${dna.recentStyles.slice(0, 6).join(', ')}` : '',
    dna.decades.length ? `mostly ${dna.decades.join(' and ')} releases` : '',
    `listens in ${dna.languages.join(', ')}`,
    `mood: often ${dna.mood.topQuadrant}, danceability ${dna.mood.danceability}`,
  ].filter(Boolean).join('; ');
}
