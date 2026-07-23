-- Drop the over-broad ai_evaluations policy left over from migration 006.
--
-- Migration 006_ai_evaluations.sql created:
--   "Authenticated users can manage evaluations" FOR ALL TO authenticated USING (true)
-- which lets any logged-in user read/write/delete every row in ai_evaluations
-- regardless of ownership.
--
-- The later migration 20260505_000003_evaluations.sql added the correctly-
-- scoped policy ("users see own evaluations" USING (auth.uid() = user_id)),
-- but PostgreSQL RLS uses OR semantics across permissive policies, so the
-- over-broad rule still wins as long as it exists.
--
-- This migration removes the bad policy. The owner-scoped policy from the
-- newer migration remains in place.

begin;

drop policy if exists "Authenticated users can manage evaluations"
  on public.ai_evaluations;

commit;

-- Verification (run after applying):
-- select policyname, cmd, roles, qual
-- from pg_policies
-- where schemaname = 'public' and tablename = 'ai_evaluations';
--
-- Expected:
--   ai_evaluations | users see own evaluations | ALL | {public} | (auth.uid() = user_id)
