# Backend

The backend contains shared TypeScript helpers used by Cloudflare Pages Functions, and the Python AI service.

## Layout

```text
backend/
  lib/                        Shared TypeScript helpers
  python-ai/                  FastAPI service for indexing, retrieval, AI answers
  tsconfig.json               Backend TypeScript config

functions/
  api/                        Cloudflare Pages Functions exposed through /api/*
```

SQL migrations live at `../supabase/migrations/`.

## Functions

API functions live in `functions/api/` and are routed automatically by Cloudflare Pages using the directory structure. For example `functions/api/ai/ask.ts` maps to `POST /api/ai/ask`.

Key function groups:

| Route prefix | Function files | Purpose |
|---|---|---|
| `/api/ai/*` | `ai.ts`, `ai/ask.ts`, `ai/stream.ts`, `ai/generate.ts`, etc. | AI chat, RAG, generation |
| `/api/documents/*` | `documents/upload.ts`, `documents/list.ts`, etc. | Document management |
| `/api/learning/*` | `learning/topic-map.ts`, `learning/next-action.ts` | Learning features |
| `/api/notes*` | `notes.ts`, `notes/generate.ts` | Notes CRUD |
| `/api/*-webhook` | `stripe-webhook.ts`, `paypal-webhook.ts` | Payment webhooks |
| `/api/chat-*` | `chat-friends.ts`, `send-chat-message.ts`, etc. | Student chat |
| `/api/admin*` | `admin-users.ts`, `admin/retrieval-logs.ts` | Admin panel |
| `/api/*-subscription*` | `pause-subscription.ts`, `cancel-subscription.ts`, etc. | Billing |

When adding a function:

1. Add the TypeScript file under `functions/api/` using directory-based routing.
2. Call the clean `/api/...` route from the frontend.
3. Reuse shared helpers from `backend/lib/`.
4. Add tests when the function handles auth, billing, validation, or persistence.

## Shared Helpers

| File | Purpose |
|---|---|
| `cors.ts` | CORS headers and preflight handling |
| `env.ts` | Required/optional environment variable helpers |
| `logger.ts` | Structured backend logging |
| `python-ai-proxy.ts` | Proxy to the FastAPI AI service |
| `rate-limit.ts` | Per-user rate limiting helpers |
| `responses.ts` | JSON/failure response helpers |
| `stripe.ts` | Stripe client setup |
| `supabase-admin.ts` | Supabase service-role client |
| `supabase-auth.ts` | Supabase JWT verification |
| `subscription-gate.ts` | Paid feature access checks |
| `types.ts` | Shared backend types |
| `validation.ts` | Input validation helpers |

## AI Flow

Most AI routes are thin Cloudflare Functions shells. They authenticate the user, enforce subscriptions/rate limits, and then proxy to `backend/python-ai`.

Typical RAG ask flow:

```text
frontend
  -> /api/ai/ask
  -> Cloudflare Pages Function verifies JWT/subscription
  -> Python AI service retrieves course context
  -> LLM response returns with source metadata
```

Streaming answers may use the Python service directly when configured, but the same auth and subscription assumptions still apply.

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

Useful checks:

```bash
npm run typecheck:backend
npm run typecheck
npm run test
```

## Environment

See `../.env.example` for the canonical list. Backend functions commonly need:

- Supabase URL and service role key
- Supabase JWT/auth settings
- OpenAI keys/model settings
- AI service URL/internal secret
- Stripe keys/webhook secret
- PayPal keys/webhook ID
- Rate-limit and fair-use settings

Never expose service-role, Stripe, PayPal, or internal AI secrets to the frontend.

## Migrations

Use `../supabase/migrations/README.md` for order and process.

Rules:

- Run migrations in filename order.
- Do not edit applied production migrations.
- Add new migrations for new schema/RLS changes.
- Include verification SQL when touching RLS, subscriptions, webhooks, chat, or retrieval.
