import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { getSql } from './db.ts'
import {
  DEFAULT_DATA_DIR,
  mutateJsonFile,
  readJsonFile,
} from './jsonStore.ts'

export const notificationTypeSchema = z.enum([
  'like',
  'comment',
  'repost',
  'reaction',
  'follow',
])

export const notificationSchema = z.object({
  id: z.string().uuid(),
  recipientId: z.string().uuid(),
  type: notificationTypeSchema,
  actorId: z.string().uuid(),
  actorHandle: z.string().min(2).max(33),
  tweetId: z.string().uuid().nullish(),
  body: z.string().max(280).nullish(),
  createdAt: z.string().datetime(),
  read: z.boolean().default(false),
})

const notificationStoreSchema = z.object({
  notifications: z.array(notificationSchema),
})

export type AppNotification = z.infer<typeof notificationSchema>
type NotificationStore = z.infer<typeof notificationStoreSchema>

const PER_USER_CAP = 200

function storePath(): string {
  return (
    process.env.NOTIFICATIONS_STORE_PATH ??
    path.join(DEFAULT_DATA_DIR, 'notifications.json')
  )
}

const emptyStore = (): NotificationStore => ({ notifications: [] })

function parseStore(raw: unknown): NotificationStore {
  const parsed = notificationStoreSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error('Notifications store is corrupt or invalid.')
  }
  return parsed.data
}

async function readStore(): Promise<NotificationStore> {
  return readJsonFile(storePath(), emptyStore(), parseStore)
}

/** Keep the newest PER_USER_CAP notifications per recipient. */
function capPerRecipient(
  notifications: AppNotification[],
): AppNotification[] {
  const byRecipient = new Map<string, AppNotification[]>()
  for (const item of notifications) {
    const list = byRecipient.get(item.recipientId) ?? []
    list.push(item)
    byRecipient.set(item.recipientId, list)
  }
  const capped: AppNotification[] = []
  for (const list of byRecipient.values()) {
    list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    capped.push(...list.slice(0, PER_USER_CAP))
  }
  capped.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return capped
}

export async function pushNotification(input: {
  recipientId: string
  type: AppNotification['type']
  actorId: string
  actorHandle: string
  tweetId?: string | null
  body?: string | null
}): Promise<AppNotification | null> {
  if (input.recipientId === input.actorId) return null

  return mutateJsonFile(storePath(), emptyStore(), parseStore, (store) => {
    const notification: AppNotification = {
      id: randomUUID(),
      recipientId: input.recipientId,
      type: input.type,
      actorId: input.actorId,
      actorHandle: input.actorHandle,
      tweetId: input.tweetId ?? null,
      body: input.body ?? null,
      createdAt: new Date().toISOString(),
      read: false,
    }

    const next = capPerRecipient([notification, ...store.notifications])
    return { store: { notifications: next }, result: notification }
  })
}

/** Same as pushNotification, but writes to Postgres. No actorHandle param —
 * no such column, joined from users on read. Caps at PER_USER_CAP the same
 * way, but scoped to just this recipient (an indexed delete), not a
 * whole-table rewrite.
 */
export async function pushNotificationFromDb(input: {
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

export async function listNotificationsForUser(
  userId: string,
  options?: { limit?: number; cursor?: string },
): Promise<{ notifications: AppNotification[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options?.limit ?? 60, 1), 100)
  const cursor = options?.cursor?.trim() || undefined
  const store = await readStore()
  const all = store.notifications
    .filter((item) => item.recipientId === userId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

  let start = 0
  if (cursor) {
    const byId = all.findIndex((item) => item.id === cursor)
    if (byId >= 0) {
      start = byId + 1
    } else {
      const cursorTime = Date.parse(cursor)
      if (!Number.isNaN(cursorTime)) {
        const idx = all.findIndex(
          (item) => Date.parse(item.createdAt) < cursorTime,
        )
        start = idx >= 0 ? idx : all.length
      }
    }
  }

  const notifications = all.slice(start, start + limit)
  const hasMore = start + notifications.length < all.length
  const last = notifications[notifications.length - 1]
  return {
    notifications,
    nextCursor: hasMore && last ? last.createdAt : null,
  }
}

/** Same as listNotificationsForUser, but reads from Postgres. The JSON
 * version's "cursor as id" branch is dead code — nextCursor is always a
 * createdAt timestamp, never an id — so this is plain keyset pagination on
 * created_at. Fetches limit+1 to know whether there's a next page without a
 * separate count query.
 */
export async function listNotificationsForUserFromDb(
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
  await mutateJsonFile(storePath(), emptyStore(), parseStore, (store) => {
    let changed = false
    const notifications = store.notifications.map((item) => {
      if (item.recipientId === userId && !item.read) {
        changed = true
        return { ...item, read: true }
      }
      return item
    })
    return {
      store: changed ? { notifications } : store,
      result: undefined,
      dirty: changed,
    }
  })
}

/** Same as markNotificationsRead, but writes to Postgres. */
export async function markNotificationsReadFromDb(userId: string): Promise<void> {
  const sql = getSql()
  await sql`
    update notifications set read = true where recipient_id = ${userId} and read = false
  `
}

export async function countUnreadNotifications(userId: string): Promise<number> {
  const store = await readStore()
  return store.notifications.filter(
    (item) => item.recipientId === userId && !item.read,
  ).length
}

/** Same as countUnreadNotifications, but reads from Postgres. */
export async function countUnreadNotificationsFromDb(userId: string): Promise<number> {
  const sql = getSql()
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from notifications
    where recipient_id = ${userId} and read = false
  `
  return row.count
}
