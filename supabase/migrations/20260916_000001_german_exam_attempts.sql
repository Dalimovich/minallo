-- Shared German Exam Engine — cross-module attempt log.
--
-- DESIGN: one table for all five exam modules (listening, reading, writing,
-- speaking, language_elements), NOT a per-module table. Hören is the first
-- consumer but this must not be biased toward objective-answer modules.
--
-- `is_correct` is deliberately NOT a column. For objective modules
-- (listening/reading/language_elements), `first_attempt_correct` and
-- `final_correct` are populated and distinguish unaided-first-try
-- correctness from correct-after-assistance (hints/transcript/retries) —
-- the adaptation engine (app/services/german_exam_adaptation.py) weighs
-- these very differently. For productive modules (writing/speaking), a
-- task may have no binary correct/incorrect concept at all, so
-- `first_attempt_correct`/`final_correct` and the hint/replay/transcript
-- telemetry columns are all nullable — NULL means "not applicable to this
-- module," not "unknown" — and `score_value`/`max_score_value`/`metadata`
-- (rubric dimension scores) carry the evaluation instead.
--
-- `item_id` (not `question_id`) — a writing/speaking task has no "question."
--
-- Insert-only: the frontend batches one part's worth of results and submits
-- them once at part completion, never per-click. No updated_at trigger.

create table if not exists public.german_exam_attempts (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null references auth.users(id) on delete cascade,

  exam_family          text        not null,
  exam_variant         text,
  profile_id           text        not null,
  profile_version      int         not null,
  target_level         text        not null,

  module               text        not null check (module in
                          ('listening', 'reading', 'writing', 'speaking', 'language_elements')),
  part_id              text        not null,
  task_type            text        not null,
  item_id              text        not null,

  skill_tags           text[]      not null default '{}',
  difficulty            text,

  attempt_count         int,
  first_attempt_correct boolean,
  final_correct          boolean,
  hint_level             int,
  replay_count           int,
  transcript_revealed    boolean,

  score_value            numeric,
  max_score_value        numeric,
  metadata                jsonb       not null default '{}',

  attempted_at            timestamptz not null default now(),
  created_at              timestamptz not null default now()
);

-- Adaptation reads recent attempts for one (user, profile, module), most-recent-first.
create index if not exists idx_german_exam_attempts_user_profile_module_attempted
  on public.german_exam_attempts (user_id, profile_id, module, attempted_at desc);

-- Weakness computation filters/aggregates by skill-tag membership.
create index if not exists idx_german_exam_attempts_skill_tags
  on public.german_exam_attempts using gin (skill_tags);

alter table public.german_exam_attempts enable row level security;

drop policy if exists "german_exam_attempts_owner" on public.german_exam_attempts;
create policy "german_exam_attempts_owner" on public.german_exam_attempts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
