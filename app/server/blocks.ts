import path from 'node:path'
import { z } from 'zod'
import { getSql } from './db.ts'
import {
  DEFAULT_DATA_DIR,
  mutateJsonFile,
  readJsonFile,
} from './jsonStore.ts'
import { getPublicUserFromDb } from './users.ts'

const blockEdgeSchema = z.object({
  blockerId: z.string().uuid(),
  blockedId: z.string().uuid(),
  createdAt: z.string().datetime(),
})

const blockStoreSchema = z.object({
  blocks: z.array(blockEdgeSchema),
})

type BlockEdge = z.infer<typeof blockEdgeSchema>
type BlockStore = z.infer<typeof blockStoreSchema>

function blocksPath(): string {
  return (
    process.env.BLOCKS_STORE_PATH ?? path.join(DEFAULT_DATA_DIR, 'blocks.json')
  )
}

const emptyStore = (): BlockStore => ({ blocks: [] })

function parseStore(raw: unknown): BlockStore {
  const parsed = blockStoreSchema.safeParse(raw)
  if (!parsed.success) throw new Error('Blocks store is corrupt or invalid.')
  return parsed.data
}

async function readStore(): Promise<BlockStore> {
  return readJsonFile(blocksPath(), emptyStore(), parseStore)
}

/** True if either user has blocked the other. */
export async function isBlockedEitherWay(
  userA: string,
  userB: string,
): Promise<boolean> {
  const store = await readStore()
  return store.blocks.some(
    (edge) =>
      (edge.blockerId === userA && edge.blockedId === userB) ||
      (edge.blockerId === userB && edge.blockedId === userA),
  )
}

/** IDs blocked by (or blocking) the given user. */
export async function listBlockedPeerIds(userId: string): Promise<Set<string>> {
  const store = await readStore()
  const ids = new Set<string>()
  for (const edge of store.blocks) {
    if (edge.blockerId === userId) ids.add(edge.blockedId)
    if (edge.blockedId === userId) ids.add(edge.blockerId)
  }
  return ids
}

/** Toggle block. Returns next isBlocked state (from blocker's perspective). */
export async function toggleBlock(
  blockerId: string,
  blockedId: string,
): Promise<{ isBlocked: boolean }> {
  if (blockerId === blockedId) {
    const error = new Error('Cannot block yourself.')
    ;(error as Error & { status: number; code: string }).status = 400
    ;(error as Error & { status: number; code: string }).code = 'INVALID_BLOCK'
    throw error
  }

  const target = await getPublicUserFromDb(blockedId)
  if (!target) {
    const error = new Error('User not found.')
    ;(error as Error & { status: number; code: string }).status = 404
    ;(error as Error & { status: number; code: string }).code = 'USER_NOT_FOUND'
    throw error
  }

  return mutateJsonFile(blocksPath(), emptyStore(), parseStore, (store) => {
    const existingIndex = store.blocks.findIndex(
      (edge) =>
        edge.blockerId === blockerId && edge.blockedId === blockedId,
    )

    let nextBlocks: BlockEdge[]
    let isBlocked: boolean
    if (existingIndex >= 0) {
      nextBlocks = store.blocks.filter((_, index) => index !== existingIndex)
      isBlocked = false
    } else {
      nextBlocks = [
        ...store.blocks,
        {
          blockerId,
          blockedId,
          createdAt: new Date().toISOString(),
        },
      ]
      isBlocked = true
    }

    return {
      store: { blocks: nextBlocks },
      result: { isBlocked },
    }
  })
}

/** Same as toggleBlock, but writes to Postgres. Same belt-and-suspenders
 * shape as toggleFollowFromDb — JS pre-check is the fast path,
 * blocks_no_self_block is the defensive backstop, caught and translated.
 */
export async function toggleBlockFromDb(
  blockerId: string,
  blockedId: string,
): Promise<{ isBlocked: boolean }> {
  if (blockerId === blockedId) {
    const error = new Error('Cannot block yourself.')
    ;(error as Error & { status: number; code: string }).status = 400
    ;(error as Error & { status: number; code: string }).code = 'INVALID_BLOCK'
    throw error
  }

  const target = await getPublicUserFromDb(blockedId)
  if (!target) {
    const error = new Error('User not found.')
    ;(error as Error & { status: number; code: string }).status = 404
    ;(error as Error & { status: number; code: string }).code = 'USER_NOT_FOUND'
    throw error
  }

  const sql = getSql()

  const deleted = await sql`
    delete from blocks where blocker_id = ${blockerId} and blocked_id = ${blockedId}
  `
  let isBlocked: boolean
  if (deleted.count > 0) {
    isBlocked = false
  } else {
    try {
      await sql`
        insert into blocks (blocker_id, blocked_id) values (${blockerId}, ${blockedId})
      `
    } catch (err) {
      const pgError = err as { code?: string; constraint_name?: string }
      if (
        pgError.code === '23514' &&
        pgError.constraint_name === 'blocks_no_self_block'
      ) {
        const error = new Error('Cannot block yourself.')
        ;(error as Error & { status: number; code: string }).status = 400
        ;(error as Error & { status: number; code: string }).code = 'INVALID_BLOCK'
        throw error
      }
      throw err
    }
    isBlocked = true
  }

  return { isBlocked }
}
