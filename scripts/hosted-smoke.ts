// Smoke-tests a deployed ECHO backend with a temporary user (deleted afterwards).
//   deno run -A --env-file=.secrets/hosted.env scripts/hosted-smoke.ts
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
const URL_ = Deno.env.get('SUPABASE_URL')!;
const PUB = Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!;
const SECRET = Deno.env.get('SUPABASE_SECRET_KEY')!;
const admin = createClient(URL_, SECRET, { auth: { persistSession: false } });
const email = `echo-smoke-${crypto.randomUUID().slice(0, 8)}@example.com`;
const password = crypto.randomUUID();
const { data: created, error: cErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (cErr) throw cErr;
const client = createClient(URL_, PUB, { auth: { persistSession: false } });
const { data: s, error: sErr } = await client.auth.signInWithPassword({ email, password });
if (sErr) throw sErr;
const token = s.session!.access_token;
const call = async (name: string, body?: unknown, method = 'POST') => {
  const r = await fetch(`${URL_}/functions/v1/${name}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${name} ${r.status}: ${JSON.stringify(j)}`);
  return j;
};
try {
  const lookup = await call('catalog', { action: 'lookup', query: 'The Stranger Camus', category: 'books' });
  console.log('lookup:', lookup.items.length, lookup.items[0]?.title);
  const onb = await call('profile', { action: 'onboarding', categories: ['books', 'podcasts', 'screen', 'music'], interests: ['existential', 'cosmic'], favorites: [lookup.items[0].id] });
  console.log('onboarding concepts:', Object.keys(onb.model.concepts).slice(0, 6).join(','));
  const feed = await call('discover', { limit: 6 });
  console.log('feed:', feed.recommendations.map((r: { item: { category: string; title: string } }) => `[${r.item.category}] ${r.item.title}`).join(' | '));
  console.log('pipeline:', feed.pipeline.map((p: { step: string; ms: number }) => `${p.step}:${p.ms}ms`).join(' '));
  const fb = await call('feedback', { itemId: feed.recommendations[0].item.id, type: 'like' });
  console.log('feedback learned:', JSON.stringify(fb.learned));
  for (const message of ["I'm feeling nostalgic. Recommend music that starts melancholic and gradually becomes uplifting.", 'I want to understand the origins of civilization through serious documentaries.', 'Something with the existential feeling of Interstellar, but it does not have to be science fiction']) {
    const chat = await call('chat', { message });
    console.log('\nCHAT:', message, '\n  ', chat.pipeline[0].detail, '\n  reply:', chat.reply);
    for (const r of chat.recommendations.slice(0, 5)) console.log(`   - [${r.item.category}/${r.item.provider}] ${r.item.title} — ${r.item.creators.join(', ')} | embed:${r.item.embed?.type ?? 'none'} | ${r.explanation.text}`);
    console.log('   providers:', JSON.stringify(chat.providers));
  }
  const exp = await call('account', { action: 'export' });
  console.log('export interactions:', exp.interactions.length);
  console.log('SMOKE OK');
} finally {
  await admin.auth.admin.deleteUser(created.user.id);
  console.log('temp user deleted');
}
