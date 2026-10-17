-- Caps automatic indexing-crash recovery (see app/services/indexing.py
-- claim_orphaned_indexing). A document repeatedly killed mid-index by a
-- backend restart was retried forever by the orphan sweeper; this counter
-- lets it give up after a few tries and surface processing_status='failed'
-- (with a Retry button) instead of spinning on "Indexing..." forever.
-- Reset to 0 on a successful index and on any user-triggered reindex trigger
-- (POST /index-document) so a manual Retry always gets a fresh budget.

alter table public.documents add column if not exists index_attempts integer not null default 0;
