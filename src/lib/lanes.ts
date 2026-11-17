// Music "lanes": the curator groups songs into listening lanes (item.metadata.lane = { id, label }).
// Each lane becomes its own shelf, in the order the feed first mentions it.

export interface Lane {
  id: string;
  label: string;
}

export interface LaneGroup<T> {
  /** Lane id, or '' for songs without a lane. */
  key: string;
  lane: Lane | null;
  items: T[];
}

/** The item's lane, when the engine set a well-formed one. */
export function laneOf(item: { metadata?: Record<string, unknown> | null }): Lane | null {
  const l = item.metadata?.lane;
  if (!l || typeof l !== 'object') return null;
  const { id, label } = l as { id?: unknown; label?: unknown };
  if (typeof id !== 'string' || typeof label !== 'string' || !id.trim() || !label.trim()) return null;
  return { id: id.trim(), label: label.trim() };
}

/** Group by lane, keeping listening order inside each lane and ordering lanes by first appearance. */
export function groupByLane<T>(list: T[], itemOf: (x: T) => { metadata?: Record<string, unknown> | null }): LaneGroup<T>[] {
  const groups = new Map<string, LaneGroup<T>>();
  for (const x of list) {
    const lane = laneOf(itemOf(x));
    const key = lane?.id ?? '';
    const g = groups.get(key);
    if (g) g.items.push(x);
    else groups.set(key, { key, lane, items: [x] });
  }
  return [...groups.values()];
}

/** "1 song", "12 songs". */
export function songsLabel(n: number): string {
  return `${n} ${n === 1 ? 'song' : 'songs'}`;
}

type LaneItemLike = { category?: string; kind?: string; embed?: { type: string } | null; metadata?: Record<string, unknown> | null };

/**
 * A YouTube live session / music video inside a music lane (category 'music', kind 'video', YouTube embed:
 * see the contract in supabase/functions/_shared/engine/lanes.ts). It sits in its lane's shelf but plays in its
 * own YouTube player, never in the lane's song queue.
 */
export function isLaneVideo(item: LaneItemLike): boolean {
  return item.category === 'music' && item.kind === 'video' && item.embed?.type === 'youtube';
}

/** The tile badge of a lane video: "Live" for a session, "Video" for a music video; null for songs. */
export function videoBadge(item: LaneItemLike): 'Live' | 'Video' | null {
  if (!isLaneVideo(item)) return null;
  return item.metadata?.videoKind === 'video' ? 'Video' : 'Live';
}

/** "Live at Tiny Desk", "Live on COLORS", "Music video" — where a lane video was filmed. */
export function sessionLine(item: LaneItemLike): string {
  const s = item.metadata?.session as { venue?: unknown; prep?: unknown } | undefined;
  const live = item.metadata?.videoKind !== 'video';
  if (!s || typeof s.venue !== 'string') return live ? 'Live session' : 'Music video';
  const prep = s.prep === 'on' || s.prep === 'for' ? s.prep : 'at';
  return `${live ? 'Live' : 'Music video'} ${prep} ${s.venue}`;
}

/** A lane's count: "8 songs", or "6 songs · 2 live sessions" / "5 songs · 1 video" when it mixes in videos. */
export function laneCountLabel(items: LaneItemLike[]): string {
  const videos = items.filter(isLaneVideo);
  if (!videos.length) return songsLabel(items.length);
  const live = videos.every((v) => videoBadge(v) === 'Live');
  const n = videos.length;
  const v = live ? `${n} live ${n === 1 ? 'session' : 'sessions'}` : `${n} ${n === 1 ? 'video' : 'videos'}`;
  const songs = items.length - n;
  return songs ? `${songsLabel(songs)} · ${v}` : v;
}

/** A DOM-id-safe slug for a lane id. */
export function laneDomId(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'for-you';
}

/** The named artist's own lane in an Echo AI answer ("Eminem"), where library songs may appear. */
export const ENTITY_BY_LANE = 'entity-by';

/** A song in that lane the user already has: tiles and cards say "In your library". */
export function ownedInEntityLane(item: { metadata?: Record<string, unknown> | null }): boolean {
  return item.metadata?.inLibrary === true && laneOf(item)?.id === ENTITY_BY_LANE;
}

/**
 * A song shown again on a short Music page (the stored fallback's tier 3: last shown 24 h–3 days ago):
 * tiles say so, so a repeat never passes for a new pick.
 */
export function shownAgain(item: { metadata?: Record<string, unknown> | null }): boolean {
  return item.metadata?.fallbackTier === 3;
}

/**
 * An Echo AI answer: music grouped by lane (listening order kept, lanes in order of appearance), then
 * everything else in its ranked order.
 */
export function splitAnswer<T>(list: T[], itemOf: (x: T) => { category: string; metadata?: Record<string, unknown> | null }): { lanes: LaneGroup<T>[]; others: T[] } {
  const music = list.filter((x) => itemOf(x).category === 'music');
  return { lanes: groupByLane(music, itemOf), others: list.filter((x) => itemOf(x).category !== 'music') };
}
