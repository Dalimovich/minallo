-- Database-backed promoter / affiliate tracking.
-- A referred user can belong to exactly one promoter. Commission is awarded
-- once, on the first successful paid subscription event.

create extension if not exists pgcrypto;

-- Affiliate access is an explicit account status. Existing users remain
-- regular users until an administrator changes this value to 'affiliate'.
alter table public.profiles
  add column if not exists status text not null default 'user';
create index if not exists profiles_status_idx on public.profiles(status);

create table if not exists public.affiliate_partners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  referral_code text not null unique check (referral_code ~ '^[a-z0-9]{8,32}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.affiliate_referrals (
  id uuid primary key default gen_random_uuid(),
  affiliate_user_id uuid not null references public.affiliate_partners(user_id) on delete cascade,
  referred_user_id uuid not null unique references auth.users(id) on delete cascade,
  signed_up_at timestamptz not null default now(),
  trial_started_at timestamptz,
  subscribed_at timestamptz,
  constraint affiliate_no_self_referral check (affiliate_user_id <> referred_user_id)
);

create table if not exists public.affiliate_commissions (
  id uuid primary key default gen_random_uuid(),
  affiliate_user_id uuid not null references public.affiliate_partners(user_id) on delete cascade,
  referral_id uuid not null unique references public.affiliate_referrals(id) on delete cascade,
  amount_cents integer not null default 300 check (amount_cents = 300),
  currency text not null default 'EUR' check (currency = 'EUR'),
  status text not null default 'earned' check (status in ('earned', 'paid', 'void')),
  earned_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists affiliate_referrals_partner_idx
  on public.affiliate_referrals(affiliate_user_id, signed_up_at desc);
create index if not exists affiliate_commissions_partner_idx
  on public.affiliate_commissions(affiliate_user_id, earned_at desc);

alter table public.affiliate_partners enable row level security;
alter table public.affiliate_referrals enable row level security;
alter table public.affiliate_commissions enable row level security;

drop policy if exists affiliate_partner_read_own on public.affiliate_partners;
create policy affiliate_partner_read_own on public.affiliate_partners
  for select to authenticated using (user_id = auth.uid());

drop policy if exists affiliate_referrals_read_own on public.affiliate_referrals;
create policy affiliate_referrals_read_own on public.affiliate_referrals
  for select to authenticated using (affiliate_user_id = auth.uid());

drop policy if exists affiliate_commissions_read_own on public.affiliate_commissions;
create policy affiliate_commissions_read_own on public.affiliate_commissions
  for select to authenticated using (affiliate_user_id = auth.uid());

-- subscription_events is written by verified payment webhooks. Mirroring its
-- lifecycle here keeps affiliate totals server-owned and provider-neutral.
create or replace function public.sync_affiliate_subscription_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  referral_row public.affiliate_referrals%rowtype;
begin
  if new.user_id is null then return new; end if;

  if new.event_type = 'trial_started' then
    update public.affiliate_referrals
       set trial_started_at = coalesce(trial_started_at, new.created_at, now())
     where referred_user_id = new.user_id;
  elsif new.event_type in ('paid', 'converted') then
    update public.affiliate_referrals
       set subscribed_at = coalesce(subscribed_at, new.created_at, now())
     where referred_user_id = new.user_id
     returning * into referral_row;

    if referral_row.id is not null then
      insert into public.affiliate_commissions
        (affiliate_user_id, referral_id, amount_cents, currency, earned_at)
      values
        (referral_row.affiliate_user_id, referral_row.id, 300, 'EUR', coalesce(new.created_at, now()))
      on conflict (referral_id) do nothing;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists affiliate_subscription_event_trigger on public.subscription_events;
create trigger affiliate_subscription_event_trigger
after insert on public.subscription_events
for each row execute function public.sync_affiliate_subscription_event();
