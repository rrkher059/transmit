import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { TWEET_TTL_MS } from '../shared/constants.ts'
import {
  createTweetSchema,
  reactTweetSchema,
  tweetStoreSchema,
  type Tweet,
  type TweetStore,
} from '../shared/schemas.ts'
import { getSql } from './db.ts'
import { listFollowingIds } from './follows.ts'
import { DEFAULT_DATA_DIR, mutateJsonFile } from './jsonStore.ts'

function storePath(): string {
  return (
    process.env.TWEET_STORE_PATH ?? path.join(DEFAULT_DATA_DIR, 'tweets.json')
  )
}

const emptyStore = (): TweetStore => ({ tweets: [] })

function parseStore(raw: unknown): TweetStore {
  const parsed = tweetStoreSchema.safeParse(raw)
  if (!parsed.success) throw new Error('Tweet store is corrupt or invalid.')
  return parsed.data
}

function httpError(message: string, status: number, code?: string): Error {
  const error = new Error(message)
  ;(error as Error & { status: number; code?: string }).status = status
  if (code) (error as Error & { status: number; code?: string }).code = code
  return error
}

export function isTweetExpired(tweet: Tweet, now = Date.now()): boolean {
  const created = Date.parse(tweet.createdAt)
  if (Number.isNaN(created)) return true
  return now - created >= TWEET_TTL_MS
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function likedByOf(tweet: Tweet): string[] {
  return Array.isArray(tweet.likedBy) ? tweet.likedBy : []
}

/** Drop posts older than one day and persist if anything changed. */
export async function purgeExpired(): Promise<Tweet[]> {
  return mutateJsonFile(storePath(), emptyStore(), parseStore, (store) => {
    const now = Date.now()
    const live = store.tweets.filter((tweet) => !isTweetExpired(tweet, now))
    if (live.length === store.tweets.length) {
      return { store, result: live, dirty: false }
    }
    return { store: { tweets: live }, result: live }
  })
}

export async function readTweets(): Promise<Tweet[]> {
  return purgeExpired()
}

function annotateForViewer(
  tweets: Tweet[],
  userId: string | undefined,
  catalog: Tweet[] = tweets,
): Tweet[] {
  const myRepostTargets = new Set(
    userId
      ? catalog
          .filter((tweet) => tweet.userId === userId && tweet.repostOfId)
          .map((tweet) => tweet.repostOfId as string)
      : [],
  )
  return tweets.map((tweet) => {
    const likedBy = likedByOf(tweet)
    return {
      ...tweet,
      likedBy,
      likes: likedBy.length,
      reactions: tweet.reactions ?? [],
      comments: tweet.comments ?? [],
      tags: tweet.tags ?? [],
      imageUrl: tweet.imageUrl ?? null,
      replyToId: tweet.replyToId ?? null,
      repostOfId: tweet.repostOfId ?? null,
      repostOfHandle: tweet.repostOfHandle ?? null,
      repostCount: tweet.repostCount ?? 0,
      // Viewer-specific — never trust the persisted flag.
      liked: userId ? likedBy.includes(userId) : false,
      reposted: userId ? myRepostTargets.has(tweet.id) : false,
    }
  })
}

function annotateOne(
  tweet: Tweet,
  userId: string | undefined,
  catalog: Tweet[],
): Tweet {
  return annotateForViewer([tweet], userId, catalog)[0]
}

/** Public landing feed — recent originals only (no follower-gated reposts). */
export async function getPublicFeed(limit?: number): Promise<Tweet[]> {
  const tweets = await purgeExpired()
  const sorted = tweets
    .filter((tweet) => !tweet.repostOfId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const sliced = limit == null ? sorted : sorted.slice(0, limit)
  return sliced.map((tweet) => annotateOne(tweet, undefined, tweets))
}

/** Same as getPublicFeed(), but reads tweets/likes/comments/reactions from Postgres. */
export async function getPublicFeedFromDb(): Promise<Tweet[]> {
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
 * Others' reposts only appear if you follow the reposter.
 */
export async function getFeedForUser(userId: string): Promise<Tweet[]> {
  const tweets = await purgeExpired()
  const followingIds = await listFollowingIds(userId)
  const mine = tweets.filter((tweet) => tweet.userId === userId)
  const others = tweets.filter((tweet) => {
    if (!tweet.userId || tweet.userId === userId) return false
    // Reposts are follower-gated; originals stay in the public random pool.
    if (tweet.repostOfId) return followingIds.has(tweet.userId)
    return true
  })
  const randomOthers = shuffle(others).slice(0, 5)

  return annotateForViewer(
    [...mine, ...randomOthers].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    ),
    userId,
    tweets,
  )
}

/** Same as getFeedForUser(), but reads tweets/likes/comments/reactions/follows from Postgres.
 * "5 random others" uses SQL `order by random()` — a different RNG than the JS
 * shuffle, so it's a uniform random sample, not a literal port of the algorithm.
 */
export async function getFeedForUserFromDb(userId: string): Promise<Tweet[]> {
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
  const tweets = await purgeExpired()
  const mine = tweets
    .filter((tweet) => tweet.userId === profileUserId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return annotateForViewer(mine, viewerId, tweets)
}

/** Same as listTweetsByUser, but reads tweets/likes/comments/reactions from Postgres. */
export async function listTweetsByUserFromDb(
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
  const tweets = await purgeExpired()
  const liked = tweets
    .filter((tweet) => likedByOf(tweet).includes(profileUserId))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return annotateForViewer(liked, viewerId, tweets)
}

/** Same as listTweetsLikedByUser, but reads tweets/likes/comments/reactions from Postgres. */
export async function listTweetsLikedByUserFromDb(
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

/** Profile replies: (a) tweets authored by user with replyToId set, PLUS
 *  (b) nested comments authored by user, projected as Tweet-shaped items
 *  with id=comment.id, body/handle/userId/createdAt from comment,
 *  replyToId=parentTweet.id, empty likes/reactions/comments, etc.
 *  Sort newest first. Annotate for viewer like other list helpers.
 */
export async function listRepliesByUser(
  profileUserId: string,
  viewerId?: string,
): Promise<Tweet[]> {
  const tweets = await purgeExpired()

  const replyTweets = tweets.filter(
    (tweet) => tweet.userId === profileUserId && tweet.replyToId,
  )

  const commentReplies: Tweet[] = []
  for (const parent of tweets) {
    for (const comment of parent.comments ?? []) {
      if (comment.userId !== profileUserId) continue
      commentReplies.push({
        id: comment.id,
        body: comment.body,
        handle: comment.handle,
        userId: comment.userId,
        createdAt: comment.createdAt,
        likes: 0,
        liked: false,
        likedBy: [],
        reactions: [],
        imageUrl: null,
        replyToId: parent.id,
        repostOfId: null,
        repostOfHandle: null,
        comments: [],
        repostCount: 0,
        reposted: false,
        tags: [],
      })
    }
  }

  const combined = [...replyTweets, ...commentReplies].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )
  return annotateForViewer(combined, viewerId, tweets)
}

/** Same as listRepliesByUser, but reads tweets/comments/likes/reactions from Postgres.
 * Union of (a) real reply-tweets authored by the profile and (b) the profile's
 * comments on other tweets, projected as zeroed-out pseudo-tweets — comments
 * can't be liked/reacted/commented-on themselves in this app's data model.
 */
export async function listRepliesByUserFromDb(
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

export async function searchTweets(query: string): Promise<Tweet[]> {
  const tweets = await purgeExpired()
  const q = query.trim().toLowerCase()
  if (!q) return tweets.slice(0, 40)

  return tweets
    .filter((tweet) => {
      const body = tweet.body.toLowerCase()
      const handle = tweet.handle.toLowerCase()
      const tags = (tweet.tags ?? []).join(' ').toLowerCase()
      const tagNeedle = q.replace(/^#/, '')
      return (
        body.includes(q) ||
        handle.includes(q) ||
        tags.includes(tagNeedle) ||
        body.includes(`#${tagNeedle}`)
      )
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 40)
}

/** All live tweets (for AI semantic ranking). */
export async function listLiveTweets(): Promise<Tweet[]> {
  return purgeExpired()
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

export async function getTrendingTopics(limit = 8): Promise<TrendingTopic[]> {
  const tweets = await purgeExpired()
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

export async function createTweet(input: {
  body: string
  handle: string
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

  return mutateJsonFile(storePath(), emptyStore(), parseStore, (store) => {
    const now = Date.now()
    const tweets = store.tweets.filter((tweet) => !isTweetExpired(tweet, now))

    if (data.replyToId) {
      const parent = tweets.find((tweet) => tweet.id === data.replyToId)
      if (!parent) throw httpError('Parent post not found.', 404)
    }

    const tweet: Tweet = {
      id: randomUUID(),
      body: data.body,
      handle: input.handle,
      userId: input.userId,
      createdAt: new Date().toISOString(),
      likes: 0,
      liked: false,
      likedBy: [],
      reactions: [],
      imageUrl: data.imageUrl ?? null,
      replyToId: data.replyToId ?? null,
      repostOfId: null,
      repostOfHandle: null,
      comments: [],
      repostCount: 0,
      reposted: false,
      tags,
    }

    const next = [tweet, ...tweets]
    return {
      store: { tweets: next },
      result: annotateOne(tweet, input.userId, next),
    }
  })
}

/** Same as createTweet, but writes to Postgres. No `handle` param — tweets
 * has no handle column, so the response's handle comes from joining users,
 * same as every read-side *FromDb function.
 */
export async function createTweetFromDb(input: {
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

export async function commentOnTweet(input: {
  tweetId: string
  body: string
  handle: string
  userId: string
}): Promise<{ tweet: Tweet; ownerId?: string }> {
  return mutateJsonFile(storePath(), emptyStore(), parseStore, (store) => {
    const now = Date.now()
    const tweets = store.tweets.filter((tweet) => !isTweetExpired(tweet, now))
    const index = tweets.findIndex((tweet) => tweet.id === input.tweetId)
    if (index === -1) throw httpError('Tweet not found.', 404)

    const current = tweets[index]
    const comment = {
      id: randomUUID(),
      body: input.body.trim(),
      handle: input.handle,
      userId: input.userId,
      createdAt: new Date().toISOString(),
    }
    const likedBy = likedByOf(current)
    const updated: Tweet = {
      ...current,
      likedBy,
      likes: likedBy.length,
      liked: false,
      comments: [...(current.comments ?? []), comment],
      reactions: current.reactions ?? [],
      imageUrl: current.imageUrl ?? null,
      replyToId: current.replyToId ?? null,
      repostOfId: current.repostOfId ?? null,
      repostOfHandle: current.repostOfHandle ?? null,
      repostCount: current.repostCount ?? 0,
      reposted: false,
    }
    const next = [...tweets]
    next[index] = updated
    return {
      store: { tweets: next },
      result: {
        tweet: annotateOne(updated, input.userId, next),
        ownerId: current.userId,
      },
    }
  })
}

/** Fetch one tweet in full response shape (handle joined, counts/viewer
 * flags computed live) — shared by every Postgres mutation below so they
 * don't each re-derive the same read after writing.
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

/** Same as commentOnTweet, but writes to Postgres. No `handle` param —
 * joined from users on read, same as every other *FromDb function.
 */
export async function commentOnTweetFromDb(input: {
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

/** Create a repost entry attributed to the current user. */
export async function repostTweet(input: {
  tweetId: string
  handle: string
  userId: string
}): Promise<{ original: Tweet; repost: Tweet; ownerId?: string }> {
  return mutateJsonFile(storePath(), emptyStore(), parseStore, (store) => {
    const now = Date.now()
    const tweets = store.tweets.filter((tweet) => !isTweetExpired(tweet, now))
    const index = tweets.findIndex((tweet) => tweet.id === input.tweetId)
    if (index === -1) throw httpError('Tweet not found.', 404)

    let target = tweets[index]
    // Always attribute the repost to the root post, not another repost.
    if (target.repostOfId) {
      const root = tweets.find((tweet) => tweet.id === target.repostOfId)
      if (root) target = root
    }

    const already = tweets.some(
      (tweet) =>
        tweet.userId === input.userId && tweet.repostOfId === target.id,
    )
    if (already) {
      throw httpError('Already reposted.', 409, 'ALREADY_REPOSTED')
    }

    const targetIndex = tweets.findIndex((tweet) => tweet.id === target.id)
    if (targetIndex === -1) throw httpError('Tweet not found.', 404)

    const repost: Tweet = {
      id: randomUUID(),
      body: target.body,
      handle: input.handle,
      userId: input.userId,
      createdAt: new Date().toISOString(),
      likes: 0,
      liked: false,
      likedBy: [],
      reactions: [],
      imageUrl: target.imageUrl ?? null,
      replyToId: null,
      repostOfId: target.id,
      repostOfHandle: target.handle,
      comments: [],
      repostCount: 0,
      reposted: false,
      tags: target.tags ?? [],
    }

    const targetLikedBy = likedByOf(target)
    const updatedOriginal: Tweet = {
      ...target,
      likedBy: targetLikedBy,
      likes: targetLikedBy.length,
      liked: false,
      repostCount: (target.repostCount ?? 0) + 1,
      reactions: target.reactions ?? [],
      comments: target.comments ?? [],
      imageUrl: target.imageUrl ?? null,
      replyToId: target.replyToId ?? null,
      repostOfId: target.repostOfId ?? null,
      repostOfHandle: target.repostOfHandle ?? null,
      reposted: false,
    }

    const without = tweets.filter((_, i) => i !== targetIndex)
    const next = [repost, updatedOriginal, ...without]
    const [annotatedRepost, annotatedOriginal] = annotateForViewer(
      [repost, updatedOriginal],
      input.userId,
      next,
    )
    return {
      store: { tweets: next },
      result: {
        original: annotatedOriginal,
        repost: annotatedRepost,
        ownerId: target.userId,
      },
    }
  })
}

/** Same as repostTweet, but writes to Postgres. Preserves the JSON version's
 * redirect-to-root-with-fallback: reposting a repost attributes to the root
 * post, UNLESS the root has since expired, in which case it falls back to
 * reposting the (still-live) repost row itself rather than erroring.
 */
export async function repostTweetFromDb(input: {
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

/** Toggle like for this viewer via likedBy ledger. */
export async function likeTweet(
  tweetId: string,
  viewerId: string,
): Promise<{ tweet: Tweet; justLiked: boolean; ownerId?: string }> {
  return mutateJsonFile(storePath(), emptyStore(), parseStore, (store) => {
    const now = Date.now()
    const tweets = store.tweets.filter((tweet) => !isTweetExpired(tweet, now))
    const index = tweets.findIndex((tweet) => tweet.id === tweetId)

    if (index === -1) {
      throw httpError('Tweet not found.', 404)
    }

    const current = tweets[index]
    const likedBy = [...likedByOf(current)]
    const existing = likedBy.indexOf(viewerId)
    let justLiked: boolean
    if (existing >= 0) {
      likedBy.splice(existing, 1)
      justLiked = false
    } else {
      likedBy.push(viewerId)
      justLiked = true
    }

    const updated: Tweet = {
      ...current,
      likedBy,
      likes: likedBy.length,
      liked: false,
      reactions: current.reactions ?? [],
      comments: current.comments ?? [],
      imageUrl: current.imageUrl ?? null,
      replyToId: current.replyToId ?? null,
      repostOfId: current.repostOfId ?? null,
      repostOfHandle: current.repostOfHandle ?? null,
      repostCount: current.repostCount ?? 0,
      reposted: false,
    }
    const next = [...tweets]
    next[index] = updated
    return {
      store: { tweets: next },
      result: {
        tweet: annotateOne(updated, viewerId, next),
        justLiked,
        ownerId: current.userId,
      },
    }
  })
}

/** Same as likeTweet, but writes to Postgres — toggle via delete-then-maybe-
 * insert instead of a separate EXISTS check first.
 */
export async function likeTweetFromDb(
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

export async function deleteTweet(
  tweetId: string,
  userId: string,
): Promise<void> {
  await mutateJsonFile(storePath(), emptyStore(), parseStore, (store) => {
    const now = Date.now()
    const tweets = store.tweets.filter((tweet) => !isTweetExpired(tweet, now))
    const index = tweets.findIndex((tweet) => tweet.id === tweetId)

    if (index === -1) {
      throw httpError('Tweet not found.', 404)
    }

    const tweet = tweets[index]
    if (tweet.userId !== userId) {
      throw httpError('You can only delete your own posts.', 403, 'FORBIDDEN')
    }

    let next = tweets.filter((_, i) => i !== index)

    if (tweet.repostOfId) {
      // Deleting a repost — decrement the original's repostCount.
      next = next.map((item) => {
        if (item.id !== tweet.repostOfId) return item
        return {
          ...item,
          repostCount: Math.max(0, (item.repostCount ?? 0) - 1),
        }
      })
    } else {
      // Deleting an original — remove orphaned reposts that point at it.
      next = next.filter((item) => item.repostOfId !== tweet.id)
    }

    return { store: { tweets: next }, result: undefined }
  })
}

/** Same as deleteTweet, but writes to Postgres. Simpler than the JSON
 * version's manual orphan-cleanup: schema.sql's ON DELETE CASCADE on
 * repost_of_id (and SET NULL on reply_to_id, likes/comments/reactions all
 * CASCADE) means dropping the row does that work declaratively.
 */
export async function deleteTweetFromDb(
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

/** Toggle an emoji reaction for this user (add if missing, remove if present). */
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
  return mutateJsonFile(storePath(), emptyStore(), parseStore, (store) => {
    const now = Date.now()
    const tweets = store.tweets.filter((tweet) => !isTweetExpired(tweet, now))
    const index = tweets.findIndex((tweet) => tweet.id === tweetId)

    if (index === -1) {
      throw httpError('Tweet not found.', 404)
    }

    const current = tweets[index]
    const reactions = [...(current.reactions ?? [])]
    const existing = reactions.findIndex(
      (reaction) => reaction.userId === userId && reaction.emoji === emoji,
    )

    if (existing >= 0) {
      reactions.splice(existing, 1)
    } else {
      reactions.push({ emoji, userId })
    }

    const likedBy = likedByOf(current)
    const updated: Tweet = {
      ...current,
      likedBy,
      likes: likedBy.length,
      liked: false,
      reactions,
      comments: current.comments ?? [],
      imageUrl: current.imageUrl ?? null,
      replyToId: current.replyToId ?? null,
      repostOfId: current.repostOfId ?? null,
      repostOfHandle: current.repostOfHandle ?? null,
      repostCount: current.repostCount ?? 0,
      reposted: false,
    }
    const next = [...tweets]
    next[index] = updated
    return {
      store: { tweets: next },
      result: {
        tweet: annotateOne(updated, userId, next),
        justAdded: existing < 0,
        ownerId: current.userId,
        emoji,
      },
    }
  })
}

/** Same as reactToTweet, but writes to Postgres. Same delete-then-maybe-
 * insert toggle as likeTweetFromDb, keyed on (tweet_id, user_id, emoji).
 */
export async function reactToTweetFromDb(
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
