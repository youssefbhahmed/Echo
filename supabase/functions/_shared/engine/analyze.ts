// Pipeline step 4 — semantic analysis of catalog items.
// Projects real provider metadata (title, genres, subjects/keywords, description)
// into the concept space. Every concept attached to an item is traceable to text
// that the provider returned; nothing is invented.
import type { AnalyzedItem, ConceptVector, ContentItem } from '../types.ts';
import { normalize, projectText, round } from './text.ts';
import { CONCEPT_BY_ID } from './concepts.ts';

/**
 * Provider genre names whose emotional/thematic meaning is not literally in
 * the word (e.g. "blues" → melancholic). Weights are modest priors (0..1).
 */
export const GENRE_HINTS: Record<string, ConceptVector> = {
  ambient: { calm: 0.7, dreamy: 0.6, contemplative: 0.4 },
  'post-rock': { awe: 0.6, melancholic: 0.4, dreamy: 0.4 },
  shoegaze: { dreamy: 0.8, melancholic: 0.3 },
  'dream pop': { dreamy: 0.8, romantic: 0.3 },
  classical: { contemplative: 0.5, calm: 0.4, cerebral: 0.3 },
  'modern classical': { contemplative: 0.6, melancholic: 0.4, calm: 0.4 },
  neoclassical: { contemplative: 0.6, melancholic: 0.4 },
  jazz: { contemplative: 0.3, nostalgic: 0.3, calm: 0.2 },
  blues: { melancholic: 0.6, nostalgic: 0.3 },
  soul: { romantic: 0.4, uplifting: 0.3 },
  gospel: { uplifting: 0.6, spiritual: 0.6 },
  folk: { cozy: 0.4, nostalgic: 0.4, contemplative: 0.3 },
  'singer-songwriter': { contemplative: 0.4, melancholic: 0.3 },
  indie: { identity: 0.2, dreamy: 0.2 },
  'hip-hop': { energetic: 0.5, society: 0.3 },
  'hip hop': { energetic: 0.5, society: 0.3 },
  rap: { energetic: 0.5, intense: 0.3 },
  electronic: { energetic: 0.4, technology: 0.1 },
  edm: { energetic: 0.8, joyful: 0.4 },
  house: { energetic: 0.7, joyful: 0.4 },
  techno: { energetic: 0.7, dark: 0.2 },
  synthwave: { nostalgic: 0.7, 'sci-fi': 0.3, energetic: 0.3 },
  metal: { intense: 0.8, dark: 0.4 },
  punk: { intense: 0.7, society: 0.3, energetic: 0.5 },
  rock: { energetic: 0.5 },
  pop: { joyful: 0.4, energetic: 0.3, accessible: 0.4 },
  'k-pop': { joyful: 0.5, energetic: 0.5 },
  'lo-fi': { calm: 0.7, cozy: 0.5, nostalgic: 0.3 },
  lofi: { calm: 0.7, cozy: 0.5, nostalgic: 0.3 },
  soundtrack: { awe: 0.4, dreamy: 0.3 },
  'film score': { awe: 0.5 },
  'new age': { calm: 0.7, spiritual: 0.5 },
  meditation: { calm: 0.8, spiritual: 0.6 },
  reggae: { joyful: 0.4, calm: 0.3, society: 0.2 },
  'r&b': { romantic: 0.6 },
  drama: { contemplative: 0.15 },
  thriller: { tense: 0.7 },
  animation: { joyful: 0.3, accessible: 0.3 },
  family: { cozy: 0.4, accessible: 0.4 },
  western: { adventure: 0.4, solitude: 0.3 },
  action: { energetic: 0.7 },
  'action & adventure': { energetic: 0.6, adventure: 0.6 },
  'sci-fi & fantasy': { 'sci-fi': 0.7, myth: 0.5 },
  'war & politics': { war: 0.7, politics: 0.6 },
  kids: { accessible: 0.5, joyful: 0.4 },
  'true crime': { mystery: 0.8, documentary: 0.6 },
  'news': { politics: 0.4, society: 0.4 },
  'news commentary': { politics: 0.5, society: 0.4 },
  education: { cerebral: 0.3, science: 0.2 },
  'society & culture': { society: 0.7 },
  'religion & spirituality': { spiritual: 0.8 },
  'health & fitness': { health: 0.8 },
  fiction: {},
  poetry: { art: 0.5, contemplative: 0.5 },
  philosophy: { philosophy: 0.9, cerebral: 0.4 },
  'science & technology': { science: 0.6, technology: 0.6 },
  'film & animation': { art: 0.2 },
  'people & blogs': { identity: 0.2, accessible: 0.3 },
  comedy: { humor: 0.9, joyful: 0.4 },
  gaming: { energetic: 0.3, technology: 0.3 },
  'howto & style': { accessible: 0.4 },
  'nonprofits & activism': { society: 0.7 },
  'pets & animals': { nature: 0.6, joyful: 0.3 },
  'travel & events': { travel: 0.8 },
  autos: { technology: 0.3 },
  music: {},
  // French / North-African / world labels (Spotify exports use the account's locale)
  chanson: { contemplative: 0.4, nostalgic: 0.4, romantic: 0.2 },
  'variete francaise': { nostalgic: 0.3, joyful: 0.2 },
  rai: { nostalgic: 0.4, energetic: 0.3, romantic: 0.3, identity: 0.2 },
  gnaoui: { spiritual: 0.6, dreamy: 0.4, identity: 0.3 },
  gnawa: { spiritual: 0.6, dreamy: 0.4, identity: 0.3 },
  chaabi: { joyful: 0.4, nostalgic: 0.4, family: 0.2 },
  maghreb: { identity: 0.3 },
  arabe: { identity: 0.2 },
  'southern gothic': { dark: 0.6, eerie: 0.4, melancholic: 0.3 },
  'blues rock': { melancholic: 0.3, energetic: 0.4 },
  'soul blues': { melancholic: 0.4, romantic: 0.3 },
  'afro house': { energetic: 0.6, joyful: 0.4 },
  'tropical house': { joyful: 0.5, energetic: 0.4 },
  'nu metal': { intense: 0.7, energetic: 0.5 },
  'hard rock': { energetic: 0.6, intense: 0.4 },
  'rock alternatif': { energetic: 0.4, identity: 0.2 },
  'alternative rock': { energetic: 0.4, identity: 0.2 },
  'rap francais': { energetic: 0.5, society: 0.3 },
  'pop urbaine': { energetic: 0.4, joyful: 0.3 },
  trap: { energetic: 0.5, dark: 0.3 },
  drill: { intense: 0.6, dark: 0.4 },
  flamenco: { romantic: 0.4, intense: 0.4 },
  bollywood: { romantic: 0.4, joyful: 0.4 },
  desi: { identity: 0.2, energetic: 0.3 },
  afrobeats: { energetic: 0.6, joyful: 0.5 },
  reggaeton: { energetic: 0.6, joyful: 0.4 },
  'world music': { travel: 0.4, identity: 0.3 },
  cinematic: { awe: 0.5 },
  'singer songwriter': { contemplative: 0.4, melancholic: 0.3 },
};

export function genreHints(genres: string[]): ConceptVector {
  const out: ConceptVector = {};
  for (const g of genres) {
    const key = normalize(g).replace(/-/g, ' ');
    // Exact label first, else any known label contained in it ("hip-hop arabe" → "hip hop" + "arabe").
    const hints = GENRE_HINTS[key] ? [GENRE_HINTS[key]] : Object.entries(GENRE_HINTS).filter(([k]) => k.length > 2 && new RegExp(`(^|\\s)${k.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&').replace(/-/g, ' ')}(\\s|$)`).test(key)).map(([, v]) => v);
    for (const hint of hints) for (const [k, v] of Object.entries(hint)) out[k] = Math.max(out[k] ?? 0, v);
  }
  return out;
}

export function itemText(item: ContentItem): string {
  return [item.title, item.creators.join(' '), item.genres.join(' '), item.tags.join(' '), item.description ?? ''].join(' . ');
}

export function analyzeItem(item: ContentItem): AnalyzedItem {
  const fromText = projectText([
    // Song/album titles are poetic, not descriptive: they count much less for music.
    { text: item.title, weight: item.category === 'music' ? 0.25 : 1.0 },
    { text: item.genres.join(' . '), weight: 1.6 },
    { text: item.tags.slice(0, 40).join(' . '), weight: 1.2 },
    { text: (item.description ?? '').slice(0, 2000), weight: 0.7 },
  ]);
  const hints = genreHints(item.genres);
  const concepts: ConceptVector = { ...fromText };
  for (const [k, v] of Object.entries(hints)) concepts[k] = round(Math.max(concepts[k] ?? 0, v));
  // Concepts the provider returned this item for (e.g. Spotify results for "melancholic").
  // Weak evidence (0.35) and never overrides text-derived values.
  const retrievedFor = Array.isArray(item.metadata?.retrievedFor) ? (item.metadata!.retrievedFor as string[]) : [];
  // Only used when the item's own metadata is too thin to analyse (e.g. a bare track title).
  const ownEvidence = Object.values(fromText).filter((v) => v >= 0.3).length;
  const inherited: string[] = [];
  if (ownEvidence < 2) for (const c of retrievedFor) if (CONCEPT_BY_ID[c] && (concepts[c] ?? 0) < 0.35) { concepts[c] = 0.35; inherited.push(c); }
  // Format-level priors grounded in the item's kind.
  if ((item.kind === 'movie' || item.kind === 'series' || item.kind === 'video') && item.genres.some((g) => /documentar/i.test(g))) {
    concepts.documentary = Math.max(concepts.documentary ?? 0, 0.9);
  }
  return inherited.length ? { ...item, concepts, metadata: { ...(item.metadata ?? {}), inheritedConcepts: inherited } } : { ...item, concepts };
}

export function analyzeItems(items: ContentItem[]): AnalyzedItem[] {
  return items.map(analyzeItem);
}
