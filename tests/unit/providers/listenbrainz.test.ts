// ListenBrainz query variants (full credits, clean titles, apostrophes), their merge, and the title
// normalisation the resolver matches with. Synthetic names only.
import { createHttp, MemoryCache } from '@shared/providers/http.ts';
import { creditVariants, lbSpotifyIds, lbVariants, LB_SPOTIFY_MAPPING_URL, mergeVariantIds, otherApostrophe } from '@shared/providers/listenbrainz.ts';
import { artistMatches, resolveSpotifyPicks, titleMatches, type SpotifyPick } from '@shared/providers/spotify.ts';
import { cleanTitle, splitArtist, splitTitle } from '@shared/engine/text.ts';

const id = (n: number) => `LBV${String(n).padStart(19, '0')}`;
const rowsOf = (v: Array<{ artist: string; track: string }>) => v.map((q) => `${q.artist} | ${q.track}`);

describe('title and credit normalisation', () => {
  it('splits featuring parts and version decorations off a title', () => {
    expect(splitTitle('Glass Coast (feat. Guest Star)')).toEqual({ title: 'Glass Coast', feat: ['Guest Star'] });
    expect(splitTitle('Glass Coast (with Guest Star)')).toEqual({ title: 'Glass Coast', feat: ['Guest Star'] });
    expect(splitTitle('Glass Coast [ft. Guest Star & Second Voice]')).toEqual({ title: 'Glass Coast', feat: ['Guest Star', 'Second Voice'] });
    expect(splitTitle('Glass Coast feat. A, B & C')).toEqual({ title: 'Glass Coast', feat: ['A', 'B', 'C'] });
    expect(splitTitle('Glass Coast - 2011 Remaster')).toEqual({ title: 'Glass Coast', feat: [] });
    expect(splitTitle('Glass Coast - Remastered 2009')).toEqual({ title: 'Glass Coast', feat: [] });
    expect(splitTitle('Glass Coast (Radio Edit)')).toEqual({ title: 'Glass Coast', feat: [] });
    expect(splitTitle('Glass Coast (feat. Guest Star) - Single Version').title).toBe('Glass Coast');
    // Real parts of a title stay: only known version words are stripped.
    expect(cleanTitle('Glass Coast - Part Two')).toBe('Glass Coast - Part Two');
    expect(cleanTitle('Live Your Life')).toBe('Live Your Life');
    // Never empty.
    expect(cleanTitle('(feat. Somebody)')).toBe('(feat. Somebody)');
  });

  it('splits a "feat." credit into its main artist and featured names', () => {
    expect(splitArtist('Nova Lane feat. Guest Star')).toEqual({ main: 'Nova Lane', feat: ['Guest Star'] });
    expect(splitArtist('Nova Lane ft. A & B')).toEqual({ main: 'Nova Lane', feat: ['A', 'B'] });
    expect(splitArtist('Nova Lane (featuring Guest Star)')).toEqual({ main: 'Nova Lane', feat: ['Guest Star'] });
    expect(splitArtist('Nova Lane & Co')).toEqual({ main: 'Nova Lane & Co', feat: [] });
    expect(splitArtist('Swiftwater')).toEqual({ main: 'Swiftwater', feat: [] });
  });

  it('matches titles ignoring featuring, version parts and apostrophe style', () => {
    expect(titleMatches('Glass Coast', 'Glass Coast (with Guest Star)')).toBe(true);
    expect(titleMatches('Glass Coast (feat. Guest Star)', 'Glass Coast')).toBe(true);
    expect(titleMatches('Glass Coast', 'Glass Coast - 2011 Remaster')).toBe(true);
    expect(titleMatches('Hold On, We’re Home', "Hold On, We're Home")).toBe(true);
    expect(titleMatches('Glass Coast', 'Paper Mountain (feat. Glass Coast Choir)')).toBe(false);
  });

  it('requires the MAIN artist on the track: a featured artist alone never matches', () => {
    expect(artistMatches('Nova Lane', ['Nova Lane', 'Guest Star'])).toBe(true);
    expect(artistMatches('Nova Lane feat. Guest Star', ['Nova Lane'])).toBe(true);
    expect(artistMatches('Nova Lane feat. Guest Star', ['Guest Star'])).toBe(false);
    // A duo credit may still match either artist.
    expect(artistMatches('Nova Lane & Guest Star', ['Guest Star'])).toBe(true);
  });
});

describe('ListenBrainz query variants', () => {
  it('as given first, then full credits with the clean title, deduped and capped at 4', () => {
    expect(rowsOf(lbVariants({ artist: 'Nova Lane', track: 'Glass Coast', feat: ['Guest Star'] }))).toEqual([
      'Nova Lane | Glass Coast',
      'Nova Lane feat. Guest Star | Glass Coast',
      'Nova Lane & Guest Star | Glass Coast',
    ]);
    // Featured names parsed out of the title; the clean title with the main artist comes last.
    expect(rowsOf(lbVariants({ artist: 'Nova Lane', track: 'Glass Coast (with Guest Star)' }))).toEqual([
      'Nova Lane | Glass Coast (with Guest Star)',
      'Nova Lane feat. Guest Star | Glass Coast',
      'Nova Lane & Guest Star | Glass Coast',
      'Nova Lane | Glass Coast',
    ]);
    // A full credit in the artist field: no duplicate of the given row.
    expect(rowsOf(lbVariants({ artist: 'Nova Lane feat. Guest Star', track: 'Glass Coast' }))).toEqual([
      'Nova Lane feat. Guest Star | Glass Coast',
      'Nova Lane & Guest Star | Glass Coast',
      'Nova Lane | Glass Coast',
    ]);
    // Two featured artists.
    expect(rowsOf(lbVariants({ artist: 'Nova Lane', track: 'Glass Coast', feat: ['A Voice', 'B Voice'] }))).toEqual([
      'Nova Lane | Glass Coast',
      'Nova Lane feat. A Voice & B Voice | Glass Coast',
      'Nova Lane, A Voice & B Voice | Glass Coast',
    ]);
    // No featuring and nothing to clean: one row.
    expect(rowsOf(lbVariants({ artist: 'Nova Lane', track: 'Glass Coast' }))).toEqual(['Nova Lane | Glass Coast']);
    // The main artist listed as featured is ignored.
    expect(rowsOf(lbVariants({ artist: 'Nova Lane', track: 'Glass Coast', feat: ['nova lane'] }))).toEqual(['Nova Lane | Glass Coast']);
  });

  it('tries the other apostrophe style when the title has one', () => {
    expect(otherApostrophe("We're Home")).toBe('We’re Home');
    expect(otherApostrophe('We’re Home')).toBe("We're Home");
    expect(otherApostrophe('Home')).toBeNull();
    expect(rowsOf(lbVariants({ artist: 'Nova Lane', track: "We're Home" }))).toEqual(["Nova Lane | We're Home", 'Nova Lane | We’re Home']);
    expect(rowsOf(lbVariants({ artist: 'Nova Lane', track: 'We’re Home', feat: ['Guest Star'] }))).toEqual([
      'Nova Lane | We’re Home',
      'Nova Lane feat. Guest Star | We’re Home',
      'Nova Lane & Guest Star | We’re Home',
      "Nova Lane feat. Guest Star | We're Home",
    ]);
  });

  it('builds credits in the forms MusicBrainz uses', () => {
    expect(creditVariants('Main', [])).toEqual([]);
    expect(creditVariants('Main', ['A'])).toEqual(['Main feat. A', 'Main & A']);
    expect(creditVariants('Main', ['A', 'B', 'C'])).toEqual(['Main feat. A, B & C', 'Main, A, B & C']);
  });

  it('merges ids per pick in variant order, deduped, at most 4', () => {
    expect(mergeVariantIds([[], ['x', 'y'], ['y', 'z'], ['w', 'v']])).toEqual(['x', 'y', 'z', 'w']);
    expect(mergeVariantIds([[], []])).toEqual([]);
  });
});

/** Fake ListenBrainz: maps "artist|track" → ids; logs every request body. */
function fakeLb(map: Record<string, string[]>, opts: { reorder?: boolean } = {}) {
  const bodies: Array<Array<{ artist_name: string; track_name: string }>> = [];
  const fetchImpl = (async (_u: string, init?: RequestInit) => {
    const rows = JSON.parse(String(init?.body)) as Array<{ artist_name: string; release_name: string; track_name: string }>;
    bodies.push(rows);
    const out = rows.map((r) => ({ ...r, spotify_track_ids: map[`${r.artist_name}|${r.track_name}`] ?? [] }));
    // A mismatched answer (last row dropped, order reversed) is matched back by the echoed names.
    return new Response(JSON.stringify(opts.reorder ? out.slice(0, -1).reverse() : out));
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

describe('lbSpotifyIds with variants', () => {
  it('sends every variant in the batched POSTs and merges each pick\'s ids', async () => {
    const { fetchImpl, bodies } = fakeLb({
      'Nova Lane feat. Guest Star|Glass Coast': [id(1), id(2)],
      'Nova Lane & Guest Star|Glass Coast': [id(2), id(3)],
      'Solo Act|Paper Mountain': [id(4)],
      'Third Band feat. Voice|Night Drive': [id(5), id(6), id(7)],
      'Third Band & Voice|Night Drive': [id(8)],
    });
    const ids = await lbSpotifyIds([
      { artist: 'Nova Lane', track: 'Glass Coast', feat: ['Guest Star'] },
      { artist: 'Solo Act', track: 'Paper Mountain' },
      { artist: 'Third Band', track: 'Night Drive (feat. Voice)' },
      { artist: 'Nobody', track: 'Nothing' },
    ], createHttp(new MemoryCache(), fetchImpl));
    expect(ids).toEqual([[id(1), id(2), id(3)], [id(4)], [id(5), id(6), id(7), id(8)], []]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].map((r) => `${r.artist_name}|${r.track_name}`)).toEqual([
      'Nova Lane|Glass Coast', 'Nova Lane feat. Guest Star|Glass Coast', 'Nova Lane & Guest Star|Glass Coast',
      'Solo Act|Paper Mountain',
      'Third Band|Night Drive (feat. Voice)', 'Third Band feat. Voice|Night Drive', 'Third Band & Voice|Night Drive', 'Third Band|Night Drive',
      'Nobody|Nothing',
    ]);
  });

  it('keeps ≤ 25 rows per request across many picks, and maps a reordered answer by name', async () => {
    const map: Record<string, string[]> = {};
    for (let i = 0; i < 12; i++) map[`Main ${i} feat. Guest ${i}|Song ${i}`] = [id(100 + i)];
    const { fetchImpl, bodies } = fakeLb(map, { reorder: true });
    const picks = Array.from({ length: 12 }, (_, i) => ({ artist: `Main ${i}`, track: `Song ${i}`, feat: [`Guest ${i}`] }));
    const ids = await lbSpotifyIds(picks, createHttp(new MemoryCache(), fetchImpl));
    expect(bodies.map((b) => b.length)).toEqual([25, 11]); // 12 picks × 3 variants
    // Every pick is mapped through its feat-credit row (the dropped last rows were an "as given" and an "&" row).
    expect(ids.map((x) => x[0])).toEqual(picks.map((_, i) => id(100 + i)));
  });
});

describe('resolving picks through credit variants', () => {
  const env = (n: string) => ({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b' } as Record<string, string>)[n];
  const track = (tid: string, name: string, artists: string[], playable = true) => ({
    id: tid, name, artists: artists.map((a, i) => ({ id: `a${i}`, name: a })), album: { id: 'al', name: 'Album', images: [], release_date: '2021-05-01', album_type: 'single' },
    duration_ms: 200000, external_urls: { spotify: `https://open.spotify.com/track/${tid}` }, is_playable: playable,
  });
  function net(lb: Record<string, string[]>, tracks: Record<string, ReturnType<typeof track>>) {
    const log: string[] = [];
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      log.push(url);
      if (url.includes('accounts.spotify.com')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      if (url === LB_SPOTIFY_MAPPING_URL) {
        const rows = JSON.parse(String(init?.body)) as Array<{ artist_name: string; track_name: string }>;
        return new Response(JSON.stringify(rows.map((r) => ({ ...r, spotify_track_ids: lb[`${r.artist_name}|${r.track_name}`] ?? [] }))));
      }
      const m = /\/v1\/tracks\/([A-Za-z0-9]+)/.exec(url);
      if (m) return tracks[m[1]] ? new Response(JSON.stringify(tracks[m[1]])) : new Response('{}', { status: 404 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, log };
  }

  it('a song only mapped under its full credit resolves; the main artist must be on the track', async () => {
    const picks: SpotifyPick[] = [
      { artist: 'Nova Lane', track: 'Glass Coast', feat: ['Guest Star'], laneId: 'melodic-house' },
      // ListenBrainz maps this one to a track by the featured artist alone: rejected.
      { artist: 'Third Band', track: 'Night Drive', feat: ['Voice'], laneId: 'melodic-house' },
    ];
    const { fetchImpl, log } = net(
      { 'Nova Lane feat. Guest Star|Glass Coast': [id(1)], 'Third Band feat. Voice|Night Drive': [id(2)] },
      { [id(1)]: track(id(1), 'Glass Coast (feat. Guest Star)', ['Nova Lane', 'Guest Star']), [id(2)]: track(id(2), 'Night Drive', ['Voice']) },
    );
    const res = await resolveSpotifyPicks(picks, { http: createHttp(new MemoryCache(), fetchImpl), env }, { allowSearch: false });
    expect(res.items.map((r) => [r.item.title, r.via])).toEqual([['Glass Coast (feat. Guest Star)', 'listenbrainz']]);
    expect(log.filter((u) => u.includes('/v1/search'))).toEqual([]);
  });

  it('an unplayable release falls through to the next candidate id', async () => {
    const { fetchImpl } = net(
      { 'Nova Lane|Glass Coast': [id(11), id(12)] },
      { [id(11)]: track(id(11), 'Glass Coast', ['Nova Lane'], false), [id(12)]: track(id(12), 'Glass Coast', ['Nova Lane']) },
    );
    const res = await resolveSpotifyPicks([{ artist: 'Nova Lane', track: 'Glass Coast', laneId: 'melodic-house' }], { http: createHttp(new MemoryCache(), fetchImpl), env }, { allowSearch: false });
    expect(res.items.map((r) => r.item.id)).toEqual([`spotify:track:${id(12)}`]);
    expect(res.stats.rejected).toEqual({});
  });
});
