-- Defensive RLS hardening for the two tables that were created in the
-- Supabase dashboard (not via migrations in this repo): public.profiles and
-- public.subscriptions. Without explicit RLS, every authenticated user could
-- read everyone else's profile + billing fields directly.
--
-- This migration is idempotent: it enables RLS if not already enabled, and
-- creates the policies if they don't already exist. Safe to run even if
-- you already locked these down manually.

begin;

-- ---------------------------------------------------------------------------
-- profiles
-- Assumption: the table has at least an `id uuid` column referencing
-- auth.users(id). The public_profiles view selects from this table by `id`,
-- so own-row access keys off `id = auth.uid()`.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'profiles') then
    execute 'alter table public.profiles enable row level security';

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_owner_select'
    ) then
      execute $p$
        create policy "profiles_owner_select"
        on public.profiles
        for select
        to authenticated
        using (id = auth.uid())
      $p$;
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_owner_insert'
    ) then
      execute $p$
        create policy "profiles_owner_insert"
        on public.profiles
        for insert
        to authenticated
        with check (id = auth.uid())
      $p$;
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_owner_update'
    ) then
      execute $p$
        create policy "profiles_owner_update"
        on public.profiles
        for update
        to authenticated
        using (id = auth.uid())
        with check (id = auth.uid())
      $p$;
    end if;

    -- No DELETE policy on purpose: profile rows are deleted via the auth
    -- cascade when the user record is removed. Anything else should go
    -- through the service-role admin path.
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- subscriptions
-- The existing 20260504_000002_rls_hardening.sql migration assumed this
-- table exists and only added a SELECT policy. We re-assert RLS-enabled and
-- the same SELECT policy here so a fresh project bootstrap is fully covered
-- by migrations.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'subscriptions') then
    execute 'alter table public.subscriptions enable row level security';

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'subscriptions' and policyname = 'subscriptions_owner_select'
    ) then
      execute $p$
        create policy "subscriptions_owner_select"
        on public.subscriptions
        for select
        to authenticated
        using (user_id = auth.uid())
      $p$;
    end if;
    -- No INSERT/UPDATE/DELETE policies: subscription rows are written only
    -- by the Stripe + PayPal webhooks and the verify-payment function, all
    -- of which use the service role key which bypasses RLS.
  end if;
end$$;

commit;
