// Songs and non-music media never steer each other (taste domains).
import { parseIntent } from '@shared/engine/intent.ts';
import { applyFeedback, emptyProfile, hydrateProfile } from '@shared/engine/profile.ts';
import { rankCandidates } from '@shared/engine/rank.ts';
import { make } from './fixtures';

const song = make({ title: 'Haunted Mystery Night', category: 'music', creators: ['Some Band'], genres: ['Rock'], description: 'A dark horror mystery song about ghosts and murder' });
const horrorFilm = make({ title: 'The Haunting', category: 'screen', creators: ['Studio'], genres: ['Horror', 'Mystery'], description: 'A horror mystery about a haunted house, ghosts and a murder.' });
const natureDoc = make({ title: 'Ocean Worlds', category: 'youtube', creators: ['BBC Earth'], genres: ['Documentary'], description: 'Nature documentary about the ocean, wildlife and the sea.' });

describe('taste domains', () => {
  it('liking songs does not teach the general (video/film/book) taste', () => {
    let p = emptyProfile();
    for (let i = 0; i < 4; i++) p = applyFeedback(p, song, 'like');
    expect(Object.keys(p.concepts)).toHaveLength(0);
    expect(Object.keys(p.conceptsByCategory.music ?? {}).length).toBeGreaterThan(0);
  });

  it('never explains a film by a song, or a song by a video', () => {
    let p = emptyProfile();
    p = applyFeedback(p, song, 'like');
    p = applyFeedback(p, horrorFilm, 'like');
    const evidence = [song, horrorFilm].map((c) => ({ id: c.id, title: c.title, category: c.category, kind: c.kind, concepts: c.concepts }));
    const otherFilm = make({ title: 'Ghost Story', category: 'screen', genres: ['Horror'], description: 'A haunted mystery with ghosts.' });
    const otherSong = make({ title: 'Murder Ballad', category: 'music', genres: ['Rock'], description: 'A dark mystery horror song about ghosts.' });
    const recs = rankCandidates([otherFilm, otherSong, natureDoc], parseIntent(''), p, { exploration: 0.3, hasQuery: false, limit: 3, evidence });
    for (const r of recs) {
      const text = r.explanation.text;
      if (r.item.category !== 'music') expect(text).not.toContain(song.title);
      else expect(text).not.toContain(horrorFilm.title);
    }
  });

  it('migrates v1 profiles: removes the music share from general concepts, once', () => {
    const v1 = { concepts: { horror: 2, mystery: 1.5, nature: 1 }, conceptsByCategory: { music: { horror: 1.8, mystery: 1.5 }, youtube: { nature: 1 } }, explicit: { likes: [], dislikes: [], statements: [], pinnedConcepts: [], blockedConcepts: [] } };
    const p = hydrateProfile(v1);
    expect(p.concepts.nature).toBe(1);
    expect(p.concepts.mystery).toBeUndefined();
    expect(p.concepts.horror).toBeCloseTo(0.2);
    expect(p.domainsVersion).toBe(2);
    expect(hydrateProfile(p).concepts).toEqual(p.concepts);
  });

  it('keeps music videos out of the open Videos feed', () => {
    const mv = make({ title: 'Artist - Song (Official Video)', category: 'youtube', genres: ['Music'], description: 'Official music video' });
    const recs = rankCandidates([mv, natureDoc], parseIntent(''), emptyProfile(), { exploration: 0.3, hasQuery: false, limit: 5 });
    expect(recs.map((r) => r.item.title)).not.toContain(mv.title);
    expect(recs.map((r) => r.item.title)).toContain(natureDoc.title);
  });
});
