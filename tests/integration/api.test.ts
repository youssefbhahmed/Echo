// End-to-end API tests against a running local stack:
//   npx supabase start && bash scripts/local-env.sh
//   deno run -A --env-file=supabase/functions/.env.local scripts/dev-functions.ts   (or supabase functions serve)
//   deno test -A --env-file=supabase/functions/.env.local tests/integration/api.test.ts
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';
import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const FN = Deno.env.get('ECHO_FUNCTIONS_URL') ?? 'http://127.0.0.1:54331/functions/v1';

async function newUser(tag: string): Promise<{ client: SupabaseClient; token: string; id: string }> {
  const client = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } });
  const email = `${tag}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const { data, error } = await client.auth.signUp({ email, password: 'correct-horse-battery-staple' });
  if (error) throw error;
  return { client, token: data.session!.access_token, id: data.user!.id };
}

async function call(token: string | null, name: string, body?: unknown, method = 'POST') {
  const res = await fetch(`${FN}/${name}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test('ECHO API end-to-end', opts, async (t) => {
  const alice = await newUser('alice');
  const bob = await newUser('bob');

  await t.step('rejects unauthenticated requests', async () => {
    const r = await call(null, 'discover', {});
    assertEquals(r.status, 401);
    const r2 = await call(ANON, 'discover', {});
    assertEquals(r2.status, 401);
  });

  await t.step('validates input', async () => {
    const r = await call(alice.token, 'feedback', { itemId: 'not valid', type: 'like' });
    assertEquals(r.status, 400);
  });

  let favoriteId = '';
  await t.step('catalog lookup returns real items for onboarding', async () => {
    const r = await call(alice.token, 'catalog', { action: 'lookup', query: 'The Myth of Sisyphus', category: 'books' });
    assertEquals(r.status, 200);
    assert(r.body.items.length > 0, 'lookup returned items');
    favoriteId = r.body.items[0].id;
    assert(favoriteId.startsWith('openlibrary:book:'));
  });

  await t.step('onboarding seeds the taste profile with real favorites', async () => {
    const r = await call(alice.token, 'profile', { action: 'onboarding', categories: ['books', 'podcasts'], interests: ['philosophy', 'cosmic'], description: 'slow, melancholic stories about memory', exploration: 0.5, favorites: [favoriteId] });
    assertEquals(r.status, 200);
    assert(r.body.model.concepts.philosophy > 1);
    assertEquals(r.body.model.interactionCount, 1);
    const p = await call(alice.token, 'profile', undefined, 'GET');
    assertExists(p.body.account.onboarded_at);
    assertEquals(p.body.stats.library, 1);
  });

  let firstRecs: Array<{ item: { id: string; title: string }; explanation: { text: string } }> = [];
  await t.step('discover feed returns personalised, explained recommendations', async () => {
    const r = await call(alice.token, 'discover', { categories: ['books', 'podcasts'], limit: 6 });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    firstRecs = r.body.recommendations;
    assert(firstRecs.length >= 3, `got ${firstRecs.length}`);
    for (const rec of firstRecs) assert(rec.explanation.text.length > 10);
    assert(!firstRecs.some((x) => x.item.id === favoriteId), 'already-liked favorite is not re-recommended');
    assertEquals(r.body.pipeline[0].step, 'intent');
  });

  await t.step('feedback updates the profile and the library', async () => {
    const target = firstRecs[0].item.id;
    const before = (await call(alice.token, 'profile', undefined, 'GET')).body.model;
    const r = await call(alice.token, 'feedback', { itemId: target, type: 'save' });
    assertEquals(r.status, 200);
    assertEquals(r.body.library.saved, true);
    const after = (await call(alice.token, 'profile', undefined, 'GET')).body.model;
    assertEquals(after.interactionCount, before.interactionCount + 1);
    const r2 = await call(alice.token, 'discover', { categories: ['books', 'podcasts'], limit: 6 });
    assert(!r2.body.recommendations.some((x: { item: { id: string } }) => x.item.id === target), 'saved item excluded from feed');
  });

  let sessionId = '';
  await t.step('chat interprets, remembers statements, and refines', async () => {
    const r = await call(alice.token, 'chat', { message: 'I love Tarkovsky. Recommend existential philosophy books and podcasts' });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    sessionId = r.body.sessionId;
    assert(r.body.recommendations.length > 0);
    assert(/existential|philosophy/i.test(r.body.reply), r.body.reply);
    const p = (await call(alice.token, 'profile', undefined, 'GET')).body.model;
    assert(p.explicit.likes.includes('Tarkovsky'));
    const r2 = await call(alice.token, 'chat', { sessionId, message: 'only podcasts' });
    assertEquals(r2.status, 200);
    assertEquals(r2.body.intent.categories, ['podcasts']);
    assert(r2.body.recommendations.every((x: { item: { category: string } }) => x.item.category === 'podcasts'));
  });

  await t.step('users are isolated', async () => {
    const { data: sessions } = await bob.client.from('chat_sessions').select('id').eq('id', sessionId);
    assertEquals(sessions?.length, 0);
    const { data: lib } = await bob.client.from('library_items').select('*');
    assertEquals(lib?.length, 0);
    const r = await call(bob.token, 'chat', { sessionId, message: 'hello there friend' });
    assertEquals(r.status, 404);
    const { error } = await bob.client.from('oauth_tokens').select('*');
    assertExists(error);
  });

  await t.step('profile edits are applied', async () => {
    const r = await call(alice.token, 'profile', { action: 'edit', edit: { blockConcept: 'horror', exploration: 0.8 } });
    assertEquals(r.status, 200);
    assert(r.body.model.explicit.blockedConcepts.includes('horror'));
    assertEquals(r.body.model.exploration, 0.8);
  });

  await t.step('export contains the user data', async () => {
    const r = await call(alice.token, 'account', { action: 'export' });
    assertEquals(r.status, 200);
    assertEquals(r.body.format, 'echo-export/v1');
    assert(r.body.interactions.length >= 2);
    assert(r.body.chatMessages.length >= 4);
  });

  await t.step('account deletion erases the user', async () => {
    const bad = await call(bob.token, 'account', { action: 'delete' });
    assertEquals(bad.status, 400);
    const r = await call(bob.token, 'account', { action: 'delete', confirm: 'DELETE' });
    assertEquals(r.status, 200);
    const again = await call(bob.token, 'profile', undefined, 'GET');
    assertEquals(again.status, 401);
  });
});
