-- Canonical physical-page inventory for each versioned document index.
create table if not exists public.document_page_manifests (
  document_id uuid not null references public.documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  index_revision text not null,
  page_number integer not null check (page_number > 0),
  source_page_id text not null,
  required_for_processing boolean not null default true,
  status text not null check (status in ('indexed', 'semantic_empty', 'filtered', 'failed')),
  exclusion_reason text,
  created_at timestamptz not null default now(),
  primary key (document_id, index_revision, page_number),
  unique (document_id, index_revision, source_page_id),
  check (
    (status = 'filtered' and required_for_processing = false and exclusion_reason is not null)
    or status <> 'filtered'
  )
);

create index if not exists document_page_manifests_owner_revision_idx
  on public.document_page_manifests (user_id, course_id, document_id, index_revision);

alter table public.document_page_manifests enable row level security;
drop policy if exists "users read own document page manifests"
  on public.document_page_manifests;
create policy "users read own document page manifests"
  on public.document_page_manifests for select
  using (auth.uid() = user_id);
grant select on public.document_page_manifests to authenticated;
grant select, insert, update, delete on public.document_page_manifests to service_role;

-- Backfill active revisions. Pages still awaiting OCR are deliberately marked
-- failed so exhaustive access waits for a verified reindex instead of claiming
-- completeness from partial text.
insert into public.document_page_manifests (
  document_id, user_id, course_id, index_revision, page_number,
  source_page_id, required_for_processing, status, exclusion_reason
)
select
  p.document_id, p.user_id, p.course_id, p.index_revision, p.page_number,
  p.index_revision || ':' || p.page_number::text,
  true,
  case
    when p.page_processing_status in ('embedded_text_reliable', 'ocr_complete') then 'indexed'
    else 'failed'
  end,
  null
from public.document_pages p
join public.documents d on d.id = p.document_id
where p.index_revision = d.active_index_revision
on conflict (document_id, index_revision, page_number) do nothing;

-- Activation now validates the canonical manifest and matching chunk revision.
create or replace function public.activate_document_index_revision(
  p_document_id uuid,
  p_user_id uuid,
  p_revision text,
  p_expected_pages integer,
  p_expected_chunks integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actual_pages integer;
  actual_chunks integer;
  manifest_pages integer;
  manifest_distinct_pages integer;
  manifest_failures integer;
begin
  select count(*) into actual_pages
  from public.document_pages
  where document_id = p_document_id and index_revision = p_revision;

  select count(*) into actual_chunks
  from public.document_chunks
  where document_id = p_document_id and index_revision = p_revision;

  select count(*), count(distinct page_number),
         count(*) filter (where status = 'failed')
    into manifest_pages, manifest_distinct_pages, manifest_failures
  from public.document_page_manifests
  where document_id = p_document_id and index_revision = p_revision;

  if actual_pages <> p_expected_pages
     or actual_chunks <> p_expected_chunks
     or manifest_pages <> p_expected_pages
     or manifest_distinct_pages <> p_expected_pages
     or manifest_failures <> 0
     or actual_pages < 1
     or actual_chunks < 1 then
    return false;
  end if;

  update public.documents
  set previous_index_revision = nullif(active_index_revision, ''),
      active_index_revision = p_revision,
      index_revision_status = 'ready',
      updated_at = now()
  where id = p_document_id and user_id = p_user_id;
  return found;
end;
$$;

revoke all on function public.activate_document_index_revision(
  uuid, uuid, text, integer, integer
) from public;
grant execute on function public.activate_document_index_revision(
  uuid, uuid, text, integer, integer
) to service_role;
