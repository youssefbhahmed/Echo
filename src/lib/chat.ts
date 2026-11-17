import type { Recommendation, ScoreBreakdown } from '@shared/types.ts';
import { restoreChatRec, type ChatPayloadRec } from '@shared/engine/chat.ts';

const NO_SCORE: ScoreBreakdown = { query: 0, deep: 0, surface: 0, novelty: 0, context: 0, quality: 0, collaborative: 0, semantic: 0, penalty: 0, total: 0 };

/** A stored answer's picks back on their catalog items, with this answer's own lanes (the message payload's meta). */
export function restoreRecs(payload: ChatPayloadRec[] | undefined, byId: Map<string, Recommendation['item']>): Recommendation[] {
  return (payload ?? [])
    .filter((r) => byId.has(r.itemId))
    .map((r) => ({ item: restoreChatRec(byId.get(r.itemId)!, r), explanation: r.explanation, score: r.score ?? NO_SCORE, trajectoryStep: r.trajectoryStep }));
}

/** Ids in groups small enough for one `in` filter in a GET URL (well under the gateway's URL limit). */
export function idChunks(ids: string[], size = 100): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
