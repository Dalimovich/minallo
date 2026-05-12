# Minallo

Minallo is a student workspace built around courses, files, AI study tools, chat, notes, and subscriptions.

The app is currently a Netlify-hosted frontend with Supabase for auth, database, and storage, plus Netlify Functions for AI, payments, admin actions, and a few chat/security-sensitive flows.

## What The Website Does Right Now

- Account auth with Supabase email/password and Google sign-in
- Course dashboard with manual subject management and course-specific file areas
- PDF viewing and PDF-based AI help
- AI side panel and chatbot-style study flows
- Lecture notes and editor tools
- Real-time-style chat UI with:
  - general rooms
  - course rooms
  - custom rooms
  - direct-message style friend rooms
- Friend search and friend list rendering
- Profile and settings pages
- Subscription UI with Stripe portal/checkout support and PayPal activation flow
- Admin user search and subscription management tools
- Small games and practice/study utility sections
- Browser extension support under `frontend/extension`

## Current Stack

| Layer               | Tech                       |
| ------------------- | -------------------------- |
| Frontend            | Vanilla JS, HTML, CSS      |
| Hosting             | Netlify                    |
| Auth / DB / Storage | Supabase                   |
| AI                  | Netlify Function to OpenAI |
| Payments            | Stripe + PayPal            |
| PDF Rendering       | pdf.js                     |

## Current Repo Layout

```txt
frontend/
  index.html
  privacy.html
  assets/
  css/
  extension/
  features/
    chat/
    chatbot/
    dashboard/
    editor/
    games/
    lecturenotes/
    practice/
    profile/
    settings/
    subscription/
    toast/
  js/
    main.js              ← entry point (imports app.js + feature modules)
    app.js               ← compatibility bridge (being trimmed down)
    app-data.js
    app-pdf.js
    app-storage.js
    auth-bootstrap.js
    config/
      icons.js
      pdf-config.js
    core/
      navigation.js
      panels.js
      state.js
    features/
      ai-chat/
        ai-ask.js
        ai-chips.js
        ai-export.js
        ai-markdown.js
        ai-message-actions.js
        multi-summary.js
      admin/
        admin-panel.js
      auth/
        onboarding.js
        user-data.js
      courses/
        course-files.js
        course-folders.js
        course-view.js
        courses-render.js
      pdf-viewer/
        pdf-text-extraction.js
        pdf-viewer.js
      settings/
        language.js
        settings.js
      study-timer/
        study-timer.js
    services/
      admin-service.js
      ai-service.js
      pdf-service.js
      storage-service.js
    utils/
      escape-html.js
    loader.js
    router.js
    minallo.js
    supabase.js
  pages/

backend/
  functions/
    _shared.js
    ai.js
    admin-users.js
    chat-friends.js
    send-chat-message.js
    join-room-by-code.js
    create-checkout.js
    create-portal.js
    verify-payment.js
    stripe-webhook.js
    activate-paypal-subscription.js
  lib/
    cors.js
    responses.js
    supabase-auth.js
    supabase-admin.js
    stripe.js
    logger.js

docs/
  Minallo_admin_security.sql
  Minallo_rls_hardening.sql
  Minallo_storage_security.sql
  Minallo_chat_room_rls_patch.sql

.env.example
```

## Important Backend Endpoints

These are exposed through `netlify.toml`:

- `/api/ai`
- `/api/admin-users`
- `/api/chat-friends`
- `/api/send-chat-message`
- `/api/join-room-by-code`
- `/api/create-checkout`
- `/api/create-portal`
- `/api/verify-payment`
- `/api/stripe-webhook`
- `/api/activate-paypal-subscription`

## Security State

The project is no longer in the old wide-open Supabase stage. The current repo includes hardening work for:

- row-level security for profiles, settings, notes, rooms, messages, reactions, pins, nicknames, typing indicators, friendships, blocked users, and subscriptions
- private Supabase Storage buckets and object policies
- backend-only subscription activation/write flows
- admin authorization through backend checks and `admins` / `security_events`
- chat message sending moved behind a backend function
- chat friend list loading moved behind a backend function
- basic chat/message rate limiting
- Netlify security headers

Supabase SQL files live in `docs/` and must be run in the Supabase SQL Editor for a real deployment.

## Supabase Setup

Run these SQL files in the Supabase SQL Editor:

1. `docs/Minallo_admin_security.sql`
2. `docs/Minallo_rls_hardening.sql`
3. `docs/Minallo_storage_security.sql`
4. `docs/Minallo_chat_room_rls_patch.sql`

Without these, the website will not match the intended security model.

## Environment Variables

The current Netlify functions expect some or all of these variables:

```txt
OPENAI_API_KEY

SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY

STRIPE_SECRET_KEY
STRIPE_PRICE_ID
STRIPE_WEBHOOK_SECRET

PAYPAL_CLIENT_ID
PAYPAL_CLIENT_SECRET
PAYPAL_PLAN_ID
PAYPAL_API_BASE

ALLOWED_ORIGIN

CHAT_RATE_LIMIT_MAX
CHAT_RATE_LIMIT_WINDOW_MS

AI_RATE_LIMIT_MAX
AI_RATE_LIMIT_WINDOW_MS
```

Notes:

- `PAYPAL_API_BASE` is optional and can point to sandbox for testing.
- `ALLOWED_ORIGIN` should match the production site origin.

## Local Development

There is no heavy frontend build step. The app is a static frontend plus Netlify Functions.

Typical local flow:

1. Install the Netlify CLI if needed.
2. Configure the required environment variables.
3. Run the site with:

```bash
netlify dev
```

This gives you:

- the frontend
- local function routing
- the same `/api/...` paths used in production

Opening `frontend/index.html` directly is not enough if you need functions, auth flows, or API-backed features.

## Deployment

Production is set up for Netlify:

- frontend publish directory: `frontend`
- functions directory: `backend/functions`
- redirects and security headers: `netlify.toml`

If the site is connected to Netlify, deploying the latest repo state is essentially:

```bash
netlify deploy --prod
```

In this workspace there are also helper scripts under `scripts/` for checks and deployment.

## Current Caveats

- `frontend/js/app.js` is still a compatibility-heavy file while the refactor continues.
- Some newer backend-protected flows coexist with older direct Supabase frontend calls in other parts of the app.
- The roadmap in `Minallo_code_improvement_roadmap.md` is still relevant for modular cleanup.
- AI, chat, and admin flows depend on correct Netlify and Supabase environment configuration.

## Related Docs

- [Minallo_code_improvement_roadmap.md](./Minallo_code_improvement_roadmap.md)
- [Minallo_security_hardening_notes.md](./Minallo_security_hardening_notes.md)
- [docs/Minallo_admin_security.sql](./docs/Minallo_admin_security.sql)
- [docs/Minallo_rls_hardening.sql](./docs/Minallo_rls_hardening.sql)
- [docs/Minallo_storage_security.sql](./docs/Minallo_storage_security.sql)
- [docs/Minallo_chat_room_rls_patch.sql](./docs/Minallo_chat_room_rls_patch.sql)
