-- Phase 11/12 of the AI/RAG plan: OCR-need assessment.
--
-- Stores the per-document OCR diagnostic computed at indexing time
-- (Phase 11 — measure_ocr_need). The frontend can read this to show
-- "X of Y pages are likely scanned — re-index with vision OCR?" and the
-- indexer reads it later to decide whether to invoke the Phase 12
-- vision fallback on a re-index.
--
-- Safe to (re-)apply on production. Idempotent.

alter table public.documents
  add column if not exists ocr_assessment jsonb;

-- Partial index so we can cheaply query "documents that need OCR" for an
-- admin / re-index sweep.
create index if not exists documents_ocr_recommended_idx
  on public.documents ((ocr_assessment->>'ocrRecommended'))
  where ocr_assessment is not null;
