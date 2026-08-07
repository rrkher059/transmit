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
-- app_user deliberately doesn't. user_credentials is deliberately excluded
-- from all of this and must stay that way — it has no legitimate
-- row-level rule to write, only the two SECURITY DEFINER functions above
-- should ever touch it. blocks keeps its placeholder allow-all policy —
-- block-aware visibility is a separate, later step, not this one.
drop policy if exists app_user_placeholder_allow_all on users;
drop policy if exists app_user_placeholder_allow_all on follows;
drop policy if exists app_user_placeholder_allow_all on tweets;
drop policy if exists app_user_placeholder_allow_all on likes;
drop policy if exists app_user_placeholder_allow_all on comments;
drop policy if exists app_user_placeholder_allow_all on reactions;
drop policy if exists app_user_placeholder_allow_all on messages;
drop policy if exists app_user_placeholder_allow_all on notifications;

-- tweets / comments / likes / reactions / follows: reads are open to
-- everyone, including guests (auth.uid() is null for them, never `using
-- (auth.uid() is not null)`) — this app serves public feeds and profiles to
-- logged-out visitors (GET /api/tweets, /api/users/:id/tweets|likes|replies
-- |follow-stats, /api/explore/trending all read these tables without
-- requiring a session). Writes are ownership-gated; guests are excluded
-- from those for free since auth.uid() = NULL never equals a real id.

drop policy if exists tweets_select_public on tweets;
drop policy if exists tweets_insert_own on tweets;
drop policy if exists tweets_delete_own on tweets;
create policy tweets_select_public on tweets for select to app_user using (true);
create policy tweets_insert_own on tweets for insert to app_user with check (auth.uid() = user_id);
create policy tweets_delete_own on tweets for delete to app_user using (auth.uid() = user_id);

drop policy if exists comments_select_public on comments;
drop policy if exists comments_insert_own on comments;
drop policy if exists comments_delete_own on comments;
create policy comments_select_public on comments for select to app_user using (true);
create policy comments_insert_own on comments for insert to app_user with check (auth.uid() = user_id);
create policy comments_delete_own on comments for delete to app_user using (auth.uid() = user_id);

drop policy if exists likes_select_public on likes;
drop policy if exists likes_insert_own on likes;
drop policy if exists likes_delete_own on likes;
create policy likes_select_public on likes for select to app_user using (true);
create policy likes_insert_own on likes for insert to app_user with check (auth.uid() = user_id);
create policy likes_delete_own on likes for delete to app_user using (auth.uid() = user_id);

drop policy if exists reactions_select_public on reactions;
drop policy if exists reactions_insert_own on reactions;
drop policy if exists reactions_delete_own on reactions;
create policy reactions_select_public on reactions for select to app_user using (true);
create policy reactions_insert_own on reactions for insert to app_user with check (auth.uid() = user_id);
create policy reactions_delete_own on reactions for delete to app_user using (auth.uid() = user_id);

-- "Yourself" here is the follower side — you can only create or remove a
-- follow edge where you are the one doing the following.
drop policy if exists follows_select_public on follows;
drop policy if exists follows_insert_own on follows;
drop policy if exists follows_delete_own on follows;
create policy follows_select_public on follows for select to app_user using (true);
create policy follows_insert_own on follows for insert to app_user with check (auth.uid() = follower_id);
create policy follows_delete_own on follows for delete to app_user using (auth.uid() = follower_id);

-- users: profiles are public reads, same reasoning as above (guest profile
-- pages need this). Updates are owner-only. Insert has no ownership check
-- (with check (true)) because signup itself creates this row before any
-- session/JWT exists — auth.uid() is always null at that point, by
-- construction, so an ownership check here would block every signup. The
-- row is inert without a matching user_credentials row, which only
-- create_user_credentials() (SECURITY DEFINER, above) can write.
drop policy if exists users_select_public on users;
drop policy if exists users_insert_signup on users;
drop policy if exists users_update_own on users;
create policy users_select_public on users for select to app_user using (true);
create policy users_insert_signup on users for insert to app_user with check (true);
create policy users_update_own on users for update to app_user using (auth.uid() = id) with check (auth.uid() = id);

-- messages: already 401-gated for guests at the app layer (GET
-- /api/messages, /api/messages/:peerId, POST /api/messages all require a
-- session), so there's no guest-facing read to preserve here.
drop policy if exists messages_select_participant on messages;
drop policy if exists messages_insert_as_sender on messages;
create policy messages_select_participant on messages for select to app_user
  using (auth.uid() = from_user_id or auth.uid() = to_user_id);
create policy messages_insert_as_sender on messages for insert to app_user
  with check (auth.uid() = from_user_id);

-- notifications: also already 401-gated for guests at the app layer. Insert
-- is "as yourself" in actor terms — you can create a notification for any
-- recipient, but only with yourself as the actor, not impersonating someone
-- else's action.
drop policy if exists notifications_select_recipient on notifications;
drop policy if exists notifications_update_recipient on notifications;
drop policy if exists notifications_insert_as_actor on notifications;
create policy notifications_select_recipient on notifications for select to app_user
  using (auth.uid() = recipient_id);
create policy notifications_update_recipient on notifications for update to app_user
  using (auth.uid() = recipient_id) with check (auth.uid() = recipient_id);
create policy notifications_insert_as_actor on notifications for insert to app_user
  with check (auth.uid() = actor_id);

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
