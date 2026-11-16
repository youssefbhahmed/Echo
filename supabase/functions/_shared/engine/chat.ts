// Chat (Echo AI) request limits and the stored message payload. Pure: shared by the chat function, the
// frontend (restoring a conversation) and tests.
import type { AnalyzedItem, DiscoverRequest, EntityTag, Explanation, LaneTag, Recommendation, ScoreBreakdown } from '../types.ts';
import { entityTagOf, laneTagOf } from './lanes.ts';

/** Picks per chat answer; a request naming an entity ("eminem") gets room for its lanes and the things around it. */
export const CHAT_LIMIT = 12;
export const CHAT_ENTITY_LIMIT = 20;

/** The pipeline request for one chat message. */
export function chatRequest(body: { message: string; categories?: DiscoverRequest['categories']; exploration?: number; intentHint?: DiscoverRequest['intentHint'] }): DiscoverRequest {
  return { query: body.message, categories: body.categories, exploration: body.exploration, limit: CHAT_LIMIT, entityLimit: CHAT_ENTITY_LIMIT, intentHint: body.intentHint };
}

/**
 * Per-answer fields of an item that the shared catalog row doesn't keep (its lane in this answer, "in
 * your library", what it says about the named entity): stored with the message so a restored
 * conversation shows the same lanes.
 */
export interface ChatItemMeta {
  lane?: LaneTag;
  inLibrary?: boolean;
  entity?: EntityTag;
}

export interface ChatPayloadRec {
  itemId: string;
  explanation: Explanation;
  score: ScoreBreakdown;
  trajectoryStep?: number;
  meta?: ChatItemMeta;
}

export function chatItemMeta(item: Pick<AnalyzedItem, 'metadata'>): ChatItemMeta | undefined {
  const lane = laneTagOf(item);
  const entity = entityTagOf(item);
  const inLibrary = item.metadata?.inLibrary === true ? true : undefined;
  const meta: ChatItemMeta = { ...(lane ? { lane } : {}), ...(inLibrary ? { inLibrary } : {}), ...(entity ? { entity } : {}) };
  return Object.keys(meta).length ? meta : undefined;
}

export function chatPayloadRecs(recs: Recommendation[]): ChatPayloadRec[] {
  return recs.map((r) => {
    const meta = chatItemMeta(r.item);
    return { itemId: r.item.id, explanation: r.explanation, score: r.score, trajectoryStep: r.trajectoryStep, ...(meta ? { meta } : {}) };
  });
}

/** A stored recommendation back on its catalog item, with the answer's own lane/library/entity fields. */
export function restoreChatRec<T extends { metadata?: Record<string, unknown> }>(item: T, rec: Pick<ChatPayloadRec, 'meta'>): T {
  const meta = rec.meta;
  // The catalog row's lane belongs to whichever answer stored it last: only this answer's lane counts.
  const { lane: _lane, inLibrary: _lib, entity: _entity, ...rest } = item.metadata ?? {};
  return { ...item, metadata: { ...rest, ...(meta?.lane ? { lane: meta.lane } : {}), ...(meta?.inLibrary ? { inLibrary: true } : {}), ...(meta?.entity ? { entity: meta.entity } : {}) } };
}
