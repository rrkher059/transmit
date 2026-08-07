-- Postgres schema. users/follows/tweets/likes/comments/reactions back the
-- routes already migrated off the JSON stores (feed, profile timeline/
-- likes/replies, follows, follow-stats). blocks/messages/notifications are
-- defined here too — for server/testDbSetup.ts's truncate and future
-- migration — but their routes still read/write data/*.json for now.
--
-- Apply with `npm run db:schema` (DATABASE_URL from .env) or
-- `npm run db:schema:test` (DATABASE_URL from .env.test) — see
-- server/applySchema.ts. Safe to re-run: every statement is idempotent.

create table if not exists users (
  id            uuid primary key,
  email         text not null unique,
  handle        text not null unique,
  created_at    timestamptz not null default now()
);

create table if not exists user_credentials (
  user_id       uuid primary key references users(id) on delete cascade,
  password_hash text not null
);

create table if not exists follows (
  follower_id  uuid not null references users(id),
  following_id uuid not null references users(id),
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint follows_no_self_follow check (follower_id <> following_id)
);

create index if not exists follows_following_id_idx on follows (following_id);

create table if not exists tweets (
  id           uuid primary key,
  user_id      uuid not null references users(id),
  body         text not null default '',
  image_url    text,
  reply_to_id  uuid references tweets(id) on delete set null,
  repost_of_id uuid references tweets(id) on delete cascade,
  tags         text[] not null default '{}',
  created_at   timestamptz not null default now()
);

create index if not exists tweets_user_id_idx on tweets (user_id);
create index if not exists tweets_repost_of_id_idx on tweets (repost_of_id);
create index if not exists tweets_created_at_idx on tweets (created_at);

create table if not exists likes (
  tweet_id   uuid not null references tweets(id) on delete cascade,
  user_id    uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (tweet_id, user_id)
);

create index if not exists likes_user_id_idx on likes (user_id);

create table if not exists comments (
  id         uuid primary key,
  tweet_id   uuid not null references tweets(id) on delete cascade,
  user_id    uuid not null references users(id),
  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists comments_tweet_id_idx on comments (tweet_id);
create index if not exists comments_user_id_idx on comments (user_id);

create table if not exists reactions (
  tweet_id   uuid not null references tweets(id) on delete cascade,
  user_id    uuid not null references users(id),
  emoji      text not null,
  created_at timestamptz not null default now(),
  primary key (tweet_id, user_id, emoji)
);

create table if not exists blocks (
  blocker_id uuid not null references users(id),
  blocked_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_no_self_block check (blocker_id <> blocked_id)
);

create index if not exists blocks_blocked_id_idx on blocks (blocked_id);

create table if not exists messages (
  id           uuid primary key,
  from_user_id uuid not null references users(id),
  to_user_id   uuid not null references users(id),
  body         text not null,
  created_at   timestamptz not null default now()
);

create index if not exists messages_from_user_id_idx on messages (from_user_id);
create index if not exists messages_to_user_id_idx on messages (to_user_id);

create table if not exists notifications (
  id         uuid primary key,
  recipient_id uuid not null references users(id),
  type       text not null check (type in ('like', 'comment', 'repost', 'reaction', 'follow')),
  actor_id   uuid not null references users(id),
  tweet_id   uuid references tweets(id) on delete set null,
  body       text,
  created_at timestamptz not null default now(),
  read       boolean not null default false
);

create index if not exists notifications_recipient_id_idx on notifications (recipient_id);

-- The tables above already existed (created before these ON DELETE actions
-- were added), so `create table if not exists` won't retroactively apply
-- them. Idempotent ALTER pass for already-provisioned databases.
alter table likes drop constraint if exists likes_tweet_id_fkey;
alter table likes add constraint likes_tweet_id_fkey
  foreign key (tweet_id) references tweets(id) on delete cascade;

alter table comments drop constraint if exists comments_tweet_id_fkey;
alter table comments add constraint comments_tweet_id_fkey
  foreign key (tweet_id) references tweets(id) on delete cascade;

alter table reactions drop constraint if exists reactions_tweet_id_fkey;
alter table reactions add constraint reactions_tweet_id_fkey
  foreign key (tweet_id) references tweets(id) on delete cascade;

alter table tweets drop constraint if exists tweets_repost_of_id_fkey;
alter table tweets add constraint tweets_repost_of_id_fkey
  foreign key (repost_of_id) references tweets(id) on delete cascade;

alter table tweets drop constraint if exists tweets_reply_to_id_fkey;
alter table tweets add constraint tweets_reply_to_id_fkey
  foreign key (reply_to_id) references tweets(id) on delete set null;

alter table notifications drop constraint if exists notifications_tweet_id_fkey;
alter table notifications add constraint notifications_tweet_id_fkey
  foreign key (tweet_id) references tweets(id) on delete set null;

alter table follows drop constraint if exists follows_no_self_follow;
alter table follows add constraint follows_no_self_follow check (follower_id <> following_id);

alter table blocks drop constraint if exists blocks_no_self_block;
alter table blocks add constraint blocks_no_self_block check (blocker_id <> blocked_id);

-- Move password_hash off users onto user_credentials. Guarded by an
-- information_schema check (not just IF EXISTS on the DROP) because the
-- INSERT itself references users.password_hash — on a database where this
-- has already run, that column is gone and the INSERT would fail to plan.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'password_hash'
  ) then
    insert into user_credentials (user_id, password_hash)
    select id, password_hash from users
    where password_hash is not null
    on conflict (user_id) do nothing;

    alter table users drop column password_hash;
  end if;
end $$;

-- Restricted application role: normal table access, but no BYPASSRLS (so
-- future RLS policies actually apply to it) and zero direct access to
-- user_credentials. Login/signup reach password_hash only through the two
-- SECURITY DEFINER functions below — created without a password: run
-- `ALTER ROLE app_user WITH PASSWORD '...'` yourself, once, out of band.
-- A real password has no business living in a file this project commits to
-- git.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user;
  end if;
end $$;

-- Re-asserted every run so the role's attributes can't silently drift from
-- what's declared here (password is untouched — not listed below). Omits
-- NOSUPERUSER: Supabase's supautils blocks any ALTER ROLE that so much as
-- names the SUPERUSER attribute from a non-superuser caller, even to set
-- the value a freshly-created role already has by default.
alter role app_user with login nocreatedb nocreaterole nobypassrls noreplication;

grant connect on database postgres to app_user;
grant usage on schema public to app_user;

-- auth.uid()/auth.role()/etc already grant EXECUTE to PUBLIC on this
-- database, but PUBLIC does not have USAGE on the auth schema itself, and
-- postgres (the role that applies this schema) was never given that
-- privilege WITH GRANT OPTION — a direct `grant usage on schema auth`
-- silently no-ops. Supabase's `authenticated` role already has it, so
-- membership inherits it. That normally would also inherit authenticated's
-- own blanket table grants (every table in public, including
-- user_credentials — a Supabase default-privilege convention, not
-- something this app set up), but user_credentials has row level security
-- enabled with zero policies (see below) and stays that way permanently —
-- RLS's default-deny beats any inherited table grant, so this membership
-- never actually exposes it.
grant authenticated to app_user;

grant select, insert, update, delete on
  users, follows, tweets, likes, comments, reactions, blocks, messages, notifications
  to app_user;

-- Table grants above cover every table except this one, on purpose — but
-- state it explicitly rather than relying on "never granted" to hold. Left
-- unreachable twice over: no grant, and (see below) no RLS policy either.
revoke all on user_credentials from app_user;

-- Every table in this project has RLS enabled with zero policies — not
-- something this migration turned on: Supabase's `ensure_rls` event
-- trigger auto-enables it on every new table. It's only ever been inert
-- because every connection so far has used postgres, which has BYPASSRLS.
-- app_user deliberately doesn't, so without policies here it would get zero
-- rows from every table the moment it's used. These policies are a
-- placeholder, not real row-level access control — USING (true) restores
-- exactly today's unrestricted behavior. Replace with real per-user rules
-- when RLS is actually designed; user_credentials is deliberately excluded
-- and must stay that way — it has no legitimate row-level rule to write,
-- only the two SECURITY DEFINER functions below should ever touch it.
do $$
declare
  t text;
begin
  foreach t in array array['users','follows','tweets','likes','comments','reactions','blocks','messages','notifications']
  loop
    execute format('drop policy if exists app_user_placeholder_allow_all on %I', t);
    execute format(
      'create policy app_user_placeholder_allow_all on %I for all to app_user using (true) with check (true)',
      t
    );
  end loop;
end $$;

-- Runs as its owner (whichever role applies this schema — currently
-- postgres), so it can read user_credentials even though app_user itself
-- has no grant on that table. search_path is locked down so it can't be
-- redirected by a same-named function/table earlier in another search
-- path.
create or replace function get_password_hash_for_login(p_email text)
returns table (
  id uuid,
  email text,
  handle text,
  password_hash text,
  created_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select u.id, u.email, u.handle, c.password_hash, u.created_at
  from users u
  join user_credentials c on c.user_id = u.id
  where u.email = p_email
$$;

revoke all on function get_password_hash_for_login(text) from public;
grant execute on function get_password_hash_for_login(text) to app_user;

-- Symmetric with the read side: signup's insert into user_credentials also
-- can't go through app_user directly once it has zero grants on that table.
create or replace function create_user_credentials(p_user_id uuid, p_password_hash text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into user_credentials (user_id, password_hash)
  values (p_user_id, p_password_hash)
$$;

revoke all on function create_user_credentials(uuid, text) from public;
grant execute on function create_user_credentials(uuid, text) to app_user;
