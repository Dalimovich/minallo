-- Daily Mission — user-marked "completed files".
--
-- Lets a user mark whole documents as already studied from the Daily Mission
-- widget. Each marked file (a) is recorded here so the checklist can show it
-- pre-checked, and (b) flips its covered topics to progress_state='studied' in
-- student_topic_state (done by the study-done-files backend handler), so the
-- weekly/daily planner stops introducing it as NEW material and surfaces it for
-- spaced repetition instead — reusing the exact rails task-completion already
-- uses. No planner code change is needed.

create table if not exists public.student_document_state (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references auth.users(id) on delete cascade,
  course_id       text        not null,
  document_id     uuid        not null references public.documents(id) on delete cascade,
  status          text        not null default 'done',  -- 'done'
  marked_done_at  timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, document_id)
);

create index if not exists idx_student_document_state_user_course
  on public.student_document_state (user_id, course_id);

drop trigger if exists set_student_document_state_updated_at on public.student_document_state;
create trigger set_student_document_state_updated_at
  before update on public.student_document_state
  for each row execute function public.update_updated_at_column();

alter table public.student_document_state enable row level security;

drop policy if exists "student_document_state_owner" on public.student_document_state;
create policy "student_document_state_owner" on public.student_document_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
