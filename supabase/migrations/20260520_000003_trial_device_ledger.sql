create table if not exists public.subscription_trial_devices (
  device_hash text primary key,
  first_user_id uuid references auth.users(id) on delete set null,
  first_subscription_id text,
  provider text not null default 'stripe',
  used_at timestamptz not null default now()
);

alter table public.subscription_trial_devices enable row level security;

drop policy if exists "No public trial-device access" on public.subscription_trial_devices;

