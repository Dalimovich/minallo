-- Track Stripe's cancel_at_period_end flag so the UI can show
-- "Pro ends on <date>" without losing access until the period actually
-- expires. Set by cancel-subscription.ts and cleared by the Stripe
-- webhook when the user reactivates (cancel_at_period_end: false) or
-- the subscription is fully deleted.
alter table public.subscriptions
  add column if not exists cancel_at_period_end boolean not null default false;
