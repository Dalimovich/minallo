-- Add AI-planner fields to weekly_study_tasks and a canonical-key unique index.
-- Idempotent: all columns use ADD COLUMN IF NOT EXISTS.

-- ── 1. New columns ────────────────────────────────────────────────────────────

alter table public.weekly_study_tasks
  add column if not exists solution_file_id           uuid,
  add column if not exists related_lecture_file_id    uuid,
  add column if not exists lecture_topics             jsonb default '[]',
  add column if not exists related_lecture_topics     jsonb default '[]',
  add column if not exists reason                     text,
  add column if not exists repetition_stage           int,
  add column if not exists repetition_origin_task_id  uuid,
  add column if not exists canonical_task_key         text;

-- ── 2. Partial unique index on canonical_task_key ─────────────────────────────

create unique index if not exists idx_weekly_study_tasks_canonical
  on public.weekly_study_tasks (plan_id, canonical_task_key)
  where canonical_task_key is not null;
