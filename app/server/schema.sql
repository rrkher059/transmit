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
  password_hash text not null,
  created_at    timestamptz not null default now()
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
