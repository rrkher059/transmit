import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { getSql } from './db.ts'
import {
  DEFAULT_DATA_DIR,
  mutateJsonFile,
  readJsonFile,
} from './jsonStore.ts'
import {
  isBlockedEitherWay,
  isBlockedEitherWayFromDb,
  listBlockedPeerIds,
} from './blocks.ts'
import { getPublicUserFromDb } from './users.ts'
import type { PublicUser } from '../shared/schemas.ts'

const dmMessageSchema = z.object({
  id: z.string().uuid(),
  fromUserId: z.string().uuid(),
  toUserId: z.string().uuid(),
  body: z.string().min(1).max(280),
  createdAt: z.string().datetime(),
})

const dmStoreSchema = z.object({
  messages: z.array(dmMessageSchema),
})

export type DmMessage = z.infer<typeof dmMessageSchema>
type DmStore = z.infer<typeof dmStoreSchema>

export type DmConversation = {
  peer: PublicUser
  preview: string
  updatedAt: string
  messages: DmMessage[]
}

function messagesPath(): string {
  return (
    process.env.MESSAGES_STORE_PATH ??
    path.join(DEFAULT_DATA_DIR, 'messages.json')
  )
}

const emptyStore = (): DmStore => ({ messages: [] })

function parseStore(raw: unknown): DmStore {
  const parsed = dmStoreSchema.safeParse(raw)
  if (!parsed.success) throw new Error('Messages store is corrupt or invalid.')
  return parsed.data
}

async function readStore(): Promise<DmStore> {
  return readJsonFile(messagesPath(), emptyStore(), parseStore)
}

function isParticipant(message: DmMessage, userId: string): boolean {
  return message.fromUserId === userId || message.toUserId === userId
}

function peerIdOf(message: DmMessage, userId: string): string {
  return message.fromUserId === userId ? message.toUserId : message.fromUserId
}

export async function listConversations(
  userId: string,
): Promise<DmConversation[]> {
  const store = await readStore()
  const blocked = await listBlockedPeerIds(userId)
  const mine = store.messages
    .filter((message) => isParticipant(message, userId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const byPeer = new Map<string, DmMessage[]>()
  for (const message of mine) {
    const peerId = peerIdOf(message, userId)
    if (blocked.has(peerId)) continue
    const list = byPeer.get(peerId) ?? []
    list.push(message)
    byPeer.set(peerId, list)
  }

  const conversations: DmConversation[] = []
  for (const [peerId, messages] of byPeer) {
    const peer = await getPublicUserFromDb(peerId)
    if (!peer) continue
    const last = messages[messages.length - 1]
    conversations.push({
      peer,
      preview: last?.body ?? '',
      updatedAt: last?.createdAt ?? new Date(0).toISOString(),
      messages,
    })
  }

  conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return conversations
}

/** Same as listConversations, but groups/aggregates/block-filters in
 * Postgres instead of JS. peer_id is computed once (in `mine`) and reused
 * for the block check (in `visible`), rather than recomputed per row.
 */
export async function listConversationsFromDb(
  userId: string,
): Promise<DmConversation[]> {
  const sql = getSql()
  return sql<DmConversation[]>`
    with mine as (
      select
        m.id, m.from_user_id, m.to_user_id, m.body, m.created_at,
        case when m.from_user_id = ${userId} then m.to_user_id else m.from_user_id end as peer_id
      from messages m
      where m.from_user_id = ${userId} or m.to_user_id = ${userId}
    ),
    visible as (
      select mine.*
      from mine
      where not exists (
        select 1 from blocks b
        where (b.blocker_id = ${userId} and b.blocked_id = mine.peer_id)
           or (b.blocker_id = mine.peer_id and b.blocked_id = ${userId})
      )
    )
    select
      json_build_object(
        'id', u.id, 'handle', u.handle,
        'createdAt', to_char(u.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) as peer,
      (array_agg(v.body order by v.created_at desc))[1] as preview,
      to_char(max(v.created_at) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt",
      json_agg(json_build_object(
        'id', v.id, 'fromUserId', v.from_user_id, 'toUserId', v.to_user_id, 'body', v.body,
        'createdAt', to_char(v.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by v.created_at) as messages
    from visible v
    join users u on u.id = v.peer_id
    group by v.peer_id, u.id, u.handle, u.created_at
    order by max(v.created_at) desc
  `
}

export async function getThread(
  userId: string,
  peerId: string,
): Promise<DmConversation | null> {
  if (await isBlockedEitherWay(userId, peerId)) {
    return null
  }

  const peer = await getPublicUserFromDb(peerId)
  if (!peer) return null

  const store = await readStore()
  const messages = store.messages
    .filter(
      (message) =>
        (message.fromUserId === userId && message.toUserId === peerId) ||
        (message.fromUserId === peerId && message.toUserId === userId),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const last = messages[messages.length - 1]
  return {
    peer,
    preview: last?.body ?? '',
    updatedAt: last?.createdAt ?? new Date(0).toISOString(),
    messages,
  }
}

/** Same as getThread, but reads from Postgres. Block check via
 * isBlockedEitherWayFromDb (SQL), not the JS blocks.json version.
 */
export async function getThreadFromDb(
  userId: string,
  peerId: string,
): Promise<DmConversation | null> {
  if (await isBlockedEitherWayFromDb(userId, peerId)) {
    return null
  }

  const peer = await getPublicUserFromDb(peerId)
  if (!peer) return null

  const sql = getSql()
  const messages = await sql<DmMessage[]>`
    select id, from_user_id as "fromUserId", to_user_id as "toUserId", body,
      to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
    from messages
    where (from_user_id = ${userId} and to_user_id = ${peerId})
       or (from_user_id = ${peerId} and to_user_id = ${userId})
    order by created_at asc
  `

  const last = messages[messages.length - 1]
  return {
    peer,
    preview: last?.body ?? '',
    updatedAt: last?.createdAt ?? new Date(0).toISOString(),
    messages,
  }
}

/** Unique undirected DM threads across the whole store. */
export async function countMessageThreads(): Promise<number> {
  const store = await readStore()
  const pairs = new Set<string>()
  for (const message of store.messages) {
    const [a, b] =
      message.fromUserId < message.toUserId
        ? [message.fromUserId, message.toUserId]
        : [message.toUserId, message.fromUserId]
    pairs.add(`${a}:${b}`)
  }
  return pairs.size
}

/** Same as countMessageThreads, but reads from Postgres. COUNT(DISTINCT ...)
 * on a (least, greatest) tuple canonicalizes each undirected pair without
 * needing string concatenation.
 */
export async function countMessageThreadsFromDb(): Promise<number> {
  const sql = getSql()
  const [row] = await sql<{ count: number }[]>`
    select count(distinct (least(from_user_id, to_user_id), greatest(from_user_id, to_user_id)))::int as count
    from messages
  `
  return row.count
}

export async function sendMessage(input: {
  fromUserId: string
  toUserId: string
  body: string
}): Promise<DmMessage> {
  if (input.fromUserId === input.toUserId) {
    const error = new Error('Cannot message yourself.')
    ;(error as Error & { status: number; code: string }).status = 400
    ;(error as Error & { status: number; code: string }).code = 'INVALID_PEER'
    throw error
  }

  const peer = await getPublicUserFromDb(input.toUserId)
  if (!peer) {
    const error = new Error('Recipient not found.')
    ;(error as Error & { status: number; code: string }).status = 404
    ;(error as Error & { status: number; code: string }).code = 'USER_NOT_FOUND'
    throw error
  }

  if (await isBlockedEitherWay(input.fromUserId, input.toUserId)) {
    const error = new Error('Cannot message this user.')
    ;(error as Error & { status: number; code: string }).status = 403
    ;(error as Error & { status: number; code: string }).code = 'BLOCKED'
    throw error
  }

  return mutateJsonFile(messagesPath(), emptyStore(), parseStore, (store) => {
    const message: DmMessage = {
      id: randomUUID(),
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      body: input.body.trim(),
      createdAt: new Date().toISOString(),
    }
    return {
      store: { messages: [...store.messages, message] },
      result: message,
    }
  })
}

/** Same as sendMessage, but writes to Postgres. Block check via
 * isBlockedEitherWayFromDb (SQL), not the JS blocks.json version.
 */
export async function sendMessageFromDb(input: {
  fromUserId: string
  toUserId: string
  body: string
}): Promise<DmMessage> {
  if (input.fromUserId === input.toUserId) {
    const error = new Error('Cannot message yourself.')
    ;(error as Error & { status: number; code: string }).status = 400
    ;(error as Error & { status: number; code: string }).code = 'INVALID_PEER'
    throw error
  }

  const peer = await getPublicUserFromDb(input.toUserId)
  if (!peer) {
    const error = new Error('Recipient not found.')
    ;(error as Error & { status: number; code: string }).status = 404
    ;(error as Error & { status: number; code: string }).code = 'USER_NOT_FOUND'
    throw error
  }

  if (await isBlockedEitherWayFromDb(input.fromUserId, input.toUserId)) {
    const error = new Error('Cannot message this user.')
    ;(error as Error & { status: number; code: string }).status = 403
    ;(error as Error & { status: number; code: string }).code = 'BLOCKED'
    throw error
  }

  const sql = getSql()
  const [message] = await sql<DmMessage[]>`
    insert into messages (id, from_user_id, to_user_id, body)
    values (${randomUUID()}, ${input.fromUserId}, ${input.toUserId}, ${input.body.trim()})
    returning id, from_user_id as "fromUserId", to_user_id as "toUserId", body,
      to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
  `
  return message
}
