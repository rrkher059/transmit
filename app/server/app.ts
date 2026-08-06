import type { Context } from 'hono'
import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import { ZodError, z } from 'zod'
import {
  createTweetSchema,
  commentTweetSchema,
  likeTweetSchema,
  loginSchema,
  reactTweetSchema,
  sendMessageSchema,
  signupSchema,
  aiAssistSchema,
  aiCompanionSchema,
  aiSearchSchema,
  type ApiErrorBody,
  type PrivateUser,
  type Tweet,
} from '../shared/schemas.ts'
import {
  assistCompose,
  companionReply,
  generateTags,
  isAiConfigured,
  moderateContent,
  semanticSearchTweets,
} from './ai.ts'
import { enforceRateLimit } from './rateLimit.ts'
import { toggleBlockFromDb } from './blocks.ts'
import {
  getFollowStatsFromDb,
  listFollowersFromDb,
  listFollowingFromDb,
  toggleFollowFromDb,
} from './follows.ts'
import {
  getThread,
  listConversations,
  sendMessage,
} from './messages.ts'
import { getPlatformStats } from './stats.ts'
import {
  SESSION_COOKIE,
  sessionCookieClearOptions,
  sessionCookieOptions,
  signSession,
  verifySession,
} from './session.ts'
import {
  createTweetFromDb,
  deleteTweetFromDb,
  getFeedForUser,
  getFeedForUserFromDb,
  getPublicFeedFromDb,
  getTrendingTopics,
  likeTweetFromDb,
  listLiveTweets,
  listRepliesByUserFromDb,
  listTweetsByUserFromDb,
  listTweetsLikedByUserFromDb,
  commentOnTweetFromDb,
  reactToTweetFromDb,
  repostTweetFromDb,
  searchTweets,
} from './store.ts'
import {
  countUnreadNotifications,
  listNotificationsForUser,
  markNotificationsRead,
  pushNotification,
} from './notifications.ts'
import {
  authenticateUserFromDb,
  createUserFromDb,
  getPrivateUserFromDb,
  listPublicUsers,
  searchUsers,
} from './users.ts'

type AppVariables = {
  user: PrivateUser
}

function errorBody(
  code: string,
  message: string,
  details?: unknown,
): ApiErrorBody {
  return { error: { code, message, details } }
}

function statusError(
  error: unknown,
): error is Error & { status: number; code?: string } {
  return (
    error instanceof Error &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  )
}

async function currentUser(c: Context): Promise<PrivateUser | null> {
  const token = getCookie(c, SESSION_COOKIE)
  const session = verifySession(token)
  if (!session) return null
  return getPrivateUserFromDb(session.userId)
}

function trustProxy(): boolean {
  return process.env.TRUST_PROXY === 'true' || Boolean(process.env.RENDER)
}

/**
 * Client identity for rate limiting.
 * Only trust X-Forwarded-For / X-Real-IP when TRUST_PROXY=true or RENDER is set.
 * Otherwise bucket everyone as 'direct' (safer than spoofable headers).
 */
function clientKey(c: Context): string {
  if (!trustProxy()) return 'direct'
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown'
  return c.req.header('x-real-ip') ?? 'unknown'
}

function allowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS?.trim()
  if (raw) {
    return raw
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  }
  return [
    'https://rrkher059-cloud.github.io',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]
}

function originHost(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return null
  }
}

function isAllowedBrowserOrigin(originOrReferer: string): boolean {
  const host = originHost(originOrReferer)
  if (!host) return false
  return allowedOrigins().some((allowed) => {
    const allowedHost = originHost(allowed)
    return allowedHost !== null && allowedHost === host
  })
}

function parseLimit(
  raw: string | undefined,
  defaultLimit: number,
  max = 100,
): number {
  if (!raw) return defaultLimit
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return defaultLimit
  return Math.min(n, max)
}

function paginateByCursor<T extends { id: string; createdAt: string }>(
  items: T[],
  limit: number,
  cursor: string | undefined,
): { page: T[]; nextCursor: string | null } {
  let start = 0
  if (cursor) {
    const byId = items.findIndex((item) => item.id === cursor)
    if (byId >= 0) {
      start = byId + 1
    } else {
      const cursorTime = Date.parse(cursor)
      if (!Number.isNaN(cursorTime)) {
        const idx = items.findIndex(
          (item) => Date.parse(item.createdAt) < cursorTime,
        )
        start = idx >= 0 ? idx : items.length
      }
    }
  }
  const page = items.slice(start, start + limit)
  const hasMore = start + page.length < items.length
  const last = page[page.length - 1]
  return {
    page,
    nextCursor: hasMore && last ? last.createdAt : null,
  }
}

function enforceAiRateLimit(c: Context) {
  return enforceRateLimit(c, `ai:${clientKey(c)}`, 20, 60_000, errorBody)
}

function enforceWriteRateLimit(c: Context, userId: string) {
  return enforceRateLimit(c, `write:${userId}`, 60, 60_000, errorBody)
}

function aiClientMessage(error: Error & { code?: string }): string {
  if (error.code === 'AI_NOT_CONFIGURED') {
    return 'AI is not configured on this server.'
  }
  if (error.code === 'VALIDATION_ERROR') return error.message
  return 'AI request failed. Try again shortly.'
}

export function createApp() {
  const app = new Hono<{ Variables: AppVariables }>()

  app.use('*', secureHeaders())
  app.use(
    '*',
    bodyLimit({
      maxSize: 800 * 1024,
      onError: (c) =>
        c.json(errorBody('PAYLOAD_TOO_LARGE', 'Request body is too large.'), 413),
    }),
  )

  app.use(
    '*',
    cors({
      origin: allowedOrigins(),
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      credentials: true,
    }),
  )

  // CSRF defense for cookie-authenticated browsers (SameSite=None cross-site).
  app.use('*', async (c, next) => {
    const method = c.req.method.toUpperCase()
    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      return next()
    }

    const origin = c.req.header('origin')?.trim()
    const referer = c.req.header('referer')?.trim()

    if (origin) {
      if (!isAllowedBrowserOrigin(origin)) {
        return c.json(
          errorBody('CSRF_REJECTED', 'Origin is not allowed.'),
          403,
        )
      }
      return next()
    }

    if (referer) {
      if (!isAllowedBrowserOrigin(referer)) {
        return c.json(
          errorBody('CSRF_REJECTED', 'Referer is not allowed.'),
          403,
        )
      }
      return next()
    }

    // No Origin and no Referer — CLI / same-origin tests / non-browser clients.
    return next()
  })

  app.get('/api/health', (c) => c.json({ ok: true, service: 'transmit-api' }))

  app.get('/api/stats', async (c) => {
    try {
      const stats = await getPlatformStats()
      return c.json({ stats })
    } catch (error) {
      console.error(error)
      return c.json(errorBody('STATS_FAILED', 'Failed to load network stats.'), 500)
    }
  })

  app.post('/api/auth/signup', async (c) => {
    try {
      const ipLimited = enforceRateLimit(
        c,
        `auth:signup:ip:${clientKey(c)}`,
        10,
        60 * 60_000,
        errorBody,
      )
      if (ipLimited) return ipLimited

      const json = await c.req.json()
      const payload = signupSchema.parse(json)

      const user = await createUserFromDb({
        email: payload.email,
        handle: payload.handle,
        password: payload.password,
      })

      const token = signSession(user.id)
      setCookie(c, SESSION_COOKIE, token, sessionCookieOptions)

      return c.json({ user }, 201)
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          errorBody('VALIDATION_ERROR', 'Invalid signup payload.', error.flatten()),
          400,
        )
      }
      if (statusError(error)) {
        return c.json(
          errorBody(error.code ?? 'CONFLICT', error.message),
          error.status as 409,
        )
      }
      if (error instanceof SyntaxError) {
        return c.json(errorBody('INVALID_JSON', 'Request body must be JSON.'), 400)
      }
      console.error(error)
      return c.json(errorBody('SIGNUP_FAILED', 'Failed to create account.'), 500)
    }
  })

  app.post('/api/auth/login', async (c) => {
    try {
      const ipLimited = enforceRateLimit(
        c,
        `auth:login:ip:${clientKey(c)}`,
        10,
        15 * 60_000,
        errorBody,
      )
      if (ipLimited) return ipLimited

      const json = await c.req.json()
      const payload = loginSchema.parse(json)

      const emailLimited = enforceRateLimit(
        c,
        `auth:login:email:${payload.email}`,
        5,
        15 * 60_000,
        errorBody,
      )
      if (emailLimited) return emailLimited

      const user = await authenticateUserFromDb(payload.email, payload.password)

      if (!user) {
        return c.json(
          errorBody('INVALID_CREDENTIALS', 'Email or password is incorrect.'),
          401,
        )
      }

      const token = signSession(user.id)
      setCookie(c, SESSION_COOKIE, token, sessionCookieOptions)
      return c.json({ user })
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          errorBody('VALIDATION_ERROR', 'Invalid login payload.', error.flatten()),
          400,
        )
      }
      if (error instanceof SyntaxError) {
        return c.json(errorBody('INVALID_JSON', 'Request body must be JSON.'), 400)
      }
      console.error(error)
      return c.json(errorBody('LOGIN_FAILED', 'Failed to log in.'), 500)
    }
  })

  app.post('/api/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, sessionCookieClearOptions)
    return c.json({ ok: true })
  })

  app.get('/api/auth/me', async (c) => {
    const user = await currentUser(c)
    if (!user) {
      return c.json(errorBody('UNAUTHORIZED', 'Not signed in.'), 401)
    }
    return c.json({ user })
  })

  app.get('/api/explore/search', async (c) => {
    try {
      const user = await currentUser(c)
      const q = c.req.query('q') ?? ''
      if (q.length > 200) {
        return c.json(
          errorBody('VALIDATION_ERROR', 'Query must be at most 200 characters.'),
          400,
        )
      }
      const semantic = c.req.query('semantic') === '1' || c.req.query('semantic') === 'true'
      const tweets = semantic && q.trim()
        ? await semanticSearchTweets(q, await listLiveTweets())
        : await searchTweets(q)
      // Guests can search tweets; user discovery requires auth.
      const users = user ? await searchUsers(q, user.id) : []
      const visible = user
        ? tweets
        : tweets.filter((tweet) => !tweet.repostOfId)
      return c.json({
        tweets: visible,
        users,
        query: q,
        semantic: Boolean(semantic && q.trim()),
      })
    } catch (error) {
      console.error(error)
      return c.json(errorBody('SEARCH_FAILED', 'Failed to search posts.'), 500)
    }
  })

  app.get('/api/ai/status', (c) => {
    return c.json({ configured: isAiConfigured() })
  })

  app.post('/api/ai/assist', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in to use AI assist.'), 401)
      }
      const limited = enforceAiRateLimit(c)
      if (limited) return limited

      const payload = aiAssistSchema.parse(await c.req.json())
      const text = await assistCompose(payload.body, payload.mode)
      return c.json({ text, mode: payload.mode })
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          errorBody('VALIDATION_ERROR', 'Invalid assist payload.', error.flatten()),
          400,
        )
      }
      if (error instanceof SyntaxError) {
        return c.json(errorBody('INVALID_JSON', 'Request body must be JSON.'), 400)
      }
      if (statusError(error)) {
        return c.json(
          errorBody(error.code ?? 'AI_FAILED', aiClientMessage(error)),
          error.status as 400 | 502 | 503,
        )
      }
      console.error(error)
      return c.json(
        errorBody('AI_FAILED', 'AI assist failed. Try again in a moment.'),
        502,
      )
    }
  })

  app.post('/api/ai/search', async (c) => {
    try {
      const limited = enforceAiRateLimit(c)
      if (limited) return limited

      const payload = aiSearchSchema.parse(await c.req.json())
      const user = await currentUser(c)
      const live = await listLiveTweets()
      const tweets = await semanticSearchTweets(payload.query, live)
      const visible = user
        ? tweets
        : tweets.filter((tweet) => !tweet.repostOfId)
      return c.json({ tweets: visible, query: payload.query, semantic: true })
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          errorBody('VALIDATION_ERROR', 'Invalid search payload.', error.flatten()),
          400,
        )
      }
      if (error instanceof SyntaxError) {
        return c.json(errorBody('INVALID_JSON', 'Request body must be JSON.'), 400)
      }
      if (statusError(error)) {
        return c.json(
          errorBody(error.code ?? 'AI_FAILED', aiClientMessage(error)),
          error.status as 400 | 502 | 503,
        )
      }
      console.error(error)
      return c.json(errorBody('SEARCH_FAILED', 'Semantic search failed.'), 500)
    }
  })

  app.post('/api/ai/companion', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(
          errorBody('UNAUTHORIZED', 'Sign in to use the AI companion.'),
          401,
        )
      }
      const limited = enforceAiRateLimit(c)
      if (limited) return limited

      const payload = aiCompanionSchema.parse(await c.req.json())
      const clientFeed = payload.feedData
      const feedContext =
        clientFeed && clientFeed.length > 0
          ? clientFeed.slice(0, 24).map((post) => ({
              handle: post.handle,
              body: post.body,
              tags: post.tags,
              likes: post.likes,
            }))
          : (await getFeedForUser(user.id)).slice(0, 24).map((tweet) => ({
              handle: tweet.handle,
              body: tweet.body,
              tags: tweet.tags,
              likes: tweet.likes,
            }))
      const reply = await companionReply({
        message: payload.message,
        history: payload.history,
        feedContext,
      })
      return c.json({ reply })
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          errorBody(
            'VALIDATION_ERROR',
            'Invalid companion payload.',
            error.flatten(),
          ),
          400,
        )
      }
      if (error instanceof SyntaxError) {
        return c.json(errorBody('INVALID_JSON', 'Request body must be JSON.'), 400)
      }
      if (statusError(error)) {
        return c.json(
          errorBody(error.code ?? 'AI_FAILED', aiClientMessage(error)),
          error.status as 400 | 502 | 503,
        )
      }
      console.error(error)
      return c.json(
        errorBody('AI_FAILED', 'Companion is offline. Try again shortly.'),
        502,
      )
    }
  })

  app.get('/api/explore/trending', async (c) => {
    try {
      const topics = await getTrendingTopics()
      return c.json({ topics })
    } catch (error) {
      console.error(error)
      return c.json(errorBody('TRENDING_FAILED', 'Failed to load trending.'), 500)
    }
  })

  app.get('/api/explore/suggestions', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(
          errorBody('UNAUTHORIZED', 'Sign in to see suggestions.'),
          401,
        )
      }
      const users = await listPublicUsers(user.id, 5)
      return c.json({ users })
    } catch (error) {
      console.error(error)
      return c.json(
        errorBody('SUGGESTIONS_FAILED', 'Failed to load suggestions.'),
        500,
      )
    }
  })

  app.get('/api/tweets', async (c) => {
    try {
      const user = await currentUser(c)
      const limit = parseLimit(c.req.query('limit'), 40)
      const cursor = c.req.query('cursor')?.trim() || undefined
      const tweets: Tweet[] = user
        ? await getFeedForUserFromDb(user.id)
        : await getPublicFeedFromDb()
      const { page, nextCursor } = paginateByCursor(tweets, limit, cursor)
      return c.json({ tweets: page, nextCursor })
    } catch (error) {
      console.error(error)
      return c.json(errorBody('STORE_READ_FAILED', 'Failed to read tweets.'), 500)
    }
  })

  app.post('/api/tweets', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in to post.'), 401)
      }
      const writeLimited = enforceWriteRateLimit(c, user.id)
      if (writeLimited) return writeLimited

      const json = await c.req.json()
      const payload = createTweetSchema.parse(json)

      if (payload.body.trim()) {
        const moderation = await moderateContent(payload.body)
        if (!moderation.allowed) {
          return c.json(
            errorBody(
              'MODERATION_BLOCKED',
              moderation.reason ??
                'This transmission was blocked by moderation.',
              { categories: moderation.categories },
            ),
            422,
          )
        }
      }

      const tags = payload.body.trim()
        ? await generateTags(payload.body)
        : []

      const tweet = await createTweetFromDb({
        body: payload.body,
        userId: user.id,
        imageUrl: payload.imageUrl,
        replyToId: payload.replyToId,
        tags,
      })
      return c.json({ tweet }, 201)
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          errorBody('VALIDATION_ERROR', 'Invalid tweet payload.', error.flatten()),
          400,
        )
      }
      if (error instanceof SyntaxError) {
        return c.json(errorBody('INVALID_JSON', 'Request body must be JSON.'), 400)
      }
      if (statusError(error) && error.status === 404) {
        return c.json(errorBody('NOT_FOUND', error.message), 404)
      }
      console.error(error)
      return c.json(errorBody('STORE_WRITE_FAILED', 'Failed to save tweet.'), 500)
    }
  })

  app.post('/api/tweets/:id/like', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in to like.'), 401)
      }
      const writeLimited = enforceWriteRateLimit(c, user.id)
      if (writeLimited) return writeLimited

      const { tweetId } = likeTweetSchema.parse({ tweetId: c.req.param('id') })
      const { tweet, justLiked, ownerId } = await likeTweetFromDb(tweetId, user.id)
      if (justLiked && ownerId) {
        await pushNotification({
          recipientId: ownerId,
          type: 'like',
          actorId: user.id,
          actorHandle: user.handle,
          tweetId: tweet.id,
          body: tweet.body.slice(0, 80),
        })
      }
      return c.json({ tweet })
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          errorBody('VALIDATION_ERROR', 'Invalid tweet id.', error.flatten()),
          400,
        )
      }
      if (statusError(error) && error.status === 404) {
        return c.json(errorBody('NOT_FOUND', error.message), 404)
      }
      console.error(error)
      return c.json(errorBody('STORE_WRITE_FAILED', 'Failed to like tweet.'), 500)
    }
  })

  app.post('/api/tweets/:id/comment', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in to comment.'), 401)
      }
      const writeLimited = enforceWriteRateLimit(c, user.id)
      if (writeLimited) return writeLimited

      const tweetId = likeTweetSchema.parse({ tweetId: c.req.param('id') }).tweetId
      const { body } = commentTweetSchema.parse(await c.req.json())
      const { tweet, ownerId } = await commentOnTweetFromDb({
        tweetId,
        body,
        userId: user.id,
      })
      if (ownerId) {
        await pushNotification({
          recipientId: ownerId,
          type: 'comment',
          actorId: user.id,
          actorHandle: user.handle,
          tweetId: tweet.id,
          body: body.slice(0, 80),
        })
      }
      return c.json({ tweet }, 201)
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          errorBody('VALIDATION_ERROR', 'Invalid comment.', error.flatten()),
          400,
        )
      }
      if (error instanceof SyntaxError) {
        return c.json(errorBody('INVALID_JSON', 'Request body must be JSON.'), 400)
      }
      if (statusError(error) && error.status === 404) {
        return c.json(errorBody('NOT_FOUND', error.message), 404)
      }
      console.error(error)
      return c.json(errorBody('STORE_WRITE_FAILED', 'Failed to comment.'), 500)
    }
  })

  app.post('/api/tweets/:id/repost', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in to repost.'), 401)
      }
      const writeLimited = enforceWriteRateLimit(c, user.id)
      if (writeLimited) return writeLimited

      const tweetId = likeTweetSchema.parse({ tweetId: c.req.param('id') }).tweetId
      const result = await repostTweetFromDb({
        tweetId,
        userId: user.id,
      })
      if (result.ownerId) {
        await pushNotification({
          recipientId: result.ownerId,
          type: 'repost',
          actorId: user.id,
          actorHandle: user.handle,
          tweetId: result.original.id,
          body: result.original.body.slice(0, 80),
        })
      }
      return c.json(
        { original: result.original, repost: result.repost },
        201,
      )
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          errorBody('VALIDATION_ERROR', 'Invalid tweet id.', error.flatten()),
          400,
        )
      }
      if (statusError(error)) {
        return c.json(
          errorBody(error.code ?? 'REPOST_FAILED', error.message),
          error.status as 400 | 404 | 409,
        )
      }
      console.error(error)
      return c.json(errorBody('STORE_WRITE_FAILED', 'Failed to repost.'), 500)
    }
  })

  app.post('/api/tweets/:id/react', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in to react.'), 401)
      }
      const writeLimited = enforceWriteRateLimit(c, user.id)
      if (writeLimited) return writeLimited

      const tweetId = likeTweetSchema.parse({ tweetId: c.req.param('id') }).tweetId
      const json = await c.req.json()
      const { emoji } = reactTweetSchema.parse(json)
      const { tweet, justAdded, ownerId } = await reactToTweetFromDb(
        tweetId,
        user.id,
        emoji,
      )
      if (justAdded && ownerId) {
        await pushNotification({
          recipientId: ownerId,
          type: 'reaction',
          actorId: user.id,
          actorHandle: user.handle,
          tweetId: tweet.id,
          body: emoji,
        })
      }
      return c.json({ tweet })
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          errorBody('VALIDATION_ERROR', 'Invalid reaction.', error.flatten()),
          400,
        )
      }
      if (error instanceof SyntaxError) {
        return c.json(errorBody('INVALID_JSON', 'Request body must be JSON.'), 400)
      }
      if (statusError(error) && error.status === 404) {
        return c.json(errorBody('NOT_FOUND', error.message), 404)
      }
      console.error(error)
      return c.json(errorBody('STORE_WRITE_FAILED', 'Failed to react.'), 500)
    }
  })

  app.delete('/api/tweets/:id', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in to delete.'), 401)
      }
      const writeLimited = enforceWriteRateLimit(c, user.id)
      if (writeLimited) return writeLimited

      const tweetId = likeTweetSchema.parse({ tweetId: c.req.param('id') }).tweetId
      await deleteTweetFromDb(tweetId, user.id)
      return c.json({ ok: true })
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          errorBody('VALIDATION_ERROR', 'Invalid tweet id.', error.flatten()),
          400,
        )
      }
      if (statusError(error) && error.status === 404) {
        return c.json(errorBody('NOT_FOUND', error.message), 404)
      }
      if (statusError(error) && error.status === 403) {
        return c.json(errorBody(error.code ?? 'FORBIDDEN', error.message), 403)
      }
      console.error(error)
      return c.json(errorBody('STORE_WRITE_FAILED', 'Failed to delete tweet.'), 500)
    }
  })

  app.get('/api/messages', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in to view messages.'), 401)
      }
      const conversations = await listConversations(user.id)
      return c.json({ conversations })
    } catch (error) {
      console.error(error)
      return c.json(errorBody('MESSAGES_FAILED', 'Failed to load messages.'), 500)
    }
  })

  app.get('/api/messages/:peerId', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in to view messages.'), 401)
      }
      const peerId = z
        .string()
        .uuid({ message: 'Invalid peer id.' })
        .parse(c.req.param('peerId'))
      const thread = await getThread(user.id, peerId)
      if (!thread) {
        return c.json(errorBody('NOT_FOUND', 'User not found.'), 404)
      }
      return c.json({ thread })
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          errorBody('VALIDATION_ERROR', 'Invalid peer id.', error.flatten()),
          400,
        )
      }
      console.error(error)
      return c.json(errorBody('MESSAGES_FAILED', 'Failed to load thread.'), 500)
    }
  })

  app.post('/api/messages', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in to send messages.'), 401)
      }
      const writeLimited = enforceWriteRateLimit(c, user.id)
      if (writeLimited) return writeLimited

      const payload = sendMessageSchema.parse(await c.req.json())
      const message = await sendMessage({
        fromUserId: user.id,
        toUserId: payload.toUserId,
        body: payload.body,
      })
      return c.json({ message }, 201)
    } catch (error) {
      if (error instanceof ZodError) {
        return c.json(
          errorBody('VALIDATION_ERROR', 'Invalid message.', error.flatten()),
          400,
        )
      }
      if (error instanceof SyntaxError) {
        return c.json(errorBody('INVALID_JSON', 'Request body must be JSON.'), 400)
      }
      if (statusError(error)) {
        return c.json(
          errorBody(error.code ?? 'MESSAGE_FAILED', error.message),
          error.status as 400 | 403 | 404,
        )
      }
      console.error(error)
      return c.json(errorBody('MESSAGE_FAILED', 'Failed to send message.'), 500)
    }
  })

  app.get('/api/users/search', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in to search users.'), 401)
      }
      const q = c.req.query('q') ?? ''
      if (q.length > 200) {
        return c.json(
          errorBody('VALIDATION_ERROR', 'Query must be at most 200 characters.'),
          400,
        )
      }
      const users = await searchUsers(q, user.id)
      return c.json({ users, query: q })
    } catch (error) {
      console.error(error)
      return c.json(errorBody('SEARCH_FAILED', 'Failed to search users.'), 500)
    }
  })

  app.get('/api/users/:id/tweets', async (c) => {
    try {
      const viewer = await currentUser(c)
      const tweets = await listTweetsByUserFromDb(c.req.param('id'), viewer?.id)
      return c.json({ tweets })
    } catch (error) {
      console.error(error)
      return c.json(errorBody('STORE_READ_FAILED', 'Failed to load posts.'), 500)
    }
  })

  app.get('/api/users/:id/likes', async (c) => {
    try {
      const viewer = await currentUser(c)
      const tweets = await listTweetsLikedByUserFromDb(c.req.param('id'), viewer?.id)
      return c.json({ tweets })
    } catch (error) {
      console.error(error)
      return c.json(errorBody('STORE_READ_FAILED', 'Failed to load likes.'), 500)
    }
  })

  app.get('/api/users/:id/replies', async (c) => {
    try {
      const viewer = await currentUser(c)
      const tweets = await listRepliesByUserFromDb(c.req.param('id'), viewer?.id)
      return c.json({ tweets })
    } catch (error) {
      console.error(error)
      return c.json(errorBody('STORE_READ_FAILED', 'Failed to load replies.'), 500)
    }
  })

  app.get('/api/users/:id/follow-stats', async (c) => {
    try {
      const viewer = await currentUser(c)
      const profileId = c.req.param('id')
      const stats = await getFollowStatsFromDb(profileId, viewer?.id)
      return c.json({ stats })
    } catch (error) {
      console.error(error)
      return c.json(errorBody('FOLLOW_FAILED', 'Failed to load follow stats.'), 500)
    }
  })

  app.get('/api/users/:id/followers', async (c) => {
    try {
      const viewer = await currentUser(c)
      if (!viewer) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in required.'), 401)
      }
      const users = await listFollowersFromDb(c.req.param('id'))
      return c.json({ users })
    } catch (error) {
      console.error(error)
      return c.json(errorBody('FOLLOW_FAILED', 'Failed to load followers.'), 500)
    }
  })

  app.get('/api/users/:id/following', async (c) => {
    try {
      const viewer = await currentUser(c)
      if (!viewer) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in required.'), 401)
      }
      const users = await listFollowingFromDb(c.req.param('id'))
      return c.json({ users })
    } catch (error) {
      console.error(error)
      return c.json(errorBody('FOLLOW_FAILED', 'Failed to load following.'), 500)
    }
  })

  app.post('/api/users/:id/follow', async (c) => {
    try {
      const viewer = await currentUser(c)
      if (!viewer) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in to follow.'), 401)
      }
      const writeLimited = enforceWriteRateLimit(c, viewer.id)
      if (writeLimited) return writeLimited

      const result = await toggleFollowFromDb(viewer.id, c.req.param('id'))
      if (result.isFollowing) {
        await pushNotification({
          recipientId: c.req.param('id'),
          type: 'follow',
          actorId: viewer.id,
          actorHandle: viewer.handle,
        })
      }
      return c.json(result)
    } catch (error) {
      if (statusError(error)) {
        return c.json(
          errorBody(error.code ?? 'FOLLOW_FAILED', error.message),
          error.status as 400 | 404,
        )
      }
      console.error(error)
      return c.json(errorBody('FOLLOW_FAILED', 'Failed to toggle follow.'), 500)
    }
  })

  app.post('/api/users/:id/block', async (c) => {
    try {
      const viewer = await currentUser(c)
      if (!viewer) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in to block.'), 401)
      }
      const writeLimited = enforceWriteRateLimit(c, viewer.id)
      if (writeLimited) return writeLimited

      const result = await toggleBlockFromDb(viewer.id, c.req.param('id'))
      return c.json(result)
    } catch (error) {
      if (statusError(error)) {
        return c.json(
          errorBody(error.code ?? 'BLOCK_FAILED', error.message),
          error.status as 400 | 404,
        )
      }
      console.error(error)
      return c.json(errorBody('BLOCK_FAILED', 'Failed to toggle block.'), 500)
    }
  })

  app.get('/api/notifications', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in required.'), 401)
      }
      const limit = parseLimit(c.req.query('limit'), 60)
      const cursor = c.req.query('cursor')?.trim() || undefined
      const { notifications, nextCursor } = await listNotificationsForUser(
        user.id,
        { limit, cursor },
      )
      return c.json({ notifications, nextCursor })
    } catch (error) {
      console.error(error)
      return c.json(
        errorBody('NOTIFICATIONS_FAILED', 'Failed to load notifications.'),
        500,
      )
    }
  })

  app.get('/api/notifications/unread-count', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in required.'), 401)
      }
      const count = await countUnreadNotifications(user.id)
      return c.json({ count })
    } catch (error) {
      console.error(error)
      return c.json(
        errorBody('NOTIFICATIONS_FAILED', 'Failed to load unread count.'),
        500,
      )
    }
  })

  app.post('/api/notifications/read', async (c) => {
    try {
      const user = await currentUser(c)
      if (!user) {
        return c.json(errorBody('UNAUTHORIZED', 'Sign in required.'), 401)
      }
      await markNotificationsRead(user.id)
      return c.json({ ok: true })
    } catch (error) {
      console.error(error)
      return c.json(
        errorBody('NOTIFICATIONS_FAILED', 'Failed to mark notifications read.'),
        500,
      )
    }
  })

  // Never return Hono's raw text 404 for /api — the SPA treats non-JSON 404 as
  // "API route missing". Real handlers above still return structured 404 JSON.
  app.notFound((c) => {
    if (c.req.path.startsWith('/api')) {
      return c.json({ status: 'ok', message: 'Endpoint fallback' })
    }
    return c.json({ ok: false, message: 'Not found' }, 404)
  })

  return app
}
