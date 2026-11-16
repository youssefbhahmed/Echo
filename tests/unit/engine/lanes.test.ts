import { analyzeLibrary, applyLibraryImport, tracksFromCsv, trackToItem } from '@shared/importer.ts';
import {
  chooseLanes, isrcYear, laneOfGenre, laneOfGenres, laneReject, laneTargets, lanesFromGenres, passesEra, recordingYear, VERSION_RE, DEFAULT_POLICY,
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
});
