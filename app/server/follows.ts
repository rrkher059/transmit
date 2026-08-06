import path from 'node:path'
import { z } from 'zod'
import { getSql } from './db.ts'
import {
  DEFAULT_DATA_DIR,
  mutateJsonFile,
  readJsonFile,
} from './jsonStore.ts'
import { getPublicUser } from './users.ts'
import type { PublicUser } from '../shared/schemas.ts'

const followEdgeSchema = z.object({
  followerId: z.string().uuid(),
  followingId: z.string().uuid(),
  createdAt: z.string().datetime(),
})

const followStoreSchema = z.object({
  follows: z.array(followEdgeSchema),
})

type FollowEdge = z.infer<typeof followEdgeSchema>
type FollowStore = z.infer<typeof followStoreSchema>

export type FollowStats = {
  followers: number
  following: number
  isFollowing: boolean
}

function followsPath(): string {
  return (
    process.env.FOLLOWS_STORE_PATH ?? path.join(DEFAULT_DATA_DIR, 'follows.json')
  )
}

const emptyStore = (): FollowStore => ({ follows: [] })

function parseStore(raw: unknown): FollowStore {
  const parsed = followStoreSchema.safeParse(raw)
  if (!parsed.success) throw new Error('Follows store is corrupt or invalid.')
  return parsed.data
}

async function readStore(): Promise<FollowStore> {
  return readJsonFile(followsPath(), emptyStore(), parseStore)
}

export async function getFollowStats(
  profileUserId: string,
  viewerUserId?: string,
): Promise<FollowStats> {
  const store = await readStore()
  const followers = store.follows.filter(
    (edge) => edge.followingId === profileUserId,
  ).length
  const following = store.follows.filter(
    (edge) => edge.followerId === profileUserId,
  ).length
  const isFollowing = viewerUserId
    ? store.follows.some(
        (edge) =>
          edge.followerId === viewerUserId &&
          edge.followingId === profileUserId,
      )
    : false
  return { followers, following, isFollowing }
}

/** Same as getFollowStats, but reads the Postgres follows table instead of follows.json. */
export async function getFollowStatsFromDb(
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
  const store = await readStore()
  const ids = store.follows
    .filter((edge) => edge.followingId === profileUserId)
    .map((edge) => edge.followerId)
  const users: PublicUser[] = []
  for (const id of ids) {
    const user = await getPublicUser(id)
    if (user) users.push(user)
  }
  return users
}

export async function listFollowing(
  profileUserId: string,
): Promise<PublicUser[]> {
  const ids = await listFollowingIds(profileUserId)
  const users: PublicUser[] = []
  for (const id of ids) {
    const user = await getPublicUser(id)
    if (user) users.push(user)
  }
  return users
}

/** Same as listFollowers, but reads the Postgres follows table instead of follows.json. */
export async function listFollowersFromDb(
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

/** Same as listFollowing, but reads the Postgres follows table instead of follows.json. */
export async function listFollowingFromDb(
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

/** IDs the given user follows (for feed visibility checks). */
export async function listFollowingIds(
  profileUserId: string,
): Promise<Set<string>> {
  const store = await readStore()
  return new Set(
    store.follows
      .filter((edge) => edge.followerId === profileUserId)
      .map((edge) => edge.followingId),
  )
}

/** Total follow edges on the platform. */
export async function countFollowEdges(): Promise<number> {
  const store = await readStore()
  return store.follows.length
}

/** Toggle follow. Returns next isFollowing state. */
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

  return mutateJsonFile(followsPath(), emptyStore(), parseStore, (store) => {
    const existingIndex = store.follows.findIndex(
      (edge) =>
        edge.followerId === followerId && edge.followingId === followingId,
    )

    let nextFollows: FollowEdge[]
    let isFollowing: boolean
    if (existingIndex >= 0) {
      nextFollows = store.follows.filter((_, index) => index !== existingIndex)
      isFollowing = false
    } else {
      nextFollows = [
        ...store.follows,
        {
          followerId,
          followingId,
          createdAt: new Date().toISOString(),
        },
      ]
      isFollowing = true
    }

    const followers = nextFollows.filter(
      (edge) => edge.followingId === followingId,
    ).length
    const following = nextFollows.filter(
      (edge) => edge.followerId === followingId,
    ).length

    return {
      store: { follows: nextFollows },
      result: {
        isFollowing,
        stats: {
          followers,
          following,
          isFollowing,
        },
      },
    }
  })
}
