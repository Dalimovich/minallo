-- Fixes a real production incident (2026-10-11, BWL_gesamt_WiSe_2026_27_V03.pdf,
-- 304 pages): activate_document_index_revision rejects the WHOLE document the
-- moment ANY document_page_manifests row has status='failed'. A big
-- diagram-heavy deck can flag far more OCR candidates than the per-document
-- cap (MINALLO_VISION_OCR_MAX_PAGES, default 20) allows attempting; every page
-- left un-OCR'd past the cap was previously written as 'failed' even though
-- most of them (49 of 49 in the BWL case) still had perfectly usable pdfminer
-- text. That one gate discarded a fully chunked and embedded 304-page index.
--
-- app/services/indexing.py now promotes any such page to 'weak_or_ambiguous'
-- (already an "indexed" status) whenever it has real pdfminer text, so the
-- vast majority of cases never reach this migration's new status at all. The
-- remaining case — a page genuinely has NO usable text and wasn't (fully)
-- OCR'd — gets this migration's new 'deferred' manifest status instead of
-- 'failed': it does not block activation, but it is NOT silently claimed as
-- fully covered either. app/services/index_manifest.py's coverage_result()
-- reports deferred pages explicitly (deferredPages) so an exhaustive feature
-- ("list every exercise") can say "pages 37, 112 not readable yet" instead of
-- quietly treating them as covered.
--
-- No RPC change needed: activate_document_index_revision
-- (20260830_000001_canonical_page_manifests.sql) already counts failures as
-- `count(*) filter (where status = 'failed')` — a literal, exact match — so a
-- 'deferred' row was already harmless to that function. It also still counts
-- toward manifest_pages/manifest_distinct_pages, so the "every physical page
-- has exactly one manifest row" guarantee is untouched. Only the check
-- constraint needs widening to allow the new value.

do $$
declare
  status_attnum smallint;
  existing_constraint text;
begin
  select attnum into status_attnum
  from pg_attribute
  where attrelid = 'public.document_page_manifests'::regclass
    and attname = 'status';

  -- Find and drop whatever single-column CHECK constraint currently governs
  -- the status column, by structure (which column(s) it references) rather
  -- than by matching pg_get_constraintdef's rendered text — Postgres
  -- normalizes `status in (...)` into `status = ANY (ARRAY[...])` internally,
  -- so a text match for "in" is NOT reliable. array_length(conkey, 1) = 1
  -- deliberately excludes the OTHER check constraint on this table (the
  -- filtered/required_for_processing/exclusion_reason one), which also
  -- references status but spans three columns.
  for existing_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.document_page_manifests'::regclass
      and contype = 'c'
      and status_attnum = any(conkey)
      and array_length(conkey, 1) = 1
  loop
    execute format(
      'alter table public.document_page_manifests drop constraint %I',
      existing_constraint
    );
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_page_manifests'::regclass
      and conname = 'document_page_manifests_status_check'
  ) then
    alter table public.document_page_manifests
      add constraint document_page_manifests_status_check
      check (status in ('indexed', 'semantic_empty', 'filtered', 'failed', 'deferred'));
  end if;
end $$;
