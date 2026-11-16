// POST /functions/v1/discover — personalised feed (filters, moods, exploration) or a one-shot query.
import { runPipeline } from '../_shared/engine/pipeline.ts';
import { reshowableIds } from '../_shared/engine/curator.ts';
import { feedFilterKey, freshFeedSeed, reusableSession } from '../_shared/engine/session.ts';
import { createHttp } from '../_shared/providers/http.ts';
import { DiscoverBody } from '../_shared/schemas.ts';
import {
  catalogFallbackFn, collaborativeFn, DbCache, embedder, env, evidenceItems, excludedIds, json, librarySongs, loadFeedSession, loadProfile, markPipelineQuota, providerBlocks, rateLimit, readJson,
  recentMusic, requireUser, saveFeedSession, serve, serviceClient, storedEmbeddings, upsertItems,
} from '../_shared/server.ts';

serve(async (req) => {
  const { userId, db } = await requireUser(req);
  await rateLimit(userId, 'discover', 30, 60);
  const body = DiscoverBody.parse(await readJson(req));
  const now = Date.now();
  const clientSeed = body.seed ?? 0;
  // A re-fetch of the feed on screen (focus/remount on the phone, same client seed) gets that same feed:
  // same effective seed, and "recently shown" measured as of when it was first served (engine/session.ts).
  const filterKey = feedFilterKey(body);
  const session = reusableSession(await loadFeedSession(userId, filterKey), clientSeed, now);
  const asOf = session?.createdAt ?? now;
  const [profile, exclude, evidence, blocks, recent, library] = await Promise.all([
    loadProfile(db, userId), excludedIds(db, userId), evidenceItems(db, userId), providerBlocks(), recentMusic(userId, { asOf }), librarySongs(db, userId),
  ]);
  for (const id of body.exclude ?? []) exclude.add(id);
  for (const id of recent.skipped) exclude.add(id);
  // A music-only page that is still short after the curator and the stored songs may show songs from
  // 24 h–3 days ago again (never the page being replaced, recent skips, the library or dislikes).
  const musicOnly = body.categories?.length === 1 && body.categories[0] === 'music';
  const reshowable = musicOnly ? reshowableIds(recent.lastShown, asOf, exclude) : undefined;
  // Music only: songs shown in the 3 days before this feed (and recent skips) don't come back on a refresh.
  for (const id of recent.shown) exclude.add(id);
  const seed = session?.seed ?? freshFeedSeed(clientSeed, recent.shown.size);
  const http = createHttp(new DbCache());
  const result = await runPipeline(
    { query: body.query, categories: body.categories, moods: body.moods, exploration: body.exploration, limit: body.limit ?? 12, intentHint: body.intentHint, mix: body.mix },
    {
      env, http, profile, excludeIds: exclude, reshowable, library, evidence, blockedProviders: blocks.providers, spotifyLookupBlocked: blocks.spotifyLookup, collaborative: collaborativeFn(db), embed: embedder(),
      // The feed's own clock (when it was first served) keeps lane fill and explanations identical on a re-fetch.
      storedEmbeddings, catalogFallback: catalogFallbackFn(userId, { asOf }), seed, now: new Date(asOf),
    },
  );
  await markPipelineQuota(result);
  const recs = result.recommendations;
  await upsertItems(recs.map((r) => r.item));
  if (recs.length) {
    await serviceClient().from('recommendation_events').insert(
      recs.map((r, i) => ({ user_id: userId, item_id: r.item.id, source: 'feed', position: i, score: r.score, explanation: r.explanation.text.slice(0, 500) })),
    );
    await saveFeedSession(userId, filterKey, { clientSeed, seed, createdAt: asOf, lastAt: now });
  }
  const { candidates: _c, quotaErrors: _q, quotaRetryAfter: _r, spotifyLookupLimitedSec: _l, ...response } = result;
  return json(req, { ...response, recommendations: recs.map((r) => ({ ...r, item: { ...r.item, embedding: undefined } })) });
});
