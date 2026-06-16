-- Run in Supabase SQL editor to check how close the project is to the
-- free-tier 500 MB database / 1 GB storage caps.

-- 1) Total database size
select pg_size_pretty(pg_database_size(current_database())) as total_db_size;

-- 2) Largest tables (includes indexes, so pgvector ivfflat/hnsw indexes on
--    document_chunks show up here too — they're often bigger than the data).
select
  relname as table_name,
  pg_size_pretty(pg_total_relation_size(relid)) as total_size,
  pg_size_pretty(pg_relation_size(relid)) as table_size,
  pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) as index_size
from pg_catalog.pg_statio_user_tables
order by pg_total_relation_size(relid) desc
limit 15;

-- 3) Row counts + size for the document/embedding tables specifically
select 'documents' as table_name, count(*) as row_count from documents
union all
select 'document_chunks', count(*) from document_chunks
union all
select 'document_pages', count(*) from document_pages
union all
select 'document_exercises', count(*) from document_exercises
union all
select 'document_formulas', count(*) from document_formulas;

-- 4) Storage bucket usage (Supabase Storage objects)
select
  bucket_id,
  count(*) as object_count,
  pg_size_pretty(sum((metadata->>'size')::bigint)) as total_size
from storage.objects
group by bucket_id
order by sum((metadata->>'size')::bigint) desc;
