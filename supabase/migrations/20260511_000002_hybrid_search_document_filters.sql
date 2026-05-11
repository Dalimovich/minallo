-- Align production hybrid chunk search with the backend RAG callers.
-- Adds the optional single-document and multi-document filters used by
-- quiz/flashcard/summary generation, plus the metadata columns that the RPC returns.

alter table public.document_chunks
  add column if not exists fts tsvector
    generated always as (to_tsvector('simple', coalesce(chunk_text, ''))) stored;

create index if not exists idx_document_chunks_fts
  on public.document_chunks using gin (fts);

alter table public.document_chunks
  add column if not exists section_title text;

alter table public.document_chunks
  add column if not exists is_official boolean default false;

drop function if exists public.match_chunks_hybrid(uuid, text, vector, text, integer, double precision);
drop function if exists public.match_chunks_hybrid(uuid, text, vector, text, integer, double precision, uuid);
drop function if exists public.match_chunks_hybrid(uuid, text, vector, text, integer, double precision, uuid, uuid[]);

create or replace function public.match_chunks_hybrid(
  p_user_id        uuid,
  p_course_id      text,
  p_embedding      vector(1536),
  p_query          text,
  p_match_count    integer default 10,
  p_threshold      double precision default 0.1,
  p_document_id    uuid default null,
  p_document_ids   uuid[] default null
)
returns table (
  id            uuid,
  document_id   uuid,
  chunk_text    text,
  page_start    integer,
  page_end      integer,
  source_type   text,
  section_title text,
  is_official   boolean,
  similarity    double precision
)
language plpgsql stable as $$
begin
  return query
  with
  semantic as (
    select
      dc.id,
      dc.document_id,
      dc.chunk_text,
      dc.page_start,
      dc.page_end,
      dc.source_type,
      dc.section_title,
      coalesce(dc.is_official, false) as is_official,
      1 - (dc.embedding <=> p_embedding) as similarity,
      row_number() over (order by dc.embedding <=> p_embedding) as rank
    from public.document_chunks dc
    where dc.user_id = p_user_id
      and dc.course_id = p_course_id
      and dc.embedding is not null
      and (p_document_id is null or dc.document_id = p_document_id)
      and (p_document_ids is null or dc.document_id = any(p_document_ids))
      and 1 - (dc.embedding <=> p_embedding) >= p_threshold
    order by dc.embedding <=> p_embedding
    limit 20
  ),
  keyword as (
    select
      dc.id,
      row_number() over (
        order by ts_rank_cd(dc.fts, websearch_to_tsquery('simple', p_query)) desc
      ) as rank
    from public.document_chunks dc
    where dc.user_id = p_user_id
      and dc.course_id = p_course_id
      and (p_document_id is null or dc.document_id = p_document_id)
      and (p_document_ids is null or dc.document_id = any(p_document_ids))
      and p_query <> ''
      and dc.fts @@ websearch_to_tsquery('simple', p_query)
    limit 20
  )
  select
    s.id,
    s.document_id,
    s.chunk_text,
    s.page_start,
    s.page_end,
    s.source_type,
    s.section_title,
    s.is_official,
    s.similarity
  from semantic s
  full outer join keyword k on k.id = s.id
  order by
    coalesce(1.0 / (60 + s.rank), 0.0) +
    coalesce(1.0 / (60 + k.rank), 0.0) desc
  limit p_match_count;
end;
$$;

grant execute on function public.match_chunks_hybrid(uuid, text, vector, text, integer, double precision, uuid, uuid[])
  to authenticated, service_role;
