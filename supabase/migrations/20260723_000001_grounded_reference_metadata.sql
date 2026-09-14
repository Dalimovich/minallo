-- Structured metadata for exact-reference retrieval and stale-chunk rejection.

alter table public.documents
  add column if not exists document_revision text,
  add column if not exists exam_variant text;

alter table public.document_chunks
  add column if not exists document_revision text,
  add column if not exists document_type text,
  add column if not exists question_number text,
  add column if not exists parent_question_number text,
  add column if not exists source_priority integer not null default 50;

create index if not exists document_chunks_exact_question_idx
  on public.document_chunks
  (user_id, course_id, document_id, question_number, page_start, page_end);

create index if not exists document_chunks_revision_idx
  on public.document_chunks (document_id, document_revision);

update public.documents
set document_revision = coalesce(document_revision, document_hash)
where document_revision is null;

update public.document_chunks dc
set
  document_revision = coalesce(dc.document_revision, d.document_revision, d.document_hash),
  document_type = coalesce(dc.document_type, d.document_type),
  source_priority = case coalesce(d.document_type, d.source_type)
    when 'official_solution' then 90
    when 'solution_sheet' then 85
    when 'solution' then 85
    when 'exam' then 80
    when 'exercise_sheet' then 75
    when 'exercise' then 75
    when 'lecture' then 65
    when 'formula_sheet' then 60
    else 50
  end
from public.documents d
where dc.document_id = d.id;

-- Service-role retrieval already filters user/course. RLS remains the final
-- tenant boundary for direct authenticated access.
