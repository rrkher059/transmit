import { getSql } from './db.ts'
import { getPublicUser } from './users.ts'
import type { PublicUser } from '../shared/schemas.ts'

export type FollowStats = {
  followers: number
  following: number
  isFollowing: boolean
}

export async function getFollowStats(
  profileUserId: string,
  viewerUserId?: string,
): Promise<FollowStats> {
  const sql = getSql()
  const [row] = await sql<FollowStats[]>`
    select
      (select count(*) from follows where following_id = ${profileUserId})::int as followers,
      (select count(*) from follows where follower_id = ${profileUserId})::int as following,
      exists (
        select 1 from follows
        where follower_id = ${viewerUserId ?? null}::uuid
          and following_id = ${profileUserId}
      ) as "isFollowing"
  `
  return row
}

export async function listFollowers(
  profileUserId: string,
): Promise<PublicUser[]> {
  const sql = getSql()
  return sql<PublicUser[]>`
    select
      u.id,
      u.handle,
      to_char(u.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
    from follows f
    join users u on u.id = f.follower_id
    where f.following_id = ${profileUserId}
    order by f.created_at asc
  `
}

export async function listFollowing(
  profileUserId: string,
): Promise<PublicUser[]> {
  const sql = getSql()
  return sql<PublicUser[]>`
    select
      u.id,
      u.handle,
      to_char(u.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
    from follows f
    join users u on u.id = f.following_id
    where f.follower_id = ${profileUserId}
    order by f.created_at asc
  `
}

/** Total follow edges on the platform. */
export async function countFollowEdges(): Promise<number> {
  const sql = getSql()
  const [row] = await sql<{ count: number }[]>`select count(*)::int as count from follows`
  return row.count
}

/** Toggle follow. Returns next isFollowing state. The follower === following
 * check is the fast path (no DB round trip); follows_no_self_follow is a
 * defensive backstop for anything that calls the insert without going
 * through this check — caught below and translated the same way, never a
 * raw constraint violation.
 */
export async function toggleFollow(
  followerId: string,
  followingId: string,
): Promise<{ isFollowing: boolean; stats: FollowStats }> {
  if (followerId === followingId) {
    const error = new Error('Cannot follow yourself.')
    ;(error as Error & { status: number; code: string }).status = 400
    ;(error as Error & { status: number; code: string }).code = 'INVALID_FOLLOW'
    throw error
  }

  const target = await getPublicUser(followingId)
  if (!target) {
    const error = new Error('User not found.')
    ;(error as Error & { status: number; code: string }).status = 404
    ;(error as Error & { status: number; code: string }).code = 'USER_NOT_FOUND'
    throw error
  }

  const sql = getSql()

  const deleted = await sql`
    delete from follows where follower_id = ${followerId} and following_id = ${followingId}
  `
  let isFollowing: boolean
  if (deleted.count > 0) {
    isFollowing = false
  } else {
    try {
      await sql`
        insert into follows (follower_id, following_id) values (${followerId}, ${followingId})
      `
    } catch (err) {
      const pgError = err as { code?: string; constraint_name?: string }
      if (
        pgError.code === '23514' &&
        pgError.constraint_name === 'follows_no_self_follow'
      ) {
        const error = new Error('Cannot follow yourself.')
        ;(error as Error & { status: number; code: string }).status = 400
        ;(error as Error & { status: number; code: string }).code = 'INVALID_FOLLOW'
        throw error
      }
      throw err
    }
    isFollowing = true
  }

  const stats = await getFollowStats(followingId, followerId)
  return { isFollowing, stats }
}
