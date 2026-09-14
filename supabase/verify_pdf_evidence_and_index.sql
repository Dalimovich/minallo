begin;

do $$
declare
  required_columns integer;
  rls_enabled boolean;
  activation_result boolean;
begin
  select count(*) into required_columns
  from information_schema.columns
  where table_schema = 'public'
    and (
      (table_name = 'pdf_region_ocr_results' and column_name in (
        'document_revision', 'index_revision', 'region_key', 'crop_sha256',
        'critical_tokens', 'disagreement', 'status'
      ))
      or (table_name = 'document_pages' and column_name in (
        'page_processing_status', 'ocr_priority_score',
        'ocr_priority_reasons', 'index_revision'
      ))
      or (table_name = 'documents' and column_name in (
        'active_index_revision', 'previous_index_revision',
        'index_revision_status'
      ))
      or (
        table_name in (
          'document_chunks', 'document_exercises', 'document_formulas'
        )
        and column_name = 'index_revision'
      )
    );
  if required_columns <> 17 then
    raise exception 'expected 17 revision/evidence columns, found %',
      required_columns;
  end if;

  select relrowsecurity into rls_enabled
  from pg_class
  where oid = 'public.pdf_region_ocr_results'::regclass;
  if not coalesce(rls_enabled, false) then
    raise exception 'pdf_region_ocr_results RLS is not enabled';
  end if;
  if to_regclass('public.document_page_corrections') is null then
    raise exception 'document_page_corrections is missing';
  end if;
  select relrowsecurity into rls_enabled
  from pg_class
  where oid = 'public.document_page_corrections'::regclass;
  if not coalesce(rls_enabled, false) then
    raise exception 'document_page_corrections RLS is not enabled';
  end if;

  if to_regprocedure(
    'public.claim_pdf_region_ocr(uuid,text,uuid,text,text,integer,text,text,integer,text)'
  ) is null then
    raise exception 'claim_pdf_region_ocr is missing';
  end if;
  if to_regprocedure(
    'public.activate_document_index_revision(uuid,uuid,text,integer,integer)'
  ) is null then
    raise exception 'activate_document_index_revision is missing';
  end if;
  if to_regprocedure(
    'public.rollback_document_index_revision(uuid,uuid)'
  ) is null then
    raise exception 'rollback_document_index_revision is missing';
  end if;

  select public.activate_document_index_revision(
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'verification-only',
    1,
    1
  ) into activation_result;
  if activation_result then
    raise exception 'activation unexpectedly accepted a nonexistent revision';
  end if;
end $$;

select 'pdf_evidence_and_atomic_index_contract_ok' as verification;

rollback;
