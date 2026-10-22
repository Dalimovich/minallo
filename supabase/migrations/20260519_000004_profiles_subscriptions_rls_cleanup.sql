-- Removes overly-permissive policies that pre-existed on public.profiles and
-- public.subscriptions (dashboard inspection 2026-05-19). Three concrete
-- threats being closed:
--
-- 1. profiles."Users can read all profiles" (SELECT, public) — almost
--    certainly USING (true). Any caller could read every user's profile.
-- 2. subscriptions."Users can manage their own data" (ALL, public) and
--    subscriptions."own" (ALL, public) — these let an authenticated user
--    UPDATE their own subscription row (set expires_at = '2099-01-01',
--    status = 'active') and grant themselves permanent Pro for free.
-- 3. Duplicate SELECT policies on both tables. RLS uses OR semantics for
--    permissive policies, so one over-broad rule defeats the strict ones.
--
-- After this migration:
--   profiles  — only the *_owner_* policies from 20260519_000003 remain.
--   subscriptions — only subscriptions_owner_select remains. Writes are
--                   exclusively via service-role (Stripe + PayPal webhooks,
--                   verify-payment function).

begin;

-- ── profiles ────────────────────────────────────────────────────────────────
drop policy if exists "Users can read all profiles"        on public.profiles;
drop policy if exists "Users can read their own profile"   on public.profiles;
drop policy if exists "Users can update their own profile" on public.profiles;
drop policy if exists "Users can insert their own profile" on public.profiles;
drop policy if exists "Users can delete their own profile" on public.profiles;
drop policy if exists "Users can manage their own data"    on public.profiles;
drop policy if exists "own"                                on public.profiles;
-- Keep profiles_owner_select / profiles_owner_insert / profiles_owner_update
-- created by 20260519_000003. No DELETE policy — profile rows cascade-delete
-- with auth.users.

-- ── subscriptions ──────────────────────────────────────────────────────────
-- Drop EVERY user-facing write policy. The legitimate flow is:
--   Stripe webhook  → service role → UPSERT
--   PayPal webhook  → service role → UPSERT
--   verify-payment  → service role → UPSERT
-- so authenticated users only need SELECT on their own row.
drop policy if exists "Users can manage their own data"     on public.subscriptions;
drop policy if exists "Users can read their own subscription" on public.subscriptions;
drop policy if exists "users read own subscription"         on public.subscriptions;
drop policy if exists "own"                                  on public.subscriptions;
-- Keep subscriptions_owner_select from 20260519_000003.

commit;

-- ── Manual verification (run after applying) ───────────────────────────────
-- Run these in the SQL editor and confirm the row counts match:
--
-- select policyname, cmd, roles
-- from pg_policies
-- where schemaname = 'public' and tablename in ('profiles', 'subscriptions')
-- order by tablename, policyname;
--
-- Expected output:
--   profiles      | profiles_owner_insert      | INSERT | {authenticated}
--   profiles      | profiles_owner_select      | SELECT | {authenticated}
--   profiles      | profiles_owner_update      | UPDATE | {authenticated}
--   subscriptions | subscriptions_owner_select | SELECT | {authenticated}
