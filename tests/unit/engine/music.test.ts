import { familyMix, familyOf, mixBrief } from '@shared/engine/music.ts';
import { emptyProfile, applyFeedback } from '@shared/engine/profile.ts';
import { make } from './fixtures';

describe('music style families', () => {
  it('maps granular labels to fair families', () => {
    expect(familyOf('hip-hop arabe')).toBe('maghreb');
    expect(familyOf('rap français')).toBe('french-rap');
    expect(familyOf('hip-hop east coast')).toBe('hip-hop');
    expect(familyOf('southern gothic')).toBe('rock');
    expect(familyOf('house organique')).toBe('house');
    expect(familyOf('variété française')).toBe('french-chanson');
  });
  it('aggregates split US rap labels so they are not under-counted', () => {
    const p = { ...emptyProfile(), genres: { 'hip hop east coast': 1, 'hip hop west coast': 1, 'southern hip hop': 1, rap: 1, 'hip hop arabe': 2 } };
    const m = familyMix(p);
    expect(m.mix[0].id).toBe('hip-hop');
    expect(m.mix[0].share).toBeCloseTo(4 / 6, 2);
  });
  it('dislikes reduce a family and can push it to "avoid"', () => {
    let p: import('@shared/types.ts').TasteProfile = { ...emptyProfile(), genres: { rock: 1, rai: 0.4 } };
    const raiTrack = make({ title: 'x', category: 'music', creators: ['A'], genres: ['raï'] });
    for (let i = 0; i < 4; i++) p = applyFeedback(p, raiTrack, 'dislike');
    const m = familyMix(p);
    expect(m.mix.find((x) => x.id === 'maghreb')).toBeUndefined();
    expect(mixBrief(m)).toMatch(/avoid: Maghreb/);
    expect(mixBrief(m)).toMatch(/100% Rock/);
  });
});
