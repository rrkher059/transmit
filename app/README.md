# 7RANSMI7 (`app/`)

Short-lived social network: Vite + React client, Hono API, shared Zod schemas, Postgres. Posts stay live for 24 hours after posting (`TWEET_TTL_MS`) — enforced by filtering on `created_at` at read time in every query, not by deleting rows.

## Run locally

```bash
cd app
npm install
cp .env.example .env   # then edit secrets
npm run dev            # Vite + API (see package.json scripts)
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
| `npm run db:schema` | Apply `server/schema.sql` to `DATABASE_URL` from `.env` |
| `npm run db:schema:test` | Apply `server/schema.sql` to `DATABASE_URL` from `.env.test` |

## Environment

See `.env.example`. Important:

| Variable | Notes |
|---|---|
| `SESSION_SECRET` | **Required in production** (min 16 chars). Dev/test may use a local default. |
| `DATABASE_URL` | **Required.** Postgres connection string (`server/db.ts`) — no fallback, the server refuses to start a query without it. |
| `VITE_API_BASE_URL` | Frontend API origin (no trailing slash). |
| `ALLOWED_ORIGINS` | Comma-separated CORS / CSRF allowlist. |
| `TRUST_PROXY` | Set when behind a trusted reverse proxy (or rely on `RENDER`). |
| `OPENROUTER_API_KEY` | Optional; enables AI assist / companion / semantic search. |

## Architecture

```
app/
  src/       React client (Vite)
  server/    Hono API + Postgres access (server/db.ts, server/schema.sql)
  shared/    Zod schemas + constants shared by client and server
```

The full REST surface is documented as a comment above `createApp()` in `server/index.ts` — check there before adding a client call, so it stays a single source of truth instead of drifting out of sync with two lists.

**Auth:** email + password signup/login, no email verification. On success the server sets an `httpOnly`, HMAC-signed session cookie (see `server/session.ts`) — there's no `Authorization`/bearer-token path. Mutating requests (`POST`/`PUT`/`DELETE`/`PATCH`) are origin/referer-checked against `ALLOWED_ORIGINS` when those headers are present, as CSRF defense for the cookie-based session.

**Data:** Postgres, accessed through a single lazily-initialized connection pool (`server/db.ts`'s `getSql()`) — importing the module is free; the pool is built on first query, so `DATABASE_URL` is only required by code paths that actually touch the database. `server/schema.sql` is the whole schema (tables, indexes, FKs with `ON DELETE CASCADE`/`SET NULL`, check constraints) and is safe to re-run — apply it with `npm run db:schema`. Tweets past 24h aren't deleted; every read filters `created_at >= now() - interval '24 hours'`, so expired rows just stop appearing. Notifications are capped at 200 per recipient, pruned on each push.

## Testing

`npm test` runs the Vitest suite (`server/*.test.ts`) against a **separate** Postgres database, configured via `.env.test` (gitignored — copy `.env.test.example`, fill in `DATABASE_URL` and `PRODUCTION_PROJECT_REF`). `server/testDbSetup.ts` (a vitest `setupFile`, wired to the `server` project only in `vitest.config.ts` — the `shared`/`src` tests don't touch Postgres at all) truncates every table before each test, and refuses to run at all if `DATABASE_URL` resolves to the same Supabase project as `PRODUCTION_PROJECT_REF` — see the guard's comments for exactly what it checks. Apply the schema to the test database once with `npm run db:schema:test`.

## Deploy

- **Client:** GitHub Pages (static Vite build). Point `VITE_API_BASE_URL` at the API.
- **API:** Render (or similar Node host). Set `SESSION_SECRET`, `DATABASE_URL`, `ALLOWED_ORIGINS`, and optional OpenRouter keys. Enable `TRUST_PROXY` / rely on `RENDER` for rate-limit IP headers. Run `npm run db:schema` against the production `DATABASE_URL` before first deploy.

## Security notes

- Never ship without a strong `SESSION_SECRET` in production.
- `DATABASE_URL` (and `.env`/`.env.test` generally) must never be committed — keep it out of git.
- Explore suggestions and user search require a signed-in session.
