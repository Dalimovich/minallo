-- Idempotent: add possible_matches column to weekly_study_plans if missing.
alter table public.weekly_study_plans
  add column if not exists possible_matches jsonb default '[]';
