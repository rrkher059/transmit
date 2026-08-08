import { randomUUID } from 'node:crypto'
import { getSql, withRequestUser } from './db.ts'

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

export const PER_USER_CAP = 200

/** Plain INSERT, no RETURNING: Postgres subjects RETURNING output to the
 * table's SELECT policy, not just INSERT's WITH CHECK — and
 * notifications_select_recipient only lets the recipient read a row, never
 * the actor creating it (they're essentially always different people; that's
 * the whole point of a notification). RETURNING the row here would fail RLS
 * for every real cross-user call. No caller used the return value anyway
 * (all 5 call sites in app.ts are bare `await pushNotification(...)`), so
 * this drops it rather than working around it. Caps at PER_USER_CAP, scoped
 * to just this recipient (an indexed delete) — run under the recipient's
 * own Postgres identity (withRequestUser), not the caller's: pushNotification
 * is always invoked while the request's identity is the actor (whoever's
 * liking/commenting/following), and notifications_delete_recipient requires
 * auth.uid() = recipient_id. Since actor and recipient are guaranteed
 * different (see the early return below), the prune delete would otherwise
 * always fail its own USING clause and silently affect 0 rows — the exact
 * bug notifications_delete_recipient was added to fix, just recreated one
 * level up. Safe to switch identity for this one write: it's a maintenance
 * operation on the recipient's own inbox, scoped by recipient_id regardless.
 */
export async function pushNotification(input: {
  recipientId: string
  type: AppNotification['type']
  actorId: string
  tweetId?: string | null
  body?: string | null
}): Promise<void> {
  if (input.recipientId === input.actorId) return

  const sql = getSql()

  await sql`
    insert into notifications (id, recipient_id, type, actor_id, tweet_id, body)
    values (
      ${randomUUID()}, ${input.recipientId}, ${input.type}, ${input.actorId},
      ${input.tweetId ?? null}, ${input.body ?? null}
    )
  `

  await withRequestUser(input.recipientId, async () => {
    const pruneSql = getSql()
    await pruneSql`
      delete from notifications
      where recipient_id = ${input.recipientId}
        and id not in (
          select id from notifications
          where recipient_id = ${input.recipientId}
          order by created_at desc
          limit ${PER_USER_CAP}
        )
    `
  })
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
