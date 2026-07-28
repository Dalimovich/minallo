-- Revision-aware last-known-good structure and question inventory cache.
create table if not exists public.document_extraction_caches (
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  document_revision text not null,
  source_fingerprint text not null,
  canonical_target text not null,
  extractor_schema_version integer not null,
  scope_fingerprint text not null,
  scope jsonb not null,
  questions jsonb not null default '[]'::jsonb,
  answer_evidence jsonb not null default '[]'::jsonb,
  paired_items jsonb not null default '[]'::jsonb,
  quality jsonb not null,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (
    user_id, document_id, document_revision, source_fingerprint,
    canonical_target, extractor_schema_version
  )
);

create index if not exists document_extraction_cache_lookup_idx
  on public.document_extraction_caches
  (user_id, document_id, canonical_target, verified, updated_at desc);

alter table public.document_extraction_caches enable row level security;

drop policy if exists "users read own document extraction caches"
  on public.document_extraction_caches;
create policy "users read own document extraction caches"
  on public.document_extraction_caches for select
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.document_extraction_caches
  to service_role;
