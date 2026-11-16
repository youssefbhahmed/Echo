// POST /functions/v1/discover — personalised feed (filters, moods, exploration) or a one-shot query.
import { runPipeline } from '../_shared/engine/pipeline.ts';
import { createHttp } from '../_shared/providers/http.ts';
import { DiscoverBody } from '../_shared/schemas.ts';
import {
  blockedProviders, catalogFallbackFn, collaborativeFn, DbCache, embedder, env, evidenceItems, excludedIds, json, loadProfile, markQuota, rateLimit, readJson, recentMusicIds, requireUser, serve, serviceClient, storedEmbeddings, upsertItems,
} from '../_shared/server.ts';

serve(async (req) => {
  const { userId, db } = await requireUser(req);
  await rateLimit(userId, 'discover', 30, 60);
  const body = DiscoverBody.parse(await readJson(req));
  const [profile, exclude, evidence, blocked, recentMusic] = await Promise.all([loadProfile(db, userId), excludedIds(db, userId), evidenceItems(db, userId), blockedProviders(), recentMusicIds(userId, 3)]);
  for (const id of body.exclude ?? []) exclude.add(id);
  // Music only: songs recommended in the last 3 days (and recent skips) don't come back on a refresh.
  for (const id of recentMusic) exclude.add(id);
  // The app restarts its refresh counter at 0; mixing in how much music was served lately keeps
  // every served feed on a fresh lane rotation and curator brief (same seed + same history = same feed).
  const seed = (body.seed ?? 0) + recentMusic.size * 7919;
  const http = createHttp(new DbCache());
  const result = await runPipeline(
    { query: body.query, categories: body.categories, moods: body.moods, exploration: body.exploration, limit: body.limit ?? 12, intentHint: body.intentHint, mix: body.mix },
    { env, http, profile, excludeIds: exclude, evidence, blockedProviders: blocked, collaborative: collaborativeFn(db), embed: embedder(), storedEmbeddings, catalogFallback: catalogFallbackFn(userId), seed },
  );
  await markQuota(result.quotaErrors, result.quotaRetryAfter);
  const recs = result.recommendations;
  await upsertItems(recs.map((r) => r.item));
  if (recs.length) {
    await serviceClient().from('recommendation_events').insert(
      recs.map((r, i) => ({ user_id: userId, item_id: r.item.id, source: 'feed', position: i, score: r.score, explanation: r.explanation.text.slice(0, 500) })),
    );
  }
  const { candidates: _c, quotaErrors: _q, quotaRetryAfter: _r, ...response } = result;
  return json(req, { ...response, recommendations: recs.map((r) => ({ ...r, item: { ...r.item, embedding: undefined } })) });
});
