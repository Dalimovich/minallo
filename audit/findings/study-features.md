# Generated study features investigation

Baseline: `1ecddd6b1beaa19a1c633160ef651c2fbd78511f`.

Executed backend command:

```
.venv/Scripts/python.exe -m pytest tests/test_indexing_recovery.py tests/test_index_manifest.py tests/test_generate_router.py tests/test_examforge.py tests/test_examforge_answer_verifier.py tests/test_deep_learn.py tests/test_deep_learn_reuse.py tests/test_cheatsheet.py -q
```

Result: **167 passed**, 3 dependency deprecation warnings. Separate document health/quiz/flashcard suite: **34 passed**. These are real unit and mocked HTTP integration tests, not browser E2E or production verification.

ExamForge tests execute malformed/procedural answer rejection, fake-source rejection, independent answer verification, replacement generation, partial count warnings, session insert failure, empty/missing persisted question IDs, and successful persisted identity construction. `examforge.generate_examforge` requires grounded and answerVerified questions, verifies persisted question IDs, and returns error on persistence failure. `backend/functions/ai-examforge.ts` does not expose legacy quiz fallback as a gradeable exam. These are useful structural safeguards for the exact-question-answer invariant.

Frontend source trace: `study-tool-workflow.generate` requires persistedResourceId for ExamForge, saves a generated flashcard deck before exposing completion, and requires noteId for Deep Learn. Failed generation/save resets status to failed and re-enables Retry. Saved references retain exact artifact IDs. Saved reopen through real UI was not executed.

No newly proved P0/P1 in these features. Python quiz/flashcard save helpers swallow database errors and can leave incomplete study_sets rows, but current `ai-generate.ts` sends save:false and the visible workflow owns persistence; this is **Backlog**, not a claimed current user-facing P0. Verify reachable callers before changing that architecture.

Remaining acceptance gaps: real flashcard/quiz/ExamForge/Saved reopen journey; browser storage and database failure injection during save; interrupted retry retaining generated content; professor-style versus ExamForge semantic intent; Study Plan/Recommendation multi-turn behavior (coordinator's conversation domain); model timeouts through visible error rendering. This report does not claim those gates passed.
