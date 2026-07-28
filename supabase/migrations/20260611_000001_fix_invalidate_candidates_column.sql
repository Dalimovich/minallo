-- Fix: account/document deletion fails with
--   ERROR: column "invalid_reason" of relation "valid_task_candidates" does not exist (42703)
--   ERROR: relation "public.daily_study_tasks" does not exist (42P01)
--
-- 20260608_000003_weekly_mission_schema.sql recreated valid_task_candidates
-- (renaming invalid_reason → invalidation_reason) and DROPPED
-- daily_study_tasks (replaced by weekly_study_tasks) — but the BEFORE DELETE
-- trigger function on public.documents from
-- 20260608_000001_daily_study_mission.sql still wrote the old column and the
-- dropped table. Any delete touching documents rows (deleting a file, or
-- deleting an account — GoTrue's user delete cascades into documents) aborted.
-- Rewritten against the weekly schema: new column name, and the task
-- invalidation now targets weekly_study_tasks ('unavailable' is the status the
-- TS planner itself uses for vanished source files).

create or replace function public.invalidate_daily_mission_candidates_for_document()
returns trigger language plpgsql as $$
begin
  update public.valid_task_candidates
    set is_valid = false,
        invalidation_reason = case
          when old.processing_status = 'failed' then 'processing_failed'
          else 'deleted_file'
        end,
        updated_at = now()
    where source_file_id = old.id;

  update public.weekly_study_tasks
    set status = 'unavailable',
        is_valid = false,
        invalidation_reason = 'deleted_file',
        updated_at = now()
    where source_file_id = old.id
      and status in ('todo','in_progress','skipped','moved');

  return old;
end;
$$;
