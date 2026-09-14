-- Durable two-phase manifests and resumable item processing for coverage retrieval.
create table if not exists public.complete_document_jobs (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null, document_ids uuid[] not null, document_revision_ids text[] not null,
  request_text text not null, canonical_target text not null, retrieval_mode text not null check (retrieval_mode in ('relevance','coverage')),
  coverage_intent text not null default 'all' check (coverage_intent in ('single','all')),
  include_answers boolean not null default false, include_explanations boolean not null default false,
  source_fingerprint text not null, scope_fingerprint text,
  manifest_id uuid, status text not null default 'discovering', discovery_status text not null default 'pending',
  discovered_count int not null default 0, pending_count int not null default 0, processing_count int not null default 0,
  answered_count int not null default 0, unresolved_count int not null default 0, failed_count int not null default 0,
  processing_started_at timestamptz, last_checkpoint_at timestamptz, completed_at timestamptz,
  failure_code text, failure_message text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.complete_document_jobs alter column course_id type text using course_id::text;
alter table public.complete_document_jobs add column if not exists coverage_intent text not null default 'all';
alter table public.complete_document_jobs add column if not exists include_answers boolean not null default false;
alter table public.complete_document_jobs add column if not exists include_explanations boolean not null default false;
alter table public.complete_document_jobs add column if not exists source_fingerprint text not null default '';
alter table public.complete_document_jobs add column if not exists scope_fingerprint text;
create table if not exists public.request_scope_manifests (
  id uuid primary key default gen_random_uuid(), job_id uuid not null references public.complete_document_jobs(id) on delete cascade,
  document_id uuid not null, document_revision_id text not null, canonical_target text not null,
  discovery_status text not null, manifest_sealed boolean not null default false, verified boolean not null default false,
  included_section_numbers text[] not null default '{}', excluded_section_numbers text[] not null default '{}', question_pages int[] not null default '{}',
  source_fingerprint text not null, scope_fingerprint text not null, extractor_schema_version text not null,
  out_of_scope_items_rejected text[] not null default '{}', quality jsonb not null default '{}', version int not null default 1,
  structure jsonb not null default '{}',
  active boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.request_scope_manifests add column if not exists structure jsonb not null default '{}';
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'complete_document_jobs_manifest_fk'
      and conrelid = 'public.complete_document_jobs'::regclass
  ) then
    alter table public.complete_document_jobs add constraint complete_document_jobs_manifest_fk
      foreign key (manifest_id) references public.request_scope_manifests(id);
  end if;
end $$;
create unique index if not exists one_active_scope_manifest on public.request_scope_manifests(document_id, document_revision_id, canonical_target) where active;
create table if not exists public.request_scope_items (
  id uuid primary key default gen_random_uuid(), manifest_id uuid not null references public.request_scope_manifests(id) on delete cascade,
  stable_key text not null, previous_stable_keys text[] not null default '{}', item_number text, label text not null, block_type text not null,
  section_number text, section_title text, page_start int, page_end int, document_order int not null, parent_id uuid,
  source_block_ids text[] not null default '{}', status text not null default 'discovered', attempts int not null default 0,
  error_code text, error_message text, result jsonb, answer_checkpoint jsonb not null default '{}', updated_at timestamptz not null default now(),
  unique(manifest_id, stable_key)
);
create table if not exists public.scope_job_events (
  event_id uuid primary key default gen_random_uuid(), job_id uuid not null references public.complete_document_jobs(id) on delete cascade,
  event_key text not null, event_type text not null, payload jsonb not null default '{}', created_at timestamptz not null default now(),
  unique(job_id, event_key)
);
alter table public.scope_job_events add column if not exists event_key text;
update public.scope_job_events set event_key = event_id::text where event_key is null;
alter table public.scope_job_events alter column event_key set not null;
create unique index if not exists scope_job_events_key_idx
  on public.scope_job_events(job_id, event_key);
create table if not exists public.document_logical_units (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  document_id uuid not null references public.documents(id) on delete cascade,
  document_revision_id text not null,
  stable_block_id text not null,
  previous_stable_keys text[] not null default '{}',
  block_type text not null check (block_type in (
    'section_heading','exam_question','exam_subquestion','exam_solution',
    'answer_option_set','definition','formula','worked_example','diagram','table','instruction'
  )),
  question_number text, parent_question text, section_number text, section_title text,
  page_start int not null, page_end int not null, document_order int not null,
  continues_on_next_page boolean not null default false, answer_format text,
  has_diagram boolean not null default false, diagram_region_ids text[] not null default '{}',
  solution_block_ids text[] not null default '{}', ocr_confidence real,
  extraction_confidence real, source_text text not null default '', metadata jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(document_id, document_revision_id, stable_block_id)
);
alter table public.documents add column if not exists structural_index_status text
  not null default 'structural_reindex_required'
  check (structural_index_status in (
    'structured_ready','structural_indexing','structural_reindex_required','structural_index_failed'
  ));
create index if not exists document_logical_units_scope_idx on public.document_logical_units
  (document_id, document_revision_id, block_type, section_number, document_order);
alter table public.complete_document_jobs enable row level security;
alter table public.request_scope_manifests enable row level security;
alter table public.request_scope_items enable row level security;
alter table public.scope_job_events enable row level security;
alter table public.document_logical_units enable row level security;
drop policy if exists scoped_jobs_owner on public.complete_document_jobs;
drop policy if exists scoped_manifests_owner on public.request_scope_manifests;
drop policy if exists scoped_items_owner on public.request_scope_items;
drop policy if exists scoped_events_owner on public.scope_job_events;
drop policy if exists logical_units_owner on public.document_logical_units;
create policy scoped_jobs_owner on public.complete_document_jobs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy scoped_manifests_owner on public.request_scope_manifests for all using (exists (select 1 from public.complete_document_jobs j where j.id=job_id and j.user_id=auth.uid()));
create policy scoped_items_owner on public.request_scope_items for all using (exists (select 1 from public.request_scope_manifests m join public.complete_document_jobs j on j.id=m.job_id where m.id=manifest_id and j.user_id=auth.uid()));
create policy scoped_events_owner on public.scope_job_events for all using (exists (select 1 from public.complete_document_jobs j where j.id=job_id and j.user_id=auth.uid()));
create policy logical_units_owner on public.document_logical_units for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists complete_document_jobs_resume_idx on public.complete_document_jobs
  (user_id, course_id, canonical_target, source_fingerprint, updated_at desc);

create or replace function public.activate_scope_manifest(p_candidate_id uuid)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  candidate public.request_scope_manifests%rowtype;
begin
  select * into candidate from public.request_scope_manifests
    where id = p_candidate_id for update;
  if candidate.id is null or not candidate.verified or not candidate.manifest_sealed
     or candidate.discovery_status <> 'complete'
     or cardinality(candidate.question_pages) = 0 then
    raise exception 'candidate manifest is not promotable';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    candidate.document_id::text || ':' || candidate.document_revision_id || ':' || candidate.canonical_target, 0
  ));
  update public.request_scope_manifests set active = false, updated_at = now()
    where document_id = candidate.document_id
      and document_revision_id = candidate.document_revision_id
      and canonical_target = candidate.canonical_target and active;
  update public.request_scope_manifests set active = true, updated_at = now()
    where id = candidate.id;
  update public.complete_document_jobs set manifest_id = candidate.id, updated_at = now()
    where id = candidate.job_id;
  return candidate.id;
end;
$$;
