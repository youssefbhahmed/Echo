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

describe('durable music controls', () => {
  it('"never" blocks a family from the mix, the curator brief and ranking', async () => {
    const { applyEdit } = await import('@shared/engine/profile.ts');
    const { rankCandidates } = await import('@shared/engine/rank.ts');
    const { parseIntent } = await import('@shared/engine/intent.ts');
    let p: import('@shared/types.ts').TasteProfile = { ...emptyProfile(), genres: { rock: 1.5, 'pop francaise': 1.8, 'hip hop arabe': 1.2 } };
    p = applyEdit(p, { family: { id: 'french-chanson', action: 'never' } });
    const m = familyMix(p);
    expect(m.mix.find((x) => x.id === 'french-chanson')).toBeUndefined();
    expect(mixBrief(m)).toMatch(/avoid: French chanson/);
    const fr = make({ title: 'Chanson', category: 'music', creators: ['FR'], genres: ['french pop'] });
    const rk = make({ title: 'Riff', category: 'music', creators: ['RK'], genres: ['indie rock'] });
    const recs = rankCandidates([fr, rk], parseIntent(''), p, { exploration: 0.5, hasQuery: false, limit: 2 });
    expect(recs[0].item.title).toBe('Riff');
    expect(recs[1].score.penalty).toBeGreaterThanOrEqual(2);
    const back = applyEdit(p, { family: { id: 'french-chanson', action: 'allow' } });
    expect(back.explicit.blockedFamilies).toEqual([]);
  });
  it('"less" and "more" shift the shares', async () => {
    const { applyEdit } = await import('@shared/engine/profile.ts');
    const p: import('@shared/types.ts').TasteProfile = { ...emptyProfile(), genres: { rock: 1, 'hip hop arabe': 1 } };
    const less = familyMix(applyEdit(p, { family: { id: 'maghreb', action: 'less' } }));
    expect(less.mix[0].id).toBe('rock');
    const more = familyMix(applyEdit(p, { family: { id: 'maghreb', action: 'more' } }));
    expect(more.mix[0].id).toBe('maghreb');
  });
  it('unlike reverses most of a like', async () => {
    const t = make({ title: 'Song', category: 'music', creators: ['Artist'], genres: ['raï'] });
    const liked = applyFeedback(emptyProfile(), t, 'like');
    const undone = applyFeedback(liked, t, 'unlike');
    expect(Math.abs(undone.creators.artist)).toBeLessThan(liked.creators.artist * 0.5);
  });
});
