# Document reliability investigation

Baseline: `1ecddd6b1beaa19a1c633160ef651c2fbd78511f`. No production changes.

No new demonstrated P0/P1 in this domain from the bounded investigation. This is not a production reliability verdict.

Executed `tests/test_document_health.py`, `tests/test_quiz_normalize.py`, `tests/test_flashcard_diagnostics.py`: **34 passed**. Additional combined indexing/generation suites: **167 passed** (see study-features report). Health tests execute the live validator against a mocked database; they are real unit execution, not proof of deployed Supabase rows or SQL behavior. Covered stale cached chunk counts, absent chunks/pages, missing manifest coverage and index consistency branches.

Source inspection: `document_health.validate_active_document_index` compares active revision row counts and validates manifests against authoritative document page_count. UNKNOWN health deliberately fails open only for health-check transport failure. `indexing.index_document` preserves a previously-ready revision across candidate failure through `preserve_active`; candidate activation is gated by coverage. `tests/test_mark_failed.py` tests the failure helper, not a complete index replacement through real database activation. No usable index was destroyed during this audit.

Selected-document generation uses `generate._resolve_ready_document_ids`, which silently drops explicitly selected indexing files while generating from remaining ready files. The response includes readiness counts but does not necessarily warn. This is an incomplete-evidence UX concern (P2 pending concrete explicit exhaustive generation journey), not silent scope broadening; no P0 inferred. Quiz has separate readiness handling and requires further convergence review.

Remaining required execution gaps: real upload/index/rename/delete lifecycle, failed candidate embedding replacement with a previously active index, actual retrieval filtering after course switch, similar filenames through UI, missing embedding service and zero relevant retrieval chunks through complete request pipeline. Passing mocks alone cannot close these gates.
