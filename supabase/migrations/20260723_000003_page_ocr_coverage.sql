-- Honest page-level OCR coverage. The automatic paid-vision budget remains
-- capped at MINALLO_VISION_OCR_MAX_PAGES (20 by default).
alter table public.document_pages
  add column if not exists page_processing_status text not null
    default 'embedded_text_reliable',
  add column if not exists ocr_priority_score double precision,
  add column if not exists ocr_priority_reasons jsonb not null default '[]'::jsonb,
  add column if not exists index_revision text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'document_pages_processing_status_chk'
  ) then
    alter table public.document_pages
      add constraint document_pages_processing_status_chk check (
        page_processing_status in (
          'embedded_text_reliable',
          'ocr_complete',
          'skipped_probable_front_matter',
          'pending_on_demand_ocr',
          'weak_or_ambiguous',
          'processing',
          'failed'
        )
      );
  end if;
end $$;

create index if not exists document_pages_ocr_coverage_idx
  on public.document_pages (
    document_id, index_revision, page_processing_status, page_number
  );
