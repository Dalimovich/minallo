-- Persistent storage for study progress per course and study lounge stats.
-- The frontend uses localStorage as the primary read path; these tables are
-- the sync target so data survives clearing browser storage / new devices.

create table if not exists public.course_progress (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  course_id       text not null,
  opened_files    jsonb not null default '[]'::jsonb,
  ai_sessions     integer not null default 0,
  last_opened_at  timestamptz,
  updated_at      timestamptz not null default now(),
  unique (user_id, course_id)
);

create table if not exists public.study_lounge_stats (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  study_minutes    integer not null default 0,
  files_opened     jsonb not null default '[]'::jsonb,
  courses_studied  jsonb not null default '[]'::jsonb,
  ai_messages      integer not null default 0,
  games_played     integer not null default 0,
  streak           integer not null default 0,
  last_date        text not null default '',
  recent_files     jsonb not null default '[]'::jsonb,
  updated_at       timestamptz not null default now()
);

create index if not exists course_progress_user_idx
  on public.course_progress (user_id);

alter table public.course_progress enable row level security;
alter table public.study_lounge_stats enable row level security;

drop policy if exists "course_progress_owner" on public.course_progress;
create policy "course_progress_owner" on public.course_progress
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "study_lounge_stats_owner" on public.study_lounge_stats;
create policy "study_lounge_stats_owner" on public.study_lounge_stats
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
