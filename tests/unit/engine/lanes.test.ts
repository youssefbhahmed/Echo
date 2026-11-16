import { analyzeLibrary, applyLibraryImport, tracksFromCsv, trackToItem } from '@shared/importer.ts';
import {
  applyLanePolicy, chooseLanes, isrcYear, laneOfGenre, laneOfGenres, laneReject, laneTargets, lanesFromGenres, librarySongIndex, passesEra, recordingYear, VERSION_RE, DEFAULT_POLICY,
  withoutPerUser,
} from '@shared/engine/lanes.ts';
import { emptyProfile } from '@shared/engine/profile.ts';
import type { ContentItem, MusicLane } from '@shared/types.ts';
import { syntheticCsv } from './library-fixture';

const NOW = new Date('2026-11-16T00:00:00Z');

describe('lane taxonomy', () => {
  it('maps French/English Spotify genre labels like the library analysis', () => {
    const cases: Record<string, string | null> = {
      'hip-hop arabe': 'arabic-pop', 'rap marocain': 'arabic-pop', 'pop égyptienne': 'arabic-pop', mahraganat: 'arabic-pop',
      gnaoui: 'maghreb-fusion', 'raï': 'maghreb-fusion', 'chaâbi marocain': 'maghreb-fusion',
      'rap français': 'french', 'pop urbaine': 'french', 'variété française': 'french', chanson: 'french',
      'house française': 'melodic-house', 'afro house': 'melodic-house', 'house organique': 'melodic-house', 'trip-hop': 'melodic-house',
      'r&b alternatif': 'hiphop-rnb', 'hip-hop west coast': 'hiphop-rnb', 'uk hip hop': 'hiphop-rnb', rap: 'hiphop-rnb',
      'rap metal': 'rock-metal', 'rock alternatif': 'rock-metal', 'southern gothic': 'blues-soul', 'soul blues': 'blues-soul',
      'tropical house': 'edm', 'house latino': 'edm', amapiano: 'afro-latin', afrobeats: 'afro-latin', 'trap latino': 'afro-latin',
      jazz: 'jazz-classical', 'bande originale': 'jazz-classical', pop: null, 'dance pop': null,
    };
    for (const [g, lane] of Object.entries(cases)) expect([g, laneOfGenre(g)]).toEqual([g, lane]);
    expect(laneOfGenres(['rap', 'hip-hop', 'pop urbaine'])).toBe('hiphop-rnb');
    expect(laneOfGenres(['pop'])).toBeNull();
  });

  it('era rules: regional strictly modern, others with 2 years of tolerance; ISRC catches reissues', () => {
    const regional = { regional: true, era: { from: 2015 } };
    const rock = { regional: false, era: { from: 2001 } };
    expect(passesEra(2014, regional)).toBe(false);
    expect(passesEra(2015, regional)).toBe(true);
    expect(passesEra(undefined, regional)).toBe(false);
    expect(passesEra(1999, rock)).toBe(true);
    expect(passesEra(1998, rock)).toBe(false);
    expect(isrcYear('USSM10107264')).toBe(2001);
    expect(isrcYear('FR6V87500123')).toBe(1975);
    expect(recordingYear({ releaseDate: '2019-01-01', metadata: { isrc: 'FR6V87500123' } })).toBe(1975);
    expect(VERSION_RE.test('Song - Live at Wembley')).toBe(true);
    expect(VERSION_RE.test('Song (Sped Up)')).toBe(true);
    expect(VERSION_RE.test('Live Your Life')).toBe(false);
  });

  it('splits picks by share with at least 3 per lane', () => {
    expect(laneTargets([{ share: 0.3 }, { share: 0.15 }, { share: 0.1 }], 10)).toEqual([4, 3, 3]);
    expect(laneTargets([{ share: 0.5 }, { share: 0.3 }, { share: 0.2 }], 24).reduce((a, b) => a + b, 0)).toBe(24);
    expect(laneTargets([{ share: 0.9 }], 3)).toEqual([3]);
  });
});

describe('taste lanes from a library export', () => {
  const tracks = tracksFromCsv(syntheticCsv());
  const analysis = analyzeLibrary(tracks, NOW);
  const lanes = analysis.dna.lanes!;

  it('reads the audio-feature columns', () => {
    expect(tracks[0]).toMatchObject({ acousticness: expect.any(Number), speechiness: expect.any(Number), instrumentalness: expect.any(Number), tempo: expect.any(Number), loudness: expect.any(Number), popularity: expect.any(Number) });
    // The ISRC travels with the imported song: liked songs are recognised under another release's id.
    expect(tracks[0].isrc).toBe('XX0000000000');
    expect(trackToItem(tracks[0]).metadata?.isrc).toBe('XX0000000000');
  });

  it('places untagged songs by their nearest tagged neighbours, never into regional lanes', () => {
    const untagged = analysis.assignments.filter((_, i) => !tracks[i].genres.length);
    expect(untagged.length).toBe(38);
    expect(untagged.every((a) => a.via === 'knn' && a.lane && !['french', 'arabic-pop', 'maghreb-fusion'].includes(a.lane))).toBe(true);
    const urban = analysis.assignments.filter((_, i) => tracks[i].name.startsWith('UntaggedUrban'));
    expect(urban.filter((a) => a.lane === 'hiphop-rnb').length).toBeGreaterThanOrEqual(27);
    const rock = analysis.assignments.filter((_, i) => tracks[i].name.startsWith('UntaggedRock'));
    expect(rock.every((a) => a.lane === 'rock-metal')).toBe(true);
  });

  it('applies the owner policy: regional lanes share 12% and start in 2015; small and jazz lanes dropped', () => {
    expect(analysis.dna.policy).toEqual({ regionalShare: 0.12, regionalMinYear: 2015, familiarity: 'library' });
    const total = lanes.reduce((s, l) => s + l.share, 0);
    expect(total).toBeCloseTo(1, 2);
    const regional = lanes.filter((l) => l.regional);
    expect(regional.length).toBeGreaterThan(0);
    expect(regional.reduce((s, l) => s + l.share, 0)).toBeCloseTo(0.12, 2);
    for (const l of regional) expect(l.era.from).toBeGreaterThanOrEqual(2015);
    expect(lanes.find((l) => l.id === 'jazz-classical')).toBeUndefined();
    for (const l of lanes) expect(l.share).toBeGreaterThanOrEqual(0.03);
    expect(lanes[0].id).toBe('hiphop-rnb');
  });

  it('describes lanes with generic words only (medians, era, popularity, sub-genres)', () => {
    const house = lanes.find((l) => l.id === 'melodic-house')!;
    expect(house).toMatchObject({ label: 'Afro & melodic house', regional: false, genres: expect.arrayContaining(['afro house', 'house organique']) });
    expect(house.valence).toBeLessThan(0.35);
    expect(house.descriptors).toEqual(expect.arrayContaining(['afro house', 'melancholic but danceable']));
    expect(house.popularity.p50).toBeGreaterThan(40);
    const text = JSON.stringify(lanes);
    for (const t of tracks) {
      expect(text).not.toContain(t.name);
      for (const a of t.artists) expect(text).not.toContain(a);
    }
  });

  it('computes styles from all songs, so tag-heavy regional styles are not inflated', () => {
    const top = analysis.dna.styles.slice(0, 3);
    expect(top).toContain('rap');
    expect(top).not.toContain('pop urbaine');
    expect(top).not.toContain('hip-hop arabe');
  });

  it('learns untagged songs as half-weight lane genres and stays idempotent on re-import', () => {
    const items = tracks.map(trackToItem);
    const added = tracks.map((t) => t.addedAt);
    const without = applyLibraryImport(emptyProfile(), items, added, NOW);
    const once = applyLibraryImport(emptyProfile(), items, added, NOW, { inferredGenres: analysis.inferredGenres });
    expect(once.genres.rap).toBeGreaterThan(without.genres.rap);
    const twice = applyLibraryImport(once, items, added, NOW, { inferredGenres: analysis.inferredGenres });
    expect(twice.genres).toEqual(once.genres);
    expect(twice.creators).toEqual(once.creators);
  });
});

describe('lane choice per refresh', () => {
  const lane = (id: string, share: number, regional = false): MusicLane => ({
    id, label: id, share, descriptors: [], era: { from: regional ? 2015 : 2005, to: 2026 }, energy: 0.6, danceability: 0.7, valence: 0.4, popularity: { p25: 30, p50: 50, p75: 70 }, regional, genres: [],
  });
  const lanes = [lane('hiphop-rnb', 0.3), lane('rock-metal', 0.18), lane('melodic-house', 0.16), lane('afro-latin', 0.13), lane('edm', 0.11), lane('french', 0.06, true), lane('arabic-pop', 0.06, true)];

  it('is deterministic per seed, varies across seeds, never serves two regional lanes', () => {
    expect(chooseLanes(lanes, 7).map((l) => l.id)).toEqual(chooseLanes(lanes, 7).map((l) => l.id));
    const seen = new Set<string>();
    let withRegional = 0;
    let withTop = 0;
    for (let s = 0; s < 400; s++) {
      const c = chooseLanes(lanes, s);
      expect(c).toHaveLength(3);
      expect(c.filter((l) => l.regional).length).toBeLessThanOrEqual(1);
      if (c.some((l) => l.regional)) withRegional++;
      if (c.some((l) => l.id === 'hiphop-rnb')) withTop++;
      seen.add(c.map((l) => l.id).sort().join(','));
    }
    expect(seen.size).toBeGreaterThan(5);
    expect(withTop / 400).toBeGreaterThan(0.6);
    // Regional lanes only come with their 12% weight: present in a minority of refreshes.
    expect(withRegional / 400).toBeGreaterThan(0.1);
    expect(withRegional / 400).toBeLessThan(0.55);
  });

  it('lane feedback and blocked families steer the rotation', () => {
    const blocked = chooseLanes(lanes, 3, 3, { blocked: (l) => l.id === 'hiphop-rnb' });
    expect(blocked.map((l) => l.id)).not.toContain('hiphop-rnb');
    let disliked = 0;
    for (let s = 0; s < 200; s++) if (chooseLanes(lanes, s, 3, { feedback: { 'hiphop-rnb': -1 } }).some((l) => l.id === 'hiphop-rnb')) disliked++;
    let neutral = 0;
    for (let s = 0; s < 200; s++) if (chooseLanes(lanes, s).some((l) => l.id === 'hiphop-rnb')) neutral++;
    expect(disliked).toBeLessThan(neutral);
  });

  it('builds lanes from learned genres when no library was imported', () => {
    const p = { ...emptyProfile(), genres: { 'rap francais': 2, 'hip hop': 1.5, rap: 1, 'afro house': 1.2, 'indie rock': 0.5 } };
    const l = lanesFromGenres(p, NOW);
    expect(l.find((x) => x.id === 'french')?.share).toBeCloseTo(0.12, 2);
    expect(l.find((x) => x.id === 'french')?.era.from).toBe(2015);
    expect(l[0].id).toBe('hiphop-rnb');
  });
});

describe('lane rules for resolved songs', () => {
  const song = (over: Partial<ContentItem>): ContentItem => ({
    id: 'spotify:track:x', category: 'music', kind: 'track', provider: 'spotify', externalId: 'x', title: 'Song', creators: ['Some Artist'], genres: [], tags: [], externalUrl: 'https://open.spotify.com/track/x', releaseDate: '2020-01-01', ...over,
  });
  const lane = { regional: true, era: { from: 2015 } };
  it('rejects old regional songs, exclusions, disliked artists and alternate versions', () => {
    const p = { ...emptyProfile(), creators: { 'bad artist': -1.2, meh: -0.3 } };
    const ctx = { profile: p, policy: DEFAULT_POLICY, excludeIds: new Set(['spotify:track:seen']) };
    expect(laneReject(song({}), lane, ctx)).toBeNull();
    expect(laneReject(song({ releaseDate: '1976-01-01' }), lane, ctx)).toBe('era');
    expect(laneReject(song({ id: 'spotify:track:seen' }), lane, ctx)).toBe('excluded');
    expect(laneReject(song({ creators: ['Bad Artist'] }), lane, ctx)).toBe('disliked');
    expect(laneReject(song({ creators: ['Meh'] }), lane, ctx)).toBeNull();
    expect(laneReject(song({ title: 'Song (Remix)' }), lane, ctx)).toBe('version');
    expect(laneReject(song({ metadata: { albumType: 'compilation' } }), lane, ctx)).toBe('compilation');
    // The user explicitly asked for older music: era rules are lifted.
    expect(laneReject(song({ releaseDate: '1976-01-01' }), lane, { ...ctx, era: false })).toBeNull();
  });

  it('rejects a library song served back under another id (same ISRC, or same artist + title in any script)', () => {
    const library = librarySongIndex([
      { title: 'Glass Coast', creators: ['Nova Lane', 'Guest Singer'], isrc: 'USAB12000001' },
      { title: 'أغنية الليل', creators: ['فنان أول'] },
    ]);
    const ctx = { profile: emptyProfile(), library };
    const free = { regional: false, era: { from: 2011 } };
    // Single vs album version: different id and decorated title, same recording.
    expect(laneReject(song({ id: 'spotify:track:single', title: 'Glass Coast - Single Version', creators: ['Nova Lane'] }), free, ctx)).toBe('library');
    expect(laneReject(song({ id: 'spotify:track:feat', title: 'Glass Coast (feat. Guest Singer)', creators: ['Guest Singer'] }), free, ctx)).toBe('library');
    expect(laneReject(song({ id: 'spotify:track:relinked', title: 'Renamed', metadata: { isrc: 'US-AB1-20-00001' } }), free, ctx)).toBe('library');
    expect(laneReject(song({ id: 'spotify:track:ar', title: 'أغنية الليل', creators: ['فنان أول'] }), lane, ctx)).toBe('library');
    // Another song by the same artist is a discovery.
    expect(laneReject(song({ id: 'spotify:track:new', title: 'Paper Mountain', creators: ['Nova Lane'] }), free, ctx)).toBeNull();
    expect(laneReject(song({ id: 'spotify:track:ar2', title: 'أغنية البحر', creators: ['فنان أول'] }), lane, ctx)).toBeNull();
  });

  it('keeps per-user fields out of shared catalog rows', () => {
    const meta = { lane: { id: 'french', label: 'French pop & rap' }, aiPick: true, isrc: 'X', lastShownAt: '2026-11-15', laneEra: { from: 2015, to: 2025 }, laneMood: 'warm', aiOrder: 3, fallback: true };
    expect(withoutPerUser(meta)).toEqual({ lane: { id: 'french', label: 'French pop & rap' }, aiPick: true, isrc: 'X' });
  });
});

describe('owner policy edge cases', () => {
  const l = (id: string, share: number, regional: boolean) => ({ id, share, regional, era: { from: 2010, to: 2025 } });

  it('treats the regional share as a cap, never inflating rare French/Arabic', () => {
    // 0.5% French stays tiny (then falls under the 3% floor) instead of becoming a 12% lane.
    expect(applyLanePolicy([l('hiphop-rnb', 0.6, false), l('rock-metal', 0.395, false), l('french', 0.005, true)]).map((x) => x.id)).toEqual(['hiphop-rnb', 'rock-metal']);
    const mid = applyLanePolicy([l('hiphop-rnb', 0.62, false), l('rock-metal', 0.3, false), l('french', 0.08, true)]);
    expect(mid.find((x) => x.id === 'french')!.share).toBeCloseTo(0.08, 3);
    const big = applyLanePolicy([l('hiphop-rnb', 0.3, false), l('rock-metal', 0.1, false), l('french', 0.4, true), l('arabic-pop', 0.2, true)]);
    expect(big.filter((x) => x.regional).reduce((s, x) => s + x.share, 0)).toBeCloseTo(0.12, 3);
    // One French like among a big genre profile does not create a French lane.
    const p = { ...emptyProfile(), genres: { 'hip hop': 2, rap: 1.5, 'afro house': 1, rock: 1, 'pop urbaine': 0.1 } };
    expect(lanesFromGenres(p, NOW).find((x) => x.id === 'french')).toBeUndefined();
  });

  it('uses the ISRC year only for reissues (ISRCs are often registered the year before release)', () => {
    const regional = { regional: true, era: { from: 2015 } };
    expect(recordingYear({ releaseDate: '2016-01-01', metadata: { isrc: 'FRX201400001' } })).toBe(2016);
    expect(passesEra(recordingYear({ releaseDate: '2016-01-01', metadata: { isrc: 'FRX201400001' } }), regional)).toBe(true);
    expect(recordingYear({ releaseDate: '2017-03-01', metadata: { isrc: 'FRX201400001' } })).toBe(2014);
    expect(recordingYear({ metadata: { isrc: 'FRX201900001' } })).toBe(2019);
  });
});

describe('lane rotation under feedback', () => {
  const lane = (id: string, share: number, regional = false): MusicLane => ({
    id, label: id, share, descriptors: [], era: { from: regional ? 2015 : 2005, to: 2026 }, energy: 0.6, danceability: 0.7, valence: 0.4, popularity: { p25: 30, p50: 50, p75: 70 }, regional, genres: [],
  });
  const withRegional = [lane('hiphop-rnb', 0.3), lane('rock-metal', 0.18), lane('melodic-house', 0.16), lane('afro-latin', 0.13), lane('edm', 0.11), lane('french', 0.06, true), lane('arabic-pop', 0.06, true)];
  const N = 3000;

  it('likes cannot raise the regional share above the policy; they only re-balance between regional lanes', () => {
    const count = (fb?: Record<string, number>) => {
      let any = 0;
      let french = 0;
      let arabic = 0;
      for (let s = 0; s < N; s++) {
        const c = chooseLanes(withRegional, s, 3, { feedback: fb, regionalShare: 0.12 });
        if (c.some((x) => x.regional)) any++;
        if (c.some((x) => x.id === 'french')) french++;
        if (c.some((x) => x.id === 'arabic-pop')) arabic++;
      }
      return { any: any / N, french, arabic };
    };
    const neutral = count();
    const both = count({ french: 1, 'arabic-pop': 1 });
    const one = count({ french: 1 });
    expect(both.any).toBeCloseTo(neutral.any, 5); // fully capped: same weights as without feedback
    expect(one.any).toBeLessThanOrEqual(neutral.any + 0.02);
    expect(one.french).toBeGreaterThan(one.arabic * 1.5);
    // Dislikes still lower them.
    expect(count({ french: -1, 'arabic-pop': -1 }).any).toBeLessThan(neutral.any);
  });

  it('feedback on one lane never reshuffles the others (a re-fetched feed keeps its lanes)', () => {
    const plain = withRegional.filter((x) => !x.regional);
    for (let s = 0; s < 500; s++) {
      const before = chooseLanes(plain, s).map((x) => x.id);
      // A skip on a lane of this refresh: at most that lane is swapped out.
      const target = before[0];
      const after = chooseLanes(plain, s, 3, { feedback: { [target]: -0.05 } }).map((x) => x.id);
      expect(before.filter((id) => id !== target).every((id) => after.includes(id))).toBe(true);
      // A dislike on a lane outside this refresh changes nothing.
      const outside = plain.find((x) => !before.includes(x.id))!.id;
      expect(chooseLanes(plain, s, 3, { feedback: { [outside]: -1 } }).map((x) => x.id)).toEqual(before);
    }
  });
});
