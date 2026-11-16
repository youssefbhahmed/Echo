// POST /functions/v1/chat — conversational discovery with refinement and memory.
import { applyContext, applyStatement } from '../_shared/engine/profile.ts';
import { runPipeline } from '../_shared/engine/pipeline.ts';
import { CONCEPT_BY_ID } from '../_shared/engine/concepts.ts';
import { GENRE_WORDS } from '../_shared/engine/intent.ts';
import { createHttp } from '../_shared/providers/http.ts';
import { ChatBody } from '../_shared/schemas.ts';
import type { Intent } from '../_shared/types.ts';
import {
  catalogFallbackFn, collaborativeFn, DbCache, embedder, env, evidenceItems, excludedIds, getItems, HttpError, json, librarySongs, loadProfile, markPipelineQuota, providerBlocks, rateLimit, readJson, requireUser, saveProfile,
  serve, serviceClient, storedEmbeddings, upsertItems,
} from '../_shared/server.ts';

serve(async (req) => {
  const { userId, db } = await requireUser(req);
  await rateLimit(userId, 'chat', 20, 60);
  const body = ChatBody.parse(await readJson(req));

  // Session (RLS-scoped)
  let sessionId = body.sessionId;
  let previousIntent: Intent | null = null;
  let previousIds: string[] = [];
  if (sessionId) {
    const { data, error } = await db.from('chat_sessions').select('id, last_intent, last_result_ids').eq('id', sessionId).maybeSingle();
    if (error || !data) throw new HttpError(404, 'Conversation not found', 'not_found');
    previousIntent = (data.last_intent as Intent) ?? null;
    previousIds = (data.last_result_ids as string[]) ?? [];
  } else {
    const { data, error } = await db.from('chat_sessions').insert({ user_id: userId, title: body.message.slice(0, 80) }).select('id').single();
    if (error) throw new HttpError(500, error.message);
    sessionId = data.id as string;
  }
  await db.from('chat_messages').insert({ session_id: sessionId, user_id: userId, role: 'user', content: body.message });

  let [profile, exclude, evidence, blocks, previousResults, library] = await Promise.all([
    loadProfile(db, userId), excludedIds(db, userId), evidenceItems(db, userId), providerBlocks(), getItems(previousIds), librarySongs(db, userId),
  ]);
  // Do not repeat what was just shown in this conversation.
  for (const id of previousIds) exclude.add(id);

  const http = createHttp(new DbCache());
  const result = await runPipeline(
    { query: body.message, categories: body.categories, exploration: body.exploration, limit: 12, intentHint: body.intentHint },
    {
      env, http, profile, excludeIds: exclude, library, evidence, previousIntent, previousResults, blockedProviders: blocks.providers, spotifyLookupBlocked: blocks.spotifyLookup, collaborative: collaborativeFn(db),
      embed: embedder(), storedEmbeddings, catalogFallback: catalogFallbackFn(userId), seed: previousIds.length + Math.floor(Math.random() * 97),
    },
  );
  await markPipelineQuota(result);

  // Memory: explicit statements → long-term profile; expressed mood → short-term context only.
  for (const s of result.intent.statements) profile = applyStatement(profile, s.subject, s.concepts, s.polarity);
  // "no motivational speeches" → remembered as a long-term dislike (editable in My Taste).
  const freeExcludes = result.intent.excludes.filter((x) => !CONCEPT_BY_ID[x] && !GENRE_WORDS.includes(x));
  if (freeExcludes.length) {
    const phrase = freeExcludes.join(' ').slice(0, 80);
    profile = { ...profile, explicit: { ...profile.explicit, dislikes: [...new Set([...profile.explicit.dislikes, phrase])].slice(-50) } };
  }
  const moodTarget = Object.fromEntries(result.intent.moods.map((m) => [m, result.intent.target[m] ?? 0]));
  profile = applyContext(profile, moodTarget);
  await saveProfile(db, userId, profile);

  const recs = result.recommendations;
  await upsertItems(recs.map((r) => r.item));
  const ids = recs.map((r) => r.item.id);
  const reply = result.clarifyingQuestion && !recs.length ? result.clarifyingQuestion.text : result.reply ?? '';
  const payload = {
    recommendations: recs.map((r) => ({ itemId: r.item.id, explanation: r.explanation, score: r.score, trajectoryStep: r.trajectoryStep })),
    clarifyingQuestion: result.clarifyingQuestion,
    intent: { intent: result.intent.intent, summary: result.pipeline[0]?.detail },
    providers: result.providers,
  };
  await db.from('chat_messages').insert({ session_id: sessionId, user_id: userId, role: 'assistant', content: reply.slice(0, 4000) || '…', payload });
  const { candidates: _c, quotaErrors: _q, quotaRetryAfter: _r, spotifyLookupLimitedSec: _l, ...rest } = result;
  await db.from('chat_sessions').update({ last_intent: { ...rest.intent, statements: [] }, last_result_ids: ids.length ? ids : previousIds }).eq('id', sessionId);
  if (recs.length) {
    await serviceClient().from('recommendation_events').insert(recs.map((r, i) => ({ user_id: userId, item_id: r.item.id, source: 'chat', position: i, score: r.score, explanation: r.explanation.text.slice(0, 500) })));
  }
  return json(req, { ...rest, reply, sessionId, recommendations: recs.map((r) => ({ ...r, item: { ...r.item, embedding: undefined } })) });
});
