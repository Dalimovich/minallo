# Backend

Netlify Functions (TypeScript, esbuild bundler) + shared helpers + Supabase migrations.

## Layout

```
backend/
├── functions/        Netlify Functions grouped by domain
│   ├── admin/        Admin-only endpoints
│   ├── ai/           AI chat, generation, evaluation
│   ├── billing/      Stripe + PayPal payments
│   ├── chat/         Friend/room/messaging endpoints
│   ├── documents/    Upload, list, delete, indexing
│   └── notes/        Notes CRUD + generation
├── lib/              Shared modules imported by functions
├── migrations/       Sequential Supabase SQL migrations
└── tsconfig.json
```

## How URLs map to function files

The frontend calls clean paths like `/api/documents/list`. `netlify.toml` rewrites each one to the corresponding Netlify Function. With nested folders under `functions/`, the function name uses `/` as the separator:

| Frontend path | Function file | Function name |
|---|---|---|
| `/api/documents/list` | `functions/documents/list.ts` | `documents/list` |
| `/api/ai/ask` | `functions/ai/ask.ts` | `ai/ask` |
| `/api/admin-users` | `functions/admin/users.ts` | `admin/users` |

**Rule of thumb**: any new function needs three things in lockstep:
1. The file under the right domain folder in `functions/`.
2. A redirect entry in `netlify.toml` mapping the public `/api/...` path to `/.netlify/functions/<folder>/<name>`.
3. Frontend code that calls the `/api/...` path (never the `/.netlify/functions/...` form).

## `lib/` responsibilities

| File | Purpose |
|---|---|
| `cors.ts` | CORS headers used by every function |
| `env.ts` | `requireEnv` / `optionalEnv` helpers |
| `logger.ts` | Structured logging |
| `python-ai-proxy.ts` | Forward requests to the Python AI service on Fly.io |
| `rate-limit.ts` | Per-user rate limiting |
| `responses.ts` | `jsonResponse`, `fail`, `handleOptions` |
| `stripe.ts` | Stripe client setup |
| `supabase-admin.ts` | Supabase service-role client |
| `supabase-auth.ts` | JWT verification |
| `types.ts` | Shared types (`NetlifyEvent`, `LambdaResponse`) |
| `validation.ts` | Input validation helpers |

## Local development

```
npm run typecheck:backend   # tsc on functions + lib
npm run dev                 # netlify dev (functions on :8888)
```

## Migrations

Numbered SQL files in `migrations/`. Run order matters — never edit an already-applied migration; add a new one instead.
