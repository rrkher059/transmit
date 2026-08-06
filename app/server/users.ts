import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  userStoreSchema,
  type PrivateUser,
  type PublicUser,
  type UserRecord,
  type UserStore,
} from '../shared/schemas.ts'
import { DUMMY_PASSWORD_HASH, hashSecret, verifySecret } from './crypto.ts'
import { getSql } from './db.ts'
import {
  DEFAULT_DATA_DIR,
  mutateJsonFile,
  readJsonFile,
} from './jsonStore.ts'

function usersPath(): string {
  return process.env.USERS_STORE_PATH ?? path.join(DEFAULT_DATA_DIR, 'users.json')
}

const emptyStore = (): UserStore => ({ users: [] })

function parseStore(raw: unknown): UserStore {
  const parsed = userStoreSchema.safeParse(raw)
  if (!parsed.success) throw new Error('User store is corrupt or invalid.')
  return parsed.data
}

async function readStore(): Promise<UserStore> {
  return readJsonFile(usersPath(), emptyStore(), parseStore)
}

function toPublic(user: UserRecord): PublicUser {
  return {
    id: user.id,
    handle: user.handle,
    createdAt: user.createdAt,
  }
}

function toPrivate(user: UserRecord): PrivateUser {
  return {
    id: user.id,
    email: user.email,
    handle: user.handle,
    createdAt: user.createdAt,
  }
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const store = await readStore()
  return store.users.find((user) => user.email === email.toLowerCase()) ?? null
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const store = await readStore()
  return store.users.find((user) => user.id === id) ?? null
}

export async function findUserByHandle(handle: string): Promise<UserRecord | null> {
  const normalized = handle.startsWith('@') ? handle : `@${handle}`
  const store = await readStore()
  return (
    store.users.find(
      (user) => user.handle.toLowerCase() === normalized.toLowerCase(),
    ) ?? null
  )
}

export async function createUser(input: {
  email: string
  handle: string
  password: string
}): Promise<PrivateUser> {
  const passwordHash = await hashSecret(input.password)
  return mutateJsonFile(usersPath(), emptyStore(), parseStore, (store) => {
    const email = input.email.toLowerCase()

    if (store.users.some((user) => user.email === email)) {
      const error = new Error('An account with this email already exists.')
      ;(error as Error & { status: number; code: string }).status = 409
      ;(error as Error & { status: number; code: string }).code = 'EMAIL_TAKEN'
      throw error
    }

    if (
      store.users.some(
        (user) => user.handle.toLowerCase() === input.handle.toLowerCase(),
      )
    ) {
      const error = new Error('Handle is already taken.')
      ;(error as Error & { status: number; code: string }).status = 409
      ;(error as Error & { status: number; code: string }).code = 'HANDLE_TAKEN'
      throw error
    }

    const user: UserRecord = {
      id: randomUUID(),
      email,
      handle: input.handle,
      passwordHash,
      createdAt: new Date().toISOString(),
    }

    return {
      store: { users: [...store.users, user] },
      result: toPrivate(user),
    }
  })
}

/** Same as createUser, but writes to Postgres. Password hashing (crypto.ts)
 * is untouched — this is a storage change only. Postgres's own unique
 * constraints replace the JSON version's two existence checks; which one
 * fired comes back as error.constraint_name (postgres.js maps the wire
 * protocol's 'n' field to this), so it's race-safe unlike a check-then-write.
 */
export async function createUserFromDb(input: {
  email: string
  handle: string
  password: string
}): Promise<PrivateUser> {
  const passwordHash = await hashSecret(input.password)
  const email = input.email.toLowerCase()
  const sql = getSql()

  try {
    const [row] = await sql<PrivateUser[]>`
      insert into users (id, email, handle, password_hash, created_at)
      values (${randomUUID()}, ${email}, ${input.handle}, ${passwordHash}, now())
      returning id, email, handle,
        to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
    `
    return row
  } catch (err) {
    const pgError = err as { code?: string; constraint_name?: string }
    if (pgError.code === '23505') {
      if (pgError.constraint_name === 'users_email_key') {
        const error = new Error('An account with this email already exists.')
        ;(error as Error & { status: number; code: string }).status = 409
        ;(error as Error & { status: number; code: string }).code = 'EMAIL_TAKEN'
        throw error
      }
      if (pgError.constraint_name === 'users_handle_key') {
        const error = new Error('Handle is already taken.')
        ;(error as Error & { status: number; code: string }).status = 409
        ;(error as Error & { status: number; code: string }).code = 'HANDLE_TAKEN'
        throw error
      }
    }
    throw err
  }
}

export async function authenticateUser(
  email: string,
  password: string,
): Promise<PrivateUser | null> {
  const user = await findUserByEmail(email)
  const ok = await verifySecret(
    password,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
  )
  if (!user || !ok) return null
  return toPrivate(user)
}

/** Same as authenticateUser, but reads from Postgres. Always calls
 * verifySecret — with DUMMY_PASSWORD_HASH when no row matched — same as the
 * JSON version, so a nonexistent email doesn't short-circuit any faster
 * than a wrong password does.
 */
export async function authenticateUserFromDb(
  email: string,
  password: string,
): Promise<PrivateUser | null> {
  const sql = getSql()
  const [row] = await sql<
    { id: string; email: string; handle: string; password_hash: string; createdAt: string }[]
  >`
    select id, email, handle, password_hash,
      to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
    from users
    where email = ${email.toLowerCase()}
  `
  const ok = await verifySecret(password, row?.password_hash ?? DUMMY_PASSWORD_HASH)
  if (!row || !ok) return null
  return { id: row.id, email: row.email, handle: row.handle, createdAt: row.createdAt }
}

export async function getPublicUser(id: string): Promise<PublicUser | null> {
  const user = await findUserById(id)
  return user ? toPublic(user) : null
}

/** Same as getPublicUser, but reads from Postgres. */
export async function getPublicUserFromDb(id: string): Promise<PublicUser | null> {
  const sql = getSql()
  const [row] = await sql<PublicUser[]>`
    select id, handle,
      to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
    from users
    where id = ${id}
  `
  return row ?? null
}

export async function getPrivateUser(id: string): Promise<PrivateUser | null> {
  const user = await findUserById(id)
  return user ? toPrivate(user) : null
}

/** Same as getPrivateUser, but reads from Postgres. */
export async function getPrivateUserFromDb(id: string): Promise<PrivateUser | null> {
  const sql = getSql()
  const [row] = await sql<PrivateUser[]>`
    select id, email, handle,
      to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
    from users
    where id = ${id}
  `
  return row ?? null
}

export async function listPublicUsers(
  excludeUserId?: string,
  limit = 5,
): Promise<PublicUser[]> {
  const store = await readStore()
  return store.users
    .filter((user) => !excludeUserId || user.id !== excludeUserId)
    .slice(0, limit)
    .map(toPublic)
}

/** Total registered operators. */
export async function countUsers(): Promise<number> {
  const store = await readStore()
  return store.users.length
}

export async function searchUsers(
  query: string,
  excludeUserId?: string,
  limit = 20,
): Promise<PublicUser[]> {
  const q = query
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
  const store = await readStore()
  return store.users
    .filter((user) => !excludeUserId || user.id !== excludeUserId)
    .filter((user) => {
      if (!q) return true
      const handle = user.handle.toLowerCase()
      return handle.includes(q) || handle.replace(/^@/, '').includes(q)
    })
    .slice(0, limit)
    .map(toPublic)
}
