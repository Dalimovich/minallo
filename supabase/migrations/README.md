# Minallo Supabase Migrations

This folder mirrors the security SQL that has been applied manually in Supabase.

## Order

Run these migrations in order:

1. `20260504_000001_admin_security.sql`
2. `20260504_000002_rls_hardening.sql`
3. `20260504_000003_chat_room_rls_patch.sql`
4. `20260504_000004_storage_security.sql`
5. `20260504_000005_security_indexes.sql`
6. `20260505_000001_rag_foundation.sql`
7. `20260505_000002_rag_caching.sql`
8. `20260505_000003_evaluations.sql`
9. `20260506_000001_processing_error.sql`
10. `20260511_000001_ai_cache_schema_alignment.sql`
11. `20260511_000002_hybrid_search_document_filters.sql`
12. `20260512_000001_python_indexer_additions.sql`
13. `20260512_000002_hybrid_search_candidate_limit.sql`
14. `20260512_000003_backfill_legacy_chunk_count.sql`
15. `20260513_000001_storage_bucket_alignment.sql`
16. `20260518_000001_markdown_indexing.sql` — Phase 1 (Markdown-based indexing)
17. `20260518_000002_exercise_formula_blocks.sql` — Phase 5 (exact-match exercise/formula handles)
18. `20260518_000003_retrieval_debug.sql` — Phase 2 (retrieval observability)
19. `20260518_000004_document_classification.sql` — Phase 4 (document_type + extraction_quality on documents)
20. `20260518_000005_ocr_assessment.sql` — Phase 11 (ocr_assessment JSON on documents)

## How to run

If this repo is later connected to the Supabase CLI, these files can be applied with the normal migration workflow.

For the current project setup, the safe manual fallback is:

1. Open the matching file in this folder or in `docs/`.
2. Paste it into the Supabase SQL Editor.
3. Run it in the order listed above.
4. Confirm the verification queries at the bottom of each script.

## Notes

- Keep new production database changes in this folder going forward.
- Export schema or confirm backups before destructive SQL.
- The `docs/` copies stay useful as reviewable SQL, but `supabase/migrations/` is the reproducible source of record.
