-- Durable, revision-scoped course visual regions produced during PDF indexing.
create table if not exists public.course_visuals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  document_id uuid not null references public.documents(id) on delete cascade,
  document_revision text not null,
  page_number integer not null check (page_number > 0),
  visual_type text not null default 'unknown' check (visual_type in (
    'diagram', 'photo', 'graph', 'table', 'flowchart', 'formula_region',
    'worked_example', 'screenshot', 'unknown'
  )),
  bounding_box jsonb not null,
  caption text,
  nearby_text text,
  section_title text,
  detected_labels jsonb not null default '[]'::jsonb,
  detected_topics jsonb not null default '[]'::jsonb,
  ocr_text text,
  visual_description text,
  quality_score double precision not null default 0 check (quality_score between 0 and 1),
  relevance_embedding vector(1536),
  storage_path text,
  thumbnail_path text,
  perceptual_hash text,
  region_hash text not null,
  extraction_schema_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, document_revision, page_number, region_hash)
);

create index if not exists course_visuals_scope_idx
  on public.course_visuals (user_id, course_id, document_id, document_revision, page_number);
create index if not exists course_visuals_topics_gin
  on public.course_visuals using gin (detected_topics);
create index if not exists course_visuals_embedding_hnsw
  on public.course_visuals using hnsw (relevance_embedding vector_cosine_ops);

alter table public.course_visuals enable row level security;
drop policy if exists "users read own course visuals" on public.course_visuals;
create policy "users read own course visuals"
  on public.course_visuals for select using (auth.uid() = user_id);
grant select on public.course_visuals to authenticated;
grant select, insert, update, delete on public.course_visuals to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('course-visuals', 'course-visuals', false, 5242880, array['image/webp', 'image/png'])
on conflict (id) do update set public = false;

drop policy if exists "users read own course visual objects" on storage.objects;
create policy "users read own course visual objects"
  on storage.objects for select to authenticated
  using (bucket_id = 'course-visuals' and (storage.foldername(name))[1] = auth.uid()::text);

create or replace function public.match_course_visuals(
  p_user_id uuid,
  p_course_id text,
  p_document_revision text,
  p_query_embedding extensions.vector(1536),
  p_limit integer default 12
) returns table (
  id uuid, document_id uuid, document_revision text, page_number integer,
  visual_type text, bounding_box jsonb, caption text, nearby_text text,
  section_title text, detected_labels jsonb, detected_topics jsonb,
  ocr_text text, visual_description text, quality_score double precision,
  thumbnail_path text, perceptual_hash text, similarity double precision
) language sql stable security definer set search_path = public, extensions as $$
  select cv.id, cv.document_id, cv.document_revision, cv.page_number,
    cv.visual_type, cv.bounding_box, cv.caption, cv.nearby_text,
    cv.section_title, cv.detected_labels, cv.detected_topics, cv.ocr_text,
    cv.visual_description, cv.quality_score, cv.thumbnail_path,
    cv.perceptual_hash,
    1 - (cv.relevance_embedding OPERATOR(extensions.<=>) p_query_embedding) as similarity
  from public.course_visuals cv
  join public.documents d on d.id = cv.document_id
  where cv.user_id = p_user_id and cv.course_id = p_course_id
    and cv.document_revision = d.document_hash
    and (p_document_revision = '' or cv.document_revision = p_document_revision)
  order by cv.relevance_embedding OPERATOR(extensions.<=>) p_query_embedding
  limit greatest(1, least(coalesce(p_limit, 12), 30));
$$;
revoke all on function public.match_course_visuals(uuid, text, text, extensions.vector, integer) from public;
grant execute on function public.match_course_visuals(uuid, text, text, extensions.vector, integer) to service_role;

alter table public.notes
  add column if not exists topic_fingerprint text,
  add column if not exists document_revision_hash text,
  add column if not exists lesson_mode text,
  add column if not exists lesson_language text,
  add column if not exists lesson_status text not null default 'complete',
  add column if not exists recommendation_id text,
  add column if not exists launch_idempotency_key text,
  add column if not exists visual_ids jsonb not null default '[]'::jsonb,
  add column if not exists source_chunk_ids jsonb not null default '[]'::jsonb;
create unique index if not exists notes_deep_learn_launch_key_uidx
  on public.notes (user_id, launch_idempotency_key)
  where type = 'deep_learn' and launch_idempotency_key is not null;
create index if not exists notes_deep_learn_reuse_idx
  on public.notes (user_id, course_id, topic_fingerprint, document_revision_hash, updated_at desc)
  where type = 'deep_learn';

create table if not exists public.deep_learn_generation_claims (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null,
  course_id text not null,
  topic_fingerprint text not null,
  document_revision_hash text not null,
  status text not null default 'processing' check (status in ('processing', 'complete', 'failed')),
  note_id uuid references public.notes(id) on delete set null,
  claimed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, idempotency_key)
);
alter table public.deep_learn_generation_claims enable row level security;
create policy "users read own deep learn claims" on public.deep_learn_generation_claims
  for select using (auth.uid() = user_id);
grant select on public.deep_learn_generation_claims to authenticated;
grant select, insert, update, delete on public.deep_learn_generation_claims to service_role;
