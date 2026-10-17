-- Server-side grading state for the generated (AI) Hören practice path — closes the answer-key
-- exposure audited 2026-10-10: generate_task()'s listening branch previously embedded every
-- answer-key field (matching.correctSpeakerId, mc3.correctIndex, note.correctFill,
-- tristate.answer — and matching.evidenceSegmentIds, which is a 1:1 proxy for correctSpeakerId)
-- directly in the content handed to the browser, because nothing held it server-side between
-- generation and grading. This table is that hold, same role as
-- dsh_lv_hv_practice_generations (20261005_000001) plays for DSH's practice path, adapted for
-- Hören's different shape: ONE generation holds MANY questions, each graded independently (and
-- a question may legitimately be re-attempted after a hint, per the existing retry/hint UX) —
-- so there is no DSH-style one-time `graded_at` claim here. Ownership (user_id) and expiry
-- (expires_at) are the only gates; grading is a plain read, never a consuming write.
--
-- grading_content is a JSON object keyed by questionId, holding ONLY what grading needs per
-- question — {taskType, correct, evidenceSegmentIds?} — never the source transcript, speaker
-- roster, or any other learner/UI metadata (see german_exam_listening_grading.py). The browser
-- gets back the same generated content with every one of those fields stripped
-- (strip_listening_answer_key), plus this row's id reused as the existing `generationId` the
-- frontend already threads through attemptsBuffer/results — no new id concept, no frontend
-- wiring change needed for id plumbing.
--
-- expires_at defaults to 2 hours (not DSH's 30 minutes): a Hören part has ~6-9 questions
-- attempted one at a time, with hints/retries, over what can be a genuinely long session —
-- sized to comfortably outlast that, not a single quick round trip.

create table if not exists public.german_exam_listening_practice_generations (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users(id) on delete cascade,
  part_id          text        not null,
  grading_content  jsonb       not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '2 hours'
);

-- The grade-item endpoint's read filters on exactly (id, user_id, expires_at); this one index
-- covers that lookup, and expires_at's own index supports an optional future cleanup sweep (not
-- required for correctness — expiry is enforced in the read itself).
create index if not exists idx_german_exam_listening_practice_generations_user_id
  on public.german_exam_listening_practice_generations (user_id, id);
create index if not exists idx_german_exam_listening_practice_generations_expires_at
  on public.german_exam_listening_practice_generations (expires_at);

alter table public.german_exam_listening_practice_generations enable row level security;

drop policy if exists "german_exam_listening_practice_generations_owner" on public.german_exam_listening_practice_generations;
create policy "german_exam_listening_practice_generations_owner" on public.german_exam_listening_practice_generations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
