-- Review-2 finding #1: keyword-only matches return all-NULL columns.
--
-- The 20260512_000002 version of match_chunks_hybrid did a FULL OUTER
-- JOIN between the semantic and keyword CTEs and then selected fields
-- from the semantic side only:
--
--     select s.id, s.document_id, s.chunk_text, ...
--     from semantic s
--     full outer join keyword k on k.id = s.id
--
-- A chunk that only matched BM25 (not in the top-200 semantic candidates)
-- has ``s.*`` all-NULL — the SELECT returns ``id=null, chunk_text=null``.
-- Downstream retrieval.py then sees an empty chunk and either drops it
-- silently or treats it as zero-content.
--
-- Fix: pull the actual chunk row from document_chunks for EVERY candidate
-- regardless of which CTE found it. We use the union of (semantic.id,
-- keyword.id) as the candidate set, then JOIN back to document_chunks
-- to materialise all the columns. Semantic similarity is recomputed
-- from the embedding so keyword-only hits also have a similarity score
-- (which the reranker can use).
--
-- Idempotent. Same signature as the previous version.

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
      row_number() over (order by dc.embedding <=> p_embedding) as rank
    from public.document_chunks dc
    where dc.user_id = p_user_id
      and dc.course_id = p_course_id
      and dc.embedding is not null
      and (p_document_id is null or dc.document_id = p_document_id)
      and (p_document_ids is null or dc.document_id = any(p_document_ids))
      and 1 - (dc.embedding <=> p_embedding) >= p_threshold
    order by dc.embedding <=> p_embedding
    limit 200
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
    limit 100
  ),
  -- One row per candidate chunk_id, carrying both ranks. Keyword-only
  -- matches get NULL semantic_rank; semantic-only matches get NULL
  -- keyword_rank. The reranker handles each missing side via coalesce.
  candidates as (
    select
      coalesce(s.id, k.id) as id,
      s.rank as semantic_rank,
      k.rank as keyword_rank
    from semantic s
    full outer join keyword k on k.id = s.id
  )
  -- Join back to document_chunks so every candidate has REAL columns,
  -- including chunk_text. Recompute similarity from the embedding so
  -- keyword-only candidates (which never went through the semantic CTE)
  -- still have a similarity score for downstream reranking.
  select
    dc.id,
    dc.document_id,
    dc.chunk_text,
    dc.page_start,
    dc.page_end,
    dc.source_type,
    dc.section_title,
    coalesce(dc.is_official, false) as is_official,
    1 - (dc.embedding <=> p_embedding) as similarity
  from candidates c
  join public.document_chunks dc on dc.id = c.id
  order by
    coalesce(1.0 / (60 + c.semantic_rank), 0.0) +
    coalesce(1.0 / (60 + c.keyword_rank), 0.0) desc
  limit p_match_count;
end;
$$;

grant execute on function public.match_chunks_hybrid(uuid, text, vector, text, integer, double precision, uuid, uuid[])
  to authenticated, service_role;
