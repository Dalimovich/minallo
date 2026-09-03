-- Phase 1 of the AI/RAG plan: Markdown-based indexing.
--
-- Adds two columns to document_pages so the indexer can persist:
--   * the cleaned, structured Markdown rendition of each page
--   * an extraction-quality tag ("good" | "weak" | "failed") computed by
--     the deterministic markdown_indexing helper.
--
-- The chunk-level retrieval path keeps working whether or not these
-- columns are populated — they are additive.
--
-- NOTE: an earlier version of this file was accidentally committed
-- empty (a single 'v'). This is the real schema. Safe to (re-)apply
-- on production. Idempotent.

alter table public.document_pages
  add column if not exists cleaned_markdown    text;

alter table public.document_pages
  add column if not exists extraction_quality  text;

-- Soft enum check — keep the column writable from the python indexer
-- with no migration coupling required when new statuses are added.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'document_pages_extraction_quality_chk'
  ) then
    alter table public.document_pages
      add constraint document_pages_extraction_quality_chk
      check (extraction_quality is null
             or extraction_quality in ('good', 'weak', 'failed'));
  end if;
end$$;

create index if not exists document_pages_quality_idx
  on public.document_pages (document_id, extraction_quality)
  where extraction_quality is not null;
