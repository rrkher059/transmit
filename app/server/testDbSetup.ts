import path from 'node:path'
import dotenv from 'dotenv'
import { beforeEach } from 'vitest'
import { getSql } from './db.ts'

// Registered as a vitest `setupFile` for the "server" project only (see
// vitest.config.ts), so this module body runs once per server test file,
// before that file's own tests — including this dotenv.config() call, which
// must land before anything reads process.env.DATABASE_URL. Doesn't override
// an already-set DATABASE_URL (e.g. from a CI secret), same as dotenv's
// default elsewhere in this app.
dotenv.config({ path: path.resolve(process.cwd(), '.env.test') })

/**
 * Supabase connection strings carry the project ref either as the pooler
 * username (`postgres.<ref>@host:6543`) or in the direct hostname
 * (`db.<ref>.supabase.co:5432`). Returns null if neither pattern matches.
 */
function supabaseProjectRef(databaseUrl: string): string | null {
  const pooler = databaseUrl.match(/:\/\/postgres\.([a-z0-9]+):/)
  if (pooler) return pooler[1]
  const direct = databaseUrl.match(/\bdb\.([a-z0-9]+)\.supabase\.co\b/)
  return direct ? direct[1] : null
}

/**
 * Refuses to run if DATABASE_URL resolves to the same Supabase project as
 * PRODUCTION_PROJECT_REF — the rest of this file truncates every table
 * before each test, so pointing it at production, even by accident,
 * would be destructive. Fails CLOSED: an unset PRODUCTION_PROJECT_REF or an
 * unparseable DATABASE_URL blocks the run instead of silently skipping the
 * check — a guard that can't verify anything shouldn't wave it through.
 */
function assertNotProductionDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set — check .env.test.')
  }

  const prodRef = process.env.PRODUCTION_PROJECT_REF
  if (!prodRef) {
    throw new Error(
      'PRODUCTION_PROJECT_REF is not set in .env.test — refusing to run the ' +
        'test suite until it is, so this guard has a known-production value ' +
        'to compare DATABASE_URL against. See .env.test.example.',
    )
  }

  const testRef = supabaseProjectRef(databaseUrl)
  if (!testRef) {
    throw new Error(
      'Could not parse a Supabase project ref out of DATABASE_URL — refusing ' +
        'to run rather than truncate a database this guard cannot identify.',
    )
  }

  if (testRef === prodRef) {
    throw new Error(
      `DATABASE_URL points at the production Supabase project (${prodRef}). ` +
        'Refusing to run — this test suite truncates every table before each test.',
    )
  }
}

assertNotProductionDatabase()

beforeEach(async () => {
  const sql = getSql()
  await sql`
    truncate table
      comments, reactions, likes, notifications, messages, blocks,
      tweets, follows, users
    restart identity cascade
  `
})
