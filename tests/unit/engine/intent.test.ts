import { parseIntent, refineIntent } from '@shared/engine/intent.ts';

describe('parseIntent', () => {
  it('handles a cross-genre reference with a relaxed genre', () => {
    const i = parseIntent("I want something that gives me the same existential feeling as Interstellar, but it doesn't have to be science fiction.");
    expect(i.references).toEqual(['Interstellar']);
    expect(i.intent).toBe('similar');
    expect(i.target.existential).toBeGreaterThan(0.4);
    expect(i.relaxed).toContain('sci-fi');
    expect(i.target['sci-fi']).toBeUndefined();
  });

  it('extracts an emotional trajectory for music', () => {
    const i = parseIntent("I'm feeling nostalgic. Recommend music that starts melancholic and gradually becomes uplifting.");
    expect(i.categories).toEqual(['music']);
    expect(i.trajectory).toEqual({ from: 'melancholic', to: 'uplifting' });
    expect(i.moods).toContain('nostalgic');
    expect(i.intent).toBe('mood');
  });

  it('understands a learning request for serious documentaries', () => {
    const i = parseIntent('I want to understand the origins of civilization through serious documentaries.');
    expect(i.categories).toEqual(expect.arrayContaining(['screen', 'youtube']));
    expect(i.complexity).toBe('deep');
    expect(i.themes).toContain('civilization');
    expect(i.target.documentary).toBeGreaterThan(0);
    expect(i.intent).toBe('learn');
    expect(i.keywords).toEqual(expect.arrayContaining(['origins', 'civilization']));
  });

  it('detects exploration requests', () => {
    const i = parseIntent('Recommend something completely outside my usual preferences, but that you think I would love.');
    expect(i.exploration).toBeGreaterThanOrEqual(0.8);
    expect(i.intent).toBe('explore');
    expect(i.vague).toBe(false);
  });

  it('maps a metaphorical request to a trajectory without treating it as a title', () => {
    const i = parseIntent('Find music that feels like watching the sunrise after a difficult night.');
    expect(i.references).toEqual([]);
    expect(i.categories).toEqual(['music']);
    expect(i.trajectory).toEqual({ from: 'melancholic', to: 'uplifting' });
  });

  it('separates preference statements from "I\'d like"', () => {
    const a = parseIntent("I'd like something calm tonight");
    expect(a.statements).toEqual([]);
    expect(a.references).toEqual([]);
    expect(a.energy).toBe('low');
    const b = parseIntent('I love Tarkovsky and I hate horror');
    expect(b.statements.map((s) => [s.polarity, s.subject])).toEqual([[1, 'Tarkovsky'], [-1, 'horror']]);
    expect(b.statements[1].concepts).toContain('horror');
  });

  it('handles exclusions', () => {
    const i = parseIntent('a mystery film but no horror please');
    expect(i.excludes).toContain('horror');
    expect(i.target.horror).toBeLessThan(0);
    expect(i.target.mystery).toBeGreaterThan(0);
  });

  it('flags vague requests', () => {
    expect(parseIntent('hmm').vague).toBe(true);
    expect(parseIntent('melancholic jazz').vague).toBe(false);
  });

  it('parses ordinals, language and duration', () => {
    const i = parseIntent('more like the second one, in french, under 15 minutes');
    expect(i.ordinalRefs).toEqual([1]);
    expect(i.language).toBe('fr');
    expect(i.duration).toBe('short');
  });
});

describe('refineIntent', () => {
  const base = parseIntent('dark atmospheric sci-fi films');
  it('applies "less X" and "only books"', () => {
    const r = refineIntent(base, parseIntent('less dark, only books'));
    expect(r.target.dark).toBeLessThan(0);
    expect(r.categories).toEqual(['books']);
    expect(r.target['sci-fi']).toBeGreaterThan(0);
  });
  it('treats a full new request as fresh', () => {
    const r = refineIntent(base, parseIntent('Recommend upbeat jazz albums for cooking dinner with friends'));
    expect(r.categories).toEqual(['music']);
    expect(r.target.dark).toBeUndefined();
  });
  it('raises exploration on "more adventurous"', () => {
    const r = refineIntent({ ...base, exploration: 0.4 }, parseIntent('more adventurous'));
    expect(r.exploration).toBeCloseTo(0.7);
  });
});

describe('genre phrases', () => {
  it('"science fiction" relaxes sci-fi only, not science', () => {
    const i = parseIntent("like Interstellar but it doesn't have to be science fiction");
    expect(i.relaxed).toContain('sci-fi');
    expect(i.relaxed).not.toContain('science');
  });
});
