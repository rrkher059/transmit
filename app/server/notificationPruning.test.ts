import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createSchemaConnection, getSql, withRequestUser } from './db.ts'
import { PER_USER_CAP, pushNotification } from './notifications.ts'

// Audit finding: notifications had no DELETE policy, so pushNotification's
// per-recipient prune-to-PER_USER_CAP delete silently affected 0 rows under
// RLS (no matching policy = default deny, no error thrown). This asserts on
// the actual row count after exceeding the cap, not on the absence of an
// error — a no-op delete throws nothing, so "it didn't throw" would have
// passed even while the bug was live.
//
// Caught by /code-review after the first version of this test: seeding
// PER_USER_CAP - 1 rows then adding exactly one more via pushNotification
// lands at exactly PER_USER_CAP, never *exceeding* it — there's nothing to
// prune at exactly the cap regardless of whether the DELETE is even
// permitted, so the assertion passed trivially either way. Fixed by seeding
// PER_USER_CAP rows (already at the cap) and then pushing one more, which
// must trigger an actual deletion for the count to come back to PER_USER_CAP.
// That in turn surfaced a second bug: pushNotification always runs while the
// request's Postgres identity is the actor, never the recipient, so
// notifications_delete_recipient's `auth.uid() = recipient_id` never matched
// either — same silent-no-op, one level up. Fixed in notifications.ts by
// running the prune delete under withRequestUser(recipientId, ...).

describe('Notification pruning — RLS delete policy', () => {
  it('prunes down to PER_USER_CAP once the cap is exceeded, at the database level', async () => {
    const schemaSql = createSchemaConnection()
    const recipientId = randomUUID()
    const actorId = randomUUID()

    try {
      await schemaSql`
        insert into users (id, email, handle, created_at)
        values
          (${recipientId}, 'prune-recipient@kuiper.test', '@prunerecipient', now()),
          (${actorId}, 'prune-actor@kuiper.test', '@pruneactor', now())
      `

      // Seed PER_USER_CAP notifications directly (privileged connection,
      // bypasses RLS — this is fixture setup, not the thing under test) —
      // already at the cap, so the next push must exceed it. Distinct,
      // deliberately-in-the-past created_at values: a single INSERT
      // statement's now() is evaluated once for every row, so plain
      // defaults would tie and make "keep the most recent" nondeterministic.
      await schemaSql`
        insert into notifications (id, recipient_id, type, actor_id, created_at)
        select gen_random_uuid(), ${recipientId}, 'follow', ${actorId},
          now() - (n || ' seconds')::interval
        from generate_series(1, ${PER_USER_CAP}) as n
      `

      const seededCount = await withRequestUser(recipientId, async () => {
        const sql = getSql()
        const [row] = await sql<{ n: number }[]>`
          select count(*)::int as n from notifications where recipient_id = ${recipientId}
        `
        return row.n
      })
      expect(seededCount).toBe(PER_USER_CAP)

      // The (PER_USER_CAP + 1)th notification, through the real app code
      // path — this is the call whose prune DELETE was silently a no-op,
      // twice over (see the comment above), before both fixes.
      await withRequestUser(actorId, () =>
        pushNotification({ recipientId, type: 'follow', actorId }),
      )

      const finalCount = await withRequestUser(recipientId, async () => {
        const sql = getSql()
        const [row] = await sql<{ n: number }[]>`
          select count(*)::int as n from notifications where recipient_id = ${recipientId}
        `
        return row.n
      })

      expect(finalCount).toBe(PER_USER_CAP)
    } finally {
      await schemaSql.end({ timeout: 1 })
    }
  })
})
