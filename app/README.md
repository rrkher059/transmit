# 7RANSMI7 (`app/`)

Short-lived social network: Vite + React client, Hono API, shared Zod schemas, Postgres with row-level security. Posts stay live for 24 hours after posting (`TWEET_TTL_MS`) — enforced by filtering on `created_at` at read time in every query, not by deleting rows.

## Run locally

```bash
cd app
npm install
cp .env.example .env       # then edit secrets
cp .env.test.example .env.test   # for running tests
npm run dev                # Vite + API (see package.json scripts)
```

From the repo root you can also use `npm run dev` (delegates to `app/`).

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | API (tsx) + Vite client, concurrently |
| `npm run build` | Typecheck (`tsc -b`) then Vite production build |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | oxlint |
| `npm run preview` | Preview the production build locally |
| `npm run deploy` | Build and push `dist/` to GitHub Pages |
| `npm run db:schema` | Apply `server/schema.sql` using `.env` |
| `npm run db:schema:test` | Apply `server/schema.sql` using `.env.test` |

## Environment

See `.env.example` / `.env.test.example`. Important:

| Variable | Notes |
|---|---|
| `SESSION_SECRET` | **Required in production** (min 16 chars). Signs the httpOnly session cookie. Dev/test may use a local default. |
| `DATABASE_URL` | **Required.** The app's runtime Postgres connection (`server/db.ts`) — the restricted `app_user` role (`schema.sql`), not `postgres`. Normal table access, no `BYPASSRLS`, no access to `user_credentials` at all. |
| `SCHEMA_DATABASE_URL` | Privileged connection used only for `npm run db:schema` — `schema.sql` creates/alters tables, roles, and functions, which `app_user` can't do. Falls back to `DATABASE_URL` if unset. |
| `SUPABASE_JWT_SECRET` | Signs a short-lived, **server-only** Postgres request token minted per authenticated request (`server/db.ts`) — never sent to the browser. Lets `auth.uid()`/`auth.role()` resolve inside RLS policies. Required in production; dev/test may use a local default. |
| `VITE_API_BASE_URL` | Frontend API origin (no trailing slash). |
| `ALLOWED_ORIGINS` | Comma-separated CORS / CSRF allowlist. |
| `TRUST_PROXY` | Set when behind a trusted reverse proxy (or rely on `RENDER`). |
| `COOKIE_SECURE` | Force `Secure` + `SameSite=None` cookies (also enabled when `NODE_ENV=production` or `RENDER`). |
| `OPENROUTER_API_KEY` | Optional; enables AI assist / companion / semantic search. |

`.env.test` needs its own `DATABASE_URL` (`app_user`), `SCHEMA_DATABASE_URL` (`postgres`), and `PRODUCTION_PROJECT_REF` — see Testing below.

## Architecture

```
app/
  src/       React client (Vite)
  server/    Hono API + Postgres access (server/db.ts, server/schema.sql)
  shared/    Zod schemas + constants shared by client and server
```

The full REST surface is documented as a comment above `createApp()` in `server/index.ts` — check there before adding a client call, so it stays a single source of truth instead of drifting out of sync with two lists.

**Auth:** email + password signup/login, no email verification. On success the server sets an `httpOnly`, HMAC-signed session cookie (see `server/session.ts`) — there's no `Authorization`/bearer-token path. Mutating requests (`POST`/`PUT`/`DELETE`/`PATCH`) are origin/referer-checked against `ALLOWED_ORIGINS` when those headers are present, as CSRF defense for the cookie-based session. Passwords are bcrypt-hashed and stored separately from the `users` row, in `user_credentials` — reachable only through two `SECURITY DEFINER` functions (`get_password_hash_for_login`, `create_user_credentials`), not a direct table grant.

**Postgres identity:** after the session cookie resolves a user, the server mints a second, short-lived JWT (`sub`/`role`/`aud`/`exp`, signed with `SUPABASE_JWT_SECRET`) that never leaves the server. Each query in that request runs in its own transaction with the claim attached via `set_config('request.jwt.claims', ..., true)` (`server/db.ts`'s `getSql()` + `withRequestUser`), so Postgres's `auth.uid()`/`auth.role()` resolve correctly inside RLS policies. Guests get no claim at all — `auth.uid()` is `NULL` for them, by design (see RLS below).

**Data / RLS:** Postgres, accessed through a lazily-initialized connection pool. The app connects as `app_user`, a restricted role with no `BYPASSRLS` — every table has row-level security enabled and enforced for it. Policies (`server/schema.sql`):

- `tweets` / `comments` / `likes` / `reactions`: readable by anyone, including guests, **except** rows authored by someone the viewer blocks or is blocked by (symmetric, checked via `is_blocked_pair()`). Insert/delete only as yourself.
- `follows`: readable by anyone. Insert/delete only as the follower.
- `users`: readable by anyone (public profiles). Insert is unrestricted (signup happens before any session exists). Update only your own row.
- `messages`: readable only by sender or recipient. Insert only as the sender.
- `notifications`: readable/updatable only by the recipient. Insert as the actor, for any recipient.
- `user_credentials`: no policies at all — unreachable by `app_user` by any path except the two `SECURITY DEFINER` functions above.

`schema.sql` also defines `SCHEMA_DATABASE_URL`'s privileged role and is safe to re-run — apply it with `npm run db:schema`. Tweets past 24h aren't deleted; every read filters `created_at >= now() - interval '24 hours'`, so expired rows just stop appearing. Notifications are capped at 200 per recipient, pruned on each push.

## Testing

`npm test` runs the Vitest suite (`server/*.test.ts`) against a **separate** Postgres database, configured via `.env.test` (gitignored — copy `.env.test.example`). It needs both `DATABASE_URL` (`app_user`, what the app under test actually connects as) and `SCHEMA_DATABASE_URL` (`postgres`, privileged). `server/testDbSetup.ts` (a vitest `setupFile`, wired to the `server` project only in `vitest.config.ts` — `shared`/`src` tests don't touch Postgres) truncates every table before each test using `SCHEMA_DATABASE_URL` (`app_user` has no `TRUNCATE` grant), and refuses to run at all if `SCHEMA_DATABASE_URL` resolves to the same Supabase project as `PRODUCTION_PROJECT_REF` — see the guard's comments for exactly what it checks. Apply the schema to the test database once with `npm run db:schema:test`.

A couple of tests (`server/deleteOwnership.test.ts`, `server/blockVisibility.test.ts`) exist specifically to prove RLS is a real backstop, not just documentation — one deliberately strips the app-level ownership check from tweet deletion and confirms the database still refuses; the other checks block-visibility directly against the database, bypassing the HTTP layer entirely.

## Deploy

- **Client:** GitHub Pages (static Vite build). Point `VITE_API_BASE_URL` at the API.
- **API:** Render (or similar Node host). Set `SESSION_SECRET`, `DATABASE_URL` (`app_user`), `SUPABASE_JWT_SECRET`, `ALLOWED_ORIGINS`, and optional OpenRouter keys. Enable `TRUST_PROXY` / rely on `RENDER` for rate-limit IP headers. Run `npm run db:schema` (with `SCHEMA_DATABASE_URL` set to the privileged connection) against production before first deploy.

## Security notes

- Never ship without a strong `SESSION_SECRET` and `SUPABASE_JWT_SECRET` in production.
- `DATABASE_URL`, `SCHEMA_DATABASE_URL` (and `.env`/`.env.test` generally) must never be committed — keep them out of git. `app_user`'s password is set out of band (`ALTER ROLE app_user WITH PASSWORD ...`), never written to a file this repo tracks.
- RLS is the backstop, not the only layer — app-level checks (ownership, block filtering in `messages.ts`) still run first. Both are meant to hold independently.
- `user_credentials` is unreachable from `app_user` by grant or by policy; only `get_password_hash_for_login`/`create_user_credentials` (`SECURITY DEFINER`) touch it.
- Explore suggestions and user search require a signed-in session.
