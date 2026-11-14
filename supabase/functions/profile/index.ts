// GET  /functions/v1/profile — taste model + insights + account status
// POST /functions/v1/profile — { action: 'edit' | 'onboarding' | 'reset' }
import { buildInsights } from '../_shared/engine/insights.ts';
import { applyEdit, applyFeedback, emptyProfile, seedProfile } from '../_shared/engine/profile.ts';
import { aiConfig } from '../_shared/engine/ai.ts';
import { providerStatus } from '../_shared/providers/index.ts';
import { ProfileBody } from '../_shared/schemas.ts';
import { env, getItems, HttpError, json, loadProfile, rateLimit, readJson, requireUser, saveProfile, serve } from '../_shared/server.ts';

serve(async (req) => {
  const { userId, db, email } = await requireUser(req);

  if (req.method === 'GET') {
    const [profile, account, snap, libCount, interCount] = await Promise.all([
      loadProfile(db, userId),
      db.from('profiles').select('display_name, onboarded_at, settings, created_at').eq('id', userId).maybeSingle(),
      db.from('taste_snapshots').select('concepts, created_at').eq('user_id', userId).lt('created_at', new Date(Date.now() - 10 * 86400_000).toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      db.from('library_items').select('item_id', { count: 'exact', head: true }).eq('user_id', userId),
      db.from('interactions').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    ]);
    const { embedding: _e, ...model } = profile;
    return json(req, {
      account: { email, ...(account.data ?? {}) },
      model,
      insights: buildInsights(profile, (snap.data?.concepts as Record<string, number>) ?? null),
      stats: { library: libCount.count ?? 0, interactions: interCount.count ?? 0 },
      server: {
        providers: providerStatus(env).map(({ id, label, configured, categories, setup }) => ({ id, label, configured, categories, setup: configured ? undefined : setup })),
        ai: aiConfig(env) ? { enabled: true, model: env('AI_MODEL') } : { enabled: false },
        embeddings: env('ECHO_EMBEDDINGS') === 'on',
      },
    });
  }

  await rateLimit(userId, 'profile', 30, 60);
  const body = ProfileBody.parse(await readJson(req));
  let profile = await loadProfile(db, userId);

  if (body.action === 'edit') {
    profile = applyEdit(profile, body.edit);
  } else if (body.action === 'reset') {
    profile = emptyProfile();
    await db.from('taste_snapshots').delete().eq('user_id', userId);
  } else {
    profile = seedProfile(profile, { categories: body.categories, interests: body.interests, description: body.description, exploration: body.exploration });
    // Favorites are real catalog items the user picked → learn from them as genuine likes.
    const favorites = await getItems(body.favorites ?? []);
    for (const item of favorites) {
      profile = applyFeedback(profile, item, 'like');
      await db.from('interactions').insert({ user_id: userId, item_id: item.id, type: 'like', context: { source: 'onboarding' } });
      await db.from('library_items').upsert({ user_id: userId, item_id: item.id, liked: true }, { onConflict: 'user_id,item_id' });
    }
    const { error } = await db.from('profiles').update({
      onboarded_at: new Date().toISOString(),
      ...(body.displayName ? { display_name: body.displayName } : {}),
      settings: { categories: body.categories ?? [], exploration: body.exploration ?? profile.exploration },
    }).eq('id', userId);
    if (error) throw new HttpError(500, error.message);
  }
  await saveProfile(db, userId, profile);
  const { embedding: _e, ...model } = profile;
  return json(req, { model, insights: buildInsights(profile) });
});
