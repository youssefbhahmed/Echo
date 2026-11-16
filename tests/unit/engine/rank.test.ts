import { parseIntent } from '@shared/engine/intent.ts';
import { applyFeedback, emptyProfile, decayProfile, applyEdit, seedProfile, applyStatement } from '@shared/engine/profile.ts';
import { rankCandidates, diversify, sequenceTrajectory } from '@shared/engine/rank.ts';
import { analyzeItem } from '@shared/engine/analyze.ts';
import { buildInsights } from '@shared/engine/insights.ts';
import { make } from './fixtures';

const catalog = [
  make({ title: 'The Myth of Sisyphus', category: 'books', creators: ['Albert Camus'], genres: ['Philosophy'], tags: ['existentialism', 'absurdism'], rating: 0.82 }),
  make({ title: 'Solaris', category: 'screen', creators: ['Andrei Tarkovsky'], genres: ['Science Fiction', 'Drama'], description: 'A psychologist travels to a space station orbiting a mysterious planet; a meditation on memory, grief and what it means to be human.', rating: 0.78 }),
  make({ title: 'Fast Lane Party Mix', category: 'music', creators: ['DJ Turbo'], genres: ['EDM'], description: 'High energy dance party bangers', rating: 0.6 }),
  make({ title: 'Kitchen Nightmares Compilation', category: 'youtube', creators: ['FoodTV'], genres: ['Entertainment'], description: 'Funny chef meltdowns in restaurant kitchens' }),
  make({ title: 'Stoicism for Modern Life', category: 'podcasts', creators: ['Daily Stoic'], genres: ['Philosophy'], description: 'Ancient wisdom and ethics for everyday life' }),
  make({ title: 'Cosmos: A Personal Voyage', category: 'screen', kind: 'series', creators: ['Carl Sagan'], genres: ['Documentary'], description: 'The universe, the stars and our place in the cosmos.', rating: 0.9 }),
];

describe('learning from feedback changes ranking', () => {
  it('likes on philosophical items lift philosophical content across categories', () => {
    const intent = parseIntent('');
    const ctx = { exploration: 0.3, hasQuery: false, limit: 6 };
    const before = rankCandidates(catalog, intent, emptyProfile(), ctx).map((r) => r.item.title);

    let p = emptyProfile();
    // User likes a book and a film (philosophy / existential)
    p = applyFeedback(p, catalog[0], 'like');
    p = applyFeedback(p, catalog[1], 'like');
    p = applyFeedback(p, catalog[2], 'dislike');
    const evidence = [catalog[0], catalog[1]].map((c) => ({ id: c.id, title: c.title, category: c.category, kind: c.kind, concepts: c.concepts }));
    const after = rankCandidates(catalog.filter((c) => c !== catalog[0] && c !== catalog[1]), intent, p, { ...ctx, evidence });
    const titles = after.map((r) => r.item.title);
    // Podcast never interacted with, but shares concepts → cross-media transfer
    expect(titles.indexOf('Stoicism for Modern Life')).toBeLessThan(titles.indexOf('Fast Lane Party Mix'));
    expect(titles.indexOf('Kitchen Nightmares Compilation')).toBeGreaterThan(titles.indexOf('Stoicism for Modern Life'));
    expect(titles[titles.length - 1]).toBe('Fast Lane Party Mix');
    expect(before).not.toEqual(titles);
    const stoic = after.find((r) => r.item.title === 'Stoicism for Modern Life')!;
    expect(stoic.explanation.text).toMatch(/You liked (The Myth of Sisyphus|Solaris)/);
  });

  it('profile weights respond to each feedback type', () => {
    const item = catalog[1];
    const liked = applyFeedback(emptyProfile(), item, 'like');
    expect(liked.concepts.psychology).toBeGreaterThan(0);
    expect(liked.creators['andrei tarkovsky']).toBeGreaterThan(0);
    expect(liked.conceptsByCategory.screen?.psychology).toBeGreaterThan(0);
    const disliked = applyFeedback(emptyProfile(), item, 'dislike');
    expect(disliked.creators['andrei tarkovsky']).toBeLessThan(0);
    // dislike moves concepts less than creators
    expect(Math.abs(disliked.concepts.psychology)).toBeLessThan(Math.abs(disliked.creators['andrei tarkovsky']));
    const rated = applyFeedback(emptyProfile(), item, 'rate', { rating: 5 });
    expect(rated.concepts.psychology).toBeCloseTo(liked.concepts.psychology, 5);
    const neutral = applyFeedback(emptyProfile(), item, 'rate', { rating: 3 });
    expect(neutral.concepts).toEqual({});
  });

  it('long-term weights decay slowly, moods decay quickly', () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const p = applyFeedback(emptyProfile(), catalog[1], 'like', { now: t0 });
    const later = decayProfile(p, new Date('2026-01-02T00:00:00Z'));
    const k = 'psychology';
    expect(later.concepts[k] / p.concepts[k]).toBeGreaterThan(0.99);
    expect((later.shortTerm.concepts[k] ?? 0) / p.shortTerm.concepts[k]).toBeLessThan(0.2);
  });
});

describe('exploration slider', () => {
  const familiarJazz = make({ title: 'Kind of Blue', category: 'music', kind: 'album', creators: ['Miles Davis'], genres: ['jazz'], description: 'melancholic late-night modal jazz' });
  const familiarJazz2 = make({ title: 'Blue Train', category: 'music', kind: 'album', creators: ['John Coltrane'], genres: ['jazz'], description: 'hard bop' });
  const novelAmbient = make({ title: 'Music for Airports', category: 'music', kind: 'album', creators: ['Brian Eno'], genres: ['ambient'], description: 'melancholic, contemplative and calm soundscapes' });
  let p = emptyProfile();
  p = applyFeedback(p, make({ title: 'A Love Supreme', category: 'music', creators: ['John Coltrane'], genres: ['jazz'], description: 'spiritual, contemplative and melancholic' }), 'like');
  p = applyFeedback(p, make({ title: 'Round Midnight', category: 'music', creators: ['Miles Davis'], genres: ['jazz'], description: 'melancholic contemplative ballad' }), 'like');

  it('familiar favours known genres/creators; adventurous favours unfamiliar-but-connected', () => {
    const intent = parseIntent('');
    const fam = rankCandidates([familiarJazz, familiarJazz2, novelAmbient], intent, p, { exploration: 0, hasQuery: false, limit: 3 });
    const adv = rankCandidates([familiarJazz, familiarJazz2, novelAmbient], intent, p, { exploration: 1, hasQuery: false, limit: 3 });
    expect(fam[0].item.title).not.toBe('Music for Airports');
    expect(adv[0].item.title).toBe('Music for Airports');
    expect(adv[0].explanation.reasons.some((r) => r.kind === 'novelty')).toBe(true);
  });
});

describe('diversity and trajectory', () => {
  it('caps repeated creators via MMR', () => {
    const same = [1, 2, 3, 4].map((i) => make({ title: `Track ${i}`, category: 'music', creators: ['Same Artist'], genres: ['pop'] }));
    const other = make({ title: 'Other', category: 'music', creators: ['Other Artist'], genres: ['folk'] });
    const ranked = [...same, other].map((item, i) => ({ item, score: { total: 1 - i * 0.01 } as never }));
    const out = diversify(ranked, 4, 0.5, false);
    expect(out.filter((o) => o.item.creators[0] === 'Same Artist').length).toBeLessThanOrEqual(2);
    expect(out.map((o) => o.item.title)).toContain('Other');
  });

  it('orders a sequence from the start mood to the end mood', () => {
    const sad = make({ title: 'Sad', category: 'music', description: 'sad melancholic sorrow' });
    const mid = make({ title: 'Mid', category: 'music', description: 'bittersweet but hopeful' });
    const up = make({ title: 'Up', category: 'music', description: 'uplifting hopeful sunrise triumph' });
    const seq = sequenceTrajectory([{ item: up }, { item: sad }, { item: mid }], 'melancholic', 'uplifting');
    expect(seq.map((s) => s.item.title)).toEqual(['Sad', 'Mid', 'Up']);
  });
});

describe('query relevance and grounding', () => {
  it('ranks query matches first and explains with concepts actually in the item', () => {
    const intent = parseIntent('serious documentaries about ancient civilization');
    const doc = make({ title: 'Origins of Civilization', category: 'youtube', genres: ['Education'], description: 'A documentary on Mesopotamia, Sumer and the ancient world.' });
    const recs = rankCandidates([catalog[2], catalog[3], doc], intent, emptyProfile(), { exploration: 0.4, hasQuery: true, limit: 3 });
    expect(recs[0].item.title).toBe('Origins of Civilization');
    for (const c of recs[0].explanation.matchedConcepts) expect(recs[0].item.concepts[c]).toBeGreaterThanOrEqual(0.25);
    expect(recs[0].explanation.text).toMatch(/ancient worlds|documentary/i);
  });

  it('penalises excluded and blocked concepts', () => {
    const horror = make({ title: 'The Haunting', category: 'screen', genres: ['Horror', 'Mystery'], description: 'a haunted house ghost story' });
    const mystery = make({ title: 'Knives Out', category: 'screen', genres: ['Mystery', 'Comedy'], description: 'a detective murder mystery' });
    const recs = rankCandidates([horror, mystery], parseIntent('a mystery film but no horror'), emptyProfile(), { exploration: 0.4, hasQuery: true, limit: 2 });
    expect(recs[0].item.title).toBe('Knives Out');
    const blocked = applyEdit(emptyProfile(), { blockConcept: 'humor' });
    const recs2 = rankCandidates([horror, mystery], parseIntent('a mystery film'), blocked, { exploration: 0.4, hasQuery: true, limit: 2 });
    expect(recs2[0].item.title).toBe('The Haunting');
  });

  it('excludes already-consumed items and references themselves', () => {
    const recs = rankCandidates(catalog, parseIntent(''), emptyProfile(), { exploration: 0.4, hasQuery: false, excludeIds: new Set([catalog[0].id]), referenceIds: new Set([catalog[1].id]) });
    expect(recs.map((r) => r.item.id)).not.toContain(catalog[0].id);
    expect(recs.map((r) => r.item.id)).not.toContain(catalog[1].id);
  });
});

describe('profile seeding, statements and insights', () => {
  it('seeds from onboarding and builds cross-media insights', () => {
    let p = seedProfile(emptyProfile(), { categories: ['books', 'music'], interests: ['philosophy', 'cosmic'], description: 'I love slow, melancholic films about memory', exploration: 0.6 });
    expect(p.concepts.philosophy).toBeGreaterThan(1);
    expect(p.concepts.melancholic).toBeGreaterThan(0);
    expect(p.exploration).toBe(0.6);
    p = applyFeedback(p, catalog[1], 'like');
    p = applyFeedback(p, analyzeItem({ ...catalog[0], category: 'books', description: 'memory and grief, psychology of the mind' }), 'like');
    const ins = buildInsights(p);
    expect(ins.clusters.length).toBeGreaterThan(0);
    expect(ins.connections.some((c) => c.categories.length >= 2)).toBe(true);
    const s = applyStatement(p, 'Tarkovsky', [], 1);
    expect(s.creators.tarkovsky).toBeGreaterThan(0);
    expect(s.explicit.likes).toContain('Tarkovsky');
  });
});

describe('grounding of inherited evidence', () => {
  it('never claims a quality that only came from the search query', () => {
    const thin = make({ title: 'Just a Track', category: 'music', creators: ['Someone'], metadata: { retrievedFor: ['civilization'], retrievedBy: 'world music' } });
    expect(thin.concepts.civilization).toBe(0.35);
    let p = emptyProfile();
    p = applyFeedback(p, make({ title: 'Ancient Rome', category: 'books', tags: ['ancient civilization', 'rome', 'history'] }), 'like');
    const [rec] = rankCandidates([thin], parseIntent(''), p, { exploration: 0.4, hasQuery: false });
    expect(rec.explanation.matchedConcepts).not.toContain('civilization');
    expect(rec.explanation.text).not.toMatch(/ancient/i);
    expect(rec.explanation.text).toMatch(/Found by searching|Retrieved/);
  });
});

describe('free-text exclusions and explicit dislikes', () => {
  const speech = make({ title: 'BELIEVE IN YOURSELF - Powerful Motivational Speech', category: 'youtube', creators: ['Motiversity'], description: 'motivational speech compilation' });
  const doc = make({ title: 'The Birth of Civilization', category: 'youtube', creators: ['History Channel'], description: 'a documentary about the first cities' });
  it('penalises items matching a "no X" request', () => {
    const recs = rankCandidates([speech, doc], parseIntent('no motivational speeches for the videos'), emptyProfile(), { exploration: 0.4, hasQuery: true, limit: 2 });
    expect(recs[0].item.title).toBe('The Birth of Civilization');
    expect(recs[1].score.penalty).toBeGreaterThan(0.5);
  });
  it('penalises items matching an explicit dislike statement', () => {
    const p = applyStatement(emptyProfile(), 'motivational speeches', [], -1);
    const recs = rankCandidates([speech, doc], parseIntent(''), p, { exploration: 0.4, hasQuery: false, limit: 2 });
    expect(recs[0].item.title).toBe('The Birth of Civilization');
  });
});
