import { describe, expect, it } from 'vitest';
import { llmMusicPicks, shrinkBrief } from '@shared/engine/ai.ts';
import { regionalByIsrc } from '@shared/engine/lanes.ts';
import { createHttp, MemoryCache } from '@shared/providers/http.ts';

describe('regional recordings by ISRC', () => {
  const item = (isrc?: string) => ({ metadata: isrc ? { isrc } : {} });
  it('keeps French/Arabic-registered vocal songs out of non-regional lanes', () => {
    expect(regionalByIsrc(item('FRUM71900001'), { id: 'hiphop-rnb', regional: false })).toBe('french');
    expect(regionalByIsrc(item('MAA012300001'), { id: 'afro-latin', regional: false })).toBe('arabic');
    expect(regionalByIsrc(item('USUM71900001'), { id: 'hiphop-rnb', regional: false })).toBeNull();
    expect(regionalByIsrc(item(), { id: 'rock-metal', regional: false })).toBeNull();
  });
  it('allows them in their own regional lane and in electronic lanes (French house producers sing in English)', () => {
    expect(regionalByIsrc(item('FRUM71900001'), { id: 'french', regional: true })).toBeNull();
    expect(regionalByIsrc(item('FRUM71900001'), { id: 'edm', regional: false })).toBeNull();
    expect(regionalByIsrc(item('FRUM71900001'), { id: 'melodic-house', regional: false })).toBeNull();
  });
});

describe('curator refusal', () => {
  const brief = { lanes: [{ id: 'edm', label: 'EDM', descriptors: ['edm'], fromYear: 2010, regional: false, count: 24 }, { id: 'rock-metal', label: 'Rock', descriptors: ['rock'], fromYear: 2000, regional: false, count: 24 }] };
  it('shrinks every lane but keeps at least 6 songs', () => {
    expect(shrinkBrief(brief, 0.5).lanes!.map((l) => l.count)).toEqual([12, 12]);
    expect(shrinkBrief({ lanes: [{ ...brief.lanes[0], count: 9 }] }, 0.5).lanes![0].count).toBe(6);
  });
  it('asks again for fewer songs when the model refuses, and never serves the cached refusal again', async () => {
    const asked: number[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const n = [...String(body.messages[1].content).matchAll(/; (\d+) songs/g)].reduce((s, m) => s + Number(m[1]), 0);
      asked.push(n);
      const content = n > 30 ? "I'm sorry, but I can't fulfill that request." : JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ artist: `Artist ${i}`, track: `Song ${i}`, lane: i % 2 ? 'edm' : 'rock-metal' })) });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }) as unknown as typeof fetch;
    const http = createHttp(new MemoryCache(), fetchImpl);
    const cfg = { baseUrl: 'https://ai.test/v1', model: 'm' };
    const picks = await llmMusicPicks(brief, cfg, http, { seed: 3 });
    expect(asked).toEqual([48, 24]);
    expect(picks).toHaveLength(24);
    // Same request again: the refusal is cached, the retry answer too -> no new calls, same picks.
    const again = await llmMusicPicks(brief, cfg, http, { seed: 3 });
    expect(asked).toEqual([48, 24]);
    expect(again).toHaveLength(24);
  });
});

describe('request interpreter model handover', () => {
  it('reads the request with the music model when the general model is over its per-minute limit', async () => {
    const { llmUnderstand } = await import('@shared/engine/understand.ts');
    const models: string[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      models.push(body.model);
      if (body.model === 'general') return new Response('{"error":{"message":"Request too large for model"}}', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ categories: ['music'], entities: [{ name: 'Eminem', kind: 'artist', want: 'all' }] }) } }] }));
    }) as unknown as typeof fetch;
    const u = await llmUnderstand('eminem', null, { baseUrl: 'https://ai.test/v1', model: 'general', musicModel: 'music' }, createHttp(new MemoryCache(), fetchImpl));
    expect(models).toEqual(['general', 'music']);
    expect(u.entities?.[0]).toMatchObject({ name: 'Eminem', kind: 'artist' });
  });
});

describe('curator memory (its own recent suggestions are not repeated)', () => {
  it('keeps the last 3 days, newest first, deduped, and leaves out entries from this feed (re-fetch = same brief)', async () => {
    const { curatorMemoryFor, rememberSuggestions, CURATOR_MEMORY_MS } = await import('@shared/engine/curator.ts');
    const t0 = 1_800_000_000_000;
    let mem = rememberSuggestions([], ['A – One', 'B – Two'], t0);
    mem = rememberSuggestions(mem, ['C – Three', 'a – one'], t0 + 1000);
    expect(curatorMemoryFor(mem, t0 + 2000)).toEqual(['C – Three', 'A – One', 'B – Two']);
    // A feed first served at t0+1000 is re-fetched: its own suggestions (at == asOf) are not in its brief.
    expect(curatorMemoryFor(mem, t0 + 1000)).toEqual(['A – One', 'B – Two']);
    // Older than 3 days: forgotten (and pruned on the next write).
    expect(curatorMemoryFor(mem, t0 + CURATOR_MEMORY_MS + 5000)).toEqual([]);
    expect(rememberSuggestions(mem, ['D – Four'], t0 + CURATOR_MEMORY_MS + 5000).map((e) => e.s)).toEqual(['D – Four']);
  });

  it('a taste-lane brief tells the curator what it already suggested; the songs are its own words', async () => {
    const { curatorPrompt } = await import('@shared/engine/ai.ts');
    const brief = { lanes: [{ id: 'edm', label: 'EDM', descriptors: ['edm'], fromYear: 2010, regional: false, count: 12 }], avoidSongs: ['Artist 1 – Song 1', 'Artist 2 – Song 2'] };
    const { user } = curatorPrompt(brief);
    expect(user).toMatch(/Already suggested recently \(never repeat these songs; other songs by the same artists are fine\): Artist 1 – Song 1; Artist 2 – Song 2/);
    expect(curatorPrompt({ lanes: brief.lanes }).user).not.toMatch(/Already suggested/);
  });

  it('curateMusic sends the memory for taste lanes and reports what it suggested; typed requests ignore it', async () => {
    const { curateMusic, planMusic } = await import('@shared/engine/curator.ts');
    const { emptyProfile } = await import('@shared/engine/profile.ts');
    const prompts: string[] = [];
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('/chat/completions')) {
        const body = JSON.parse(String(init?.body));
        prompts.push(body.messages[1].content);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{ artist: 'New Artist', track: 'New Song', lane: 'mix' }] }) } }] }));
      }
      return new Response('[]');
    }) as unknown as typeof fetch;
    const deps = { ai: { baseUrl: 'https://ai.test/v1', model: 'm' }, http: createHttp(new MemoryCache(), fetchImpl), env: () => undefined, profile: emptyProfile(), recentSongs: ['Old Artist – Old Song'], searchBlocked: true, lookupBlocked: true, seed: 1 };
    const lanes = planMusic(emptyProfile(), { hasQuery: false, seed: 1, total: 6 })!;
    const r = await curateMusic(lanes, deps);
    expect(prompts[0]).toMatch(/Old Artist – Old Song/);
    expect(r.suggested).toEqual(['New Artist – New Song']);
    const req = planMusic(emptyProfile(), { hasQuery: true, seed: 1, total: 6, text: 'rainy day songs' })!;
    const r2 = await curateMusic(req, { ...deps, http: createHttp(new MemoryCache(), fetchImpl) });
    expect(prompts[prompts.length - 1]).not.toMatch(/Old Artist/);
    expect(r2.suggested).toBeUndefined();
  });
});
