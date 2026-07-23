-- Review fix #10 — retrieval_debug_log retention.
--
-- The base table (20260518_000003) already has:
--   * RLS so users only see their own rows
--   * `on delete cascade` to auth.users → log rows vanish when the
--     account is deleted (GDPR right-to-be-forgotten covered)
--
-- Missing: ROUTINE retention. Question text is kept verbatim in the
-- ``question`` column; for GDPR proportionality we should not keep it
-- longer than needed for product debugging. 30 days is the same default
-- most analytics products use.
--
-- This migration adds a SECURITY DEFINER function the operator schedules
-- via pg_cron (Supabase Dashboard → Database → Extensions → pg_cron) OR
-- a Supabase Edge Function on a daily cron. The default retention is
-- 30 days; the caller can override per-invocation.
--
-- Idempotent. Safe to run on production.

create or replace function public.cleanup_retrieval_debug_log(
  retention_days integer default 30
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  if retention_days is null or retention_days < 1 then
    raise exception 'retention_days must be >= 1';
  end if;
  delete from public.retrieval_debug_log
  where created_at < (now() - make_interval(days => retention_days));
  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function public.cleanup_retrieval_debug_log(integer) is
  'Deletes retrieval_debug_log rows older than retention_days (default 30). '
  'Schedule via pg_cron: '
  '    select cron.schedule(''minallo-debug-log-cleanup'', ''0 3 * * *'', '
  '      $$select public.cleanup_retrieval_debug_log(30)$$); '
  'Returns the number of rows deleted.';

-- Restrict EXECUTE to the service role only — this is an admin/ops
-- function, not something a logged-in user should be able to call.
revoke all on function public.cleanup_retrieval_debug_log(integer) from public;
revoke all on function public.cleanup_retrieval_debug_log(integer) from anon;
revoke all on function public.cleanup_retrieval_debug_log(integer) from authenticated;
grant execute on function public.cleanup_retrieval_debug_log(integer) to service_role;
