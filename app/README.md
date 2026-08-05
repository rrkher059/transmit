# 7RANSMI7 (`app/`)

Short-lived social network: Vite + React client, Hono API, shared Zod schemas, JSON file stores. Posts self-delete 24 hours after posting (`TWEET_TTL_MS`, swept every 30s server-side).

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

## Environment

See `.env.example`. Important:

| Variable | Notes |
|---|---|
| `SESSION_SECRET` | **Required in production** (min 16 chars). Dev/test may use a local default. |
| `VITE_API_BASE_URL` | Frontend API origin (no trailing slash). |
| `ALLOWED_ORIGINS` | Comma-separated CORS / CSRF allowlist. |
| `TRUST_PROXY` | Set when behind a trusted reverse proxy (or rely on `RENDER`). |
| `OPENROUTER_API_KEY` | Optional; enables AI assist / companion / semantic search. |

## Architecture

```
app/
  src/       React client (Vite)
  server/    Hono API + JSON stores (tweets, users, follows, messages, notifications, blocks)
  shared/    Zod schemas + constants shared by client and server
  data/      Runtime JSON files (gitignored except .gitkeep)
```

The full REST surface is documented as a comment above `createApp()` in `server/index.ts` — check there before adding a client call, so it stays a single source of truth instead of drifting out of sync with two lists.

**Auth:** email + password signup/login, no email verification. On success the server sets an `httpOnly`, HMAC-signed session cookie (see `server/session.ts`) — there's no `Authorization`/bearer-token path. Mutating requests (`POST`/`PUT`/`DELETE`/`PATCH`) are origin/referer-checked against `ALLOWED_ORIGINS` when those headers are present, as CSRF defense for the cookie-based session.

**Data:** JSON files under `data/`, no database. Reads/writes go through `server/jsonStore.ts`; tweets older than 24h and expired rate-limit buckets are purged on a 30s interval (`server/index.ts`). To reset local state, stop the server and delete `data/*.json`.

## Testing

`npm test` runs the Vitest suite (`server/*.test.ts`) against temp JSON stores — each test file gets its own `mkdtemp` dir via `TWEET_STORE_PATH`/`USERS_STORE_PATH`, so runs don't touch `data/` or each other.

## Deploy

- **Client:** GitHub Pages (static Vite build). Point `VITE_API_BASE_URL` at the API.
- **API:** Render (or similar Node host). Set `SESSION_SECRET`, `ALLOWED_ORIGINS`, and optional OpenRouter keys. Enable `TRUST_PROXY` / rely on `RENDER` for rate-limit IP headers.

## Security notes

- Never ship without a strong `SESSION_SECRET` in production.
- Runtime data under `data/` is private — keep it out of git.
- Explore suggestions and user search require a signed-in session.
