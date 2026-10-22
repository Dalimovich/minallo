-- Global Document Understanding Layer — Stage 1 (schema).
--
-- Builds on the coarse `documents.document_type` added in
-- 20260518_000004_document_classification.sql. Expands the type vocabulary and
-- persists a richer, per-document understanding payload that every AI feature
-- reads before prompting/retrieval.
--
-- Design:
--   * document_type / document_type_confidence stay as first-class columns
--     (queried by retrieval reranking and the documents list).
--   * user_document_type_override is a SEPARATE column so a user correction is
--     never overwritten by re-classification and always wins downstream.
--   * Everything else (signals, language, subject/topic, content flags) lives in
--     a single `document_understanding` jsonb so we don't churn the schema as the
--     payload grows.
--
-- Idempotent and safe to (re-)apply. NO backfill here — existing rows keep their
-- current document_type; a separate background path recomputes understanding
-- from stored cleaned_text without re-embedding.

alter table public.documents
  add column if not exists document_type_confidence    real;

alter table public.documents
  add column if not exists user_document_type_override  text;

alter table public.documents
  add column if not exists document_understanding       jsonb;

-- Expand the allowed type set (old set was a strict subset, so existing rows
-- still satisfy the new constraint). Drop + recreate to widen it.
do $$
begin
  -- document_type: widen the soft enum.
  if exists (
    select 1 from pg_constraint where conname = 'documents_document_type_chk'
  ) then
    alter table public.documents drop constraint documents_document_type_chk;
  end if;

  alter table public.documents
    add constraint documents_document_type_chk
    check (document_type is null
           or document_type in (
             'exam', 'lecture', 'exercise_sheet', 'solution_sheet',
             'summary', 'slides', 'textbook_chapter', 'assignment',
             'cheat_sheet', 'formula_sheet', 'unknown'
           ));

  -- user override accepts the same vocabulary.
  if not exists (
    select 1 from pg_constraint where conname = 'documents_user_doc_type_override_chk'
  ) then
    alter table public.documents
      add constraint documents_user_doc_type_override_chk
      check (user_document_type_override is null
             or user_document_type_override in (
               'exam', 'lecture', 'exercise_sheet', 'solution_sheet',
               'summary', 'slides', 'textbook_chapter', 'assignment',
               'cheat_sheet', 'formula_sheet', 'unknown'
             ));
  end if;

  -- confidence stays within [0, 1] when present.
  if not exists (
    select 1 from pg_constraint where conname = 'documents_doc_type_confidence_chk'
  ) then
    alter table public.documents
      add constraint documents_doc_type_confidence_chk
      check (document_type_confidence is null
             or (document_type_confidence >= 0 and document_type_confidence <= 1));
  end if;
end$$;
