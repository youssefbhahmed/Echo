// POST /functions/v1/feedback — pipeline step 8: learn from an interaction.
import { applyFeedback, creatorKeys } from '../_shared/engine/profile.ts';
import { FeedbackBody } from '../_shared/schemas.ts';
import { getItems, HttpError, json, loadProfile, rateLimit, readJson, requireUser, saveProfile, serve, serviceClient } from '../_shared/server.ts';
import { topKeys } from '../_shared/engine/text.ts';

serve(async (req) => {
  const { userId, db } = await requireUser(req);
  await rateLimit(userId, 'feedback', 120, 60);
  const body = FeedbackBody.parse(await readJson(req));
  if (body.type === 'rate' && !body.rating) throw new HttpError(400, 'rating is required for type=rate', 'validation');
  const [item] = await getItems([body.itemId]);
  if (!item) throw new HttpError(404, 'Unknown item', 'not_found');

  const before = await loadProfile(db, userId);
  const profile = applyFeedback(before, item, body.type, { rating: body.rating });
  await saveProfile(db, userId, profile);

  const { error: iErr } = await db.from('interactions').insert({ user_id: userId, item_id: item.id, type: body.type, rating: body.rating ?? null, context: body.context ?? {} });
  if (iErr) throw new HttpError(500, iErr.message);

  const now = new Date().toISOString();
  const patch: Record<string, unknown> | null = (() => {
    switch (body.type) {
      case 'like': return { liked: true };
      case 'unlike': return { liked: null };
      case 'dislike': return { liked: false, saved: false };
      case 'save': return { saved: true, saved_at: now };
      case 'unsave': return { saved: false };
      case 'rate': return { rating: body.rating, ...(body.rating! >= 4 ? { liked: true } : body.rating! <= 2 ? { liked: false } : {}) };
      case 'consumed': return { status: 'consumed', consumed_at: now };
      default: return null;
    }
  })();
  let library = null;
  if (patch) {
    const { data, error } = await db.from('library_items').upsert({ user_id: userId, item_id: item.id, ...patch }, { onConflict: 'user_id,item_id' }).select().single();
    if (error) throw new HttpError(500, error.message);
    library = data;
  }

  // Weekly snapshot for taste evolution ("emerging interests").
  const { data: last } = await db.from('taste_snapshots').select('created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!last || Date.now() - new Date(last.created_at).getTime() > 7 * 86400_000) {
    await serviceClient().from('taste_snapshots').insert({ user_id: userId, concepts: profile.concepts });
  }

  // Report what changed so the UI can show that ECHO actually learned something.
  const changed = topKeys(Object.fromEntries(Object.keys(profile.concepts).map((k) => [k, Math.abs((profile.concepts[k] ?? 0) - (before.concepts[k] ?? 0))])), 3, 0.01);
  // Songs teach the artist and lane weights (a skip/dislike keeps the artist out of the next refreshes).
  const lane = (item.metadata?.lane as { id?: string; label?: string } | undefined) ?? undefined;
  const music = item.category === 'music'
    ? {
      artists: creatorKeys(item).map((k) => ({ artist: k, from: before.creators[k] ?? 0, to: profile.creators[k] ?? 0, filtered: (profile.creators[k] ?? 0) <= -0.5 })),
      ...(lane?.id ? { lane: { id: lane.id, label: lane.label, from: before.laneFeedback?.[lane.id] ?? 0, to: profile.laneFeedback?.[lane.id] ?? 0 } } : {}),
    }
    : undefined;
  return json(req, { ok: true, library, learned: changed.map((k) => ({ concept: k, from: before.concepts[k] ?? 0, to: profile.concepts[k] ?? 0 })), music, interactionCount: profile.interactionCount });
});
