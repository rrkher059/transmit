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
  primary key (follower_id, following_id)
);

create index if not exists follows_following_id_idx on follows (following_id);

create table if not exists tweets (
  id           uuid primary key,
  user_id      uuid not null references users(id),
  body         text not null default '',
  image_url    text,
  reply_to_id  uuid references tweets(id),
  repost_of_id uuid references tweets(id),
  tags         text[] not null default '{}',
  created_at   timestamptz not null default now()
);

create index if not exists tweets_user_id_idx on tweets (user_id);
create index if not exists tweets_repost_of_id_idx on tweets (repost_of_id);
create index if not exists tweets_created_at_idx on tweets (created_at);

create table if not exists likes (
  tweet_id   uuid not null references tweets(id),
  user_id    uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (tweet_id, user_id)
);

create index if not exists likes_user_id_idx on likes (user_id);

create table if not exists comments (
  id         uuid primary key,
  tweet_id   uuid not null references tweets(id),
  user_id    uuid not null references users(id),
  body       text not null,
  created_at timestamptz not null default now()
);

create index if not exists comments_tweet_id_idx on comments (tweet_id);
create index if not exists comments_user_id_idx on comments (user_id);

create table if not exists reactions (
  tweet_id   uuid not null references tweets(id),
  user_id    uuid not null references users(id),
  emoji      text not null,
  created_at timestamptz not null default now(),
  primary key (tweet_id, user_id, emoji)
);

create table if not exists blocks (
  blocker_id uuid not null references users(id),
  blocked_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
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
  tweet_id   uuid references tweets(id),
  body       text,
  created_at timestamptz not null default now(),
  read       boolean not null default false
);

create index if not exists notifications_recipient_id_idx on notifications (recipient_id);
