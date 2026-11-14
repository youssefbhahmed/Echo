// POST /functions/v1/account — { action: 'export' } returns all of the user's data; { action: 'delete', confirm: 'DELETE' } erases the account.
import { AccountBody } from '../_shared/schemas.ts';
import { HttpError, json, rateLimit, readJson, requireUser, serve, serviceClient } from '../_shared/server.ts';

serve(async (req) => {
  const { userId, db, email } = await requireUser(req);
  await rateLimit(userId, 'account', 5, 60);
  const body = AccountBody.parse(await readJson(req));

  if (body.action === 'export') {
    const q = (t: string, col = 'user_id', limit = 10000) => db.from(t).select('*').eq(col, userId).limit(limit).then((r) => r.data ?? []);
    const [profile, taste, snapshots, interactions, library, collections, collectionItems, sessions, messages, events] = await Promise.all([
      q('profiles', 'id'), q('taste_profiles'), q('taste_snapshots'), q('interactions'), q('library_items'), q('collections'), q('collection_items'), q('chat_sessions'), q('chat_messages'), q('recommendation_events', 'user_id', 2000),
    ]);
    const itemIds = [...new Set([...interactions, ...library, ...collectionItems].map((r: Record<string, unknown>) => r.item_id as string))];
    const items = itemIds.length ? (await db.from('content_items').select('id,title,creators,category,kind,provider,external_url').in('id', itemIds.slice(0, 5000))).data ?? [] : [];
    const { data: spotify } = await serviceClient().from('oauth_tokens').select('provider, scope, updated_at').eq('user_id', userId);
    return json(req, {
      exportedAt: new Date().toISOString(), format: 'echo-export/v1', account: { id: userId, email },
      profile, taste, snapshots, interactions, library, collections, collectionItems, chatSessions: sessions, chatMessages: messages, recommendationEvents: events, items,
      connectedPlatforms: spotify ?? [],
    });
  }

  if (body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm account deletion', 'confirm_required');
  // All user rows cascade from auth.users.
  const { error } = await serviceClient().auth.admin.deleteUser(userId);
  if (error) throw new HttpError(500, error.message);
  return json(req, { deleted: true });
});
