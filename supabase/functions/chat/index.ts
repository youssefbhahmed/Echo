// POST /functions/v1/chat — conversational discovery with refinement and memory.
import { applyContext, applyStatement } from '../_shared/engine/profile.ts';
import { runPipeline } from '../_shared/engine/pipeline.ts';
import { CONCEPT_BY_ID } from '../_shared/engine/concepts.ts';
import { chatPayloadRecs, chatRequest } from '../_shared/engine/chat.ts';
import { sanitizeStoredIntent } from '../_shared/engine/understand.ts';
import { GENRE_WORDS } from '../_shared/engine/intent.ts';
import { createHttp } from '../_shared/providers/http.ts';
import type { Intent } from '../_shared/types.ts';
import { ChatBody } from '../_shared/schemas.ts';
import {
  catalogFns, collaborativeFn, DbCache, embedder, env, evidenceItems, exclusions, getItems, HttpError, json, librarySongs, loadProfile, markPipelineQuota, providerBlocks, rateLimit, readJson, requireUser, saveProfile,
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
    // The stored intent is re-checked: the row is user-writable (bounded entities, references, enums).
    previousIntent = sanitizeStoredIntent(data.last_intent);
    previousIds = (data.last_result_ids as string[]) ?? [];
  } else {
    const { data, error } = await db.from('chat_sessions').insert({ user_id: userId, title: body.message.slice(0, 80) }).select('id').single();
    if (error) throw new HttpError(500, error.message);
    sessionId = data.id as string;
  }
  await db.from('chat_messages').insert({ session_id: sessionId, user_id: userId, role: 'user', content: body.message });

  const [loadedProfile, held, evidence, blocks, previousResults, library] = await Promise.all([
    loadProfile(db, userId), exclusions(db, userId), evidenceItems(db, userId), providerBlocks(), getItems(previousIds), librarySongs(db, userId),
  ]);
  let profile = loadedProfile;
  const exclude = held.all;
  // Do not repeat what was just shown in this conversation.
  for (const id of previousIds) exclude.add(id);
  const catalog = catalogFns(userId);

  const http = createHttp(new DbCache());
  // 12 picks; 20 when the message names an entity (an artist's lanes + the things around them).
  const result = await runPipeline(
    chatRequest(body),
    {
      // Held back even from a named artist's own lane: what this conversation just showed, and dislikes.
      env, http, profile, excludeIds: exclude, shownIds: new Set([...previousIds, ...held.disliked]), library, evidence, previousIntent, previousResults, blockedProviders: blocks.providers, spotifyLookupBlocked: blocks.spotifyLookup,
      collaborative: collaborativeFn(db),
      embed: embedder(), storedEmbeddings, catalogFallback: catalog.fallback, catalogByName: catalog.byName, seed: previousIds.length + Math.floor(Math.random() * 97),
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
    // Each pick's lane / "in your library" / entity fields travel with the message (the catalog row is shared).
    recommendations: chatPayloadRecs(recs),
    clarifyingQuestion: result.clarifyingQuestion,
    intent: { intent: result.intent.intent, summary: result.pipeline[0]?.detail },
    providers: result.providers,
  };
  await db.from('chat_messages').insert({ session_id: sessionId, user_id: userId, role: 'assistant', content: reply.slice(0, 4000) || '…', payload });
  const { candidates: _c, quotaErrors: _q, quotaRetryAfter: _r, spotifyLookupLimitedSec: _l, curatorSuggested: _m, ...rest } = result;
  await db.from('chat_sessions').update({ last_intent: { ...rest.intent, statements: [] }, last_result_ids: ids.length ? ids : previousIds }).eq('id', sessionId);
  if (recs.length) {
    await serviceClient().from('recommendation_events').insert(recs.map((r, i) => ({ user_id: userId, item_id: r.item.id, source: 'chat', position: i, score: r.score, explanation: r.explanation.text.slice(0, 500) })));
  }
  return json(req, { ...rest, reply, sessionId, recommendations: recs.map((r) => ({ ...r, item: { ...r.item, embedding: undefined } })) });
});
