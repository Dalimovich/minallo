-- Persist per-page text-block bounding boxes from the pdfminer text layer.
--
-- Each element of the JSON array is { "t": <block text>, "bbox": [left, top,
-- right, bottom] } with coordinates NORMALISED to 0..1 and a TOP-LEFT origin,
-- so a frontend can draw a highlight overlay on a rendered page image without
-- the PDF's point size. Only populated for text-layer pages — scanned / OCR'd
-- pages have no reliable text-layer coordinates and leave this NULL.
--
-- Additive + nullable: nothing reads it yet. It captures the block coordinates
-- pdfminer already hands us (and that the extractor used to throw away),
-- enabling future grounded citations / answer highlighting for text PDFs
-- without a vision model.

alter table public.document_pages
  add column if not exists text_blocks jsonb;

-- OCR provenance and review signals.
--
-- Vision OCR providers do not expose reliable token-level confidence, so the
-- indexer stores a conservative page-level confidence estimate plus an explicit
-- review flag. Handwritten pages are always reviewable; pages with [unclear]
-- markers or low confidence are flagged too. A later correction UI can query
-- these columns and let students fix the page text before RAG relies on it.

alter table public.document_pages
  add column if not exists ocr_provider text,
  add column if not exists ocr_mode text,
  add column if not exists ocr_confidence numeric,
  add column if not exists ocr_needs_review boolean not null default false,
  add column if not exists ocr_unclear_count integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'document_pages_ocr_mode_chk'
  ) then
    alter table public.document_pages
      add constraint document_pages_ocr_mode_chk
      check (ocr_mode is null or ocr_mode in ('standard', 'handwriting'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'document_pages_ocr_confidence_chk'
  ) then
    alter table public.document_pages
      add constraint document_pages_ocr_confidence_chk
      check (ocr_confidence is null or (ocr_confidence >= 0 and ocr_confidence <= 1));
  end if;
end $$;

create index if not exists document_pages_ocr_review_idx
  on public.document_pages (document_id, page_number)
  where ocr_needs_review = true;
