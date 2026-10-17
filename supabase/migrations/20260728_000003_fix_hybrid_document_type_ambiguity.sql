-- `document_chunks.document_type` was added after the routed hybrid function.
-- Selecting dc.* and aliasing a second column as document_type made references
-- to eligible.document_type ambiguous at execution time (Postgres 42702).
drop function if exists public.match_chunks_hybrid(
  uuid, text, extensions.vector, text, integer, double precision,
  uuid, uuid[], text[], text[], text[], text[]
);

create or replace function public.match_chunks_hybrid(
  p_user_id uuid,
  p_course_id text,
  p_embedding extensions.vector(1536),
  p_query text,
  p_match_count integer default 10,
  p_threshold double precision default 0.1,
  p_document_id uuid default null,
  p_document_ids uuid[] default null,
  p_document_types text[] default null,
  p_primary_topics text[] default null,
  p_topics text[] default null,
  p_chunk_types text[] default null
) returns table (
  id uuid, document_id uuid, chunk_text text, page_start integer, page_end integer,
  source_type text, section_title text, is_official boolean,
  similarity double precision, chunk_type text, primary_topic text, topics text[],
  document_type text, document_type_confidence double precision,
  authority text
) language plpgsql stable security invoker set search_path = public, extensions as $$
begin
  return query
  with eligible as (
    select dc.*,
      coalesce(d.user_document_type_override, d.document_type) as effective_document_type,
      d.document_type_confidence::double precision as effective_document_type_confidence,
      coalesce(d.authority, 'unknown') as document_authority
    from public.document_chunks dc
    join public.documents d on d.id = dc.document_id
    where dc.user_id = p_user_id and dc.course_id = p_course_id
      and d.user_id = p_user_id and d.course_id = p_course_id
      and (d.active_index_revision is null or d.active_index_revision = ''
           or dc.index_revision = d.active_index_revision)
      and (p_document_id is null or dc.document_id = p_document_id)
      and (p_document_ids is null or dc.document_id = any(p_document_ids))
      and (p_document_types is null
           or coalesce(d.user_document_type_override, d.document_type) = any(p_document_types))
      and (p_primary_topics is null or dc.primary_topic = any(p_primary_topics))
      and (p_topics is null or dc.topics && p_topics)
      and (p_chunk_types is null or dc.chunk_type = any(p_chunk_types))
  ),
  semantic as (
    select e.id,
      row_number() over (order by e.embedding OPERATOR(extensions.<=>) p_embedding) as rank
    from eligible e
    where e.embedding is not null
      and 1 - (e.embedding OPERATOR(extensions.<=>) p_embedding) >= p_threshold
    order by e.embedding OPERATOR(extensions.<=>) p_embedding
    limit 200
  ),
  keyword as (
    select e.id,
      row_number() over (
        order by ts_rank_cd(e.fts, websearch_to_tsquery('simple', p_query)) desc
      ) as rank
    from eligible e
    where p_query <> '' and e.fts @@ websearch_to_tsquery('simple', p_query)
    limit 100
  ),
  candidates as (
    select coalesce(s.id, k.id) id, s.rank semantic_rank, k.rank keyword_rank
    from semantic s full outer join keyword k on k.id = s.id
  )
  select e.id, e.document_id, e.chunk_text, e.page_start, e.page_end,
    e.source_type, e.section_title, coalesce(e.is_official, false),
    1 - (e.embedding OPERATOR(extensions.<=>) p_embedding), e.chunk_type,
    e.primary_topic, e.topics, e.effective_document_type,
    e.effective_document_type_confidence, e.document_authority
  from candidates c join eligible e on e.id = c.id
  order by coalesce(1.0 / (60 + c.semantic_rank), 0.0)
         + coalesce(1.0 / (60 + c.keyword_rank), 0.0) desc
  limit greatest(1, least(coalesce(p_match_count, 10), 200));
end;
$$;

revoke all on function public.match_chunks_hybrid(
  uuid, text, extensions.vector, text, integer, double precision,
  uuid, uuid[], text[], text[], text[], text[]
) from public;
grant execute on function public.match_chunks_hybrid(
  uuid, text, extensions.vector, text, integer, double precision,
  uuid, uuid[], text[], text[], text[], text[]
) to authenticated, service_role;
