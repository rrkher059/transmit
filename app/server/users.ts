import { randomUUID } from 'node:crypto'
import type { PrivateUser, PublicUser } from '../shared/schemas.ts'
import { DUMMY_PASSWORD_HASH, hashSecret, verifySecret } from './crypto.ts'
import { getSql } from './db.ts'

/** Password hashing (crypto.ts) is untouched by any of this — Postgres's own
 * unique constraints replace the old check-then-write existence checks;
 * which one fired comes back as error.constraint_name (postgres.js maps the
 * wire protocol's 'n' field to this), so it's race-safe unlike a
 * check-then-write would be.
 */
export async function createUser(input: {
  email: string
  handle: string
  password: string
}): Promise<PrivateUser> {
  const passwordHash = await hashSecret(input.password)
  const email = input.email.toLowerCase()
  const userId = randomUUID()
  const sql = getSql()

  try {
    return await sql.begin(async (tx) => {
      const [user] = await tx<PrivateUser[]>`
        insert into users (id, email, handle, created_at)
        values (${userId}, ${email}, ${input.handle}, now())
        returning id, email, handle,
          to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
      `
      await tx`
        insert into user_credentials (user_id, password_hash)
        values (${userId}, ${passwordHash})
      `
      return user
    })
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

/** Always calls verifySecret — with DUMMY_PASSWORD_HASH when no row matched
 * — so a nonexistent email doesn't short-circuit any faster than a wrong
 * password does.
 */
export async function authenticateUser(
  email: string,
  password: string,
): Promise<PrivateUser | null> {
  const sql = getSql()
  const [row] = await sql<
    { id: string; email: string; handle: string; password_hash: string; createdAt: string }[]
  >`
    select u.id, u.email, u.handle, c.password_hash,
      to_char(u.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
    from users u
    join user_credentials c on c.user_id = u.id
    where u.email = ${email.toLowerCase()}
  `
  const ok = await verifySecret(password, row?.password_hash ?? DUMMY_PASSWORD_HASH)
  if (!row || !ok) return null
  return { id: row.id, email: row.email, handle: row.handle, createdAt: row.createdAt }
}

export async function getPublicUser(id: string): Promise<PublicUser | null> {
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
  const sql = getSql()
  const [row] = await sql<PrivateUser[]>`
    select id, email, handle,
      to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
    from users
    where id = ${id}
  `
  return row ?? null
}

/** No explicit sort here — matches the old JSON store's array order, which
 * was signup order (created_at), not handle.
 */
export async function listPublicUsers(
  excludeUserId?: string,
  limit = 5,
): Promise<PublicUser[]> {
  const sql = getSql()
  return sql<PublicUser[]>`
    select id, handle,
      to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
    from users
    where ${excludeUserId ?? null}::uuid is null or id <> ${excludeUserId ?? null}::uuid
    order by created_at asc, id asc
    limit ${limit}
  `
}

/** Total registered operators. */
export async function countUsers(): Promise<number> {
  const sql = getSql()
  const [row] = await sql<{ count: number }[]>`select count(*)::int as count from users`
  return row.count
}

/** handle is always stored with a leading '@' (handleSchema), so matching
 * against the handle with '@' stripped can never match anything matching
 * against the un-stripped handle doesn't — stripped is always a substring
 * of unstripped. Only the one condition is needed.
 */
export async function searchUsers(
  query: string,
  excludeUserId?: string,
  limit = 20,
): Promise<PublicUser[]> {
  const q = query
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
  const sql = getSql()
  return sql<PublicUser[]>`
    select id, handle,
      to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"
    from users
    where (${excludeUserId ?? null}::uuid is null or id <> ${excludeUserId ?? null}::uuid)
      and (${q} = '' or position(${q} in lower(handle)) > 0)
    order by created_at asc, id asc
    limit ${limit}
  `
}
