-- Phase 2 of the AI/RAG plan: retrieval observability.
--
-- Every /ask, /ask-stream, and /retrieve-context call writes a single
-- debug row so we can see what was searched, what was retrieved, and
-- which chunks made it into the model prompt. We deliberately store
-- chunk *metadata* and short excerpts (~200 chars) rather than full
-- context blobs — privacy-safer and small enough to keep around.
--
-- Read access is restricted to the requesting user; service role writes.
-- Safe to run on production. Idempotent.

create table if not exists public.retrieval_debug_log (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  course_id             text not null,
  endpoint              text not null,                -- 'ask' | 'ask-stream' | 'retrieve-context'
  question              text not null,
  active_document_id    uuid,
  selected_document_ids uuid[] not null default '{}',
  retrieval_strategy    text,                          -- e.g. 'vector+bm25', 'exercise-exact+vector'
  retrieval_mode        text,                          -- 'strong' | 'weak' | 'none'
  candidate_doc_count   integer,
  exercise_hit          jsonb,                         -- {documentId, exerciseNumber, subpart, pages} or null
  chunk_metadata        jsonb not null default '[]'::jsonb,
                                                       -- array of {chunkId, documentId, pageStart, pageEnd, score, similarity, chunkType, excerpt, sectionTitle}
  model                 text,
  cache_hit             boolean not null default false,
  prompt_tokens         integer,
  completion_tokens     integer,
  duration_ms           integer,
  error                 text,
  created_at            timestamptz not null default now()
);

alter table public.retrieval_debug_log enable row level security;

drop policy if exists "users see own debug logs"   on public.retrieval_debug_log;
drop policy if exists "users insert own debug logs" on public.retrieval_debug_log;

create policy "users see own debug logs"
  on public.retrieval_debug_log for select
  using (auth.uid() = user_id);

create policy "users insert own debug logs"
  on public.retrieval_debug_log for insert
  with check (auth.uid() = user_id);

create index if not exists retrieval_debug_log_user_idx
  on public.retrieval_debug_log (user_id, created_at desc);
create index if not exists retrieval_debug_log_course_idx
  on public.retrieval_debug_log (course_id, created_at desc);
