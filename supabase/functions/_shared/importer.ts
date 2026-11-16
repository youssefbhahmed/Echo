// Import a user's own Spotify "Liked Songs" export (Exportify-style CSV) into ECHO.
// Pure functions: parse → normalise to ContentItems → bulk-learn the taste profile.
// The data stays in ECHO's deterministic engine; track/artist names are never sent to AI models.
import type { AnalyzedItem, ConceptVector, ContentItem, MusicDna, TasteProfile } from './types.ts';
import { genreHints } from './engine/analyze.ts';
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
  addedAt?: string;
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
  const iAdded = idx('added at');
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
      addedAt: iAdded >= 0 ? r[iAdded] : undefined,
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
    metadata: { album: t.album, imported: 'spotify-liked', valence: t.valence, energy: t.energy },
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
 */
export function applyLibraryImport(input: TasteProfile, items: AnalyzedItem[], addedAt: Array<string | undefined>, now = new Date()): TasteProfile {
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

/** A compact, generic description of a music library ("music DNA"). Contains no track or artist names. */
export function computeMusicDna(tracks: ImportedTrack[], now = new Date()): MusicDna {
  const count = (rows: ImportedTrack[]) => {
    const c: Record<string, number> = {};
    for (const t of rows) for (const g of t.genres) c[g] = (c[g] ?? 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  };
  const recentCut = new Date(now.getTime() - 200 * 86_400_000).toISOString();
  const recent = tracks.filter((t) => (t.addedAt ?? '') >= recentCut);
  const styles = count(tracks).slice(0, 12).map(([g]) => g);
  const recentStyles = count(recent).filter(([, n]) => n >= 2).slice(0, 8).map(([g]) => g);
  const dec: Record<string, number> = {};
  for (const t of tracks) {
    const y = Number((t.releaseDate ?? '').slice(0, 4));
    if (y > 1900) dec[`${Math.floor(y / 10) * 10}s`] = (dec[`${Math.floor(y / 10) * 10}s`] ?? 0) + 1;
  }
  const decades = Object.entries(dec).sort((a, b) => b[1] - a[1]).filter(([, n]) => n >= tracks.length * 0.08).map(([d]) => d);
  const allGenres = tracks.flatMap((t) => t.genres).join(' ');
  const fr = tracks.filter((t) => FRENCH.test(t.genres.join(' '))).length;
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
  void allGenres;
  return {
    tracks: tracks.length,
    distinctArtists: new Set(tracks.flatMap((t) => t.artists.map((a) => a.toLowerCase()))).size,
    styles,
    recentStyles,
    decades,
    languages,
    mood: { valence: mean('valence'), energy: mean('energy'), danceability: mean('danceability'), topQuadrant: Object.entries(q).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'mixed' },
    importedAt: now.toISOString(),
  };
}

/** Brief for the AI music curator built only from generic taste words. */
export function musicBrief(dna: MusicDna, opts: { styles?: boolean } = {}): string {
  const eclectic = dna.distinctArtists / Math.max(1, dna.tracks) > 0.8 ? 'very eclectic (rarely repeats an artist; loves discovering new ones)' : 'has favourite artists they return to';
  return [
    opts.styles === false ? '' : `loves ${dna.styles.slice(0, 10).join(', ')}`,
    opts.styles === false ? '' : dna.recentStyles.length ? `lately also into ${dna.recentStyles.slice(0, 6).join(', ')}` : '',
    dna.decades.length ? `mostly ${dna.decades.join(' and ')} releases` : '',
    `listens in ${dna.languages.join(', ')}`,
    `mood: often ${dna.mood.topQuadrant}, danceability ${dna.mood.danceability}`,
    eclectic,
  ].filter(Boolean).join('; ');
}
