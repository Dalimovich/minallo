# Supabase Migrations

This folder is the source of record for Minallo database schema, storage, RLS, retrieval, chat, billing, and evaluation migrations.

Run migrations in filename order. Do not edit a migration that has already been applied to production. Add a new migration instead.

## Current Migration Order

```text
001_hybrid_search.sql
002_section_title_and_retrieval_cache.sql
003_extended_document_metadata.sql
004_storage_bucket_security.sql
005_answer_and_question_cache.sql
006_ai_evaluations.sql
007_document_id_filter.sql
008_flashcard_decks.sql
009_chat_history.sql
010_document_ids_filter.sql
011_study_sets.sql
012_notes.sql
013_ai_cache_schema_alignment.sql
014_hybrid_search_document_filters.sql
20260504_000001_admin_security.sql
20260504_000002_rls_hardening.sql
20260504_000003_chat_room_rls_patch.sql
20260504_000004_storage_security.sql
20260504_000005_security_indexes.sql
20260504_000006_public_profiles.sql
20260504_000007_chat_reports.sql
20260505_000001_rag_foundation.sql
20260505_000002_rag_caching.sql
20260505_000003_evaluations.sql
20260506_000001_processing_error.sql
20260511_000001_ai_cache_schema_alignment.sql
20260511_000002_hybrid_search_document_filters.sql
20260512_000001_python_indexer_additions.sql
20260512_000002_hybrid_search_candidate_limit.sql
20260512_000003_backfill_legacy_chunk_count.sql
20260513_000001_storage_bucket_alignment.sql
20260518_000001_markdown_indexing.sql
20260518_000002_exercise_formula_blocks.sql
20260518_000003_retrieval_debug.sql
20260518_000004_document_classification.sql
20260518_000005_ocr_assessment.sql
20260519_000001_stripe_webhook_idempotency.sql
20260519_000002_paypal_webhook_idempotency.sql
20260519_000003_profiles_subscriptions_rls.sql
20260519_000004_profiles_subscriptions_rls_cleanup.sql
20260519_000005_profiles_university_and_suggestions.sql
20260519_000006_chunk_topics.sql
20260520_000001_user_topic_mastery.sql
20260520_000002_subscription_pause.sql
20260520_000003_trial_device_ledger.sql
20260520_000004_subscription_had_trial.sql
20260520_000005_subscription_cancel_at_period_end.sql
20260520_000006_subscription_retention_offer.sql
20260521_000001_chunk_exercise_link.sql
20260521_000002_debug_log_retention.sql
20260521_000003_hybrid_search_keyword_only_fix.sql
20260527_000001_ai_evaluations_rls_cleanup.sql
20260527_000002_rls_cleanup_stage1.sql
20260527_000003_rls_cleanup_stage2.sql
20260527_000004_rls_cleanup_stage3.sql
20260527_000005_room_members_recursion_hotfix.sql
```

## How To Apply

Preferred with Supabase CLI:

```bash
supabase db push
```

Manual fallback:

1. Sort files by filename.
2. Open the next unapplied migration.
3. Paste it into the Supabase SQL editor.
4. Run it.
5. Run any verification query at the bottom of the migration.
6. Record the applied migration in your deployment notes.

## Rules

- New production database changes go in this folder.
- Do not reorder migrations.
- Do not modify a migration after it has been applied to production.
- Include verification SQL for RLS, billing, webhook, storage, chat, retrieval, and admin changes.
- Avoid destructive SQL unless there is a backup and a clear rollback plan.
- Keep storage policies and table RLS policies in sync with frontend/API behavior.

## Areas Covered

| Area | Examples |
|---|---|
| RAG | `document_chunks`, pgvector search, document filters, cache alignment |
| Retrieval quality | debug logs, document classification, OCR assessment, topic links |
| Course generation | notes, flashcards, quizzes, study sets |
| Chat | chat history, rooms, reports, room-member recursion fixes |
| Billing | Stripe/PayPal webhook idempotency, trials, pause/cancel/retention |
| Security | RLS hardening, storage policies, admin tables, public profiles |

## After Applying

For any migration that touches RLS, run a quick authenticated smoke test:

- Regular user can only read/write their own data.
- Admin-only routes require an admin entry.
- Storage access matches the user/course ownership model.
- Webhook tables are service-role only.
- Retrieval logs do not leak data across users.
