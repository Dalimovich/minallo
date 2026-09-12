# Permanent critical journey coverage outline

Read-only review, 2026-09-10. Proposed compact selection uses permanent tests already in the repository. A mapped test is not automatically a passing full journey. Python filenames are under `backend/python-ai/tests/`, JavaScript under `tests/frontend/`. **I** integration with mocked dependencies; **U** real unit execution; **H** helper only; **W** source wiring; **B** real browser with mocked HTTP. No live E2E was established here.

| # | Required journey | Exact current anchor | Evidence and remaining assertion |
|---|---|---|---|
| 1 | General answer → clarification | `test_conversational_evidence_resolution.py::test_general_followup_stays_conversational` | I; synthetic first answer, real follow-up route |
| 2 | Grounded answer → clarification | `test_answer_provenance_journey.py::test_grounded_answer_clarification_then_verification_retains_evidence` | I; actual route provenance chain, mocked generation |
| 3 | Grounded answer → verification | `test_conversational_evidence_resolution.py::test_verification_after_grounded_answer_runs_fresh_course_check` | U; add real retrieval invocation assertion for complete journey |
| 4 | General answer → verification | `test_conversational_evidence_resolution.py::test_verification_after_general_answer_stays_general_no_course` | U; evidence resolution |
| 5 | Grounded answer → exact page | `test_conversational_evidence_resolution.py::test_explicit_location_after_grounded_answer_runs_fresh_course_retrieval` | I; fake retrieval boundary |
| 6 | Course chat → unrelated general | `test_conversational_evidence_resolution.py::test_medium_complexity_general_question_in_course_chat_still_answers_correctly` | I; fake model answer, real route |
| 7 | PDF open → unrelated general | `optional-pdf-capture-runtime.test.mjs`: `optional PDF render failure still submits a general question to authoritative evidence routing`; `test_optional_viewer_evidence.py` | I; real transport/route separately, not real viewer |
| 8 | PDF open → deictic meaning | `optional-pdf-capture-runtime.test.mjs`: `required visible-page failure remains typed and preserves selected retrieval scope` | I failure recovery; successful visual interpretation journey GAP |
| 9 | Selected file only | `test_explicit_evidence_preflight.py::test_explicit_scope_cannot_exit_through_general_shortcut`; `ai-request-scope-runtime.test.mjs` | I; hard scope at preflight/transport, actual live index GAP |
| 10 | Missing selected file | `test_document_health.py::test_missing_document_reports_failed` | I health function; selected-file chat recovery journey GAP |
| 11 | Full-document scan | `test_full_document_failures.py::test_hundred_page_document_reports_genuine_progress_and_complete_final_answer` | I; actual processor fake rows/model; consult truncation fix status |
| 12 | Interrupted full-document resume | `test_document_extraction.py::test_resume_only_processes_pages_after_last_checkpoint` | I; real extraction with provided checkpoint, not worker restart/persisted reload; separate summary path GAP |
| 13 | General calculation | `test_execution_router.py` parametrized task/lane matrix | U routing; numeric answer/user-visible completion GAP |
| 14 | Course calculation | `test_explicit_evidence_preflight.py::test_explicit_scope_cannot_exit_through_general_shortcut` plus selected scope policy | I partial; exact grounded numeric calculation journey GAP |
| 15 | Study recommendation without course | `test_learning_recommendation.py::test_explicit_explanation_builds_detailed_plan`; `test_execution_router.py::test_stream_courseless_study_plan_reaction_skips_workspace_pipeline` | H/I different supporting cases; actual recommendation UI journey GAP |
| 16 | Study recommendation with course | `test_learning_recommendation.py::test_low_mastery_requires_real_matching_record` | H; generation/persistence/reopen GAP |
| 17 | Flashcards confirmation | `test_execution_router.py::test_stream_confirmation_executes_resolved_study_plan_not_raw_chitchat` | I confirms Study Plan mechanism only; Flashcards exact confirmation → generator journey GAP |
| 18 | ExamForge exact Saved reopen | `test_examforge.py::test_generate_examforge_success_persists_ids_and_session`; `examforge-inline.test.mjs` | I persistence / W UI; exact Saved browser reopen GAP |
| 19 | Stop → next prompt | `audit/repros/browser-chat.mjs`: `stop`, `stop-next` | B; should promote harness into permanent integration command |
| 20 | Failure before first token | `ai-terminal-runtime.test.mjs`: `failure before token is recoverable and the next request remains usable` | I actual transport with synthetic error |
| 21 | Failure after first token | same file: `failure after token is recoverable and the next request remains usable`; browser `partial-disconnect` | I/B partial preservation |
| 22 | Expired JWT | `authenticated-fetch.test.mjs`: `refreshes before sending an expiring token`, `coalesces simultaneous refreshes` | U central transport with fake dependencies |
| 23 | Refresh token rejected | `auth-browser-adapter.test.mjs`: `revoked refresh surfaces a session error and never retries without authentication` | I actual adapter, fake auth |
| 24 | Switch chats while streaming | `ai-request-scope-runtime.test.mjs`: `chat switch during PDF capture retains the submitted source mode and selected scope`; browser `switch-before-submission` | I/B pre-submission switch; mid-token background completion full journey GAP |
| 25 | Model structured-output failure | `test_semantic_followup_gate.py::test_malformed_semantic_output_uses_safe_conversation_fallback` | U real semantic adapter fake model; downstream next-turn usability supplemented by route timeout test |

## Compact suite completion plan

Keep direct executable regressions as the permanent safety net. Build a runner selecting the exact anchors above and report separate counts for runtime integration, browser integration, helpers, source wiring, skipped, and missing journeys. Do not turn missing rows into passing placeholders or count the 50-scenario resolver corpus as browser journeys.

Promote the synthetic browser harness into a permanent command after its final run is green. Add bounded scenarios for selected-file missing/retry, Flashcards confirmation, exact ExamForge Saved reopen, mid-token chat switching, and regenerate with changed UI scope. These exercise product behavior beyond routing helpers.

For resume, reuse the existing real extraction checkpoint test, but add actual worker interruption → persisted checkpoint load → resume without duplicate processed items. Describe full-document summary retry separately because it does not automatically share extraction checkpoint execution.

Final acceptance requires the coordinator's complete rerun and clear accounting for the remaining gaps. This outline alone is not a passing 25-journey suite.
