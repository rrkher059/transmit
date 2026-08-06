import { getSql } from './db.ts'
import { getPublicUser } from './users.ts'

/** True if either user has blocked the other. */
export async function isBlockedEitherWay(
  userA: string,
  userB: string,
): Promise<boolean> {
  const sql = getSql()
  const [row] = await sql<{ exists: boolean }[]>`
    select exists(
      select 1 from blocks
      where (blocker_id = ${userA} and blocked_id = ${userB})
         or (blocker_id = ${userB} and blocked_id = ${userA})
    ) as "exists"
  `
  return row.exists
}

/** Toggle block. Returns next isBlocked state (from blocker's perspective).
 * JS pre-check is the fast path; blocks_no_self_block is the defensive
 * backstop, caught and translated to the same clean error.
 */
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

  const target = await getPublicUser(blockedId)
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
