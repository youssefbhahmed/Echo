import { applyLibraryImport, parseCsv, topStyles, tracksFromCsv, trackToItem } from '@shared/importer.ts';
import { emptyProfile } from '@shared/engine/profile.ts';

const CSV = `﻿Track URI,ISRC,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label,Danceability,Energy,Key,Loudness,Mode,Speechiness,Acousticness,Instrumentalness,Liveness,Valence,Tempo,Time Signature
spotify:track:4e9eGQYsOiBcftrWXwsVco,X,"Aerials","Toxicity","System Of A Down",2001-09-04,235053,86,false,u,2026-11-13T11:15:51Z,"nu metal,metal,rock","L",0.36,0.92,0,-4,0,0.05,0.0,0.03,0.06,0.227,79,4
spotify:track:75OSVIdR2KPpEmViMt8MX2,X,"Pal Pal, ""live""","Pal Pal","Afusic;Talwiinder",2025-04-10,208000,77,false,u,2025-11-10T17:07:04Z,"desi,hip-hop desi","A",0.73,0.52,5,-8,0,0.08,0.69,0.001,0.24,0.299,105,4
spotify:track:1111111111111111111111,X,"Gnawa Night","G","Labess",2020-01-01,300000,50,false,u,2026-10-01T00:00:00Z,"gnaoui,hip-hop arabe","L",0.5,0.4,0,-8,0,0.05,0.3,0.0,0.1,0.8,100,4
spotify:track:2222222222222222222222,X,"Another","G","Labess",2020-01-01,300000,50,false,u,2026-10-01T00:00:00Z,"gnaoui,raï","L",0.5,0.4,0,-8,0,0.05,0.3,0.0,0.1,0.5,100,4`;

describe('Spotify liked-songs import', () => {
  it('parses Exportify CSV including quotes, multiple artists and BOM', () => {
    expect(parseCsv('a,"b,c","d ""e"""\n1,2,3')).toEqual([['a', 'b,c', 'd "e"'], ['1', '2', '3']]);
    const t = tracksFromCsv(CSV);
    expect(t).toHaveLength(4);
    expect(t[1]).toMatchObject({ id: '75OSVIdR2KPpEmViMt8MX2', name: 'Pal Pal, "live"', artists: ['Afusic', 'Talwiinder'], genres: ['desi', 'hip-hop desi'] });
  });
  it('turns tracks into playable Spotify items with grounded mood concepts', () => {
    const [aerials] = tracksFromCsv(CSV).map(trackToItem);
    expect(aerials).toMatchObject({ id: 'spotify:track:4e9eGQYsOiBcftrWXwsVco', category: 'music', embed: { type: 'spotify', uri: 'spotify:track:4e9eGQYsOiBcftrWXwsVco' } });
    expect(aerials.concepts.intense).toBeGreaterThan(0.5); // nu metal
    expect(aerials.concepts.energetic).toBeGreaterThan(0.4); // energy 0.92
    expect(aerials.concepts.melancholic).toBeGreaterThan(0.4); // valence 0.23
  });
  it('learns styles and artists in one bounded pass', () => {
    const tracks = tracksFromCsv(CSV);
    const p = applyLibraryImport(emptyProfile(), tracks.map(trackToItem), tracks.map((t) => t.addedAt), new Date('2026-11-14'));
    expect(p.creators.labess).toBeGreaterThan(p.creators['system of a down']);
    expect(topStyles(p)).toContain('gnaoui');
    expect(p.concepts.spiritual).toBeGreaterThan(0);
    for (const v of Object.values(p.concepts)) expect(Math.abs(v)).toBeLessThanOrEqual(3);
  });
  it('rejects files without Spotify columns', () => {
    expect(() => tracksFromCsv('title,artist\nx,y')).toThrow(/Track URI/);
  });
});

describe('import hygiene', () => {
  it('ignores song titles when learning themes', () => {
    const t = tracksFromCsv(CSV)[0];
    const item = trackToItem({ ...t, name: 'Power Politics Horror Mystery', genres: ['chanson'] });
    expect(item.concepts.politics).toBeUndefined();
    expect(item.concepts.horror).toBeUndefined();
    expect(item.concepts.contemplative).toBeGreaterThan(0);
  });
  it('re-importing replaces the previous contribution instead of stacking', () => {
    const tracks = tracksFromCsv(CSV);
    const items = tracks.map(trackToItem);
    const once = applyLibraryImport(emptyProfile(), items, tracks.map((x) => x.addedAt), new Date('2026-11-14'));
    const twice = applyLibraryImport(once, items, tracks.map((x) => x.addedAt), new Date('2026-11-14'));
    expect(twice.concepts).toEqual(once.concepts);
    expect(twice.genres).toEqual(once.genres);
    expect(twice.interactionCount).toBe(once.interactionCount);
  });
});
