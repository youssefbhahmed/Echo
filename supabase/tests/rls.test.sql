-- Row-level security & data-isolation tests. Run with: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

-- Two users (trigger creates their profile rows)
insert into auth.users (id, email, instance_id, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

select is((select count(*)::int from public.profiles), 2, 'signup trigger creates profiles');
select is((select count(*)::int from public.taste_profiles), 2, 'signup trigger creates taste profiles');

insert into public.content_items (id, category, kind, provider, external_id, title, external_url)
values ('openlibrary:book:OL1W', 'books', 'book', 'openlibrary', 'OL1W', 'A Book', 'https://openlibrary.org/works/OL1W');
insert into public.provider_cache (key, value, expires_at) values ('k', '{}', now() + interval '1 day');
insert into public.oauth_tokens (user_id, provider, access_token, expires_at) values ('11111111-1111-1111-1111-111111111111', 'spotify', 'secret-token', now());

-- ── act as Alice ──
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select is((select count(*)::int from public.profiles), 1, 'alice sees only her profile');
select is((select count(*)::int from public.content_items), 1, 'catalog is readable');
select throws_ok($$ insert into public.content_items (id, category, kind, provider, external_id, title, external_url) values ('x', 'books', 'book', 'openlibrary', 'x', 'x', 'https://x') $$, '42501', null, 'users cannot write the shared catalog');
select throws_ok($$ select * from public.oauth_tokens $$, '42501', null, 'oauth tokens are not readable by users');
select throws_ok($$ select * from public.provider_cache $$, '42501', null, 'provider cache is not readable by users');
select throws_ok($$ select public.check_rate_limit('11111111-1111-1111-1111-111111111111', 'x', 1, 60) $$, '42501', null, 'rate limiter is server-only');

select lives_ok($$ insert into public.interactions (item_id, type) values ('openlibrary:book:OL1W', 'like') $$, 'alice can record feedback');
select lives_ok($$ insert into public.library_items (item_id, saved, saved_at) values ('openlibrary:book:OL1W', true, now()) $$, 'alice can save to library');
select lives_ok($$ insert into public.collections (id, name) values ('33333333-3333-3333-3333-333333333333', 'Late night') $$, 'alice can create a collection');
select throws_ok($$ insert into public.interactions (user_id, item_id, type) values ('22222222-2222-2222-2222-222222222222', 'openlibrary:book:OL1W', 'like') $$, '42501', null, 'alice cannot write as bob');
update public.taste_profiles set model = '{"concepts":{"philosophy":1}}';
select is((select model->'concepts'->>'philosophy' from public.taste_profiles), '1', 'alice can update her taste profile');

-- ── act as Bob ──
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from public.interactions), 0, 'bob cannot see alice interactions');
select is((select count(*)::int from public.library_items), 0, 'bob cannot see alice library');
select is((select count(*)::int from public.collections), 0, 'bob cannot see alice collections');
update public.taste_profiles set model = '{}' where user_id = '11111111-1111-1111-1111-111111111111';
select throws_ok($$ insert into public.collection_items (collection_id, item_id) values ('33333333-3333-3333-3333-333333333333', 'openlibrary:book:OL1W') $$, '42501', null, 'bob cannot add items to alice collection');
select is((select count(*)::int from public.cf_scores(array['openlibrary:book:OL1W'])), 0, 'collaborative filtering stays off below community threshold');

-- ── anon ──
reset role;
set local role anon;
select is((select count(*)::int from public.content_items), 0, 'anon cannot read catalog');

reset role;
select is((select model->'concepts'->>'philosophy' from public.taste_profiles where user_id = '11111111-1111-1111-1111-111111111111'), '1', 'bob could not modify alice taste profile');

select * from finish();
rollback;
