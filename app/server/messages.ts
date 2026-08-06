import { randomUUID } from 'node:crypto'
import { getSql } from './db.ts'
import { isBlockedEitherWay } from './blocks.ts'
import { getPublicUser } from './users.ts'
import type { PublicUser } from '../shared/schemas.ts'

export type DmMessage = {
  id: string
  fromUserId: string
  toUserId: string
  body: string
  createdAt: string
}

export type DmConversation = {
  peer: PublicUser
  preview: string
  updatedAt: string
  messages: DmMessage[]
}

/** Groups/aggregates/block-filters entirely in Postgres. peer_id is computed
 * once (in `mine`) and reused for the block check (in `visible`), rather
 * than recomputed per row.
 */
export async function listConversations(
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

  const peer = await getPublicUser(peerId)
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

/** Unique undirected DM threads across the whole platform. COUNT(DISTINCT
 * ...) on a (least, greatest) tuple canonicalizes each pair without needing
 * string concatenation.
 */
export async function countMessageThreads(): Promise<number> {
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

  const peer = await getPublicUser(input.toUserId)
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

  const sql = getSql()
  const [message] = await sql<DmMessage[]>`
    insert into messages (id, from_user_id, to_user_id, body)
    values (${randomUUID()}, ${input.fromUserId}, ${input.toUserId}, ${input.body.trim()})
    returning id, from_user_id as "fromUserId", to_user_id as "toUserId", body,
      to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
  `
  return message
}
