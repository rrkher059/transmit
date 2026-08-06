import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import {
  DEFAULT_DATA_DIR,
  mutateJsonFile,
  readJsonFile,
} from './jsonStore.ts'
import { isBlockedEitherWay, listBlockedPeerIds } from './blocks.ts'
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
