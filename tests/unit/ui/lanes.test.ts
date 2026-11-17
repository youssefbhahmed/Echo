import { describe, expect, it } from 'vitest';
import { groupByLane, laneDomId, laneOf, songsLabel, isLaneVideo, videoBadge, sessionLine, laneCountLabel } from '../../../src/lib/lanes';

// Synthetic fixtures only (no real library data).
const rec = (id: string, lane?: unknown) => ({ item: { id, metadata: lane === undefined ? {} : { lane, aiPick: true } } });

describe('laneOf', () => {
  it('reads a well-formed lane', () => {
    expect(laneOf({ metadata: { lane: { id: 'afro-house', label: 'Afro & melodic house' } } })).toEqual({ id: 'afro-house', label: 'Afro & melodic house' });
  });

  it('ignores missing or malformed lanes', () => {
    expect(laneOf({})).toBeNull();
    expect(laneOf({ metadata: null })).toBeNull();
    expect(laneOf({ metadata: { lane: 'hip-hop' } })).toBeNull();
    expect(laneOf({ metadata: { lane: { id: 'x' } } })).toBeNull();
    expect(laneOf({ metadata: { lane: { id: '  ', label: 'Rock' } } })).toBeNull();
    expect(laneOf({ metadata: { lane: { id: 'rock', label: 7 } } })).toBeNull();
  });
});

describe('groupByLane', () => {
  it('keeps listening order within a lane and orders lanes by first appearance', () => {
    const list = [
      rec('a1', { id: 'a', label: 'Lane A' }),
      rec('a2', { id: 'a', label: 'Lane A' }),
      rec('b1', { id: 'b', label: 'Lane B' }),
      rec('b2', { id: 'b', label: 'Lane B' }),
      rec('c1', { id: 'c', label: 'Lane C' }),
    ];
    const groups = groupByLane(list, (r) => r.item);
    expect(groups.map((g) => g.lane?.label)).toEqual(['Lane A', 'Lane B', 'Lane C']);
    expect(groups.map((g) => g.items.map((r) => r.item.id))).toEqual([['a1', 'a2'], ['b1', 'b2'], ['c1']]);
  });

  it('collects songs without a lane into one group, placed where the first one appears', () => {
    const list = [rec('a1', { id: 'a', label: 'Lane A' }), rec('x1'), rec('a2', { id: 'a', label: 'Lane A' }), rec('x2', { bad: true }), rec('b1', { id: 'b', label: 'Lane B' })];
    const groups = groupByLane(list, (r) => r.item);
    expect(groups.map((g) => g.key)).toEqual(['a', '', 'b']);
    expect(groups[1].lane).toBeNull();
    expect(groups[1].items.map((r) => r.item.id)).toEqual(['x1', 'x2']);
    expect(groups[0].items.map((r) => r.item.id)).toEqual(['a1', 'a2']);
  });

  it('returns a single unlaned group when nothing has a lane (the classic "Music for you" shelf)', () => {
    const groups = groupByLane([rec('x1'), rec('x2')], (r) => r.item);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: '', lane: null });
  });

  it('handles an empty list', () => {
    expect(groupByLane([], (r: { item: { metadata?: Record<string, unknown> } }) => r.item)).toEqual([]);
  });
});

describe('labels', () => {
  it('pluralises song counts', () => {
    expect(songsLabel(1)).toBe('1 song');
    expect(songsLabel(6)).toBe('6 songs');
  });

  it('makes DOM-safe ids', () => {
    expect(laneDomId('Hip-hop & R&B')).toBe('hip-hop-r-b');
    expect(laneDomId('')).toBe('for-you');
  });
});

describe('videos inside music lanes', () => {
  const v = (kind: 'live' | 'video' = 'live') => ({
    category: 'music', kind: 'video', embed: { type: 'youtube' }, metadata: { lane: { id: 'hiphop-rnb', label: 'Hip-hop & R&B' }, videoKind: kind, session: { venue: 'COLORS', prep: 'on' } },
  });
  const s = { category: 'music', kind: 'track', embed: { type: 'spotify' }, metadata: { lane: { id: 'hiphop-rnb', label: 'Hip-hop & R&B' } } };

  it('badges, session lines and lane counts', () => {
    expect(isLaneVideo(v())).toBe(true);
    expect(isLaneVideo(s)).toBe(false);
    expect(isLaneVideo({ ...v(), category: 'youtube' })).toBe(false);
    expect(videoBadge(v())).toBe('Live');
    expect(videoBadge(v('video'))).toBe('Video');
    expect(videoBadge(s)).toBeNull();
    expect(sessionLine(v())).toBe('Live on COLORS');
    expect(sessionLine({ ...v(), metadata: { videoKind: 'live' } })).toBe('Live session');
    expect(laneCountLabel([s, s, v(), s])).toBe('3 songs · 1 live session');
    expect(laneCountLabel([s, v('video'), v('live')])).toBe('1 song · 2 videos');
    expect(laneCountLabel([s, s])).toBe('2 songs');
    expect(laneCountLabel([v(), v()])).toBe('2 live sessions');
  });

  it('a lane groups its songs and videos together, in listening order', () => {
    const groups = groupByLane([s, v(), s], (x) => x);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((x) => x.kind)).toEqual(['track', 'video', 'track']);
  });
});
