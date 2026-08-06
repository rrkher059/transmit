import { randomUUID } from 'node:crypto'
import { getSql } from './db.ts'

export type AppNotification = {
  id: string
  recipientId: string
  type: 'like' | 'comment' | 'repost' | 'reaction' | 'follow'
  actorId: string
  actorHandle: string
  tweetId?: string | null
  body?: string | null
  createdAt: string
  read: boolean
}

const PER_USER_CAP = 200

/** No actorHandle param — no such column, joined from users on read. Caps
 * at PER_USER_CAP, scoped to just this recipient (an indexed delete).
 */
export async function pushNotification(input: {
  recipientId: string
  type: AppNotification['type']
  actorId: string
  tweetId?: string | null
  body?: string | null
}): Promise<AppNotification | null> {
  if (input.recipientId === input.actorId) return null

  const sql = getSql()

  const [notification] = await sql<AppNotification[]>`
    with inserted as (
      insert into notifications (id, recipient_id, type, actor_id, tweet_id, body)
      values (
        ${randomUUID()}, ${input.recipientId}, ${input.type}, ${input.actorId},
        ${input.tweetId ?? null}, ${input.body ?? null}
      )
      returning id, recipient_id, type, actor_id, tweet_id, body, created_at, read
    )
    select
      inserted.id,
      inserted.recipient_id as "recipientId",
      inserted.type,
      inserted.actor_id as "actorId",
      u.handle as "actorHandle",
      inserted.tweet_id as "tweetId",
      inserted.body,
      to_char(inserted.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
      inserted.read
    from inserted
    join users u on u.id = inserted.actor_id
  `

  await sql`
    delete from notifications
    where recipient_id = ${input.recipientId}
      and id not in (
        select id from notifications
        where recipient_id = ${input.recipientId}
        order by created_at desc
        limit ${PER_USER_CAP}
      )
  `

  return notification
}

/** Plain keyset pagination on created_at. Fetches limit+1 to know whether
 * there's a next page without a separate count query.
 */
export async function listNotificationsForUser(
  userId: string,
  options?: { limit?: number; cursor?: string },
): Promise<{ notifications: AppNotification[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options?.limit ?? 60, 1), 100)
  const cursor = options?.cursor?.trim() || undefined

  const sql = getSql()
  const rows = await sql<AppNotification[]>`
    select
      n.id, n.recipient_id as "recipientId", n.type, n.actor_id as "actorId",
      u.handle as "actorHandle", n.tweet_id as "tweetId", n.body,
      to_char(n.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
      n.read
    from notifications n
    join users u on u.id = n.actor_id
    where n.recipient_id = ${userId}
      and (${cursor ?? null}::timestamptz is null or n.created_at < ${cursor ?? null}::timestamptz)
    order by n.created_at desc
    limit ${limit + 1}
  `

  const hasMore = rows.length > limit
  const notifications = hasMore ? rows.slice(0, limit) : rows
  const last = notifications[notifications.length - 1]
  return {
    notifications,
    nextCursor: hasMore && last ? last.createdAt : null,
  }
}

export async function markNotificationsRead(userId: string): Promise<void> {
  const sql = getSql()
  await sql`
    update notifications set read = true where recipient_id = ${userId} and read = false
  `
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  const sql = getSql()
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from notifications
    where recipient_id = ${userId} and read = false
  `
  return row.count
}
