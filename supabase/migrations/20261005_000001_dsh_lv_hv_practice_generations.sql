-- DSH LV/HV practice-only server-side grading state.
--
-- Closes the gap audited across 336cc2c2/1a173aad: the DSH LV/HV practice generate/grade
-- endpoints (app/routers/german_exam.py) previously had to return the full generated content
-- (including the answer key: requiredPoints, referenceAnswer, errorfulVariant, gradingNotes) to
-- the browser, because nothing held it server-side between the two calls. This table is that
-- server-side hold: the Python backend (service-role, same trust model as every other
-- german_exam_* table) writes the grading-essential content here at generation time and the
-- browser gets back only a learner-safe `content` plus this row's `id` (as `generationId`) — the
-- answer key never leaves the backend.
--
-- `grading_content` deliberately holds ONLY what the existing grader actually consumes
-- (german_exam_dsh_grading.grade_dsh_open_answer_part -> dsh_content_model.
-- open_answer_item_from_generated/score_content_item): per-item question/maxPoints/
-- requiredPoints/optionalPoints/gradingNotes. It does NOT hold referenceAnswer or
-- errorfulVariant (generation-QUALITY-ONLY fields grading never reads — see
-- german_exam_dsh_grading.minimal_grading_content), and it does NOT hold the lecture/source
-- text or any other learner/UI metadata the grader never touches.
--
-- Practice-only: this table has no relation to any official DSH result. DSH
-- PartBlueprint.available stays false everywhere; nothing here feeds dsh_result.py.
--
-- Atomic one-time consumption: the grade endpoint does
--   UPDATE ... SET graded_at = now()
--   WHERE id = :generation_id AND user_id = :trusted_user_id
--     AND graded_at IS NULL AND expires_at > now()
--   RETURNING grading_content
-- as a single statement (one PostgREST PATCH = one SQL UPDATE), so two concurrent grade
-- attempts for the same generation can never both succeed — the second one simply matches zero
-- rows. Unknown id, wrong user, expired, and already-graded all fail the same way (zero rows
-- matched), so none of those cases can be distinguished from outside.

create table if not exists public.dsh_lv_hv_practice_generations (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users(id) on delete cascade,
  part             text        not null check (part in ('lv', 'hv')),
  grading_content  jsonb       not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '30 minutes',
  graded_at        timestamptz
);

-- The grade endpoint's atomic claim filters on exactly (id, user_id, graded_at, expires_at);
-- this one index covers the ownership+id lookup, and expires_at's own index supports an optional
-- future cleanup sweep (not required for correctness — expiry is enforced in the claim itself).
create index if not exists idx_dsh_lv_hv_practice_generations_user_id
  on public.dsh_lv_hv_practice_generations (user_id, id);
create index if not exists idx_dsh_lv_hv_practice_generations_expires_at
  on public.dsh_lv_hv_practice_generations (expires_at);

alter table public.dsh_lv_hv_practice_generations enable row level security;

drop policy if exists "dsh_lv_hv_practice_generations_owner" on public.dsh_lv_hv_practice_generations;
create policy "dsh_lv_hv_practice_generations_owner" on public.dsh_lv_hv_practice_generations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
