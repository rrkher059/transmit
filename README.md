# Transmit

Short-lived social network built with a Vite + React client and a Hono API.

**Live:** https://transmit-blond.vercel.app

## Stack

- React / Vite (frontend, hosted on Vercel)
- Hono (API, hosted on Render)
- Zod (shared schemas)
- Postgres via Supabase, with row-level security

## Setup

```bash
cd app
npm install
cp .env.example .env
npm run dev
```

Or from the repo root:

```bash
npm run dev
```

Copy `.env.example` to `app/.env` and fill in secrets before running. See `app/README.md` for environment variables, architecture, and deploy notes.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start API + Vite client |
| `npm run build` | Production build |
| `npm test` | Run tests |
| `npm run lint` | Lint |

## License

Private / unpublished.
