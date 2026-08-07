import { describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { getSql, withRequestUser } from './db.ts'
import { clearRateLimitBuckets } from './rateLimit.ts'

// Unlike DELETE /api/tweets/:id (server/deleteOwnership.test.ts), there is
// no existing app-level block filter on tweet/comment/like/reaction reads
// to remove — "blocks only affect messages" today, via hand-written SQL in
// server/messages.ts, not RLS. So this queries the database directly (via
// withRequestUser, bypassing the HTTP route layer and any app code
// entirely) to isolate the RLS policies themselves as the thing under test.

function cookieFrom(response: Response): string {
  const raw = response.headers.getSetCookie?.() ?? []
  if (raw.length > 0) {
    return raw.map((part) => part.split(';')[0]).join('; ')
  }
  const single = response.headers.get('set-cookie')
  return single ? single.split(';')[0] : ''
}

async function signupSession(
  app: ReturnType<typeof createApp>,
  email: string,
  handle: string,
): Promise<{ cookie: string; userId: string }> {
  const signup = await app.request('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'securepass1', handle }),
  })
  expect(signup.status).toBe(201)
  const { user } = await signup.json()
  return { cookie: cookieFrom(signup), userId: user.id }
}

async function createTweet(
  app: ReturnType<typeof createApp>,
  cookie: string,
  body: string,
): Promise<string> {
  const response = await app.request('/api/tweets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ body }),
  })
  expect(response.status).toBe(201)
  const { tweet } = await response.json()
  return tweet.id as string
}

async function tweetIdsVisibleTo(viewerId: string, candidateIds: string[]) {
  return withRequestUser(viewerId, async () => {
    const sql = getSql()
    const rows = await sql<{ id: string }[]>`
      select id from tweets where id = any(${candidateIds})
    `
    return rows.map((r) => r.id)
  })
}

describe('Symmetric block visibility — tweets RLS', () => {
  const app = createApp()

  it("hides each blocked user's tweets from the other, at the database level", async () => {
    clearRateLimitBuckets()

    const a = await signupSession(app, 'blocker@kuiper.test', 'blocker')
    const b = await signupSession(app, 'blocked@kuiper.test', 'blocked')
    const c = await signupSession(app, 'onlooker@kuiper.test', 'onlooker')

    const tweetAId = await createTweet(app, a.cookie, "A's tweet")
    const tweetBId = await createTweet(app, b.cookie, "B's tweet")

    const blockResponse = await app.request(`/api/users/${b.userId}/block`, {
      method: 'POST',
      headers: { Cookie: a.cookie },
    })
    expect(blockResponse.status).toBe(200)

    const visibleToB = await tweetIdsVisibleTo(b.userId, [tweetAId, tweetBId])
    expect(visibleToB).not.toContain(tweetAId)
    expect(visibleToB).toContain(tweetBId)

    const visibleToA = await tweetIdsVisibleTo(a.userId, [tweetAId, tweetBId])
    expect(visibleToA).not.toContain(tweetBId)
    expect(visibleToA).toContain(tweetAId)

    // Sanity: an unrelated third party is unaffected by A/B's block.
    const visibleToC = await tweetIdsVisibleTo(c.userId, [tweetAId, tweetBId])
    expect(visibleToC).toContain(tweetAId)
    expect(visibleToC).toContain(tweetBId)
  })
})
