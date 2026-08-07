import { createHmac } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import postgres, { type Sql } from 'postgres'

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER)
}

function isDevOrTestRuntime(): boolean {
  return (
    process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
  )
}

function connect(connectionString: string): Sql {
  return postgres(connectionString, {
    // Render's managed Postgres (and most hosted providers) require SSL but
    // present certs that fail default CA verification; 'require' encrypts
    // the connection without verifying the chain. Local/dev Postgres has no
    // SSL listener at all, so it must stay off there.
    ssl: isProductionRuntime() ? 'require' : false,
  })
}

let client: Sql | undefined

/**
 * Lazy module-scope singleton: the pool is built on the first call, not at
 * import time, so files that import this module (directly or transitively)
 * don't need DATABASE_URL set unless they actually run a query — e.g. tests
 * that import server/app.ts but never touch Postgres. Every call after the
 * first reuses the same `client`, so it's still one pool for the process.
 *
 * This is the app's runtime connection — DATABASE_URL is expected to be the
 * restricted app_user role (see schema.sql), which has no DDL privileges.
 * Schema application uses createSchemaConnection() below instead.
 */
function getPool(): Sql {
  if (client) return client

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL is required.')
  }

  client = connect(connectionString)
  return client
}

/**
 * A separate, non-singleton connection for server/applySchema.ts only.
 * schema.sql creates/alters tables, roles, and SECURITY DEFINER functions —
 * DDL that app_user (DATABASE_URL, above) can't run. Prefers
 * SCHEMA_DATABASE_URL so the two can point at different roles once
 * app_user's password is set; falls back to DATABASE_URL so this keeps
 * working before that split is made.
 */
export function createSchemaConnection(): Sql {
  const connectionString = process.env.SCHEMA_DATABASE_URL ?? process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('SCHEMA_DATABASE_URL (or DATABASE_URL) is required.')
  }
  return connect(connectionString)
}

// ---- Postgres-side request identity, for RLS's auth.uid()/auth.role() ----
//
// The browser's httpOnly session cookie (server/session.ts) is untouched —
// this is a second, server-only credential. currentUser() verifies the
// cookie and resolves a userId; everything below turns that userId into
// something Postgres itself can see for the lifetime of one request.

/** Documented local-only default — never used when NODE_ENV=production or
 * RENDER is set. A JWT signed with this has zero security value outside
 * dev/test, same reasoning as session.ts's DEV_SESSION_SECRET.
 */
const DEV_SUPABASE_JWT_SECRET = 'dev-only-transmit-supabase-jwt-secret'

const REQUEST_JWT_TTL_SECONDS = 60

function supabaseJwtSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET
  if (secret && secret.length > 0) return secret

  if (isProductionRuntime()) {
    throw new Error('SUPABASE_JWT_SECRET must be set in production.')
  }
  if (isDevOrTestRuntime() || !process.env.NODE_ENV) {
    return DEV_SUPABASE_JWT_SECRET
  }
  throw new Error('SUPABASE_JWT_SECRET is required.')
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/**
 * Signs a Supabase-shaped access token for this one request — sub/role/aud
 * plus a short exp, HS256 with SUPABASE_JWT_SECRET. Hand-rolled rather than
 * pulling in a JWT library, same call as session.ts's HMAC-signed cookie
 * token: HS256 is a header, a payload, and an HMAC — nothing a library adds
 * value over here. Nothing verifies this signature anywhere in this flow
 * (we mint it and consume it ourselves, in the same process, in the same
 * request) — it's shaped correctly so it stays usable by anything else that
 * expects a real Supabase access token later (Storage, Realtime, a future
 * PostgREST-fronted path), not because this flow itself checks it.
 */
function signRequestJwt(userId: string): { claims: Record<string, unknown> } {
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    sub: userId,
    role: 'authenticated',
    aud: 'authenticated',
    iat: now,
    exp: now + REQUEST_JWT_TTL_SECONDS,
  }
  // Signed even though nothing here verifies it — see the doc comment above.
  const header = { alg: 'HS256', typ: 'JWT' }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  createHmac('sha256', supabaseJwtSecret()).update(signingInput).digest('base64url')
  return { claims }
}

const requestUser = new AsyncLocalStorage<string>()

/**
 * Runs fn with a Postgres request-identity established for its whole
 * duration: every getSql() call made anywhere inside fn — however deep,
 * across any awaited call chain, no matter which store/route module calls
 * it — transparently runs its query with this user's claims attached, so
 * auth.uid()/auth.role() resolve inside that query. RLS isn't enabled on
 * any table yet, so today this has no observable effect — it's the plumbing
 * for when it is.
 */
export function withRequestUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return requestUser.run(userId, fn)
}

/**
 * Same singleton pool as always. The only difference: inside
 * withRequestUser(), each call returns a wrapper with the same
 * tagged-template call shape, but every individual query runs in its own
 * short transaction that SET LOCALs request.jwt.claims first. One
 * mini-transaction per query — not one held open for the whole request —
 * so a slow route (an AI call mid-handler, say) never ties up a pooled
 * connection past the single query that actually needed the claim.
 */
export function getSql(): Sql {
  const userId = requestUser.getStore()
  if (!userId) return getPool()

  const pool = getPool()
  const scoped = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { claims } = signRequestJwt(userId)
    return pool.begin(async (tx) => {
      // set_config(..., true) is SET LOCAL — scoped to this transaction only,
      // and automatically cleared at COMMIT/ROLLBACK. That's load-bearing:
      // this connection goes back into the shared pool right after, and a
      // bare SET (no LOCAL) would leak this user's identity into whichever
      // unrelated request happens to reuse this physical connection next.
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`
      return (tx as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(
        strings,
        ...values,
      )
    })
  }) as unknown as Sql

  return scoped
}
