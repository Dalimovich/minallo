-- Weekly / Daily Study Mission schema — Phase 2
--
-- Adds: weekly_study_plans, weekly_study_tasks, daily_study_plans (view),
--       student_topic_state (replaces old narrower version),
--       student_subject_state, study_preferences (replaces old version),
--       valid_task_candidates (drop-recreate with full schema),
--       study_events (replaces old narrower version).
--
-- The migration is idempotent for tables that did not exist before and uses
-- DROP … IF EXISTS + CREATE OR REPLACE where necessary for objects that did.

-- ────────────────────────────────────────────────────────────────────────────
-- 0. Shared updated_at trigger function (idempotent)
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.update_updated_at_column()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. weekly_study_plans
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.weekly_study_plans (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users(id) on delete cascade,
  week_start_date   date        not null,
  plan_scope        text        not null default 'global_week',
  course_id         text,
  status            text        not null default 'active',
  generated_at      timestamptz not null default now(),
  regenerated_at    timestamptz,
  generation_params jsonb                 default '{}',
  created_at        timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. weekly_study_tasks
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.weekly_study_tasks (
  id                    uuid        primary key default gen_random_uuid(),
  plan_id               uuid        not null references public.weekly_study_plans(id) on delete cascade,
  user_id               uuid        not null references auth.users(id) on delete cascade,
  plan_date             date        not null,
  day_order             int         not null default 0,
  course_id             text        not null,
  subject_name          text,
  topic_id              uuid,
  source_file_id        uuid,
  exercise_file_id      uuid,
  task_type             text        not null,
  task_title            text        not null,
  task_description      text,
  estimated_minutes     int                   default 30,
  priority_score        float                 default 0.5,
  study_state_required  text                  default 'not_started',
  exercise_available    boolean               default false,
  page_range            text,
  status                text        not null default 'todo',
  status_changed_at     timestamptz,
  source_confidence     text                  default 'high',
  is_valid              boolean     not null default true,
  invalidation_reason   text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. daily_study_plans — view over weekly_study_tasks
--    The old TABLE named daily_study_plans (from migration 000001) must be
--    dropped first so we can create the view with the same name.
-- ────────────────────────────────────────────────────────────────────────────

-- Drop dependent objects first (tasks referenced daily_study_plans.id)
drop table if exists public.daily_study_tasks cascade;
drop table if exists public.daily_study_plans cascade;
drop view if exists public.daily_study_plans cascade;

create or replace view public.daily_study_plans as
select
  wst.id,
  wst.plan_id,
  wst.user_id,
  wst.plan_date,
  wst.day_order,
  wst.course_id,
  wst.subject_name,
  wst.topic_id,
  wst.source_file_id,
  wst.exercise_file_id,
  wst.task_type,
  wst.task_title as title,
  wst.task_description as description,
  wst.estimated_minutes,
  wst.priority_score,
  case
    when wst.priority_score >= 0.8 then 'must_do'
    when wst.priority_score >= 0.5 then 'should_do'
    else 'optional'
  end as priority_group,
  wst.study_state_required,
  wst.exercise_available,
  wst.page_range,
  null::integer as page_start,
  null::integer as page_end,
  null::text as reason,
  null::text as reason_code,
  wst.status,
  wst.status_changed_at,
  wst.source_confidence,
  wst.is_valid,
  wst.invalidation_reason,
  wst.created_at,
  wst.updated_at,
  wsp.plan_scope,
  wsp.week_start_date
from public.weekly_study_tasks wst
join public.weekly_study_plans wsp on wsp.id = wst.plan_id
where wst.status not in ('replaced', 'unavailable')
  and wst.is_valid = true;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. student_topic_state — drop old version (different shape) and recreate
-- ────────────────────────────────────────────────────────────────────────────

drop table if exists public.student_topic_state cascade;

create table public.student_topic_state (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,
  course_id           text        not null,
  topic_id            uuid        not null,
  progress_state      text        not null default 'not_started',
  last_studied_at     timestamptz,
  last_practiced_at   timestamptz,
  last_tested_at      timestamptz,
  weak_since          timestamptz,
  study_sessions      int                   default 0,
  practice_sessions   int                   default 0,
  updated_at          timestamptz not null default now(),
  unique (user_id, topic_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. student_subject_state
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.student_subject_state (
  id                     uuid        primary key default gen_random_uuid(),
  user_id                uuid        not null references auth.users(id) on delete cascade,
  course_id              text        not null,
  subject_name           text,
  exam_date              date,
  deadline               date,
  priority               int                   default 5,
  user_excluded          boolean               default false,
  user_priority_override int,
  total_topics           int                   default 0,
  studied_topics         int                   default 0,
  practiced_topics       int                   default 0,
  weak_topics            int                   default 0,
  last_studied_at        timestamptz,
  updated_at             timestamptz not null default now(),
  unique (user_id, course_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. study_preferences — drop old narrow version and recreate
-- ────────────────────────────────────────────────────────────────────────────

drop table if exists public.study_preferences cascade;

create table public.study_preferences (
  user_id               uuid        primary key references auth.users(id) on delete cascade,
  default_plan_scope    text        not null default 'global_week',
  daily_study_minutes   int                   default 120,
  preferred_subjects    jsonb                 default '[]',
  excluded_subjects     jsonb                 default '[]',
  study_days            jsonb                 default '[1,2,3,4,5]',
  updated_at            timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- 7. valid_task_candidates — drop and recreate with full schema
-- ────────────────────────────────────────────────────────────────────────────

drop table if exists public.valid_task_candidates cascade;

create table public.valid_task_candidates (
  id                    uuid        primary key default gen_random_uuid(),
  user_id               uuid        not null references auth.users(id) on delete cascade,
  course_id             text        not null,
  subject_name          text,
  topic_id              uuid        references public.course_topics(id) on delete set null,
  source_file_id        uuid        references public.documents(id) on delete set null,
  exercise_file_id      uuid        references public.documents(id) on delete set null,
  task_type             text        not null,
  task_title            text        not null,
  task_description      text,
  estimated_minutes     int                   default 30,
  difficulty            text                  default 'medium',
  study_state_required  text                  default 'not_started',
  exercise_available    boolean               default false,
  page_range            text,
  priority_score        float                 default 0.5,
  is_valid              boolean     not null default true,
  source_confidence     text        not null default 'high',
  invalidation_reason   text,
  candidate_reason      text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- 8. study_events — drop old narrow version and recreate
-- ────────────────────────────────────────────────────────────────────────────

drop table if exists public.study_events cascade;

create table public.study_events (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  course_id   text,
  topic_id    uuid,
  task_id     uuid,
  event_type  text        not null,
  event_data  jsonb                 default '{}',
  created_at  timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- 9. Indexes
-- ────────────────────────────────────────────────────────────────────────────

-- Unique plan per (user, week, scope, course) — coalesce handles NULL course_id
create unique index if not exists idx_weekly_study_plans_unique
  on public.weekly_study_plans (user_id, week_start_date, plan_scope, coalesce(course_id, ''));

create index if not exists idx_weekly_study_tasks_user_date
  on public.weekly_study_tasks (user_id, plan_date);

create index if not exists idx_weekly_study_tasks_plan
  on public.weekly_study_tasks (plan_id);

create index if not exists idx_student_topic_state_user_course
  on public.student_topic_state (user_id, course_id);

create index if not exists idx_valid_task_candidates_user_course
  on public.valid_task_candidates (user_id, course_id);

create index if not exists idx_valid_task_candidates_valid
  on public.valid_task_candidates (user_id, is_valid)
  where is_valid = true;

create index if not exists idx_study_events_user
  on public.study_events (user_id, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 10. updated_at triggers
-- ────────────────────────────────────────────────────────────────────────────

drop trigger if exists set_weekly_study_plans_updated_at on public.weekly_study_plans;
create trigger set_weekly_study_plans_updated_at
  before update on public.weekly_study_plans
  for each row execute function public.update_updated_at_column();

drop trigger if exists set_weekly_study_tasks_updated_at on public.weekly_study_tasks;
create trigger set_weekly_study_tasks_updated_at
  before update on public.weekly_study_tasks
  for each row execute function public.update_updated_at_column();

drop trigger if exists set_student_topic_state_updated_at on public.student_topic_state;
create trigger set_student_topic_state_updated_at
  before update on public.student_topic_state
  for each row execute function public.update_updated_at_column();

drop trigger if exists set_student_subject_state_updated_at on public.student_subject_state;
create trigger set_student_subject_state_updated_at
  before update on public.student_subject_state
  for each row execute function public.update_updated_at_column();

drop trigger if exists set_study_preferences_updated_at on public.study_preferences;
create trigger set_study_preferences_updated_at
  before update on public.study_preferences
  for each row execute function public.update_updated_at_column();

drop trigger if exists set_valid_task_candidates_updated_at on public.valid_task_candidates;
create trigger set_valid_task_candidates_updated_at
  before update on public.valid_task_candidates
  for each row execute function public.update_updated_at_column();

-- ────────────────────────────────────────────────────────────────────────────
-- 11. Row-Level Security
-- ────────────────────────────────────────────────────────────────────────────

alter table public.weekly_study_plans     enable row level security;
alter table public.weekly_study_tasks     enable row level security;
alter table public.student_topic_state    enable row level security;
alter table public.student_subject_state  enable row level security;
alter table public.study_preferences      enable row level security;
alter table public.valid_task_candidates  enable row level security;
alter table public.study_events           enable row level security;

-- weekly_study_plans
drop policy if exists "weekly_study_plans_owner" on public.weekly_study_plans;
create policy "weekly_study_plans_owner" on public.weekly_study_plans
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- weekly_study_tasks
drop policy if exists "weekly_study_tasks_owner" on public.weekly_study_tasks;
create policy "weekly_study_tasks_owner" on public.weekly_study_tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- student_topic_state
drop policy if exists "student_topic_state_owner" on public.student_topic_state;
create policy "student_topic_state_owner" on public.student_topic_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- student_subject_state
drop policy if exists "student_subject_state_owner" on public.student_subject_state;
create policy "student_subject_state_owner" on public.student_subject_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- study_preferences (PK is user_id)
drop policy if exists "study_preferences_owner" on public.study_preferences;
create policy "study_preferences_owner" on public.study_preferences
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- valid_task_candidates
drop policy if exists "valid_task_candidates_owner" on public.valid_task_candidates;
create policy "valid_task_candidates_owner" on public.valid_task_candidates
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- study_events
drop policy if exists "study_events_owner" on public.study_events;
create policy "study_events_owner" on public.study_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
