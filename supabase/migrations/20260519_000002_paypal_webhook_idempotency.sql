-- Idempotency ledger for the PayPal webhook (BILLING.SUBSCRIPTION.* and
-- PAYMENT.SALE.COMPLETED events). Same pattern as stripe_webhook_events.

begin;

create table if not exists public.paypal_webhook_events (
  event_id text primary key,
  event_type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received',  -- received | processed | failed
  error text
);

create index if not exists paypal_webhook_events_received_at_idx
  on public.paypal_webhook_events (received_at desc);

alter table public.paypal_webhook_events enable row level security;

-- No client-facing policies — only the service role writes here.

commit;
