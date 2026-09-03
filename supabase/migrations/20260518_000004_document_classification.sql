-- Phase 4 of the AI/RAG plan: document classification + extraction-quality
-- rollup.
--
-- Adds two columns to `documents`:
--   * document_type      — coarse class so retrieval and the answer prompt
--                          can prefer exercise sheets when the question is
--                          an exercise reference, formula sheets when the
--                          question is a formula lookup, etc.
--   * extraction_quality — doc-level rollup of per-page quality; lets us
--                          flag scanned / image-heavy PDFs that need OCR
--                          (Phase 11) before they degrade retrieval.
--
-- Safe to (re-)apply on production. Idempotent.

alter table public.documents
  add column if not exists document_type      text;

alter table public.documents
  add column if not exists extraction_quality text;

-- Soft enums — same rationale as the document_pages constraint added in
-- 20260518_000001: keeps the indexer decoupled from migrations.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'documents_document_type_chk'
  ) then
    alter table public.documents
      add constraint documents_document_type_chk
      check (document_type is null
             or document_type in (
               'exercise_sheet', 'solution_sheet', 'lecture',
               'formula_sheet', 'summary', 'exam', 'unknown'
             ));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'documents_extraction_quality_chk'
  ) then
    alter table public.documents
      add constraint documents_extraction_quality_chk
      check (extraction_quality is null
             or extraction_quality in ('good', 'weak', 'failed'));
  end if;
end$$;

create index if not exists documents_type_idx
  on public.documents (course_id, document_type)
  where document_type is not null;
