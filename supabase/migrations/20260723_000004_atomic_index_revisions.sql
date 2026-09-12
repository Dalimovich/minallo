-- Versioned document indexes. New rows are built under a candidate revision;
-- the previous ready revision remains queryable until atomic activation.
alter table public.documents
  add column if not exists active_index_revision text not null default '',
  add column if not exists previous_index_revision text,
  add column if not exists index_revision_status text not null default 'legacy';

alter table public.document_chunks
  add column if not exists index_revision text not null default '';
alter table public.document_exercises
  add column if not exists index_revision text not null default '';
alter table public.document_formulas
  add column if not exists index_revision text not null default '';

create index if not exists document_chunks_active_revision_idx
  on public.document_chunks (document_id, index_revision, chunk_index);
create index if not exists document_exercises_active_revision_idx
  on public.document_exercises (document_id, index_revision, exercise_number);
create index if not exists document_formulas_active_revision_idx
  on public.document_formulas (document_id, index_revision, page_number);

create table if not exists public.document_page_corrections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  document_id uuid not null references public.documents(id) on delete cascade,
  base_index_revision text not null,
  page_number integer not null check (page_number > 0),
  corrected_text text not null,
  status text not null default 'pending'
    check (status in ('pending', 'applied', 'rejected')),
  created_at timestamptz not null default now(),
  applied_index_revision text,
  applied_at timestamptz,
  unique (user_id, document_id, base_index_revision, page_number)
);

alter table public.document_page_corrections enable row level security;
drop policy if exists "users manage own page corrections"
  on public.document_page_corrections;
create policy "users manage own page corrections"
  on public.document_page_corrections for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
grant select, insert, update, delete on public.document_page_corrections
  to authenticated, service_role;

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
begin
  select count(*) into actual_pages
  from public.document_pages
  where document_id = p_document_id and index_revision = p_revision;

  select count(*) into actual_chunks
  from public.document_chunks
  where document_id = p_document_id and index_revision = p_revision;

  if actual_pages <> p_expected_pages
     or actual_chunks <> p_expected_chunks
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

create or replace function public.rollback_document_index_revision(
  p_document_id uuid,
  p_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  old_active text;
  rollback_revision text;
begin
  select active_index_revision, previous_index_revision
    into old_active, rollback_revision
  from public.documents
  where id = p_document_id and user_id = p_user_id
  for update;
  if rollback_revision is null or rollback_revision = '' then
    return false;
  end if;
  update public.documents
  set active_index_revision = rollback_revision,
      previous_index_revision = nullif(old_active, ''),
      index_revision_status = 'ready',
      updated_at = now()
  where id = p_document_id and user_id = p_user_id;
  return found;
end;
$$;

revoke all on function public.rollback_document_index_revision(uuid, uuid)
  from public;
grant execute on function public.rollback_document_index_revision(uuid, uuid)
  to service_role;
