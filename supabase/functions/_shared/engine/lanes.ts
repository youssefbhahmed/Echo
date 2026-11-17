// Taste lanes: coherent listening "lanes" of a music library (e.g. "Afro & melodic house").
// The taxonomy mirrors the library analysis (scratch csv_analysis.py LANES) and is shared by the
// importer (lane shares), the curator (briefs), the resolver (era/regional rules) and the fallback.
// Pure functions, generic words only: no track or artist names live here.
import type { ContentItem, EntityTag, LaneTag, MusicLane, MusicPolicy, TasteProfile } from '../types.ts';
import { inBlockedFamily } from './music.ts';
import { normalize, normKey, songKey } from './text.ts';

export interface LaneDef {
  id: string;
  label: string;
  /** French / Arabic / Maghreb: capped share, modern releases only (owner policy). */
  regional: boolean;
  /** Matched against laneKey(genre); first matching lane wins (order matters, like the analysis script). */
  re: RegExp;
  /** Second pass for broad labels no specific rule matched ("uk hip hop", "electronic"). */
  broad?: RegExp;
  /** Style families (engine/music.ts) the lane belongs to; a lane is off when all of them are blocked. */
  families: string[];
  /** Generic sub-genre words used when the library has too few tags for the lane. */
  descriptors: string[];
  /** Instrumental by nature (vocals rule relaxed). */
  instrumental?: boolean;
}

// Order = priority for a single genre label (as in the analysis script): regional lanes first so
// "rap français" is French and "hip-hop arabe" is Arabic, never US hip-hop.
export const LANES: LaneDef[] = [
  {
    id: 'maghreb-fusion', label: 'Maghreb fusion', regional: true, families: ['maghreb'],
    re: /\b(gnaoui|gnawa|gnawi|sufi|amazigh|berbere?|andalou(se)?|mizrahi|rai|chaabi(?! egyptien))\b/,
    descriptors: ['modern gnawa fusion', 'raï', 'chaâbi'],
  },
  {
    id: 'arabic-pop', label: 'Arabic rap & pop', regional: true, families: ['maghreb'],
    re: /mahraganat|khalee?ji|chaabi egyptien|\b(arabe?|arabic|arab|marocaine?|moroccan|egyptienne?|egyptian|libanaise?|lebanese|algerienne?|algerian|tunisienne?|tunisian|maghrebi?|darija)\b/,
    descriptors: ['Moroccan rap', 'Arabic pop', 'Arabic hip-hop'],
  },
  {
    id: 'french', label: 'French pop & rap', regional: true, families: ['french-rap', 'french-chanson'],
    // "house française" is electronic, not French pop.
    re: /^(?!.*\b(house|techno)\b).*\b(francaise?|french|chanson|variete|pop urbaine|queb\w*|electro swing|rap belge|drill francaise)\b/,
    descriptors: ['French pop', 'pop urbaine', 'French rap'],
  },
  {
    id: 'hiphop-rnb', label: 'Hip-hop & R&B', regional: false, families: ['hip-hop', 'rnb'],
    re: /^rap$|^hip hop$|east coast|west coast|old school|southern hip hop|g funk|trap soul|^r b$|^rnb$|r b alternatif|alternative r b|contemporary r b|dark r b|uk r b|gangster|hyphy|jazz rap|neo soul|crunk|grime|rage rap|rap melodique|melodic rap|hip hop hardcore|^trap$|r b indie|indie r b|pop soul|afroswing|uk hip hop|uk rap|uk drill|pop rap|conscious hip hop|underground hip hop|boom bap|cloud rap|emo rap|new jack swing/,
    broad: /\b(hip hop|rap|trap|drill|r b|rnb)\b/,
    descriptors: ['hip-hop', 'R&B', 'melodic rap'],
  },
  {
    id: 'rock-metal', label: 'Rock & metal', regional: false, families: ['rock'],
    re: /rock|metal|punk|grunge|stoner|sludge|doom|shoegaze|\bemo\b/,
    descriptors: ['alternative rock', 'hard rock', 'metal'],
  },
  {
    id: 'blues-soul', label: 'Blues, soul & Americana', regional: false, families: ['blues-jazz', 'folk'],
    re: /southern gothic|blues|^soul$|retro soul|indie soul|country|americana|folk|bluegrass|red dirt|motown|northern soul|soul classique|classic soul|singer songwriter/,
    descriptors: ['southern gothic', 'blues', 'soul', 'Americana'],
  },
  {
    id: 'melodic-house', label: 'Afro & melodic house', regional: false, families: ['house'],
    re: /afro house|house organique|organic house|house tribale|tribal house|afro tech|house melodique|melodic house|techno melodique|melodic techno|downtempo|deep house|jazz house|trip hop|^electro$|electronique|electronica|^electronic$|techno|basse melodique|melodic bass|house francaise|french house|house lo fi|lo fi house|dub techno|house progressive|progressive house|nu disco|chillwave|chillstep|lo fi|indie dance|organic electronic/,
    broad: /\b(house|electro|electronic|chill)\b/,
    descriptors: ['afro house', 'organic house', 'melodic house', 'downtempo'],
  },
  {
    id: 'edm', label: 'EDM & tropical house', regional: false, families: ['house'],
    re: /^edm$|\bedm\b|tropical house|slap house|big room|moombahton|brazilian bass|future house|future bass|dubstep|^house$|house latino|stutter house|electro house|bass house|drumstep|hardstyle|trance|g house|tech house|europop|jersey club|3 step|drum (and )?bass/,
    descriptors: ['EDM', 'tropical house', 'festival house'],
  },
  {
    id: 'afro-latin', label: 'Afro, Latin & Caribbean', regional: false, families: ['afro', 'latin'],
    re: /afropop|afro pop|afrosoul|afro soul|afrobeats?|r b afro|afro r b|afropiano|amapiano|dancehall|kizomba|ragga|soca|kompa|zouk|reggae|latino|latin|reggaeton|cumbia|bachata|salsa|urbano|dembow|azonto|hiplife|highlife|gqom|kuduro|\balte\b|maskandi|funk bresilien\w*|brazilian funk|baile funk|forro|\bmpb\b|piseiro|\bdub\b|riddim|lover|techengue|tango|afro adura/,
    broad: /\bafro\b/,
    descriptors: ['afrobeats', 'amapiano', 'reggaeton', 'dancehall'],
  },
  {
    id: 'jazz-classical', label: 'Jazz, classical & soundtrack', regional: false, families: ['blues-jazz', 'cinematic'], instrumental: true,
    re: /jazz|classique|classical|piano|concerto|chambre|baroque|bande originale|soundtrack|impressionnisme|expressionnisme|neo classique|neoclassical|neo classical|symphon|orchestr|opera|fado|swing|comedies musicales|\banime\b|medievale/,
    broad: /\b(ambient|new age|score|cinematic|minimalism|experimental|avant garde)\b/,
    descriptors: ['jazz', 'modern classical', 'film score'],
  },
];

export const LANE_BY_ID: Record<string, LaneDef> = Object.fromEntries(LANES.map((l) => [l.id, l]));

export const DEFAULT_POLICY: MusicPolicy = { regionalShare: 0.12, regionalMinYear: 2015, familiarity: 'library' };
/** Non-regional lanes default to releases from this year on when the library says nothing else. */
export const DEFAULT_MIN_YEAR = 2005;
/** Release-year tolerance when checking a song against its lane's era (non-regional lanes). */
export const ERA_TOLERANCE = 2;
export const MIN_LANE_SHARE = 0.03;
export const MIN_JAZZ_SHARE = 0.06;

/** Pseudo-lanes: a typed request (chat/search) and a listener with no library yet. */
export const REQUEST_LANE: LaneTag = { id: 'request', label: 'For your request' };
export const MIX_LANE: LaneTag = { id: 'mix', label: 'Fresh picks' };
/** Lanes of a request naming an artist: their own songs ("Eminem") and songs by related artists ("Artists like Eminem"). */
export const ENTITY_BY_LANE = 'entity-by';
export const ENTITY_LIKE_LANE = 'entity-like';

/** A lane answering a named artist (labels are per request, so they never go in the shared catalog). */
export function isEntityLane(id: string | undefined | null): boolean {
  return id === ENTITY_BY_LANE || id === ENTITY_LIKE_LANE;
}

/** Normalised genre label for the taxonomy ("Hip-Hop", "hip-hop" → "hip hop"; "R&B" → "r b"; accents stripped). */
export function laneKey(genre: string): string {
  return normalize(genre).replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Lane of one genre label, or null when no rule matches ("pop", "dance pop"). */
export function laneOfGenre(genre: string): string | null {
  const k = laneKey(genre);
  if (!k) return null;
  return LANES.find((l) => l.re.test(k))?.id ?? LANES.find((l) => l.broad?.test(k))?.id ?? null;
}

/** Lane of a tagged track: majority vote of its genres (ties: the first label's lane). */
export function laneOfGenres(genres: string[]): string | null {
  const votes = new Map<string, number>();
  for (const g of genres) {
    const l = laneOfGenre(g);
    if (l) votes.set(l, (votes.get(l) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [l, c] of votes) if (c > n) [best, n] = [l, c];
  return best;
}

export function laneTag(l: { id: string; label: string }): LaneTag {
  return { id: l.id, label: l.label };
}

export function laneTagOf(item: { metadata?: Record<string, unknown> }): LaneTag | null {
  const l = item.metadata?.lane as Partial<LaneTag> | undefined;
  return l && typeof l.id === 'string' && typeof l.label === 'string' ? { id: l.id, label: l.label } : null;
}

/** The item's entity tag (metadata.entity) when it answers a named entity. */
export function entityTagOf(item: { metadata?: Record<string, unknown> }): EntityTag | null {
  const e = item.metadata?.entity as Partial<EntityTag> | undefined;
  if (!e || typeof e.name !== 'string' || (e.role !== 'by' && e.role !== 'like' && e.role !== 'about')) return null;
  return { name: e.name, role: e.role, ...(typeof e.note === 'string' && e.note ? { note: e.note } : {}) };
}

/** A non-music item answering an entity (works, things about it) — music answers sit in entity lanes. */
export function isEntityExtra(item: { category: string; metadata?: Record<string, unknown> }): boolean {
  return !!entityTagOf(item) && !(item.category === 'music' && laneTagOf(item));
}

// ───────────── videos inside music lanes ─────────────
//
// Contract: a YouTube live session or music video placed in a music lane is a MUSIC item —
// category 'music', kind 'video', provider 'youtube', embed { type: 'youtube' }, its own id
// `youtube:music:<videoId>` (never the Videos feed's `youtube:video:<videoId>` row), creators = the
// performing artists (so one-per-artist, disliked artists and feedback work as for songs),
// metadata.lane = its lane, metadata.video = true, metadata.videoKind 'live' | 'video',
// metadata.session = where it was filmed. Being category 'music', it is grouped into the lane shelves on
// Discover and in Echo AI answers and never appears in the Videos shelf.

export const LANE_VIDEO_PREFIX = 'youtube:music:';

/** Where a lane video was filmed and who plays (metadata.session, from its YouTube title; shared, not per user). */
export interface SessionTag {
  /** SessionChannel.key */
  channel: string;
  /** "Tiny Desk", "COLORS" */
  venue: string;
  prep: 'at' | 'on' | 'for';
  /** The performing artist as the title credits them. */
  artist: string;
  /** Short display title: the song, or what the session is called ("Tiny Desk Concert"). */
  label: string;
}

/** A YouTube live session / music video inside a music lane (see the contract above). */
export function isLaneVideo(item: { category: string; kind?: string; embed?: { type: string } | null; metadata?: Record<string, unknown> }): boolean {
  return item.category === 'music' && item.kind === 'video' && item.embed?.type === 'youtube';
}

export function sessionTagOf(item: { metadata?: Record<string, unknown> }): SessionTag | null {
  const s = item.metadata?.session as Partial<SessionTag> | undefined;
  if (!s || typeof s.venue !== 'string' || typeof s.artist !== 'string') return null;
  const prep = s.prep === 'on' || s.prep === 'for' ? s.prep : 'at';
  return { channel: typeof s.channel === 'string' ? s.channel : '', venue: s.venue, prep, artist: s.artist, label: typeof s.label === 'string' && s.label ? s.label : s.venue };
}

/** Every lane id this engine writes: the taxonomy lanes plus the request/open pseudo-lanes. */
export const ENGINE_LANE_IDS: string[] = [...LANES.map((l) => l.id), REQUEST_LANE.id, MIX_LANE.id];
/** The taxonomy lanes only (a song placed in one fits it by the lane's own rules, language included). */
export const TAXONOMY_LANE_IDS: string[] = LANES.map((l) => l.id);

/** A lane id this engine writes (taxonomy lanes plus the request/open pseudo-lanes); older curator picks carry none. */
export function isEngineLane(id: string | undefined | null): boolean {
  return !!id && (!!LANE_BY_ID[id] || id === REQUEST_LANE.id || id === MIX_LANE.id);
}

/**
 * Per-user / per-response fields of a recommended item: rebuilt for every response, never stored in the
 * shared catalog (content_items is readable by every signed-in user) nor carried over from it.
 */
export const PER_USER_METADATA = ['lastShownAt', 'laneEra', 'laneMood', 'aiOrder', 'fallback', 'fallbackTier', 'inLibrary', 'entity', 'entityOrder', 'wantedScene', 'videoMatch'] as const;

/** Item metadata without per-user / per-request fields (an entity lane tag is per request too). */
export function withoutPerUser(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const out = { ...(meta ?? {}) };
  for (const k of PER_USER_METADATA) delete out[k];
  if (isEntityLane(laneTagOf({ metadata: out })?.id)) delete out.lane;
  return out;
}

/**
 * Catalog metadata to store for an item over the row already there (content_items is shared, and an
 * upsert replaces the whole column): this response's fields, minus per-user ones, but the lane the row
 * already had is kept when this response has none (an entity lane is per request), and a taxonomy lane
 * over a pseudo-lane (a request): the stored fallback tiers and lane feedback read it. The curator's
 * lyrics language is kept too.
 */
export function mergeCatalogMetadata(existing: Record<string, unknown> | undefined | null, incoming: Record<string, unknown> | undefined): Record<string, unknown> {
  const out = withoutPerUser(incoming);
  const prev = withoutPerUser(existing ?? undefined);
  const prevLane = laneTagOf({ metadata: prev });
  const lane = laneTagOf({ metadata: out });
  const keepPrev = !!prevLane && isEngineLane(prevLane.id) && (!lane || (!LANE_BY_ID[lane.id] && !!LANE_BY_ID[prevLane.id]));
  if (keepPrev) out.lane = prevLane;
  if (out.lyricsLang === undefined && typeof prev.lyricsLang === 'string') out.lyricsLang = prev.lyricsLang;
  return out;
}

/** Style families of a regional scene ("french" → French rap and chanson; "arabic-pop" → maghreb). */
export function sceneFamilies(scene: string): string[] {
  return LANE_BY_ID[scene]?.families ?? [];
}

/**
 * The profile with these regional scenes' style families allowed again: the request asks for the scene
 * ("rap français"), or names an artist of it. Every other switched-off family stays off.
 */
export function allowScenes(profile: TasteProfile, scenes: Iterable<string>): TasteProfile {
  const fam = new Set([...scenes].flatMap(sceneFamilies));
  const blocked = profile.explicit.blockedFamilies ?? [];
  if (!fam.size || !blocked.some((f) => fam.has(f))) return profile;
  return { ...profile, explicit: { ...profile.explicit, blockedFamilies: blocked.filter((f) => !fam.has(f)) } };
}

/** The regional scene a request's own words asked for, or a named artist belongs to (metadata.wantedScene, per response). */
export function wantedSceneOf(item: { metadata?: Record<string, unknown> }): string | null {
  const s = item.metadata?.wantedScene;
  return typeof s === 'string' && LANE_BY_ID[s]?.regional ? s : null;
}

// ───────────── owner policy ─────────────

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Regional lanes share at most policy.regionalShare between them (proportionally); the rest share the
 * remainder. A cap, not a quota: a library that is 0.5% French keeps a 0.5% French lane (then dropped).
 */
function rescale<T extends { share: number; regional: boolean }>(lanes: T[], policy: MusicPolicy): T[] {
  const reg = lanes.filter((l) => l.regional);
  const other = lanes.filter((l) => !l.regional);
  const rs = sum(reg.map((l) => l.share));
  const os = sum(other.map((l) => l.share));
  const regTotal = !other.length ? 1 : !reg.length ? 0 : Math.min(policy.regionalShare, rs / (rs + os || 1));
  return lanes.map((l) => ({ ...l, share: l.regional ? (rs ? (l.share / rs) * regTotal : 0) : os ? (l.share / os) * (1 - regTotal) : 0 }));
}

/**
 * Owner policy: regional lanes (French, Arabic rap & pop, Maghreb fusion) get a combined share of at most
 * policy.regionalShare and modern releases only; lanes under 3% are dropped (jazz/classical under 6%);
 * shares are renormalised. Sorted by share.
 */
export function applyLanePolicy<T extends { id: string; share: number; regional: boolean; era: { from: number; to: number } }>(lanes: T[], policy: MusicPolicy = DEFAULT_POLICY): T[] {
  const positive = lanes.filter((l) => l.share > 0);
  const kept = new Set(rescale(positive, policy).filter((l) => l.share >= (l.id === 'jazz-classical' ? MIN_JAZZ_SHARE : MIN_LANE_SHARE)).map((l) => l.id));
  // Renormalise the kept lanes from their measured shares (capping already-capped shares would shrink the regional cap).
  return rescale(positive.filter((l) => kept.has(l.id)), policy)
    .map((l) => (l.regional ? { ...l, era: { from: Math.max(l.era.from, policy.regionalMinYear), to: Math.max(l.era.to, policy.regionalMinYear) } } : l))
    .sort((a, b) => b.share - a.share);
}

// ───────────── generic words for briefs ─────────────

const finite = (x: number | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

/** "bittersweet but danceable, mid-energy" from a lane's audio medians ('' when unknown). */
export function moodPhrase(l: { energy: number; danceability: number; valence: number }): string {
  if (!finite(l.valence) || !finite(l.energy)) return '';
  const tone = l.valence < 0.35 ? 'melancholic' : l.valence < 0.5 ? 'bittersweet' : l.valence < 0.65 ? 'warm' : 'upbeat';
  const energy = l.energy < 0.45 ? 'mellow' : l.energy < 0.7 ? 'mid-energy' : 'high-energy';
  const dance = finite(l.danceability) && l.danceability >= 0.65 ? 'danceable' : '';
  if (dance && (tone === 'melancholic' || tone === 'bittersweet')) return `${tone} but danceable, ${energy}`;
  return [tone, dance, energy].filter(Boolean).join(', ');
}

export function tempoWord(bpm: number | undefined): string {
  if (!finite(bpm) || bpm <= 0) return '';
  return bpm < 90 ? 'slow tempo' : bpm < 118 ? 'mid-tempo' : 'uptempo';
}

/** Familiarity in words from the lane's Spotify popularity quartiles ('' when unknown). */
export function popularityPhrase(p: { p25: number; p50: number; p75: number } | undefined): string {
  if (!p || !finite(p.p50) || p.p50 <= 0) return '';
  if (p.p50 >= 60) return 'mostly popular songs, hits welcome';
  if (p.p50 >= 40) return 'mostly mid-popularity songs well known in the scene, a couple of bigger hits';
  return 'songs known within the scene rather than chart hits (never obscure)';
}

export function decadeLabel(y: number): string {
  return `${Math.floor(y / 10) * 10}s`;
}

// ───────────── lane choice per refresh ─────────────

/** Small deterministic PRNG (mulberry32) so a refresh seed always gives the same lanes. */
export function seededRandom(seed: number): () => number {
  let a = (Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0) || 0x2545f491;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A lane is off when every style family it belongs to is blocked ("never" in My Taste → Music mix). */
export function laneBlocked(l: { id: string; genres?: string[] }, profile: TasteProfile): boolean {
  const blocked = profile.explicit.blockedFamilies ?? [];
  if (!blocked.length) return false;
  const def = LANE_BY_ID[l.id];
  if (def) return def.families.every((f) => blocked.includes(f));
  return !!l.genres?.length && inBlockedFamily(l.genres, profile);
}

/** FNV-1a: a lane id → 32-bit int. */
function hash32(x: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < x.length; i++) h = Math.imul(h ^ x.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** The draw of one lane for one seed: depends on nothing else, so other lanes' weights can't move it. */
function laneUniform(seed: number, laneId: string): number {
  return Math.max(1e-12, seededRandom(Math.imul((seed | 0) ^ 0x5bd1e995, 0x27d4eb2d) ^ hash32(laneId))());
}

/**
 * Feedback may re-balance between regional lanes and lower them, never raise their combined weight:
 * regional lanes keep at most min(policy.regionalShare, their share before feedback) of the pool.
 */
function capRegional(pool: Array<{ l: MusicLane; w: number }>, regionalShare: number): void {
  const reg0 = sum(pool.filter((x) => x.l.regional).map((x) => x.l.share));
  const tot0 = sum(pool.map((x) => x.l.share));
  const reg = sum(pool.filter((x) => x.l.regional).map((x) => x.w));
  const other = sum(pool.filter((x) => !x.l.regional).map((x) => x.w));
  if (!reg || !other || !tot0) return;
  const cap = Math.min(regionalShare, reg0 / tot0);
  if (reg / (reg + other) <= cap) return;
  const scale = (cap * other) / (1 - cap) / reg;
  for (const x of pool) if (x.l.regional) x.w *= scale;
}

/**
 * Lanes for one refresh: share-weighted draws without replacement (the top lane comes up often),
 * nudged by lane feedback. Regional lanes only enter with their policy weight (~12% combined, which
 * feedback can't raise) and at most one per refresh. Drawn as an exponential race (Efraimidis-Spirakis):
 * each lane's draw comes from (seed, lane id) alone, so a like or skip on one lane doesn't reshuffle the
 * others and a re-fetched feed keeps its lanes. Returned strongest first.
 */
export function chooseLanes(
  lanes: MusicLane[],
  seed: number,
  n = 3,
  opts: { feedback?: Record<string, number>; blocked?: (l: MusicLane) => boolean; regionalShare?: number } = {},
): MusicLane[] {
  const pool = lanes
    .filter((l) => l.share > 0 && !opts.blocked?.(l))
    .map((l) => ({ l, w: l.share * Math.exp(Math.max(-1, Math.min(1, opts.feedback?.[l.id] ?? 0))) }));
  capRegional(pool, opts.regionalShare ?? DEFAULT_POLICY.regionalShare);
  const raced = pool.filter((x) => x.w > 0).map((x) => ({ ...x, key: -Math.log(laneUniform(seed, x.l.id)) / x.w })).sort((a, b) => a.key - b.key);
  const out: Array<{ l: MusicLane; w: number }> = [];
  for (const x of raced) {
    if (out.length >= n) break;
    if (x.l.regional && out.some((o) => o.l.regional)) continue;
    out.push(x);
  }
  return out.sort((a, b) => b.w - a.w).map((x) => x.l);
}

/** Split `total` picks across lanes by share, at least `min` each (fewer lanes when total is small). */
export function laneTargets(lanes: Array<{ share: number }>, total: number, min = 3): number[] {
  const n = lanes.length;
  if (!n || total <= 0) return lanes.map(() => 0);
  if (total <= min * n) {
    const base = Math.floor(total / n);
    return lanes.map((_, i) => base + (i < total - base * n ? 1 : 0));
  }
  const s = sum(lanes.map((l) => l.share)) || 1;
  const raw = lanes.map((l) => (total * (l.share || 1 / n)) / s);
  const t = raw.map((x) => Math.max(min, Math.floor(x)));
  while (sum(t) > total) {
    let i = -1;
    for (let j = 0; j < n; j++) if (t[j] > min && (i < 0 || t[j] - raw[j] > t[i] - raw[i])) i = j;
    if (i < 0) break;
    t[i]--;
  }
  while (sum(t) < total) {
    let i = 0;
    for (let j = 1; j < n; j++) if (raw[j] - t[j] > raw[i] - t[i]) i = j;
    t[i]++;
  }
  return t;
}

// ───────────── lanes for any profile ─────────────

const nowYear = (now = new Date()) => now.getUTCFullYear();

/** Lanes without a library import: grouped from learned genre weights (no audio medians). */
export function lanesFromGenres(profile: TasteProfile, now = new Date(), policy: MusicPolicy = DEFAULT_POLICY): MusicLane[] {
  const acc = new Map<string, { w: number; genres: Array<[string, number]> }>();
  for (const [g, w] of Object.entries(profile.genres)) {
    if (w <= 0) continue;
    const id = laneOfGenre(g);
    if (!id) continue;
    const e = acc.get(id) ?? { w: 0, genres: [] };
    e.w += w;
    e.genres.push([g, w]);
    acc.set(id, e);
  }
  const lanes: MusicLane[] = [...acc.entries()].map(([id, e]) => {
    const def = LANE_BY_ID[id];
    const genres = e.genres.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g]) => g);
    return {
      id, label: def.label, share: e.w, descriptors: genres.slice(0, 4), era: { from: def.regional ? policy.regionalMinYear : DEFAULT_MIN_YEAR, to: nowYear(now) },
      energy: NaN, danceability: NaN, valence: NaN, popularity: { p25: NaN, p50: NaN, p75: NaN }, regional: def.regional, genres, source: 'genres',
    };
  });
  return applyLanePolicy(lanes, policy);
}

export function mixLane(now = new Date()): MusicLane {
  return {
    ...MIX_LANE, share: 1, descriptors: [], era: { from: DEFAULT_MIN_YEAR, to: nowYear(now) }, energy: NaN, danceability: NaN, valence: NaN,
    popularity: { p25: NaN, p50: NaN, p75: NaN }, regional: false, genres: [], source: 'default',
  };
}

/** The lanes ECHO curates from: the imported library's lanes, else lanes from learned genres, else one open lane. */
export function effectiveLanes(profile: TasteProfile, now = new Date()): MusicLane[] {
  const policy = musicPolicy(profile);
  if (profile.music?.lanes?.length) return profile.music.lanes;
  const fromGenres = lanesFromGenres(profile, now, policy);
  return fromGenres.length ? fromGenres : [mixLane(now)];
}

export function musicPolicy(profile: TasteProfile): MusicPolicy {
  return { ...DEFAULT_POLICY, ...(profile.music?.policy ?? {}) };
}

// ───────────── release-era and taste rules ─────────────

export function yearOf(date: string | undefined | null): number | undefined {
  const y = Number(String(date ?? '').slice(0, 4));
  return y > 1900 && y < 2100 ? y : undefined;
}

/** ISRC "CC-XXX-YY-NNNNN": YY is the recording's registration year. */
export function isrcYear(isrc: string | undefined | null, now = new Date()): number | undefined {
  const m = /^[A-Z]{2}[A-Z0-9]{3}(\d{2})\d{5}$/i.exec(String(isrc ?? '').replace(/-/g, ''));
  if (!m) return undefined;
  const yy = Number(m[1]);
  return yy <= (nowYear(now) % 100) + 1 ? 2000 + yy : 1900 + yy;
}

/** An ISRC this many years older than the album marks a reissue (ISRCs are often registered a year before release). */
export const REISSUE_GAP = 3;

/** Best estimate of when a recording was first released: the album year, or the ISRC year for reissues. */
export function recordingYear(item: Pick<ContentItem, 'releaseDate' | 'metadata'>, now = new Date()): number | undefined {
  const a = yearOf(item.releaseDate);
  const i = isrcYear(item.metadata?.isrc as string | undefined, now);
  if (a && i) return i <= a - REISSUE_GAP ? i : a;
  return a ?? i;
}

/** First allowed release year for a lane (regional lanes never before policy.regionalMinYear). */
export function eraFloor(l: { regional: boolean; era?: { from: number } }, policy: MusicPolicy = DEFAULT_POLICY): number {
  const from = l.era?.from && l.era.from > 1900 ? l.era.from : DEFAULT_MIN_YEAR;
  return l.regional ? Math.max(policy.regionalMinYear, from) : from;
}

/** Era rule: within the lane's era with a 2-year tolerance; regional lanes strictly from policy.regionalMinYear. */
export function passesEra(year: number | undefined, l: { regional: boolean; era?: { from: number } }, policy: MusicPolicy = DEFAULT_POLICY): boolean {
  if (year === undefined) return !l.regional;
  if (l.regional) return year >= Math.max(policy.regionalMinYear, eraFloor(l, policy) - ERA_TOLERANCE);
  return year >= eraFloor(l, policy) - ERA_TOLERANCE;
}

/** Alternate versions the curator must not serve (suffix only, so "Live Your Life" is fine). */
export const VERSION_RE = /(\s[-–]\s|[([]).*\b(live|remix(ed)?|re-?mix|sped up|slowed|reverb|nightcore|karaoke|instrumental|acapella|a cappella|8d audio|cover)\b/i;

export function isDislikedArtist(artists: string[], profile: TasteProfile): boolean {
  const dislikes = new Set(profile.explicit.dislikes.map(normKey));
  return artists.some((a) => {
    const k = normKey(a);
    return !!k && ((profile.creators[k] ?? 0) <= -0.5 || dislikes.has(k));
  });
}

/** The user's liked/saved songs by recording identity, not just by Spotify id. */
export interface LibrarySongs {
  isrcs: Set<string>;
  /** songKey(artist, title) for every credited artist. */
  songs: Set<string>;
  /** The library rows' own item ids (an entity lane may show these songs, flagged "In your library"). */
  ids?: Set<string>;
  /**
   * The lane most of each library artist's songs belong to (normKey(artist) → lane id, by the songs' own
   * genres): which lane a live session by an artist the user listens to joins. Local data only.
   */
  artistLanes?: Map<string, string>;
}

export function normIsrc(x: unknown): string {
  const s = typeof x === 'string' ? x.replace(/[-\s]/g, '').toUpperCase() : '';
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(s) ? s : '';
}

/** Index of library songs (title, credited artists, ISRC when the export had one). */
export function librarySongIndex(rows: Array<{ id?: string | null; title?: string | null; creators?: string[] | null; isrc?: unknown; genres?: string[] | null }>): LibrarySongs {
  const lib: LibrarySongs = { isrcs: new Set(), songs: new Set(), ids: new Set() };
  const votes = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.id) lib.ids!.add(r.id);
    const isrc = normIsrc(r.isrc);
    if (isrc) lib.isrcs.add(isrc);
    const lane = r.genres?.length ? laneOfGenres(r.genres) : null;
    for (const a of r.creators ?? []) {
      const k = r.title ? songKey(a, r.title) : '';
      if (k) lib.songs.add(k);
      const ak = normKey(a);
      if (!lane || !ak) continue;
      const v = votes.get(ak) ?? new Map<string, number>();
      v.set(lane, (v.get(lane) ?? 0) + 1);
      votes.set(ak, v);
    }
  }
  if (votes.size) {
    lib.artistLanes = new Map();
    for (const [a, v] of votes) {
      let best = '';
      let n = 0;
      for (const [l, c] of v) if (c > n) [best, n] = [l, c];
      if (best) lib.artistLanes.set(a, best);
    }
  }
  return lib;
}

/** Same recording as a library song under another id (single vs album vs deluxe vs relinked)? */
export function inLibrary(item: Pick<ContentItem, 'title' | 'creators' | 'metadata'>, lib: LibrarySongs | undefined): boolean {
  if (!lib) return false;
  const isrc = normIsrc(item.metadata?.isrc);
  if (isrc && lib.isrcs.has(isrc)) return true;
  return item.creators.some((a) => {
    const k = songKey(a, item.title);
    return !!k && lib.songs.has(k);
  });
}

export interface LaneRuleContext {
  profile: TasteProfile;
  policy?: MusicPolicy;
  excludeIds?: Set<string>;
  /** Liked/saved songs by ISRC and artist|title, so a liked song never comes back under another id. */
  library?: LibrarySongs;
  /** false when the user explicitly asked for older music. */
  era?: boolean;
  now?: Date;
}

/** Why a resolved song may not be served in a lane (null = fine). */
// Recordings registered in France / the Arab world (ISRC country) are, outside electronic music, almost always
// French- or Arabic-language: they only ever fill their own regional lane (capped, 2015+, off when switched off).
const FRENCH_ISRC = /^FR/i;
const ARABIC_ISRC = /^(MA|DZ|TN|LY|EG|LB|SY|JO|PS|IQ|SA|AE|KW|QA|BH|OM|YE)/i;
const LANGUAGE_NEUTRAL_LANES = new Set(['melodic-house', 'edm', 'jazz-classical']);

/** 'french' | 'arabic' when the ISRC says the recording is regional in a lane where that is a language signal. */
export function regionalByIsrc(item: Pick<ContentItem, 'metadata'>, lane: { id?: string; regional: boolean }): 'french' | 'arabic' | null {
  if (lane.regional || (lane.id && LANGUAGE_NEUTRAL_LANES.has(lane.id))) return null;
  const isrc = String(item.metadata?.isrc ?? '').trim();
  if (FRENCH_ISRC.test(isrc)) return 'french';
  if (ARABIC_ISRC.test(isrc)) return 'arabic';
  return null;
}

export function laneReject(item: ContentItem, lane: { id?: string; regional: boolean; era?: { from: number } }, ctx: LaneRuleContext): string | null {
  if (ctx.excludeIds?.has(item.id)) return 'excluded';
  if (inLibrary(item, ctx.library)) return 'library';
  if (isDislikedArtist(item.creators, ctx.profile)) return 'disliked';
  if (VERSION_RE.test(item.title)) return 'version';
  if (item.metadata?.albumType === 'compilation') return 'compilation';
  if (ctx.era !== false) {
    const y = recordingYear(item, ctx.now);
    if (!passesEra(y, lane, ctx.policy ?? DEFAULT_POLICY)) return 'era';
  }
  if (inBlockedFamily(item.genres, ctx.profile)) return 'blocked';
  if (regionalByIsrc(item, lane)) return 'regional-language';
  return null;
}
