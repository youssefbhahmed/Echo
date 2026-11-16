import { analyzeLibrary, applyLibraryImport, tracksFromCsv, trackToItem } from '@shared/importer.ts';
import { curatorCacheKey, curatorPrompt, parseMusicPicks } from '@shared/engine/ai.ts';
import { buildBrief, musicQuotaFor, planMusic, requestRules } from '@shared/engine/curator.ts';
import { parseIntent } from '@shared/engine/intent.ts';
import { emptyProfile } from '@shared/engine/profile.ts';
import type { TasteProfile } from '@shared/types.ts';
import { syntheticCsv } from './library-fixture';

const NOW = new Date('2026-11-16T00:00:00Z');

function importedProfile(): { profile: TasteProfile; names: string[] } {
  const tracks = tracksFromCsv(syntheticCsv());
  const { dna, inferredGenres } = analyzeLibrary(tracks, NOW);
  const p = applyLibraryImport(emptyProfile(), tracks.map(trackToItem), tracks.map((t) => t.addedAt), NOW, { inferredGenres });
  return { profile: { ...p, music: dna }, names: [...tracks.map((t) => t.name), ...tracks.flatMap((t) => t.artists), ...tracks.map((t) => t.album ?? '')] };
}

const BANNED = /acclaimed|cult|lesser-known|outside the (obvious )?mainstream|mix eras|countries|hidden gems/i;

describe('music curator brief', () => {
  const { profile, names } = importedProfile();

  it('plans up to 3 lanes for a 48-pick feed and splits the music quota by share (min 3 each)', () => {
    const total = musicQuotaFor(['youtube', 'music', 'screen', 'books', 'podcasts'], 48, undefined, false);
    expect(total).toBe(10);
    const plan = planMusic(profile, { hasQuery: false, seed: 4, total, now: NOW })!;
    expect(plan.mode).toBe('lanes');
    expect(plan.lanes).toHaveLength(3);
    expect(plan.lanes.filter((l) => l.regional).length).toBeLessThanOrEqual(1);
    expect(Object.values(plan.targets).reduce((a, b) => a + b, 0)).toBe(10);
    for (const n of Object.values(plan.targets)) expect(n).toBeGreaterThanOrEqual(3);
    expect(planMusic(profile, { hasQuery: false, seed: 4, total: 3, now: NOW })!.lanes).toHaveLength(1);
  });

  it('sends generic lane words with the policy rules, never library track/artist names', () => {
    // Pick a seed whose rotation includes a regional lane, and one without.
    let regionalSeed = -1;
    for (let s = 0; s < 200 && regionalSeed < 0; s++) if (planMusic(profile, { hasQuery: false, seed: s, total: 10, now: NOW })!.lanes.some((l) => l.regional)) regionalSeed = s;
    expect(regionalSeed).toBeGreaterThanOrEqual(0);
    const plan = planMusic(profile, { hasQuery: false, seed: regionalSeed, total: 10, now: NOW })!;
    const { system, user } = curatorPrompt(buildBrief(plan, profile, { moods: ['melancholic'] }));
    const all = `${system}\n${user}`;
    for (const n of names) if (n) expect(all).not.toContain(n);
    for (const creator of Object.keys(profile.creators)) expect(all.toLowerCase()).not.toContain(creator);
    expect(all).not.toMatch(BANNED);
    // Policy constraints
    expect(system).toMatch(/with vocals/);
    expect(system).toMatch(/well known in their scene/);
    expect(system).toMatch(/Never obscure, avant-garde, experimental, ambient/);
    expect(system).toMatch(/One song per artist/);
    expect(system).toMatch(/smooth listening flow/);
    expect(system).toMatch(/no live, remix/);
    expect(user).toMatch(/modern only: released 2015 or later, no traditional or classic-era songs/);
    for (const l of plan.lanes) expect(user).toContain(`lane "${l.id}" (${l.label})`);
    expect(user).toMatch(/\b(9|1[0-4]) songs/);
    expect(user).toMatch(/Session mood: melancholic/);
    // Lanes carry mood/energy from the library medians.
    expect(user).toMatch(/(melancholic|bittersweet|warm|upbeat)/);
  });

  it('only passes user-typed dislikes to the curator', () => {
    const p = { ...profile, explicit: { ...profile.explicit, dislikes: ['no christmas songs'] }, creators: { ...profile.creators, 'skipped artist': -1.2 } };
    const plan = planMusic(p, { hasQuery: false, seed: 1, total: 10, now: NOW })!;
    const { user } = curatorPrompt(buildBrief(plan, p));
    expect(user).toMatch(/Avoid: no christmas songs/);
    expect(user).not.toMatch(/skipped artist/);
  });

  it('keeps typed requests query-driven but applies era/vocal/familiarity rules unless asked otherwise', () => {
    const intent = parseIntent('upbeat moroccan rap for a road trip');
    const plan = planMusic(profile, { hasQuery: true, seed: 1, total: 12, text: intent.rawText, now: NOW })!;
    expect(plan).toMatchObject({ mode: 'request', order: ['request'], targets: { request: 12 } });
    const { system, user } = curatorPrompt(buildBrief(plan, profile, { intent }));
    expect(user).toMatch(/^Request: upbeat moroccan rap for a road trip/);
    expect(system).toMatch(/first released in or after 2005; French, Arabic or Maghreb songs only from 2015 on/);
    expect(system).toMatch(/with vocals/);
    expect(system).toMatch(/well known in their scene/);
    for (const n of names) if (n) expect(`${system}${user}`).not.toContain(n);

    expect(requestRules('old school 90s hip hop classics')).toMatchObject({ era: false });
    expect(requestRules('instrumental piano for focus')).toMatchObject({ vocals: false });
    expect(requestRules('obscure underground deep cuts')).toMatchObject({ familiar: false });
    const old = planMusic(profile, { hasQuery: true, seed: 1, total: 12, text: 'classic 70s soul', now: NOW })!;
    expect(curatorPrompt(buildBrief(old, profile, { intent: parseIntent('classic 70s soul') })).system).not.toMatch(/released in or after/);
  });

  it('cache key changes with every seed and is stable for the same seed and brief', async () => {
    const plan = planMusic(profile, { hasQuery: false, seed: 2, total: 10, now: NOW })!;
    const prompt = curatorPrompt(buildBrief(plan, profile));
    const a = await curatorCacheKey('m', prompt, 2);
    expect(await curatorCacheKey('m', prompt, 2)).toBe(a);
    expect(await curatorCacheKey('m', prompt, 3)).not.toBe(a);
    expect(await curatorCacheKey('m', prompt, 6)).not.toBe(a); // no seed % 4 reuse
  });

  it('parses curator JSON: artist + track required, one song per artist', () => {
    const picks = parseMusicPicks(JSON.stringify({ items: [{ artist: 'A', track: 'One', lane: 'Hiphop-RNB' }, { artist: 'a', track: 'Two', lane: 'edm' }, { artist: 'B' }, { artist: 'C', track: 'Three' }] }));
    expect(picks).toEqual([{ artist: 'A', track: 'One', lane: 'hiphop-rnb' }, { artist: 'C', track: 'Three' }]);
  });
});
