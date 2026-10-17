-- Idempotency ledger for the Stripe webhook (and any future provider webhook).
-- Stripe re-delivers events on retries and from the "Resend" dashboard button;
-- recording the event id BEFORE processing lets us short-circuit duplicates and
-- safely return 5xx on transient failures so Stripe will retry.
--
-- Writes happen only via the service role key — RLS denies everything else.

begin;

create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received',  -- received | processed | failed
  error text
);

create index if not exists stripe_webhook_events_received_at_idx
  on public.stripe_webhook_events (received_at desc);

alter table public.stripe_webhook_events enable row level security;

-- No SELECT / INSERT / UPDATE / DELETE policies for authenticated users.
-- The webhook function uses the service role key which bypasses RLS.

commit;
