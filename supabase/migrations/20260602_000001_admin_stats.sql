-- Admin analytics: an append-only history of subscription lifecycle events.
--
-- The `subscriptions` table only stores each user's CURRENT state, so it can't
-- answer "how many users kept paying month after month until they cancelled".
-- This table records each lifecycle transition as it happens (written by the
-- Stripe and PayPal webhooks) so the admin retention report can reconstruct
-- the paid timeline per user.
--
-- Signup analytics read auth.users.created_at directly from the admin function
-- (via the Auth Admin API), so they need no table here.
--
-- event_type vocabulary (kept small and stable):
--   trial_started — user began the 7-day free trial
--   paid          — user started a paid subscription with no trial
--   converted     — a trialing subscription became active (trial → paid)
--   renewed       — a recurring payment succeeded (monthly renewal)
--   cancelled     — subscription cancelled or deleted
--   expired       — subscription lapsed/expired

create table if not exists public.subscription_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid,
  provider        text not null default 'stripe',   -- stripe | paypal
  event_type      text not null,
  subscription_id text,
  amount_cents    integer,
  currency        text,
  period_start    timestamptz,
  period_end      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists idx_subscription_events_created_at
  on public.subscription_events (created_at desc);
create index if not exists idx_subscription_events_user_created
  on public.subscription_events (user_id, created_at);
create index if not exists idx_subscription_events_type_created
  on public.subscription_events (event_type, created_at);

-- Lock the table down: only the service role (used by the webhooks and the
-- admin function) may read/write it. Enabling RLS with no policies denies all
-- access to anon/authenticated; the service role bypasses RLS.
alter table public.subscription_events enable row level security;
