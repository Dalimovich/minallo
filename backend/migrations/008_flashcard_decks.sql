-- Multi-deck flashcards & quiz runs.
-- Replaces the single in-memory _coCards / _coQuizItems with persistent decks.

create table if not exists flashcard_decks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  document_id uuid references documents(id) on delete set null,
  name text not null,
  cards jsonb not null default '[]'::jsonb,    -- [{front, back, source, page?}]
  card_count int generated always as (jsonb_array_length(cards)) stored,
  last_studied_at timestamptz,
  study_progress int not null default 0,        -- last viewed card index
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists flashcard_decks_user_course_idx
  on flashcard_decks (user_id, course_id);
create index if not exists flashcard_decks_user_last_studied_idx
  on flashcard_decks (user_id, last_studied_at desc nulls last);

alter table flashcard_decks enable row level security;

drop policy if exists "decks owner read" on flashcard_decks;
create policy "decks owner read" on flashcard_decks
  for select using (auth.uid() = user_id);
drop policy if exists "decks owner write" on flashcard_decks;
create policy "decks owner write" on flashcard_decks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Quiz runs: each generated quiz set is its own row, with the user's answers
-- (so you can resume / show "last score" per quiz).
create table if not exists quiz_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  document_id uuid references documents(id) on delete set null,
  name text not null,
  items jsonb not null default '[]'::jsonb,     -- [{question, options{A..D}, answer, explanation}]
  answers jsonb not null default '{}'::jsonb,   -- { "<questionIdx>": "<letter>" }
  score numeric,                                -- 0..1 once completed
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists quiz_runs_user_course_idx
  on quiz_runs (user_id, course_id);

alter table quiz_runs enable row level security;

drop policy if exists "quiz_runs owner read" on quiz_runs;
create policy "quiz_runs owner read" on quiz_runs
  for select using (auth.uid() = user_id);
drop policy if exists "quiz_runs owner write" on quiz_runs;
create policy "quiz_runs owner write" on quiz_runs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
