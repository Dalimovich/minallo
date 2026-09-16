-- Shared German Exam Engine — generationId traceability + consume idempotency.
--
-- Every POST /german-exam/generate response now carries a generationId
-- (uuid4, see german_exam_generator.py). This ties every resulting attempt
-- row back to the exact generated task that produced it — e.g. "why did
-- this student suddenly become weak at causal_relationship?" traces to one
-- generation_id in german_exam_attempts — and makes topic-history "consume"
-- writes (POST /german-exam/consume, for prefetched content) idempotent
-- instead of accepting an arbitrary number of repeat calls for the same
-- generation.

alter table public.german_exam_attempts
  add column if not exists generation_id text;

alter table public.german_exam_topic_history
  add column if not exists generation_id text;

-- Idempotency for the consume path: a given generationId may record "this
-- topic was consumed" at most once. Partial (generation_id is often null —
-- a non-speculative/direct generation already records its topic usage
-- synchronously inside generate_task(), not via /consume) so multiple
-- NULLs never collide.
create unique index if not exists german_exam_topic_history_generation_id_idx
  on public.german_exam_topic_history (generation_id)
  where generation_id is not null;

create index if not exists german_exam_attempts_generation_id_idx
  on public.german_exam_attempts (generation_id)
  where generation_id is not null;
