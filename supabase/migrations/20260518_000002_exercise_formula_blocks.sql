-- Phase 5 of the AI/RAG plan: exact-match handles for exercises and formulas.
--
-- When a student asks "do exercise 1.2" or "what's the formula for bending
-- moment", retrieval can short-circuit to the exact block instead of relying
-- on vector similarity (which often loses to chunks that happen to mention
-- the keyword).
--
-- Both tables are additive. The chunk-level retrieval path keeps working
-- whether or not these tables are populated.
--
-- Safe to run on production. Idempotent.

-- ── document_exercises ─────────────────────────────────────────────────────

create table if not exists public.document_exercises (
  id                  uuid primary key default gen_random_uuid(),
  document_id         uuid not null references public.documents(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  course_id           text not null,
  exercise_number     text not null,   -- "1.2", "3", "4.1.2"
  subpart             text,            -- "a", "b" — null when none
  page_start          integer not null,
  page_end            integer not null,
  statement_markdown  text not null,
  solution_markdown   text,            -- null when no Lösung/Solution found
  created_at          timestamptz not null default now()
);

alter table public.document_exercises enable row level security;

drop policy if exists "users see own exercises" on public.document_exercises;
drop policy if exists "users insert own exercises" on public.document_exercises;

create policy "users see own exercises"
  on public.document_exercises for select
  using (auth.uid() = user_id);

create policy "users insert own exercises"
  on public.document_exercises for insert
  with check (auth.uid() = user_id);

create index if not exists document_exercises_doc_idx
  on public.document_exercises (document_id);
create index if not exists document_exercises_lookup_idx
  on public.document_exercises (course_id, exercise_number);


-- ── document_formulas ──────────────────────────────────────────────────────

create table if not exists public.document_formulas (
  id                uuid primary key default gen_random_uuid(),
  document_id       uuid not null references public.documents(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  course_id         text not null,
  formula_name      text,            -- "Bending Moment", null when no heading
  formula_markdown  text not null,   -- always wrapped in $$...$$
  symbols           text[] not null default '{}',
  page_number       integer not null,
  created_at        timestamptz not null default now()
);

alter table public.document_formulas enable row level security;

drop policy if exists "users see own formulas" on public.document_formulas;
drop policy if exists "users insert own formulas" on public.document_formulas;

create policy "users see own formulas"
  on public.document_formulas for select
  using (auth.uid() = user_id);

create policy "users insert own formulas"
  on public.document_formulas for insert
  with check (auth.uid() = user_id);

create index if not exists document_formulas_doc_idx
  on public.document_formulas (document_id);
create index if not exists document_formulas_name_idx
  on public.document_formulas (course_id, formula_name)
  where formula_name is not null;
