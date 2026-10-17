-- Daily Study Mission planner foundation.
--
-- The scheduler reads valid_task_candidates only. These rows are derived from
-- confirmed course/topic/source links and can be invalidated independently
-- when files, access, or source confidence changes.

create table if not exists public.study_preferences (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  daily_minutes          integer not null default 45,
  preferred_load         text not null default 'normal',
  default_task_count     integer not null default 3,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (user_id)
);

create table if not exists public.course_study_settings (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  course_id              text not null,
  enabled                boolean not null default true,
  exam_date              date,
  course_priority        text not null default 'normal',
  daily_minutes_override integer,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (user_id, course_id)
);

create table if not exists public.student_topic_state (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  course_id               text not null,
  topic_id                uuid not null references public.course_topics(id) on delete cascade,
  state                   text not null default 'not_started',
  last_seen_at            timestamptz,
  last_practiced_at       timestamptz,
  last_quiz_at            timestamptz,
  last_task_completed_at  timestamptz,
  quiz_accuracy           numeric,
  tasks_completed_count   integer not null default 0,
  tasks_skipped_count     integer not null default 0,
  updated_at              timestamptz not null default now(),
  unique (user_id, course_id, topic_id)
);

create table if not exists public.valid_task_candidates (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  course_id             text not null,
  topic_id              uuid not null references public.course_topics(id) on delete cascade,
  task_type             text not null,
  source_file_id        uuid not null references public.documents(id) on delete cascade,
  page_start            integer,
  page_end              integer,
  estimated_minutes     integer not null default 20,
  candidate_reason      text,
  source_confidence     text not null default 'medium',
  is_valid              boolean not null default true,
  invalid_reason        text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, course_id, topic_id, task_type, source_file_id, page_start, page_end)
);

create table if not exists public.daily_study_plans (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  plan_date                date not null,
  user_timezone            text not null default 'UTC',
  plan_scope               text not null default 'course',
  course_id                text,
  status                   text not null default 'active',
  generation_status        text not null default 'idle',
  generation_attempts      integer not null default 0,
  last_generation_error    text,
  total_estimated_minutes  integer not null default 0,
  generated_reason         text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (user_id, plan_date, plan_scope, course_id)
);

create table if not exists public.daily_study_tasks (
  id                       uuid primary key default gen_random_uuid(),
  daily_plan_id            uuid not null references public.daily_study_plans(id) on delete cascade,
  user_id                  uuid not null references auth.users(id) on delete cascade,
  course_id                text not null,
  topic_id                 uuid references public.course_topics(id) on delete set null,
  valid_task_candidate_id  uuid references public.valid_task_candidates(id) on delete set null,
  task_type                text not null,
  priority_group           text not null,
  title                    text not null,
  description              text,
  reason                   text,
  reason_code              text,
  reason_metadata          jsonb not null default '{}'::jsonb,
  source_file_id           uuid references public.documents(id) on delete set null,
  page_start               integer,
  page_end                 integer,
  estimated_minutes        integer not null default 20,
  status                   text not null default 'todo',
  moved_to_date            date,
  order_index              integer not null default 0,
  started_at               timestamptz,
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create table if not exists public.study_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  course_id    text,
  topic_id     uuid references public.course_topics(id) on delete set null,
  task_id      uuid references public.daily_study_tasks(id) on delete set null,
  event_type   text not null,
  value        text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'study_preferences_load_chk') then
    alter table public.study_preferences
      add constraint study_preferences_load_chk check (preferred_load in ('light','normal','intensive'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'course_study_settings_priority_chk') then
    alter table public.course_study_settings
      add constraint course_study_settings_priority_chk check (course_priority in ('low','normal','high'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'student_topic_state_state_chk') then
    alter table public.student_topic_state
      add constraint student_topic_state_state_chk check (state in ('not_started','started','reviewed','practiced','weak','good','exam_ready'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'valid_task_candidates_type_chk') then
    alter table public.valid_task_candidates
      add constraint valid_task_candidates_type_chk check (task_type in ('review','learn','practice','quiz','flashcards','deeplearn','examforge'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'valid_task_candidates_confidence_chk') then
    alter table public.valid_task_candidates
      add constraint valid_task_candidates_confidence_chk check (source_confidence in ('low','medium','high','confirmed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'valid_task_candidates_invalid_reason_chk') then
    alter table public.valid_task_candidates
      add constraint valid_task_candidates_invalid_reason_chk check (
        invalid_reason is null or invalid_reason in (
          'deleted_file','invisible_file','unconfirmed_source','missing_topic',
          'access_removed','processing_failed','invalid_page_range'
        )
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'daily_study_plans_scope_chk') then
    alter table public.daily_study_plans
      add constraint daily_study_plans_scope_chk check (plan_scope in ('course','global'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'daily_study_plans_status_chk') then
    alter table public.daily_study_plans
      add constraint daily_study_plans_status_chk check (status in ('active','completed','adjusted'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'daily_study_plans_generation_status_chk') then
    alter table public.daily_study_plans
      add constraint daily_study_plans_generation_status_chk check (generation_status in ('idle','generating','failed','completed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'daily_study_tasks_group_chk') then
    alter table public.daily_study_tasks
      add constraint daily_study_tasks_group_chk check (priority_group in ('must_do','should_do','optional'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'daily_study_tasks_status_chk') then
    alter table public.daily_study_tasks
      add constraint daily_study_tasks_status_chk check (status in ('todo','in_progress','completed','skipped','moved','unavailable','replaced'));
  end if;
end $$;

create index if not exists valid_task_candidates_user_course_idx
  on public.valid_task_candidates (user_id, course_id, is_valid, source_confidence);
create index if not exists daily_study_plans_user_date_idx
  on public.daily_study_plans (user_id, plan_date, course_id);
create index if not exists daily_study_tasks_plan_idx
  on public.daily_study_tasks (daily_plan_id, order_index);
create index if not exists daily_study_tasks_user_status_idx
  on public.daily_study_tasks (user_id, status);
create index if not exists study_events_user_created_idx
  on public.study_events (user_id, created_at desc);

alter table public.study_preferences enable row level security;
alter table public.course_study_settings enable row level security;
alter table public.student_topic_state enable row level security;
alter table public.valid_task_candidates enable row level security;
alter table public.daily_study_plans enable row level security;
alter table public.daily_study_tasks enable row level security;
alter table public.study_events enable row level security;

drop policy if exists "study_preferences_owner_all" on public.study_preferences;
create policy "study_preferences_owner_all" on public.study_preferences
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "course_study_settings_owner_all" on public.course_study_settings;
create policy "course_study_settings_owner_all" on public.course_study_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "student_topic_state_owner_all" on public.student_topic_state;
create policy "student_topic_state_owner_all" on public.student_topic_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "valid_task_candidates_owner_select" on public.valid_task_candidates;
create policy "valid_task_candidates_owner_select" on public.valid_task_candidates
  for select using (auth.uid() = user_id);

drop policy if exists "daily_study_plans_owner_all" on public.daily_study_plans;
create policy "daily_study_plans_owner_all" on public.daily_study_plans
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "daily_study_tasks_owner_all" on public.daily_study_tasks;
create policy "daily_study_tasks_owner_all" on public.daily_study_tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "study_events_owner_select_insert" on public.study_events;
create policy "study_events_owner_select_insert" on public.study_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.invalidate_daily_mission_candidates_for_document()
returns trigger language plpgsql as $$
begin
  update public.valid_task_candidates
    set is_valid = false,
        invalid_reason = case
          when old.processing_status = 'failed' then 'processing_failed'
          else 'deleted_file'
        end,
        updated_at = now()
    where source_file_id = old.id;

  update public.daily_study_tasks
    set status = 'unavailable',
        updated_at = now()
    where source_file_id = old.id
      and status in ('todo','in_progress','skipped','moved');

  return old;
end;
$$;

drop trigger if exists daily_mission_document_delete on public.documents;
create trigger daily_mission_document_delete
  before delete on public.documents
  for each row execute procedure public.invalidate_daily_mission_candidates_for_document();
