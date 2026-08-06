import { countFollowEdges } from './follows.ts'
import { countMessageThreadsFromDb } from './messages.ts'
import { readTweets } from './store.ts'
import { countUsersFromDb } from './users.ts'

export type PlatformStats = {
  users: number
  livePosts: number
  messageThreads: number
  follows: number
}

/** Live platform totals from on-disk stores — no placeholder values. */
export async function getPlatformStats(): Promise<PlatformStats> {
  const [users, tweets, messageThreads, follows] = await Promise.all([
    countUsersFromDb(),
    readTweets(),
    countMessageThreadsFromDb(),
    countFollowEdges(),
  ])

  return {
    users,
    livePosts: tweets.length,
    messageThreads,
    follows,
  }
}
