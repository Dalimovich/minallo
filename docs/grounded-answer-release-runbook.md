# Grounded-answer migration and release runbook

This runbook is for the question-reference metadata migration and index upgrade.
Do not mutate the active production index progressively.

1. Record the current application release, database migration version, active
   index version, document count, chunk count, and question-label coverage.
2. Snapshot `documents`, `document_chunks`, and answer-cache metadata. Do not
   export raw private PDF text into deployment logs.
3. Apply the migration in staging and verify the expected columns, indexes,
   row counts, null rates, document revisions, and tenant ownership constraints.
4. Deploy code that can read both the old and new metadata shapes before making
   the new fields mandatory.
5. Reindex into a new immutable index-version namespace. Keep the active index
   unchanged while this runs.
6. Compare per-user, per-course, per-document, per-page, and exact-question
   coverage between the old and candidate indexes. Run the fixed multilingual,
   correction, numerical, OCR, tenant-isolation, and prompt-injection suites.
7. Canary the candidate index. Roll back automatically on any wrong-exercise,
   invented-number, ignored-correction, wrong-language, stale-result reuse, or
   tenant-isolation failure. Also monitor clarification and latency changes.
8. Atomically switch the active index-version pointer after the canary passes.
9. Retain the prior application release, schema snapshot, and index pointer for
   rollback. Do not delete the old index during the initial observation window.
10. Remove the old index only after coverage, latency, error, and critical
    failure metrics remain within thresholds for the agreed retention period.

Privacy-safe observability should log request, conversation, document, revision,
region, chunk, and index identifiers or hashes; resolution/verification status;
confidence; failure category; and phase timings. It must not log raw selected
text, OCR output, PDF content, prompts, or generated private answers.
