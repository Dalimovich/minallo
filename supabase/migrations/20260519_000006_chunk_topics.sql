-- Phase 1 of the tutor-mode plan: per-chunk topic tagging.
--
-- The indexer extracts a short topic list per document (3-8 free-form labels
-- like "Kräftegleichgewicht", "Momentengleichgewicht") and assigns one primary
-- topic to each chunk. Phase 2 builds user_topic_mastery on top of these
-- labels so the tutor can say "you struggle with Reibung — practice this".
--
-- Additive columns; existing chunks stay NULL until reindexed. Retrieval
-- queries do not read these columns yet.

alter table public.document_chunks
  add column if not exists topics         text[],
  add column if not exists primary_topic  text;

-- Index for the upcoming "weak topic → chunks in this course" lookup.
-- Partial so only tagged rows pay the index-maintenance cost.
create index if not exists document_chunks_primary_topic_idx
  on public.document_chunks (course_id, primary_topic)
  where primary_topic is not null;
