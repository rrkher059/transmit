import postgres from 'postgres'

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER)
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL is required.')
}

/**
 * Module-scope singleton: Node's ESM loader caches a module by resolved
 * path and runs its body once per process, so every `import { sql } from
 * './db.ts'` — no matter how many files do it — resolves to this same
 * `sql` value and the one pool it wraps.
 */
export const sql = postgres(connectionString, {
  // Render's managed Postgres (and most hosted providers) require SSL but
  // present certs that fail default CA verification; 'require' encrypts
  // the connection without verifying the chain. Local/dev Postgres has no
  // SSL listener at all, so it must stay off there.
  ssl: isProductionRuntime() ? 'require' : false,
})
