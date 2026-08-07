import { describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { clearRateLimitBuckets } from './rateLimit.ts'

// Deliberately targets the DELETE /api/tweets/:id ownership check as a
// defense-in-depth proof: the assertion here only checks that the tweet
// still exists afterward, not the HTTP status code the route returns —
// that status legitimately differs depending on whether the app-layer
// check (server/store.ts's deleteTweet) is present (403) or has been
// deliberately removed to prove RLS's tweets_delete_own policy is a real
// backstop, not just documentation (200, but a no-op). Data integrity is
// the thing that must hold either way.

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

describe('DELETE /api/tweets/:id ownership — defense in depth', () => {
  const app = createApp()

  it("refuses to let one user delete another user's tweet", async () => {
    clearRateLimitBuckets()

    const owner = await signupSession(app, 'owner@kuiper.test', 'owner')
    const created = await app.request('/api/tweets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.cookie },
      body: JSON.stringify({ body: 'mine, not yours' }),
    })
    expect(created.status).toBe(201)
    const { tweet } = await created.json()

    const intruder = await signupSession(app, 'intruder@kuiper.test', 'intruder')
    const deleteAttempt = await app.request(`/api/tweets/${tweet.id}`, {
      method: 'DELETE',
      headers: { Cookie: intruder.cookie },
    })
    // Not asserted as a fixed value — see the file-level comment. Logged so
    // it's visible which layer (if either) actually caught this.
    console.log('DELETE attempt by non-owner returned status:', deleteAttempt.status)
    expect(deleteAttempt.status).not.toBe(500)

    const ownerTweets = await app.request(`/api/users/${owner.userId}/tweets`, {
      headers: { Cookie: owner.cookie },
    })
    expect(ownerTweets.status).toBe(200)
    const { tweets } = await ownerTweets.json()
    const stillExists = tweets.some((t: { id: string }) => t.id === tweet.id)

    expect(stillExists).toBe(true)
  })
})
