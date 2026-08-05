import postgres, { type Sql } from 'postgres'

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER)
}

let client: Sql | undefined

/**
 * Lazy module-scope singleton: the pool is built on the first call, not at
 * import time, so files that import this module (directly or transitively)
 * don't need DATABASE_URL set unless they actually run a query — e.g. tests
 * that import server/app.ts but never touch Postgres. Every call after the
 * first reuses the same `client`, so it's still one pool for the process.
 */
export function getSql(): Sql {
  if (client) return client

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL is required.')
  }

  client = postgres(connectionString, {
    // Render's managed Postgres (and most hosted providers) require SSL but
    // present certs that fail default CA verification; 'require' encrypts
    // the connection without verifying the chain. Local/dev Postgres has no
    // SSL listener at all, so it must stay off there.
    ssl: isProductionRuntime() ? 'require' : false,
  })
  return client
}
