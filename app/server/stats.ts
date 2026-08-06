import { countFollowEdges } from './follows.ts'
import { countMessageThreads } from './messages.ts'
import { countLiveTweets } from './store.ts'
import { countUsers } from './users.ts'

export type PlatformStats = {
  users: number
  livePosts: number
  messageThreads: number
  follows: number
}

/** Live platform totals from Postgres — no placeholder values. */
export async function getPlatformStats(): Promise<PlatformStats> {
  const [users, livePosts, messageThreads, follows] = await Promise.all([
    countUsers(),
    countLiveTweets(),
    countMessageThreads(),
    countFollowEdges(),
  ])

  return {
    users,
    livePosts,
    messageThreads,
    follows,
  }
}
