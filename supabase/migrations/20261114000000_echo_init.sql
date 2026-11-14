-- ECHO initial schema
-- Principles:
--   • Every user-owned row is protected by row-level security (RLS) keyed on auth.uid().
--   • Shared catalog data (content_items) is readable by signed-in users, writable only by the service role.
--   • Secrets/tokens/caches live in tables with RLS enabled and NO policies, and with privileges revoked
--     from anon/authenticated: only Edge Functions (service role) can touch them.

create extension if not exists vector with schema extensions;

-- ───────────────────────── helpers ─────────────────────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ───────────────────────── user profile ─────────────────────────
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  onboarded_at timestamptz,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();

-- Learned taste model (see supabase/functions/_shared/engine/profile.ts)
create table public.taste_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  model jsonb not null default '{}'::jsonb,
  embedding extensions.vector(384),
  updated_at timestamptz not null default now()
);

-- Periodic snapshots power "emerging interests" and taste evolution
create table public.taste_snapshots (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  concepts jsonb not null,
  created_at timestamptz not null default now()
);
create index taste_snapshots_user_idx on public.taste_snapshots (user_id, created_at desc);

-- New auth user → profile rows
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name) values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  insert into public.taste_profiles (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ───────────────────────── shared catalog ─────────────────────────
create table public.content_items (
  id text primary key check (char_length(id) <= 200),
  category text not null check (category in ('youtube', 'music', 'screen', 'books', 'podcasts')),
  kind text not null,
  provider text not null,
  external_id text not null,
  title text not null,
  creators text[] not null default '{}',
  description text,
  genres text[] not null default '{}',
  tags text[] not null default '{}',
  artwork_url text,
  duration_sec integer,
  language text,
  release_date text,
  external_url text not null,
  embed jsonb,
  playback_note text,
  rating real,
  popularity real,
  metadata jsonb not null default '{}'::jsonb,
  concepts jsonb not null default '{}'::jsonb,
  embedding extensions.vector(384),
  stale boolean not null default false,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index content_items_provider_idx on public.content_items (provider, fetched_at);
create index content_items_title_trgm_idx on public.content_items using gin (to_tsvector('simple', title));

-- ───────────────────────── user data ─────────────────────────
create table public.interactions (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id text not null references public.content_items (id) on delete cascade,
  type text not null check (type in ('like', 'dislike', 'save', 'unsave', 'skip', 'rate', 'consumed', 'open', 'play')),
  rating smallint check (rating between 1 and 5),
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index interactions_user_idx on public.interactions (user_id, created_at desc);
create index interactions_item_idx on public.interactions (item_id, type);

create table public.library_items (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id text not null references public.content_items (id) on delete cascade,
  saved boolean not null default false,
  status text not null default 'none' check (status in ('none', 'want', 'in_progress', 'consumed')),
  liked boolean,
  rating smallint check (rating between 1 and 5),
  note text check (char_length(note) <= 2000),
  saved_at timestamptz,
  consumed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, item_id)
);
create index library_items_user_idx on public.library_items (user_id, updated_at desc);
create trigger library_items_touch before update on public.library_items for each row execute function public.touch_updated_at();

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text check (char_length(description) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index collections_user_idx on public.collections (user_id);
create trigger collections_touch before update on public.collections for each row execute function public.touch_updated_at();

create table public.collection_items (
  collection_id uuid not null references public.collections (id) on delete cascade,
  item_id text not null references public.content_items (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (collection_id, item_id)
);

create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text,
  last_intent jsonb,
  last_result_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index chat_sessions_user_idx on public.chat_sessions (user_id, updated_at desc);
create trigger chat_sessions_touch before update on public.chat_sessions for each row execute function public.touch_updated_at();

create table public.chat_messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.chat_sessions (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) <= 4000),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index chat_messages_session_idx on public.chat_messages (session_id, created_at);

-- Recommendations actually shown (history, "recently discovered", offline evaluation)
create table public.recommendation_events (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id text not null references public.content_items (id) on delete cascade,
  source text not null check (source in ('feed', 'chat', 'onboarding')),
  position smallint,
  score jsonb,
  explanation text,
  created_at timestamptz not null default now()
);
create index recommendation_events_user_idx on public.recommendation_events (user_id, created_at desc);

-- ───────────────────────── server-only tables ─────────────────────────
create table public.oauth_tokens (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('spotify')),
  access_token text not null,
  refresh_token text,
  scope text,
  expires_at timestamptz not null,
  external_user_id text,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

create table public.oauth_states (
  state text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  code_verifier text not null,
  redirect_to text not null,
  created_at timestamptz not null default now()
);

create table public.provider_cache (
  key text primary key,
  value jsonb not null,
  expires_at timestamptz not null
);
create index provider_cache_exp_idx on public.provider_cache (expires_at);

create table public.provider_status (
  provider text primary key,
  blocked_until timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create table public.rate_limits (
  user_id uuid not null,
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (user_id, bucket, window_start)
);

-- ───────────────────────── RLS ─────────────────────────
alter table public.profiles enable row level security;
alter table public.taste_profiles enable row level security;
alter table public.taste_snapshots enable row level security;
alter table public.content_items enable row level security;
alter table public.interactions enable row level security;
alter table public.library_items enable row level security;
alter table public.collections enable row level security;
alter table public.collection_items enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.recommendation_events enable row level security;
alter table public.oauth_tokens enable row level security;
alter table public.oauth_states enable row level security;
alter table public.provider_cache enable row level security;
alter table public.provider_status enable row level security;
alter table public.rate_limits enable row level security;

-- Server-only: no policies + revoke = unreachable from the browser even with a valid JWT.
revoke all on public.oauth_tokens, public.oauth_states, public.provider_cache, public.provider_status, public.rate_limits from anon, authenticated;

-- Catalog: read-only for signed-in users.
revoke insert, update, delete on public.content_items from anon, authenticated;
create policy "catalog readable by signed-in users" on public.content_items for select to authenticated using (true);

create policy "own profile" on public.profiles for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "own taste" on public.taste_profiles for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own snapshots read" on public.taste_snapshots for select to authenticated using (user_id = (select auth.uid()));
create policy "own snapshots delete" on public.taste_snapshots for delete to authenticated using (user_id = (select auth.uid()));

create policy "own interactions read" on public.interactions for select to authenticated using (user_id = (select auth.uid()));
create policy "own interactions insert" on public.interactions for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own interactions delete" on public.interactions for delete to authenticated using (user_id = (select auth.uid()));

create policy "own library" on public.library_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own collections" on public.collections for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own collection items" on public.collection_items for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and exists (select 1 from public.collections c where c.id = collection_id and c.user_id = (select auth.uid())));
create policy "own chat sessions" on public.chat_sessions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own chat messages" on public.chat_messages for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and exists (select 1 from public.chat_sessions s where s.id = session_id and s.user_id = (select auth.uid())));
create policy "own rec events read" on public.recommendation_events for select to authenticated using (user_id = (select auth.uid()));
create policy "own rec events delete" on public.recommendation_events for delete to authenticated using (user_id = (select auth.uid()));

-- ───────────────────────── functions ─────────────────────────

-- Atomic fixed-window rate limiter (called by Edge Functions with the service role).
create or replace function public.check_rate_limit(p_user uuid, p_bucket text, p_max integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  c integer;
begin
  insert into public.rate_limits (user_id, bucket, window_start, count) values (p_user, p_bucket, w, 1)
  on conflict (user_id, bucket, window_start) do update set count = public.rate_limits.count + 1
  returning count into c;
  return c <= p_max;
end $$;
revoke all on function public.check_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;

-- Item-item collaborative filtering. Returns only aggregate scores (never user ids), and only
-- once the community is large enough; each scored item needs >= 2 distinct like-minded users.
create or replace function public.cf_scores(candidate_ids text[], min_community integer default 20)
returns table (item_id text, score real)
language sql stable security definer set search_path = '' as $$
  with community as (
    select count(distinct user_id) as n from public.interactions where type in ('like', 'save')
  ),
  mine as (
    select distinct i.item_id from public.interactions i
    where i.user_id = auth.uid() and (i.type in ('like', 'save') or (i.type = 'rate' and i.rating >= 4))
  ),
  neighbours as (
    select i.user_id, count(*)::real as overlap
    from public.interactions i join mine m on m.item_id = i.item_id
    where i.user_id <> auth.uid() and i.type in ('like', 'save')
    group by i.user_id having count(*) >= 2
  )
  select i.item_id, least(1.0, sum(n.overlap) / 10.0)::real as score
  from public.interactions i join neighbours n on n.user_id = i.user_id
  where i.item_id = any (candidate_ids) and i.type in ('like', 'save')
    and (select n from community) >= min_community
  group by i.item_id
  having count(distinct i.user_id) >= 2
$$;
revoke all on function public.cf_scores(text[], integer) from public, anon;
grant execute on function public.cf_scores(text[], integer) to authenticated;

-- Housekeeping: expire caches and honour YouTube's 30-day storage limit by stripping stale
-- YouTube metadata (it is re-fetched on demand by the catalog function).
create or replace function public.echo_cleanup() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.provider_cache where expires_at < now();
  delete from public.rate_limits where window_start < now() - interval '2 days';
  delete from public.oauth_states where created_at < now() - interval '1 hour';
  update public.content_items
     set title = 'YouTube video', description = null, tags = '{}', artwork_url = null, metadata = '{}'::jsonb,
         creators = '{}', concepts = '{}'::jsonb, embedding = null, stale = true
   where provider = 'youtube' and stale = false and fetched_at < now() - interval '29 days';
  delete from public.content_items c
   where c.fetched_at < now() - interval '120 days'
     and not exists (select 1 from public.interactions i where i.item_id = c.id)
     and not exists (select 1 from public.library_items l where l.item_id = c.id)
     and not exists (select 1 from public.collection_items ci where ci.item_id = c.id)
     and not exists (select 1 from public.recommendation_events r where r.item_id = c.id);
end $$;
revoke all on function public.echo_cleanup() from public, anon, authenticated;

-- Schedule daily cleanup when pg_cron is available (it is on Supabase, including the free plan).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('echo-cleanup', '17 3 * * *', 'select public.echo_cleanup()');
  end if;
exception when others then
  raise notice 'pg_cron not scheduled: %', sqlerrm;
end $$;
