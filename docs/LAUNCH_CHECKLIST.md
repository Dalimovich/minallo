# Launch checklist

Post-deploy steps and the SQL queries to keep an eye on after launch.
Each step is independent — work through them top-to-bottom or as needed.

## 1. Apply the new Supabase migrations

Run these in the Supabase SQL editor, in this order. All are idempotent
(safe to re-run). The two `2026-05-19` files are the only launch-blockers:
without `…_000004_…_cleanup.sql` an authenticated user can grant themselves
permanent Pro via a direct PostgREST PATCH.

| File | Purpose |
| --- | --- |
| [`20260519_000001_stripe_webhook_idempotency.sql`](../supabase/migrations/20260519_000001_stripe_webhook_idempotency.sql) | Idempotency ledger for the Stripe webhook |
| [`20260519_000002_paypal_webhook_idempotency.sql`](../supabase/migrations/20260519_000002_paypal_webhook_idempotency.sql) | Idempotency ledger for the PayPal webhook |
| [`20260519_000003_profiles_subscriptions_rls.sql`](../supabase/migrations/20260519_000003_profiles_subscriptions_rls.sql) | Defensive RLS + own-row policies on profiles / subscriptions |
| [`20260519_000004_profiles_subscriptions_rls_cleanup.sql`](../supabase/migrations/20260519_000004_profiles_subscriptions_rls_cleanup.sql) | **Drops the dangerous `ALL public` policies that let users self-grant Pro** |

After running `000004`, verify the remaining policies:

```sql
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename in ('profiles', 'subscriptions')
order by tablename, policyname;
```

Expected output (exactly these four rows):

```
profiles      | profiles_owner_insert      | INSERT | {authenticated}
profiles      | profiles_owner_select      | SELECT | {authenticated}
profiles      | profiles_owner_update      | UPDATE | {authenticated}
subscriptions | subscriptions_owner_select | SELECT | {authenticated}
```

If any `public`-role policy remains, drop it manually.

## 2. Netlify env vars

Confirm all of these are set in **Site settings → Environment variables**.
Anything new since the audit is starred.

```
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
OPENAI_API_KEY
AI_SERVICE_URL                # https://python-ai.fly.dev
INTERNAL_SECRET               # shared with the Fly service
STRIPE_SECRET_KEY
STRIPE_PRICE_ID
STRIPE_WEBHOOK_SECRET
PAYPAL_CLIENT_ID
PAYPAL_CLIENT_SECRET
PAYPAL_PLAN_ID
PAYPAL_WEBHOOK_ID             # *new, required by /api/paypal-webhook
PAYPAL_API_BASE               # https://api-m.paypal.com
ALLOWED_ORIGIN                # https://minallo.de
INTERACTIVE_MONTHLY_CAP       # *new, default 2000 (chat / RAG / writing-coach)
GENERATION_MONTHLY_CAP        # *new, default 200  (quiz / flashcards / notes)
AI_MONTHLY_CAP                # legacy alias, routes to interactive bucket
```

Trigger a Netlify redeploy after editing env vars — function bundles do not
auto-pick-up env changes.

## 3. Stripe webhook

In **Stripe Dashboard → Developers → Webhooks**:

- URL: `https://minallo.de/api/stripe-webhook`
- Events to subscribe: `checkout.session.completed`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `invoice.payment_failed`.
- The signing secret goes into `STRIPE_WEBHOOK_SECRET`.

**Stripe Tax** should be left off / set to "inclusive of tax" since the
business runs under §19 UStG (no VAT).

## 4. PayPal webhook

In **PayPal Developer Dashboard → Apps & Credentials → your live app →
Webhooks**:

- URL: `https://minallo.de/api/paypal-webhook`
- Subscribe to the `Billing subscription` event family + `Payment sale completed`
  (others may stay enabled — the handler ignores unknown types).
- Copy the webhook ID into `PAYPAL_WEBHOOK_ID`.

If you also use the PayPal Sandbox in a non-production Netlify deploy
context, register a separate sandbox webhook and scope a separate
`PAYPAL_WEBHOOK_ID` value to those contexts.

## 5. Fly.io (Python AI service)

The Schreibtrainer routes (`/writing-coach-analyse`) live in the Python
service. After merging today's branch:

```bash
cd backend/python-ai
flyctl deploy
```

If the deploy fails with `x509: certificate signed by unknown authority`
on the depot builder, that's a local network/cert issue — retry from a
different network or behind a known-good proxy.

## 6. Domain-level

- `datenschutz@minallo.de` alias → your inbox (referenced in the privacy
  policy; without it Art. 15 DSGVO requests will bounce).
- DNS / Netlify domain assignment to `minallo.de` confirmed and
  HTTPS-only.

---

# Post-launch monitoring queries

Run these in the Supabase SQL editor. They cover the three things that
will hurt if they go wrong: cost runaway, abuse attempts, and payment
state drift.

## Cost / fair-use

Top 20 users by AI call count this calendar month:

```sql
select user_id,
       count(*) filter (where event_type = 'ai_ask')                  as ai_ask,
       count(*) filter (where event_type = 'ai_generate')             as ai_generate,
       count(*) filter (where event_type = 'ai_chat')                 as ai_chat,
       count(*) filter (where event_type = 'notes_generate')          as notes_generate,
       count(*) filter (where event_type = 'writing_coach_analyse')   as writing_coach,
       count(*) filter (where event_type = 'ask_stream')              as ask_stream,
       count(*)                                                       as total
from public.security_events
where created_at >= date_trunc('month', now())
  and event_type in (
    'ai_ask','ai_generate','ai_chat','notes_generate',
    'writing_coach_analyse','ask_stream'
  )
group by user_id
order by total desc
limit 20;
```

Users who hit either monthly fair-use cap (= cost-protection working).
The `bucket` field on the metadata distinguishes `interactive` (chat / RAG /
writing-coach / stream, default 2000/mo) from `generation` (quiz / flashcards
/ notes, default 200/mo):

```sql
select user_id, count(*) as cap_hits, max(created_at) as last_hit
from public.security_events
where event_type = 'ai_monthly_cap_blocked'
  and created_at >= date_trunc('month', now())
group by user_id
order by cap_hits desc;
```

## Abuse / security

Subscription-gate denials this week (free users probing paid endpoints):

```sql
select user_id, metadata->>'reason' as endpoint, count(*) as attempts
from public.security_events
where event_type = 'subscription_gate_blocked'
  and created_at >= now() - interval '7 days'
group by user_id, endpoint
order by attempts desc;
```

Hourly rate-limit hits (= bursts / scripts):

```sql
select date_trunc('hour', created_at) as hr,
       event_type,
       count(*) as hits
from public.security_events
where event_type like '%_rate_limited'
  and created_at >= now() - interval '7 days'
group by hr, event_type
order by hr desc, hits desc;
```

Failed PayPal-subscription plan / user mismatches (potential spoofing):

```sql
select user_id, event_type, metadata, created_at
from public.security_events
where event_type in ('paypal_subscription_plan_mismatch',
                     'paypal_subscription_user_mismatch')
  and created_at >= now() - interval '30 days'
order by created_at desc;
```

## Webhook health

Webhook events that failed processing (these are auto-retried, but a
sustained failure rate signals a bug):

```sql
select 'stripe' as provider, event_type, count(*) as failed
from public.stripe_webhook_events
where status = 'failed' and received_at >= now() - interval '7 days'
group by event_type
union all
select 'paypal' as provider, event_type, count(*) as failed
from public.paypal_webhook_events
where status = 'failed' and received_at >= now() - interval '7 days'
group by event_type
order by failed desc;
```

Duplicate webhook deliveries (sanity — idempotency catching retries):

```sql
select provider, count(*) as duplicates
from (
  select 'stripe' as provider from public.stripe_webhook_events
  union all
  select 'paypal' as provider from public.paypal_webhook_events
) e
group by provider;
```

## Subscription state drift

Users marked `active` but with `expires_at` in the past (something fell
through the cracks — webhook should have already cleared this):

```sql
select user_id, plan, status, expires_at, updated_at
from public.subscriptions
where status in ('active', 'trialing')
  and expires_at < now()
order by expires_at;
```

Users marked `past_due` (payment failed; consider a recovery email):

```sql
select user_id, plan, expires_at, updated_at
from public.subscriptions
where status = 'past_due'
order by updated_at desc;
```

---

# Rollback notes

If `20260519_000004` accidentally removed a policy you needed (e.g. a
chat-friends feature that read profiles cross-user via the anon key
rather than via the backend service-role), the safe way back is to
re-add a *narrowly-scoped* policy rather than restoring the
`ALL public` policy. Cross-user profile reads should go through the
backend (`/api/chat-friends`, `/api/chat-user-search`), which uses the
service role and is already deployed.

If you must restore broad read access temporarily, the policy that's
**safe-ish** is:

```sql
create policy "profiles_authenticated_curated_read"
on public.profiles
for select to authenticated
using (true);
```

But never re-create `ALL public` policies on `subscriptions` — that one
is a direct revenue leak.
