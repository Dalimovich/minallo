-- ExamForge: generated course exams with per-question answers.

create table if not exists public.exam_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  title text not null default 'ExamForge',
  difficulty text not null default 'medium',
  question_count integer not null default 0,
  question_types text[] not null default array['mcq']::text[],
  source_document_ids uuid[] null,
  topic text null,
  status text not null default 'ready',
  score numeric null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.exam_questions (
  id uuid primary key default gen_random_uuid(),
  exam_session_id uuid not null references public.exam_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  position integer not null,
  question_type text not null default 'mcq',
  topic text null,
  difficulty text not null default 'medium',
  points integer not null default 1,
  question_text text not null,
  options jsonb not null default '[]'::jsonb,
  correct_answer text not null,
  explanation text null,
  source_chunk_ids uuid[] null,
  source_document_names text[] null,
  source_pages text[] null,
  validation_status text not null default 'grounded',
  validation_score numeric null,
  created_at timestamptz not null default now()
);

create table if not exists public.exam_answers (
  id uuid primary key default gen_random_uuid(),
  exam_question_id uuid not null references public.exam_questions(id) on delete cascade,
  exam_session_id uuid not null references public.exam_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_answer text not null,
  is_correct boolean not null default false,
  score numeric not null default 0,
  feedback text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_exam_sessions_user_course
  on public.exam_sessions(user_id, course_id, created_at desc);
create index if not exists idx_exam_questions_session
  on public.exam_questions(exam_session_id, position);
create index if not exists idx_exam_answers_session_user
  on public.exam_answers(exam_session_id, user_id);

alter table public.exam_sessions enable row level security;
alter table public.exam_questions enable row level security;
alter table public.exam_answers enable row level security;

drop policy if exists "exam_sessions_owner_select" on public.exam_sessions;
drop policy if exists "exam_sessions_owner_insert" on public.exam_sessions;
drop policy if exists "exam_sessions_owner_update" on public.exam_sessions;
drop policy if exists "exam_sessions_owner_delete" on public.exam_sessions;
create policy "exam_sessions_owner_select" on public.exam_sessions
  for select using (auth.uid() = user_id);
create policy "exam_sessions_owner_insert" on public.exam_sessions
  for insert with check (auth.uid() = user_id);
create policy "exam_sessions_owner_update" on public.exam_sessions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "exam_sessions_owner_delete" on public.exam_sessions
  for delete using (auth.uid() = user_id);

drop policy if exists "exam_questions_owner_select" on public.exam_questions;
drop policy if exists "exam_questions_owner_insert" on public.exam_questions;
drop policy if exists "exam_questions_owner_update" on public.exam_questions;
drop policy if exists "exam_questions_owner_delete" on public.exam_questions;
create policy "exam_questions_owner_select" on public.exam_questions
  for select using (auth.uid() = user_id);
create policy "exam_questions_owner_insert" on public.exam_questions
  for insert with check (auth.uid() = user_id);
create policy "exam_questions_owner_update" on public.exam_questions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "exam_questions_owner_delete" on public.exam_questions
  for delete using (auth.uid() = user_id);

drop policy if exists "exam_answers_owner_select" on public.exam_answers;
drop policy if exists "exam_answers_owner_insert" on public.exam_answers;
drop policy if exists "exam_answers_owner_update" on public.exam_answers;
drop policy if exists "exam_answers_owner_delete" on public.exam_answers;
create policy "exam_answers_owner_select" on public.exam_answers
  for select using (auth.uid() = user_id);
create policy "exam_answers_owner_insert" on public.exam_answers
  for insert with check (auth.uid() = user_id);
create policy "exam_answers_owner_update" on public.exam_answers
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "exam_answers_owner_delete" on public.exam_answers
  for delete using (auth.uid() = user_id);
