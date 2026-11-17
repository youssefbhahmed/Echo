// Music fallback tiers: this user's recent songs → songs ECHO verified for anyone → (music-only page)
// songs shown 24 h–3 days ago. Pure helpers, no database. Synthetic songs only.
import { fallbackTierOf, historyTiers, laneFallback, reshowableIds, sharedPool, type MusicPlan } from '@shared/engine/curator.ts';
import { DEFAULT_POLICY, MIX_LANE, mixLane, withoutPerUser } from '@shared/engine/lanes.ts';
import { emptyProfile } from '@shared/engine/profile.ts';
import { runPipeline } from '@shared/engine/pipeline.ts';
import { createHttp, MemoryCache } from '@shared/providers/http.ts';
import type { AnalyzedItem, ContentItem, MusicLane, TasteProfile } from '@shared/types.ts';
import { make } from './fixtures';

const NOW = new Date('2026-11-16T12:00:00Z');
const H = 3600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const tid = (n: number) => `spotify:track:FB${String(n).padStart(20, '0')}`;

const HIP: MusicLane = {
  id: 'hiphop-rnb', label: 'Hip-hop & R&B', share: 1, descriptors: ['rap'], era: { from: 2010, to: 2025 }, energy: 0.6, danceability: 0.7, valence: 0.4,
  popularity: { p25: 30, p50: 50, p75: 70 }, regional: false, genres: ['rap'], source: 'library',
};
const plan = (lane: MusicLane, target: number): MusicPlan => ({
  mode: 'lanes', lanes: [lane], order: [lane.id], targets: { [lane.id]: target }, total: target, policy: DEFAULT_POLICY, rules: { era: true, vocals: true, familiar: true },
});

function song(n: number, o: { lane?: { id: string; label: string }; tier?: 1 | 2 | 3; shownAt?: string; year?: number; genres?: string[]; meta?: Record<string, unknown>; embed?: boolean } = {}): AnalyzedItem {
  const id = tid(n);
  return make({
    id, title: `Fallback Song ${n}`, category: 'music', provider: 'spotify', kind: 'track', creators: [`Fallback Artist ${n}`], genres: o.genres ?? ['rap'], releaseDate: `${o.year ?? 2020}-01-01`,
    embed: o.embed === false ? null : { type: 'spotify', uri: id, kind: 'track' },
    metadata: { lane: o.lane ?? { id: HIP.id, label: HIP.label }, aiPick: true, ...(o.tier ? { fallbackTier: o.tier } : {}), ...(o.shownAt ? { lastShownAt: o.shownAt } : {}), ...(o.meta ?? {}) },
  });
}
const ids = (xs: ContentItem[]) => xs.map((x) => x.id);

describe('which of the user\'s own songs each tier may use', () => {
  const lastShown = new Map<string, number>([
    [tid(1), NOW.getTime() - 10 * D],
    [tid(2), NOW.getTime() - 5 * D],
    [tid(3), NOW.getTime() - 2 * D],
    [tid(4), NOW.getTime() - 30 * H],
    [tid(5), NOW.getTime() - 10 * H],
    [tid(6), NOW.getTime() - 20 * D], // held back (library / dislike)
    ['spotify:album:ALBUM0000000000000000', NOW.getTime() - 9 * D],
  ]);
  const hold = (id: string) => id === tid(6);

  it('tier 1 = shown before the 3-day window, shown longest ago first; tier 3 = 24 h–3 days, only when asked', () => {
    expect(historyTiers(lastShown, NOW.getTime(), hold)).toEqual({ own: [tid(1), tid(2)], reshow: [] });
    expect(historyTiers(lastShown, NOW.getTime(), hold, { reshow: true })).toEqual({ own: [tid(1), tid(2)], reshow: [tid(3), tid(4)] });
    expect(historyTiers(lastShown, NOW.getTime(), hold, { max: 1 }).own).toEqual([tid(1)]);
  });

  it('re-showable = tracks shown 24 h–3 days ago that nothing else holds back (skips, the page being replaced, library)', () => {
    expect([...reshowableIds(lastShown, NOW.getTime(), new Set())].sort()).toEqual([tid(3), tid(4)]);
    expect([...reshowableIds(lastShown, NOW.getTime(), new Set([tid(4)]))]).toEqual([tid(3)]);
  });
});

describe('the shared pool (songs ECHO verified for any user)', () => {
  it('keeps taste-lane, playable Spotify tracks not in this user\'s history or held back, without per-user fields', () => {
    const rows = [
      song(10, { meta: { lastShownAt: ago(D), aiOrder: 3, laneEra: { from: 2000, to: 2020 }, fallback: true } }),
      song(11, { lane: { id: 'old-curator-lane', label: 'Old' } }), // not an engine lane
      song(12, { meta: { imported: true } }),
      song(13, { embed: false }),
      song(14), // in this user's history
      song(15), // held back (library / shown in the last 3 days)
      song(10), // duplicate row
      { ...song(16), kind: 'album' as const },
      // Another user's open lane or typed request: only a free-text style label vouches for them (a French
      // song labelled "drill" would pass as hip-hop), so they never join the shared pool.
      song(17, { lane: { id: 'mix', label: 'Fresh picks' } }),
      song(18, { lane: { id: 'request', label: 'For your request' } }),
    ];
    const pool = sharedPool(rows, new Set([tid(14)]), (id) => id === tid(15));
    expect(ids(pool)).toEqual([tid(10)]);
    expect(pool[0].metadata).toEqual(expect.objectContaining({ fallbackTier: 2, lane: { id: HIP.id, label: HIP.label } }));
    for (const k of ['lastShownAt', 'aiOrder', 'laneEra', 'fallback']) expect(pool[0].metadata).not.toHaveProperty(k);
    // fallbackTier is per-user: it never reaches the shared catalog row.
    expect(withoutPerUser(pool[0].metadata)).not.toHaveProperty('fallbackTier');
  });
});

describe('laneFallback tiers', () => {
  const own = [song(1, { tier: 1, shownAt: ago(10 * D) }), song(2, { tier: 1, shownAt: ago(40 * D) })];
  const shared = [song(20, { tier: 2 }), song(21, { tier: 2 }), song(22, { tier: 2, year: 1990 }), song(23, { tier: 2 }), song(24, { tier: 2 }), song(25, { tier: 2 }), song(26, { tier: 2 })];
  const reshow = [song(30, { tier: 3, shownAt: ago(30 * H) }), song(31, { tier: 3, shownAt: ago(60 * H) }), song(32, { tier: 3, shownAt: ago(40 * H) })];

  it('fills from the user\'s own songs first (shown longest ago first), then the shared pool, under the lane rules', () => {
    const out = laneFallback([...shared, ...own], plan(HIP, 4), { profile: emptyProfile(), now: NOW });
    // want = deficit 4 + 2 spare
    expect(ids(out)).toEqual([tid(2), tid(1), tid(20), tid(21), tid(23), tid(24)]);
    expect(out.map(fallbackTierOf)).toEqual([1, 1, 2, 2, 2, 2]);
    expect(ids(out)).not.toContain(tid(22)); // 1990: before the lane's era
    for (const o of out) expect(o.metadata).toMatchObject({ fallback: true, aiPick: false, lane: { id: HIP.id } });
  });

  it('never re-shows songs from the last 3 days unless the page is music-only and they are marked re-showable', () => {
    const small = [own[0]];
    const excludeIds = new Set(reshow.map((s) => s.id));
    const reshowable = new Set([tid(30), tid(31)]); // 32 was skipped / on the page being replaced
    expect(ids(laneFallback([...small, ...reshow], plan(HIP, 4), { profile: emptyProfile(), excludeIds, reshowable, now: NOW }))).toEqual([tid(1)]);
    const out = laneFallback([...small, ...reshow], plan(HIP, 4), { profile: emptyProfile(), excludeIds, reshowable, musicOnly: true, now: NOW });
    // Least recently shown first; 32 never.
    expect(ids(out)).toEqual([tid(1), tid(31), tid(30)]);
    expect(out.map(fallbackTierOf)).toEqual([1, 3, 3]);
    // Without a re-showable set, nothing from tier 3 passes the exclusions.
    expect(ids(laneFallback([...small, ...reshow], plan(HIP, 4), { profile: emptyProfile(), excludeIds, musicOnly: true, now: NOW }))).toEqual([tid(1)]);
  });

  it('stops once the lanes are full: tier 3 is only reached when tiers 1 and 2 fall short', () => {
    const out = laneFallback([...own, ...shared, ...reshow], plan(HIP, 3), { profile: emptyProfile(), reshowable: new Set(ids(reshow)), musicOnly: true, now: NOW });
    expect(out.map(fallbackTierOf)).toEqual([1, 1, 2, 2, 2]);
  });

  it('the open lane keeps regional songs within the regional share, and never uses a switched-off lane\'s songs', () => {
    const profile: TasteProfile = { ...emptyProfile(), explicit: { ...emptyProfile().explicit, blockedFamilies: ['french-rap', 'french-chanson'] } };
    const arabic = { id: 'arabic-pop', label: 'Arabic rap & pop' };
    const french = { id: 'french', label: 'French pop & rap' };
    const pool = [
      ...[40, 41, 42].map((n) => song(n, { tier: 2, lane: arabic, genres: ['rap marocain'], year: 2021 })),
      ...[50, 51].map((n) => song(n, { tier: 2, lane: french, genres: ['pop urbaine'], year: 2021 })),
      ...[60, 61, 62, 63, 64, 65, 66, 67, 68, 69].map((n) => song(n, { tier: 2 })),
    ];
    const mixPlan: MusicPlan = { ...plan(mixLane(NOW), 10), lanes: [mixLane(NOW)], order: [MIX_LANE.id], targets: { [MIX_LANE.id]: 10 } };
    const out = laneFallback(pool, mixPlan, { profile, now: NOW });
    expect(out.filter((o) => [tid(40), tid(41), tid(42)].includes(o.id))).toHaveLength(1); // floor(10 × 12%)
    expect(ids(out)).not.toContain(tid(50));
    expect(ids(out)).not.toContain(tid(51));
    expect(out).toHaveLength(11); // 10 + 1 regional (wanted 12: the cap leaves it one short)
  });
});

describe('a short music-only page (pipeline, no curator, Spotify search blocked)', () => {
  const profile: TasteProfile = {
    ...emptyProfile(),
    music: { tracks: 10, distinctArtists: 10, styles: ['rap'], recentStyles: [], decades: ['2010s'], languages: [], mood: { valence: 0.4, energy: 0.6, danceability: 0.7, topQuadrant: '' }, importedAt: '', lanes: [HIP] },
  };
  const stored = [song(1, { tier: 1, shownAt: ago(10 * D) }), song(20, { tier: 2 }), song(30, { tier: 3, shownAt: ago(30 * H) }), song(31, { tier: 3, shownAt: ago(50 * H) })];
  const calls: Array<{ categories: string[]; opts: unknown }> = [];
  const catalogFallback = async (_p: string, categories: string[], opts?: unknown) => {
    calls.push({ categories, opts });
    return stored;
  };
  const run = (categories: Array<'music' | 'books'>, reshowable?: Set<string>) =>
    runPipeline({ categories, limit: 6 }, {
      env: () => undefined, http: createHttp(new MemoryCache(), (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch), profile, blockedProviders: new Set(['spotify']),
      excludeIds: new Set([tid(30), tid(31)]), reshowable, catalogFallback, seed: 1, now: NOW,
    });

  it('asks for the shared pool and re-shows songs from more than 24 h ago, least recently shown first', async () => {
    calls.length = 0;
    const res = await run(['music'], new Set([tid(30), tid(31)]));
    expect(calls.find((c) => c.categories.includes('music'))?.opts).toEqual({ shared: true, reshow: true });
    expect(ids(res.recommendations.map((r) => r.item))).toEqual([tid(1), tid(20), tid(31), tid(30)]);
    expect(res.pipeline.find((p) => p.step === 'fallback' && /lane slots/.test(p.detail ?? ''))?.detail).toMatch(/yours 1, shared 1, shown again 2/);
  });

  it('a mixed page never re-shows recent songs', async () => {
    calls.length = 0;
    const res = await run(['music', 'books'], new Set([tid(30), tid(31)]));
    expect(calls.find((c) => c.categories.includes('music'))?.opts).toEqual({ shared: true, reshow: false });
    const shown = ids(res.recommendations.map((r) => r.item));
    expect(shown).not.toContain(tid(30));
    expect(shown).not.toContain(tid(31));
  });
});
