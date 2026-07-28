# Netlify → Cloudflare Pages migration

This branch (`cloudflare-migration`) ports the Netlify-hosted frontend +
Functions + Edge Function to Cloudflare Pages. The Python backend on
Fly.io is unaffected.

## What changed

| Old (Netlify) | New (Cloudflare Pages) |
|---|---|
| `netlify.toml` | `wrangler.toml` + dashboard settings |
| `backend/functions/*.ts` (36 handlers) | unchanged — re-exported through `functions/api/*` shims |
| `backend/edge-functions/ai-stream.js` | reused via `functions/api/ai/stream.ts` shim |
| `[[redirects]]` for `/api/*` | not needed — file-based routing under `functions/api/` |
| `[[headers]]` | `frontend/_headers` |
| `[[redirects]]` for static paths | `frontend/_redirects` |

The 36 existing handlers in `backend/functions/` are imported and
re-exported by tiny shims under `functions/api/` via the
`backend/lib/pages-adapter.ts` adapter. The adapter synthesises a
`NetlifyEvent` from the Pages `Request`, calls the handler unchanged,
and converts the returned `LambdaResponse` back to a `Response`.
Re-generate the shims by running:

```
node scripts/generate-pages-shims.mjs
```

`stripe-webhook` and `paypal-webhook` shims pass
`{ rawBody: 'base64' }` so the adapter base64-encodes the body and
sets `isBase64Encoded: true`. The existing webhook handlers already
decode that into the raw bytes for signature verification — no code
changes needed.

The edge SSE handler at `functions/api/ai/stream.ts` shims `Deno.env`
on `globalThis` and dynamically imports the original `.js` so it runs
unchanged on Workers (only `Deno.env.get` was Deno-specific; everything
else is Web standard).

## Cloudflare Pages dashboard settings

After connecting the GitHub repo:

| Setting | Value |
|---|---|
| Production branch | `main` (or `cloudflare-migration` for staging first) |
| Build command | `npm run build:frontend` |
| Build output directory | `frontend` |
| Root directory | (repo root) |
| Compatibility flags | `nodejs_compat` (also set in `wrangler.toml`) |
| Compatibility date | `2026-05-22` (set in `wrangler.toml`) |

## Environment variables to set in Cloudflare dashboard

Project → Settings → Environment variables. Both **Production** and
**Preview** environments need these (the values can differ).

### Supabase
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

### Python AI backend
- `AI_SERVICE_URL` (e.g. `https://python-ai.fly.dev`)
- `AI_UPSTREAM_TIMEOUT_MS`
- `INTERNAL_SECRET`

### OpenAI (edge SSE function)
- `OPENAI_API_KEY`
- `AI_MODEL` (default `gpt-4o`)
- `AI_NANO_MODEL` (default `gpt-4.1-nano`)

### Stripe
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID`

### PayPal
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_PLAN_ID`
- `PAYPAL_WEBHOOK_ID`
- `PAYPAL_API_BASE`

### Rate limits + caps (optional — handlers have defaults)
- `AI_CHAT_RATE_LIMIT_MAX` / `AI_CHAT_RATE_LIMIT_WINDOW_MS`
- `AI_ASK_RATE_LIMIT_MAX` / `AI_ASK_RATE_LIMIT_WINDOW_MS`
- `AI_GENERATE_RATE_LIMIT_MAX` / `AI_GENERATE_RATE_LIMIT_WINDOW_MS`
- `CHAT_RATE_LIMIT_MAX` / `CHAT_RATE_LIMIT_WINDOW_MS`
- `NOTES_RATE_LIMIT_MAX` / `NOTES_RATE_LIMIT_WINDOW_MS`
- `UPLOAD_RATE_LIMIT_MAX` / `UPLOAD_RATE_LIMIT_WINDOW_MS`
- `WRITING_COACH_RATE_LIMIT_MAX` / `WRITING_COACH_RATE_LIMIT_WINDOW_MS`
- `AI_MONTHLY_CAP`, `INTERACTIVE_MONTHLY_CAP`, `GENERATION_MONTHLY_CAP`

### Misc
- `ALLOWED_ORIGIN` (e.g. `https://minallo.de`)
- `RAG_STORAGE_BUCKET`

## Webhook URLs to update at the providers

After the first successful Pages deploy, update the webhook URLs on
Stripe and PayPal so they point to Cloudflare instead of Netlify.

| Provider | Old URL | New URL |
|---|---|---|
| Stripe | `https://minallo.netlify.app/api/stripe-webhook` | `https://<pages-domain>/api/stripe-webhook` |
| PayPal | `https://minallo.netlify.app/api/paypal-webhook` | `https://<pages-domain>/api/paypal-webhook` |

Stripe + PayPal webhook secrets stay the same — the signature verification
code is unchanged; only the receiving URL moves.

## DNS cutover

When Pages is verified to work end-to-end on the `*.pages.dev` URL:

1. In Cloudflare: add `minallo.de` (or whatever the prod domain is) as a
   custom domain on the Pages project.
2. Point the apex / `www` DNS record at the Pages target (Cloudflare DNS
   does this automatically when the domain is on Cloudflare).
3. Wait for the Pages-issued cert to provision.
4. Disable the Netlify production deploy (or delete the site once you're
   confident no rollback is needed).

## Things to verify after first deploy

- [ ] `/` loads, sign-in works (Supabase auth)
- [ ] `/api/ai` returns a valid response (the proxy to python-ai)
- [ ] `/api/ai/stream` streams SSE tokens (the edge function port)
- [ ] `/api/documents/upload` accepts a PDF (file upload through Pages)
- [ ] `/api/stripe-webhook` returns 200 to a Stripe test event (raw-body signature ok)
- [ ] `/api/paypal-webhook` returns 200 to a PayPal sandbox event
- [ ] CSP doesn't break any third-party iframes / scripts
- [ ] Cache headers correct on `/*.js`, `/*.css`, `/assets/*`, `/*.html`

## Rollback

The `netlify.toml` is preserved on this branch. To roll back:

1. Re-enable the Netlify production deploy from the Netlify dashboard.
2. Move the DNS records back to Netlify.
3. Re-point Stripe + PayPal webhooks to the Netlify URLs.

No code changes are needed — everything Netlify-side was left intact.
