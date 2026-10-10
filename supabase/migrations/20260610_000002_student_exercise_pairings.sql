-- Durable user decisions on exercise↔lecture pairings.
--
-- The weekly planner proposes uncertain exercise↔lecture matches in
-- weekly_study_plans.possible_matches and the user confirms/dismisses them. That
-- list lives on the plan row, so regenerating the plan repopulated it — dismissed
-- suggestions came back, and the AI never learned from confirmations. This table
-- records the decision durably so:
--   • the suggestions list hides pairs the user already decided, and
--   • the planner can schedule confirmed pairs directly and never re-suggest
--     dismissed ones.

create table if not exists public.student_exercise_pairings (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users(id) on delete cascade,
  course_id        text        not null,
  exercise_file_id uuid        not null references public.documents(id) on delete cascade,
  lecture_file_id  uuid        not null references public.documents(id) on delete cascade,
  status           text        not null default 'confirmed',  -- 'confirmed' | 'dismissed'
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, exercise_file_id, lecture_file_id)
);

create index if not exists idx_student_exercise_pairings_user_course
  on public.student_exercise_pairings (user_id, course_id);

drop trigger if exists set_student_exercise_pairings_updated_at on public.student_exercise_pairings;
create trigger set_student_exercise_pairings_updated_at
  before update on public.student_exercise_pairings
  for each row execute function public.update_updated_at_column();

alter table public.student_exercise_pairings enable row level security;

drop policy if exists "student_exercise_pairings_owner" on public.student_exercise_pairings;
create policy "student_exercise_pairings_owner" on public.student_exercise_pairings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
