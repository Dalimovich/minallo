-- Phase 3 Step D — link chunks back to the exercise they belong to.
--
-- Step C made the chunker emit each exercise statement as a single
-- (potentially over-budget) chunk. Step D adds the FK so retrieval can
-- bundle "everything related to Aufgabe X" — statement chunk + formula
-- companion chunks + solution chunk — in one lookup.
--
-- The column is NULLABLE on purpose:
--   * Pre-Step-C chunks (and any chunk not produced from an exercise
--     no-split region) have no exercise — they stay NULL.
--   * Phase-3 Step E (retrieval) will treat NULL as "single-chunk hit"
--     and skip the bundle expansion.
--
-- ON DELETE SET NULL keeps document_chunks rows alive when an exercise
-- is removed during a re-index — the orphan chunks still carry useful
-- vector context.
--
-- Safe to run on production. Idempotent.

alter table public.document_chunks
  add column if not exists exercise_id uuid
    references public.document_exercises(id) on delete set null;

-- Partial index — most chunks are NOT part of an exercise (lecture slides,
-- summaries, definitions), so a partial index over the populated rows
-- gives the same lookup performance for ~10× less storage on a large
-- corpus.
create index if not exists document_chunks_exercise_idx
  on public.document_chunks (exercise_id)
  where exercise_id is not null;
