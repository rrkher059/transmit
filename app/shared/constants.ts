/** Shared product limits — single source of truth for client and API. */
export const APP_NAME = 'Transmit'
export const APP_VERSION = 'v1.2'
export const TWEET_MAX_CHARS = 280
export const TWEET_TTL_MS = 24 * 60 * 60 * 1000
/** Max data-URL length for inline post images (~0.75MB). */
export const TWEET_IMAGE_MAX_CHARS = 750_000
export const PASSWORD_MIN_LENGTH = 10
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const SESSION_COOKIE = 'transmit_session'
