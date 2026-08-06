import { randomUUID } from 'node:crypto'
import {
  createTweetSchema,
  reactTweetSchema,
  type Tweet,
} from '../shared/schemas.ts'
import { getSql } from './db.ts'

function httpError(message: string, status: number, code?: string): Error {
  const error = new Error(message)
  ;(error as Error & { status: number; code?: string }).status = status
  if (code) (error as Error & { status: number; code?: string }).code = code
  return error
}

/** Public landing feed — recent originals only (no follower-gated reposts). */
export async function getPublicFeed(): Promise<Tweet[]> {
  const sql = getSql()
  return sql<Tweet[]>`
    select
      t.id,
      t.body,
      u.handle,
      t.user_id as "userId",
      to_char(t.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
      (select count(*)::int from likes l where l.tweet_id = t.id) as likes,
      false as liked,
      t.image_url as "imageUrl",
      t.reply_to_id as "replyToId",
      null::uuid as "repostOfId",
      null::text as "repostOfHandle",
      (select count(*)::int from tweets r where r.repost_of_id = t.id) as "repostCount",
      false as reposted,
      coalesce(t.tags, '{}') as tags,
      coalesce((
        select json_agg(json_build_object(
          'id', c.id,
          'body', c.body,
          'handle', cu.handle,
          'userId', c.user_id,
          'createdAt', to_char(c.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) order by c.created_at)
        from comments c join users cu on cu.id = c.user_id
        where c.tweet_id = t.id
      ), '[]') as comments,
      coalesce((
        select json_agg(json_build_object('emoji', r.emoji, 'userId', r.user_id) order by r.created_at)
        from reactions r
        where r.tweet_id = t.id
      ), '[]') as reactions
    from tweets t
    join users u on u.id = t.user_id
    where t.created_at >= now() - interval '24 hours'
      and t.repost_of_id is null
    order by t.created_at desc
  `
}

/** Your posts + up to 5 random posts from everyone else (non-expired).
 * Others' reposts only appear if you follow the reposter. "5 random others"
 * uses SQL `order by random()` — a uniform random sample.
 */
export async function getFeedForUser(userId: string): Promise<Tweet[]> {
  const sql = getSql()
  return sql<Tweet[]>`
    with live as (
      select * from tweets where created_at >= now() - interval '24 hours'
    ),
    mine as (
      select * from live where user_id = ${userId}
    ),
    others as (
      select o.* from live o
      where o.user_id is not null
        and o.user_id <> ${userId}
        and (
          o.repost_of_id is null
          or exists (
            select 1 from follows f
            where f.follower_id = ${userId} and f.following_id = o.user_id
          )
        )
    ),
    random_others as (
      select * from others order by random() limit 5
    ),
    feed as (
      select * from mine
      union all
      select * from random_others
    )
    select
      f.id,
      f.body,
      u.handle,
      f.user_id as "userId",
      to_char(f.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
      (select count(*)::int from likes l where l.tweet_id = f.id) as likes,
      exists(select 1 from likes l where l.tweet_id = f.id and l.user_id = ${userId}) as liked,
      f.image_url as "imageUrl",
      f.reply_to_id as "replyToId",
      f.repost_of_id as "repostOfId",
      ru.handle as "repostOfHandle",
      (select count(*)::int from tweets r where r.repost_of_id = f.id) as "repostCount",
      exists(select 1 from tweets r where r.repost_of_id = f.id and r.user_id = ${userId}) as reposted,
      coalesce(f.tags, '{}') as tags,
      coalesce((
        select json_agg(json_build_object(
          'id', c.id,
          'body', c.body,
          'handle', cu.handle,
          'userId', c.user_id,
          'createdAt', to_char(c.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) order by c.created_at)
        from comments c join users cu on cu.id = c.user_id
        where c.tweet_id = f.id
      ), '[]') as comments,
      coalesce((
        select json_agg(json_build_object('emoji', r.emoji, 'userId', r.user_id) order by r.created_at)
        from reactions r
        where r.tweet_id = f.id
      ), '[]') as reactions
    from feed f
    join users u on u.id = f.user_id
    left join tweets ot on ot.id = f.repost_of_id
    left join users ru on ru.id = ot.user_id
    order by f.created_at desc
  `
}

/** Full timeline for a profile (originals, replies, and reposts). */
export async function listTweetsByUser(
  profileUserId: string,
  viewerId?: string,
): Promise<Tweet[]> {
  const sql = getSql()
  return sql<Tweet[]>`
    select
      t.id,
      t.body,
      u.handle,
      t.user_id as "userId",
      to_char(t.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
      (select count(*)::int from likes l where l.tweet_id = t.id) as likes,
      exists(select 1 from likes l where l.tweet_id = t.id and l.user_id = ${viewerId ?? null}::uuid) as liked,
      t.image_url as "imageUrl",
      t.reply_to_id as "replyToId",
      t.repost_of_id as "repostOfId",
      ru.handle as "repostOfHandle",
      (select count(*)::int from tweets r where r.repost_of_id = t.id) as "repostCount",
      exists(select 1 from tweets r where r.repost_of_id = t.id and r.user_id = ${viewerId ?? null}::uuid) as reposted,
      coalesce(t.tags, '{}') as tags,
      coalesce((
        select json_agg(json_build_object(
          'id', c.id,
          'body', c.body,
          'handle', cu.handle,
          'userId', c.user_id,
          'createdAt', to_char(c.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) order by c.created_at)
        from comments c join users cu on cu.id = c.user_id
        where c.tweet_id = t.id
      ), '[]') as comments,
      coalesce((
        select json_agg(json_build_object('emoji', r.emoji, 'userId', r.user_id) order by r.created_at)
        from reactions r
        where r.tweet_id = t.id
      ), '[]') as reactions
    from tweets t
    join users u on u.id = t.user_id
    left join tweets ot on ot.id = t.repost_of_id
    left join users ru on ru.id = ot.user_id
    where t.user_id = ${profileUserId}
      and t.created_at >= now() - interval '24 hours'
    order by t.created_at desc
  `
}

/** Tweets liked by this profile user (any author). */
export async function listTweetsLikedByUser(
  profileUserId: string,
  viewerId?: string,
): Promise<Tweet[]> {
  const sql = getSql()
  return sql<Tweet[]>`
    select
      t.id,
      t.body,
      u.handle,
      t.user_id as "userId",
      to_char(t.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
      (select count(*)::int from likes l where l.tweet_id = t.id) as likes,
      exists(select 1 from likes l where l.tweet_id = t.id and l.user_id = ${viewerId ?? null}::uuid) as liked,
      t.image_url as "imageUrl",
      t.reply_to_id as "replyToId",
      t.repost_of_id as "repostOfId",
      ru.handle as "repostOfHandle",
      (select count(*)::int from tweets r where r.repost_of_id = t.id) as "repostCount",
      exists(select 1 from tweets r where r.repost_of_id = t.id and r.user_id = ${viewerId ?? null}::uuid) as reposted,
      coalesce(t.tags, '{}') as tags,
      coalesce((
        select json_agg(json_build_object(
          'id', c.id,
          'body', c.body,
          'handle', cu.handle,
          'userId', c.user_id,
          'createdAt', to_char(c.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) order by c.created_at)
        from comments c join users cu on cu.id = c.user_id
        where c.tweet_id = t.id
      ), '[]') as comments,
      coalesce((
        select json_agg(json_build_object('emoji', r.emoji, 'userId', r.user_id) order by r.created_at)
        from reactions r
        where r.tweet_id = t.id
      ), '[]') as reactions
    from tweets t
    join users u on u.id = t.user_id
    join likes pl on pl.tweet_id = t.id and pl.user_id = ${profileUserId}
    left join tweets ot on ot.id = t.repost_of_id
    left join users ru on ru.id = ot.user_id
    where t.created_at >= now() - interval '24 hours'
    order by t.created_at desc
  `
}

/** Profile replies: union of (a) real reply-tweets authored by the profile
 * and (b) the profile's comments on other tweets, projected as zeroed-out
 * pseudo-tweets — comments can't be liked/reacted/commented-on themselves
 * in this app's data model.
 */
export async function listRepliesByUser(
  profileUserId: string,
  viewerId?: string,
): Promise<Tweet[]> {
  const sql = getSql()
  return sql<Tweet[]>`
    (
      select
        t.id,
        t.body,
        u.handle,
        t.user_id as "userId",
        to_char(t.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
        (select count(*)::int from likes l where l.tweet_id = t.id) as likes,
        exists(select 1 from likes l where l.tweet_id = t.id and l.user_id = ${viewerId ?? null}::uuid) as liked,
        t.image_url as "imageUrl",
        t.reply_to_id as "replyToId",
        t.repost_of_id as "repostOfId",
        ru.handle as "repostOfHandle",
        (select count(*)::int from tweets r where r.repost_of_id = t.id) as "repostCount",
        exists(select 1 from tweets r where r.repost_of_id = t.id and r.user_id = ${viewerId ?? null}::uuid) as reposted,
        coalesce(t.tags, '{}') as tags,
        coalesce((
          select json_agg(json_build_object(
            'id', c.id,
            'body', c.body,
            'handle', cu.handle,
            'userId', c.user_id,
            'createdAt', to_char(c.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ) order by c.created_at)
          from comments c join users cu on cu.id = c.user_id
          where c.tweet_id = t.id
        ), '[]') as comments,
        coalesce((
          select json_agg(json_build_object('emoji', r.emoji, 'userId', r.user_id) order by r.created_at)
          from reactions r
          where r.tweet_id = t.id
        ), '[]') as reactions
      from tweets t
      join users u on u.id = t.user_id
      left join tweets ot on ot.id = t.repost_of_id
      left join users ru on ru.id = ot.user_id
      where t.user_id = ${profileUserId}
        and t.reply_to_id is not null
        and t.created_at >= now() - interval '24 hours'
    )
    union all
    (
      select
        c.id,
        c.body,
        cu.handle,
        c.user_id as "userId",
        to_char(c.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
        0 as likes,
        false as liked,
        null::text as "imageUrl",
        pt.id as "replyToId",
        null::uuid as "repostOfId",
        null::text as "repostOfHandle",
        0 as "repostCount",
        false as reposted,
        '{}'::text[] as tags,
        '[]'::json as comments,
        '[]'::json as reactions
      from comments c
      join users cu on cu.id = c.user_id
      join tweets pt on pt.id = c.tweet_id
      where c.user_id = ${profileUserId}
        and pt.created_at >= now() - interval '24 hours'
    )
    order by "createdAt" desc
  `
}

/** All live tweets, guest-context (liked/reposted always false — matches
 * this endpoint's historical behavior of never reflecting a specific
 * viewer). Used for AI ranking (semanticSearchTweets) and as the AI
 * companion's feed fallback, both of which need full Tweet objects, not a
 * projection.
 */
export async function listLiveTweets(): Promise<Tweet[]> {
  const sql = getSql()
  return sql<Tweet[]>`
    select
      t.id,
      t.body,
      u.handle,
      t.user_id as "userId",
      to_char(t.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
      (select count(*)::int from likes l where l.tweet_id = t.id) as likes,
      false as liked,
      t.image_url as "imageUrl",
      t.reply_to_id as "replyToId",
      t.repost_of_id as "repostOfId",
      ru.handle as "repostOfHandle",
      (select count(*)::int from tweets r where r.repost_of_id = t.id) as "repostCount",
      false as reposted,
      coalesce(t.tags, '{}') as tags,
      coalesce((
        select json_agg(json_build_object(
          'id', c.id,
          'body', c.body,
          'handle', cu.handle,
          'userId', c.user_id,
          'createdAt', to_char(c.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) order by c.created_at)
        from comments c join users cu on cu.id = c.user_id
        where c.tweet_id = t.id
      ), '[]') as comments,
      coalesce((
        select json_agg(json_build_object('emoji', r.emoji, 'userId', r.user_id) order by r.created_at)
        from reactions r
        where r.tweet_id = t.id
      ), '[]') as reactions
    from tweets t
    join users u on u.id = t.user_id
    left join tweets ot on ot.id = t.repost_of_id
    left join users ru on ru.id = ot.user_id
    where t.created_at >= now() - interval '24 hours'
    order by t.created_at desc
  `
}

/** Live post count, for /api/stats. A dedicated count query rather than
 * listLiveTweets().length — stats only ever needed the number.
 */
export async function countLiveTweets(): Promise<number> {
  const sql = getSql()
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from tweets
    where created_at >= now() - interval '24 hours'
  `
  return row.count
}

/** Plain substring search over body/handle/tags, newest first, capped at 40
 * — matches the tag search joining tags into a single string and checking
 * substring (not per-tag exact match), same as the query used to build it.
 */
export async function searchTweets(query: string): Promise<Tweet[]> {
  const q = query.trim().toLowerCase()
  const tagNeedle = q.replace(/^#/, '')
  const hashNeedle = `#${tagNeedle}`

  const sql = getSql()
  return sql<Tweet[]>`
    select
      t.id,
      t.body,
      u.handle,
      t.user_id as "userId",
      to_char(t.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
      (select count(*)::int from likes l where l.tweet_id = t.id) as likes,
      false as liked,
      t.image_url as "imageUrl",
      t.reply_to_id as "replyToId",
      t.repost_of_id as "repostOfId",
      ru.handle as "repostOfHandle",
      (select count(*)::int from tweets r where r.repost_of_id = t.id) as "repostCount",
      false as reposted,
      coalesce(t.tags, '{}') as tags,
      coalesce((
        select json_agg(json_build_object(
          'id', c.id,
          'body', c.body,
          'handle', cu.handle,
          'userId', c.user_id,
          'createdAt', to_char(c.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) order by c.created_at)
        from comments c join users cu on cu.id = c.user_id
        where c.tweet_id = t.id
      ), '[]') as comments,
      coalesce((
        select json_agg(json_build_object('emoji', r.emoji, 'userId', r.user_id) order by r.created_at)
        from reactions r
        where r.tweet_id = t.id
      ), '[]') as reactions
    from tweets t
    join users u on u.id = t.user_id
    left join tweets ot on ot.id = t.repost_of_id
    left join users ru on ru.id = ot.user_id
    where t.created_at >= now() - interval '24 hours'
      and (
        ${q} = ''
        or position(${q} in lower(t.body)) > 0
        or position(${q} in lower(u.handle)) > 0
        or position(${tagNeedle} in lower(array_to_string(t.tags, ' '))) > 0
        or position(${hashNeedle} in lower(t.body)) > 0
      )
    order by t.created_at desc
    limit 40
  `
}

export type TrendingTopic = {
  hashtag: string
  category: string
  postCount: number
}

function categorizeHashtag(tag: string): string {
  const t = tag.toLowerCase()
  if (/mars|kuiper|europa|orbit|space|moon|zvezda/.test(t)) return 'Mission'
  if (/travel|tokyo|flight|boarding|air/.test(t)) return 'Transit'
  if (/lab|research|farnsworth|mercury|data/.test(t)) return 'Research'
  if (/signal|transmit|hud|ops|feed/.test(t)) return 'Comms'
  return 'General'
}

function normalizeTrendingTag(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32)
  return cleaned ? `#${cleaned}` : null
}

/** Hashtag/tag counting and categorization is plain text processing that
 * doesn't belong in SQL — only the data source changed here. Fetches just
 * body/tags (not the full Tweet shape) since that's all this needs.
 */
export async function getTrendingTopics(limit = 8): Promise<TrendingTopic[]> {
  const sql = getSql()
  const tweets = await sql<{ body: string; tags: string[] }[]>`
    select body, coalesce(tags, '{}') as tags
    from tweets
    where created_at >= now() - interval '24 hours'
  `

  const counts = new Map<string, number>()

  for (const tweet of tweets) {
    // Count unique tags per post so body #hashtags and AI `tags` both drive
    // Explore trending without double-counting the same topic on one tweet.
    const seen = new Set<string>()

    const bodyMatches = tweet.body.match(/#[\p{L}\p{N}_-]+/gu) ?? []
    for (const raw of bodyMatches) {
      const tag = normalizeTrendingTag(raw)
      if (tag) seen.add(tag)
    }

    for (const raw of tweet.tags ?? []) {
      const tag = normalizeTrendingTag(raw)
      if (tag) seen.add(tag)
    }

    for (const tag of seen) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }

  // Seed topics when the channel is quiet so Explore still reads as live.
  if (counts.size === 0) {
    return [
      { hashtag: '#kuiperalpha', category: 'Mission', postCount: 0 },
      { hashtag: '#marslanding', category: 'Mission', postCount: 0 },
      { hashtag: '#signalops', category: 'Comms', postCount: 0 },
      { hashtag: '#newtokyo', category: 'Transit', postCount: 0 },
      { hashtag: '#mercurylabs', category: 'Research', postCount: 0 },
    ].slice(0, limit)
  }

  return [...counts.entries()]
    .map(([hashtag, postCount]) => ({
      hashtag,
      category: categorizeHashtag(hashtag),
      postCount,
    }))
    .sort((a, b) => b.postCount - a.postCount || a.hashtag.localeCompare(b.hashtag))
    .slice(0, limit)
}

/** No `handle` param — tweets has no handle column, so the response's
 * handle comes from joining users, same as every other read here.
 */
export async function createTweet(input: {
  body: string
  userId: string
  imageUrl?: string
  replyToId?: string
  tags?: string[]
}): Promise<Tweet> {
  const data = createTweetSchema.parse({
    body: input.body,
    imageUrl: input.imageUrl,
    replyToId: input.replyToId,
  })

  const tags = (input.tags ?? [])
    .map((tag) =>
      tag
        .trim()
        .toLowerCase()
        .replace(/^#/, '')
        .slice(0, 32),
    )
    .filter(Boolean)
    .slice(0, 4)

  const sql = getSql()

  if (data.replyToId) {
    const [parent] = await sql`
      select exists(
        select 1 from tweets
        where id = ${data.replyToId}
          and created_at >= now() - interval '24 hours'
      ) as "exists"
    `
    if (!parent.exists) throw httpError('Parent post not found.', 404)
  }

  const [row] = await sql<Tweet[]>`
    with inserted as (
      insert into tweets (id, user_id, body, image_url, reply_to_id, tags)
      values (
        ${randomUUID()}, ${input.userId}, ${data.body},
        ${data.imageUrl ?? null}, ${data.replyToId ?? null}, ${tags}
      )
      returning id, user_id, body, image_url, reply_to_id, repost_of_id, tags, created_at
    )
    select
      inserted.id,
      inserted.body,
      u.handle,
      inserted.user_id as "userId",
      to_char(inserted.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
      0 as likes,
      false as liked,
      inserted.image_url as "imageUrl",
      inserted.reply_to_id as "replyToId",
      inserted.repost_of_id as "repostOfId",
      null::text as "repostOfHandle",
      0 as "repostCount",
      false as reposted,
      coalesce(inserted.tags, '{}') as tags,
      '[]'::json as comments,
      '[]'::json as reactions
    from inserted
    join users u on u.id = inserted.user_id
  `
  return row
}

/** Fetch one tweet in full response shape (handle joined, counts/viewer
 * flags computed live) — shared by every mutation below so they don't each
 * re-derive the same read after writing.
 */
async function fetchTweetForViewer(
  sql: ReturnType<typeof getSql>,
  tweetId: string,
  viewerId: string,
): Promise<Tweet> {
  const [row] = await sql<Tweet[]>`
    select
      t.id,
      t.body,
      u.handle,
      t.user_id as "userId",
      to_char(t.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
      (select count(*)::int from likes l where l.tweet_id = t.id) as likes,
      exists(select 1 from likes l where l.tweet_id = t.id and l.user_id = ${viewerId}::uuid) as liked,
      t.image_url as "imageUrl",
      t.reply_to_id as "replyToId",
      t.repost_of_id as "repostOfId",
      ru.handle as "repostOfHandle",
      (select count(*)::int from tweets r where r.repost_of_id = t.id) as "repostCount",
      exists(select 1 from tweets r where r.repost_of_id = t.id and r.user_id = ${viewerId}::uuid) as reposted,
      coalesce(t.tags, '{}') as tags,
      coalesce((
        select json_agg(json_build_object(
          'id', c.id,
          'body', c.body,
          'handle', cu.handle,
          'userId', c.user_id,
          'createdAt', to_char(c.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) order by c.created_at)
        from comments c join users cu on cu.id = c.user_id
        where c.tweet_id = t.id
      ), '[]') as comments,
      coalesce((
        select json_agg(json_build_object('emoji', r.emoji, 'userId', r.user_id) order by r.created_at)
        from reactions r
        where r.tweet_id = t.id
      ), '[]') as reactions
    from tweets t
    join users u on u.id = t.user_id
    left join tweets ot on ot.id = t.repost_of_id
    left join users ru on ru.id = ot.user_id
    where t.id = ${tweetId}
  `
  return row
}

/** No `handle` param — joined from users on read. */
export async function commentOnTweet(input: {
  tweetId: string
  body: string
  userId: string
}): Promise<{ tweet: Tweet; ownerId?: string }> {
  const sql = getSql()

  const [parent] = await sql<{ user_id: string }[]>`
    select user_id from tweets
    where id = ${input.tweetId} and created_at >= now() - interval '24 hours'
  `
  if (!parent) throw httpError('Tweet not found.', 404)

  await sql`
    insert into comments (id, tweet_id, user_id, body)
    values (${randomUUID()}, ${input.tweetId}, ${input.userId}, ${input.body.trim()})
  `

  const tweet = await fetchTweetForViewer(sql, input.tweetId, input.userId)
  return { tweet, ownerId: parent.user_id }
}

/** Create a repost entry attributed to the current user. Redirect-to-root
 * with fallback: reposting a repost attributes to the root post, UNLESS the
 * root has since expired, in which case it falls back to reposting the
 * (still-live) repost row itself rather than erroring.
 */
export async function repostTweet(input: {
  tweetId: string
  userId: string
}): Promise<{ original: Tweet; repost: Tweet; ownerId?: string }> {
  const sql = getSql()

  type TargetRow = {
    id: string
    user_id: string
    body: string
    image_url: string | null
    tags: string[]
  }

  const [requested] = await sql<
    (TargetRow & { repost_of_id: string | null })[]
  >`
    select id, user_id, repost_of_id, body, image_url, tags
    from tweets
    where id = ${input.tweetId} and created_at >= now() - interval '24 hours'
  `
  if (!requested) throw httpError('Tweet not found.', 404)

  let target: TargetRow = requested
  if (requested.repost_of_id) {
    const [root] = await sql<TargetRow[]>`
      select id, user_id, body, image_url, tags
      from tweets
      where id = ${requested.repost_of_id} and created_at >= now() - interval '24 hours'
    `
    if (root) target = root
  }

  const [already] = await sql<{ exists: boolean }[]>`
    select exists(
      select 1 from tweets
      where user_id = ${input.userId} and repost_of_id = ${target.id}
    ) as "exists"
  `
  if (already.exists) {
    throw httpError('Already reposted.', 409, 'ALREADY_REPOSTED')
  }

  const repostId = randomUUID()
  await sql`
    insert into tweets (id, user_id, body, image_url, reply_to_id, repost_of_id, tags)
    values (
      ${repostId}, ${input.userId}, ${target.body}, ${target.image_url},
      null, ${target.id}, ${target.tags}
    )
  `

  const original = await fetchTweetForViewer(sql, target.id, input.userId)
  const repost = await fetchTweetForViewer(sql, repostId, input.userId)
  return { original, repost, ownerId: target.user_id }
}

/** Toggle like for this viewer — delete-then-maybe-insert instead of a
 * separate EXISTS check first.
 */
export async function likeTweet(
  tweetId: string,
  viewerId: string,
): Promise<{ tweet: Tweet; justLiked: boolean; ownerId?: string }> {
  const sql = getSql()

  const [row] = await sql<{ user_id: string }[]>`
    select user_id from tweets
    where id = ${tweetId} and created_at >= now() - interval '24 hours'
  `
  if (!row) throw httpError('Tweet not found.', 404)

  const deleted = await sql`
    delete from likes where tweet_id = ${tweetId} and user_id = ${viewerId}
  `
  let justLiked: boolean
  if (deleted.count > 0) {
    justLiked = false
  } else {
    await sql`insert into likes (tweet_id, user_id) values (${tweetId}, ${viewerId})`
    justLiked = true
  }

  const tweet = await fetchTweetForViewer(sql, tweetId, viewerId)
  return { tweet, justLiked, ownerId: row.user_id }
}

/** Deleting the row is enough — schema.sql's ON DELETE CASCADE on
 * repost_of_id (and SET NULL on reply_to_id, likes/comments/reactions all
 * CASCADE) does the orphan cleanup declaratively.
 */
export async function deleteTweet(
  tweetId: string,
  userId: string,
): Promise<void> {
  const sql = getSql()

  const [row] = await sql<{ user_id: string }[]>`
    select user_id from tweets
    where id = ${tweetId} and created_at >= now() - interval '24 hours'
  `
  if (!row) throw httpError('Tweet not found.', 404)
  if (row.user_id !== userId) {
    throw httpError('You can only delete your own posts.', 403, 'FORBIDDEN')
  }

  await sql`delete from tweets where id = ${tweetId}`
}

/** Toggle an emoji reaction for this user (add if missing, remove if
 * present) — same delete-then-maybe-insert toggle as likeTweet, keyed on
 * (tweet_id, user_id, emoji).
 */
export async function reactToTweet(
  tweetId: string,
  userId: string,
  emojiRaw: string,
): Promise<{
  tweet: Tweet
  justAdded: boolean
  ownerId?: string
  emoji: string
}> {
  const { emoji } = reactTweetSchema.parse({ emoji: emojiRaw })
  const sql = getSql()

  const [row] = await sql<{ user_id: string }[]>`
    select user_id from tweets
    where id = ${tweetId} and created_at >= now() - interval '24 hours'
  `
  if (!row) throw httpError('Tweet not found.', 404)

  const deleted = await sql`
    delete from reactions
    where tweet_id = ${tweetId} and user_id = ${userId} and emoji = ${emoji}
  `
  let justAdded: boolean
  if (deleted.count > 0) {
    justAdded = false
  } else {
    await sql`
      insert into reactions (tweet_id, user_id, emoji) values (${tweetId}, ${userId}, ${emoji})
    `
    justAdded = true
  }

  const tweet = await fetchTweetForViewer(sql, tweetId, userId)
  return { tweet, justAdded, ownerId: row.user_id, emoji }
}
