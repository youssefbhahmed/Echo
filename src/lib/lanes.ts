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

/** A DOM-id-safe slug for a lane id. */
export function laneDomId(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'for-you';
}
