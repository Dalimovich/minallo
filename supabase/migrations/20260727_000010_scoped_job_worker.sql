-- Durable execution queue for exhaustive RAG. Workers atomically lease jobs;
-- expired leases are reclaimable after process or machine restarts.
alter table public.complete_document_jobs
  add column if not exists request_payload jsonb not null default '{}'::jsonb,
  add column if not exists worker_id text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists worker_attempts integer not null default 0;

create index if not exists complete_document_jobs_worker_queue_idx
  on public.complete_document_jobs(status, lease_expires_at, created_at);

create or replace function public.claim_next_scoped_job(
  p_worker_id text,
  p_lease_seconds integer default 300
) returns setof public.complete_document_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  select id into claimed_id
  from public.complete_document_jobs
  where request_payload <> '{}'::jsonb
    and (
      status = 'queued'
      or (
        status in ('structural_indexing','discovering','processing','recovering')
        and (lease_expires_at is null or lease_expires_at < now())
      )
    )
  order by created_at
  for update skip locked
  limit 1;

  if claimed_id is null then return; end if;

  return query
  update public.complete_document_jobs set
    status = case when status = 'queued' then 'structural_indexing' else 'recovering' end,
    current_stage = case when status = 'queued' then 'structural_indexing' else current_stage end,
    worker_id = p_worker_id,
    lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 30)),
    worker_attempts = worker_attempts + 1,
    updated_at = now()
  where id = claimed_id
  returning *;
end;
$$;

revoke all on function public.claim_next_scoped_job(text,integer) from public;
grant execute on function public.claim_next_scoped_job(text,integer) to service_role;
