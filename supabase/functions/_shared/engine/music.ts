// Music style families: Spotify genre labels are very granular and unevenly so (US rap splits into
// "east coast", "southern hip-hop"…), which skews any per-label ranking. Families give a fair mix.
import type { TasteProfile } from '../types.ts';
import { normalize } from './text.ts';

export const FAMILIES: Array<{ id: string; label: string; re: RegExp }> = [
  { id: 'maghreb', label: 'Maghreb & Arabic (Arabic hip-hop, raï, gnawa, chaâbi, Moroccan pop)', re: /\b(arabe|arabic|marocain|moroccan|gnaoui|gnawa|rai|chaabi|khaliji|khaleeji|algerien|tunisien|egyptien|maghreb|andalou|mahraganat|amazigh|berber)\b/ },
  { id: 'french-rap', label: 'French rap & pop urbaine', re: /\b(rap francais|french rap|pop urbaine|drill francaise|rap belge|rap quebecois|r b francais)\b/ },
  { id: 'french-chanson', label: 'French chanson, variété & French pop', re: /\b(chanson|variete|pop francaise|french pop|pop quebecoise|jazz francais)\b/ },
  { id: 'hip-hop', label: 'US/UK hip-hop & rap', re: /\b(hip hop|hip-hop|rap|trap|drill|grime|g funk|boom bap)\b/ },
  { id: 'rnb', label: 'R&B & soul', re: /\b(r b|rnb|soul|neo soul|motown|quiet storm|trap soul)\b/ },
  { id: 'house', label: 'House & electronic (afro / organic / melodic house, techno)', re: /\b(house|techno|edm|electro|electronic|trance|downtempo|dance|melodique|tropical|afro tech|dubstep|drum and bass)\b/ },
  { id: 'rock', label: 'Rock & metal (alt rock, blues rock, southern gothic, metal)', re: /\b(rock|metal|grunge|punk|emo|southern gothic|post punk|shoegaze)\b/ },
  { id: 'blues-jazz', label: 'Blues & jazz', re: /\b(blues|jazz|swing|bossa)\b/ },
  { id: 'afro', label: 'Afrobeats, afropop & afrosoul', re: /\b(afrobeats?|afropop|afrosoul|amapiano|afro|highlife|alte)\b/ },
  { id: 'latin', label: 'Latin', re: /\b(latin|reggaeton|cumbia|salsa|bachata|flamenco|urbano)\b/ },
  { id: 'south-asian', label: 'South Asian (desi, Punjabi, Bollywood)', re: /\b(desi|punjabi|bollywood|hindi|indian)\b/ },
  { id: 'pop', label: 'Pop', re: /\bpop\b/ },
  { id: 'folk', label: 'Folk & singer-songwriter', re: /\b(folk|singer songwriter|acoustic|americana|country)\b/ },
  { id: 'cinematic', label: 'Cinematic, ambient & neo-classical', re: /\b(ambient|neoclassical|neo classical|cinematic|soundtrack|classical|piano)\b/ },
];

export function familyOf(genre: string): string | null {
  const g = normalize(genre).replace(/[-&]/g, ' ').replace(/\s+/g, ' ');
  return FAMILIES.find((f) => f.re.test(g))?.id ?? null;
}

export interface FamilyMix {
  mix: Array<{ id: string; label: string; share: number }>;
  avoid: string[];
}

/** Live style mix from the profile's genre weights (feedback and removals change it immediately). */
export function familyMix(p: TasteProfile): FamilyMix {
  const pos: Record<string, number> = {};
  const neg: Record<string, number> = {};
  for (const [g, w] of Object.entries(p.genres)) {
    const f = familyOf(g);
    if (!f) continue;
    if (w > 0) pos[f] = (pos[f] ?? 0) + w;
    else neg[f] = (neg[f] ?? 0) + w;
  }
  // A family is only "liked" net of its dislikes; blocked families are out entirely.
  for (const f of Object.keys(neg)) pos[f] = (pos[f] ?? 0) + neg[f] * 3;
  const blocked = new Set(p.explicit.blockedFamilies ?? []);
  for (const f of blocked) pos[f] = 0;
  const total = Object.values(pos).filter((w) => w > 0).reduce((a, b) => a + b, 0);
  const mix = FAMILIES.filter((f) => (pos[f.id] ?? 0) > 0)
    .map((f) => ({ id: f.id, label: f.label, share: total ? pos[f.id] / total : 0 }))
    .filter((x) => x.share >= 0.03)
    .sort((a, b) => b.share - a.share);
  const avoid = FAMILIES.filter((f) => blocked.has(f.id) || ((pos[f.id] ?? 0) <= 0 && (neg[f.id] ?? 0) < -0.3)).map((f) => f.label);
  return { mix, avoid };
}

/** True when a music item belongs to a family the user blocked. */
export function inBlockedFamily(genres: string[], p: TasteProfile): boolean {
  const blocked = p.explicit.blockedFamilies ?? [];
  return blocked.length > 0 && genres.some((g) => { const f = familyOf(g); return !!f && blocked.includes(f); });
}

export function mixBrief(m: FamilyMix): string {
  if (!m.mix.length) return '';
  const parts = m.mix.slice(0, 8).map((x) => `${Math.round(x.share * 100)}% ${x.label}`);
  return `target mix of the picks (follow these proportions): ${parts.join(', ')}${m.avoid.length ? `; avoid: ${m.avoid.join(', ')}` : ''}`;
}
