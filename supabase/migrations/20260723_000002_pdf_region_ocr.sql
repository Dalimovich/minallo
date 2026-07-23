-- Revision-scoped, tenant-isolated OCR cache and distributed work claim for
-- server-rendered PDF regions. Client-provided text/hashes never enter here.
create table if not exists public.pdf_region_ocr_results (
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  document_id uuid not null references public.documents(id) on delete cascade,
  document_revision text not null,
  index_revision text not null default '',
  page_number integer not null check (page_number > 0),
  region_key text not null,
  crop_sha256 text not null,
  render_dpi integer not null,
  model text not null,
  status text not null default 'processing'
    check (status in ('processing', 'complete', 'weak', 'failed')),
  recognized_text text,
  critical_tokens jsonb not null default '[]'::jsonb,
  confidence double precision,
  disagreement jsonb not null default '{}'::jsonb,
  error_code text,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (
    user_id, document_id, document_revision, index_revision,
    page_number, region_key, render_dpi, model
  )
);

create index if not exists pdf_region_ocr_document_idx
  on public.pdf_region_ocr_results (
    user_id, course_id, document_id, document_revision, page_number
  );

alter table public.pdf_region_ocr_results enable row level security;

drop policy if exists "users read own PDF region OCR" on public.pdf_region_ocr_results;
create policy "users read own PDF region OCR"
  on public.pdf_region_ocr_results for select
  using (auth.uid() = user_id);

grant select on public.pdf_region_ocr_results to authenticated;
grant select, insert, update, delete on public.pdf_region_ocr_results to service_role;

create or replace function public.claim_pdf_region_ocr(
  p_user_id uuid,
  p_course_id text,
  p_document_id uuid,
  p_document_revision text,
  p_index_revision text,
  p_page_number integer,
  p_region_key text,
  p_crop_sha256 text,
  p_render_dpi integer,
  p_model text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  current_status text;
begin
  insert into public.pdf_region_ocr_results (
    user_id, course_id, document_id, document_revision, index_revision,
    page_number, region_key, crop_sha256, render_dpi, model, status
  ) values (
    p_user_id, p_course_id, p_document_id, p_document_revision,
    coalesce(p_index_revision, ''), p_page_number, p_region_key,
    p_crop_sha256, p_render_dpi, p_model, 'processing'
  )
  on conflict do nothing;

  if found then
    return 'claimed';
  end if;

  update public.pdf_region_ocr_results
  set status = 'processing',
      crop_sha256 = p_crop_sha256,
      claimed_at = now(),
      completed_at = null,
      error_code = null,
      updated_at = now()
  where user_id = p_user_id
    and document_id = p_document_id
    and document_revision = p_document_revision
    and index_revision = coalesce(p_index_revision, '')
    and page_number = p_page_number
    and region_key = p_region_key
    and render_dpi = p_render_dpi
    and model = p_model
    and (
      status = 'failed'
      or (status = 'processing' and claimed_at < now() - interval '5 minutes')
    );

  if found then
    return 'claimed';
  end if;

  select status into current_status
  from public.pdf_region_ocr_results
  where user_id = p_user_id
    and document_id = p_document_id
    and document_revision = p_document_revision
    and index_revision = coalesce(p_index_revision, '')
    and page_number = p_page_number
    and region_key = p_region_key
    and render_dpi = p_render_dpi
    and model = p_model;

  return coalesce(current_status, 'failed');
end;
$$;

revoke all on function public.claim_pdf_region_ocr(
  uuid, text, uuid, text, text, integer, text, text, integer, text
) from public;
grant execute on function public.claim_pdf_region_ocr(
  uuid, text, uuid, text, text, integer, text, text, integer, text
) to service_role;
