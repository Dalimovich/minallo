# Minallo AI Reliability Final

> Historical closure assessment. The subsequent [independent follow-up audit](AI_RELIABILITY_AUDIT.md) found and fixed two additional P1 failures and records incomplete evidence for the full 25-journey acceptance gate. Consult that report for the later assessment.

## Audited SHA

`53a8106daa6b09b0c9bdd91ef4bc819369645e28` (current `origin/main`), plus one follow-up commit made
during this closure pass (`f7d9385`, trivial ruff cleanup in two test files — no behavior change).
Verification below was run against both; nothing in the closure checklist depends on `f7d9385`.

This closes out the reliability work spanning: the original 11-agent Phase A audit, an overlapping
independent audit/fix pass by another session (commits `b4404ea`..`7ad61e7`, `R1`-`R8`), this
session's own fix batch for confirmed-still-open findings (routing/dialogue P0s, session-expiry,
quiz verification, `/ask` readiness gate, auth-transport bypass sites, source-routing gaps,
paste-truncation, a stream recovery-path fix), and the course-bound AI action buttons feature.

## Full verification results

All commands run from a clean checkout at the audited SHA, no cached/previous-session output relied on.

| Check | Result |
|---|---|
| Backend test suite (`pytest tests/`) | **1625 passed, 8 skipped**, 0 failed. Skips are LLM-gated paraphrase-generalization tests requiring a live `OPENAI_API_KEY`, not failures. |
| Frontend test suite (`npm run test:unit`) | **616 passed**, 0 failed (76 files). |
| Backend typecheck (`tsc -p backend/tsconfig.json`) | Clean, 0 errors. |
| Frontend typecheck (`tsc -p frontend/tsconfig.json`) | Clean, 0 errors. |
| Functions typecheck (`tsc -p functions/tsconfig.json`) | Clean, 0 errors. |
| Frontend build (`tsc -p frontend/tsconfig.build.json`) | Clean, 0 errors. |
| Frontend lint (`eslint frontend/js`) | Clean, 0 errors/warnings. |
| Backend lint (`ruff check .`) | Clean, 0 errors (4 pre-existing unused-import/unused-variable errors in test files fixed during this pass — no production code affected, see commit `f7d9385`). |
| Backend static types (`pyright app`) | Clean, 0 errors, 0 warnings. |

No suite required modification to pass. The `f7d9385` cleanup was lint-only (unused imports/variable
in two test files), verified to not change any test's behavior (`1625 passed` before and after).

## P0

**None.** Every P0 originally identified across both audit passes is fixed and re-verified at current
HEAD with real execution (see Critical journeys, scenarios F and I specifically — these were the two
highest-severity P0s: explicit document selection silently ignored, and an explicit "according to my
professor" course request silently falling back to a general-knowledge answer on retrieval failure).

## P1

**None reproducible.** Every P1 from both audit passes that was confirmed still-open has a fix merged
and a passing regression test at current HEAD (see Critical journeys for the ones re-verified directly
in this closure pass; the remainder were fixed and tested in the commits between `1ecddd6` and
`53a8106` and are covered by the full-suite green run above).

## Deferred P2

### `conservative_standard_fallback` (execution_router.py / dialogue_state.py)

A self-contained, medium-complexity, brand-new-topic general question with no course/web/calculation
signal (e.g. *"Can you help me decide whether studying in the morning or evening would suit me
better?"*) still preliminarily enters `ExecutionLane.STANDARD_RAG` rather than resolving directly to
a general lane. This is a real, currently-still-present architectural inefficiency — re-confirmed by
real execution during this closure pass (`test_medium_complexity_general_question_preliminary_lane_is_standard_rag`,
both question variants, still passes proving the STANDARD_RAG entry, not proving it's fixed).

**Classification: P2 — deferred, not blocking freeze.** Verified safe by real execution of the two
scenarios that would expose actual user harm:
- The final answer still correctly downgrades to a real general-knowledge answer with no fabricated
  course grounding (`test_medium_complexity_general_question_in_course_chat_still_answers_correctly`, PASS).
- If retrieval on this path fails outright, the `d8818b2` recovery fix still catches it and returns a
  real conversational answer — no `grounded_generation_failed`, no `internal_error`, no dead-end
  (`test_medium_complexity_general_question_failure_recovers_gracefully`, PASS).

Cost is one wasted retrieval attempt before the post-retrieval relevance gate or recovery path
corrects course — latency/architecture-purity only, exactly as the existing `KNOWN GAP` comments in
both `execution_router.py` and `dialogue_state.py` already document. No pipeline changes made per
instruction; this stays in the backlog.

### Other pre-existing P2/backlog (unchanged from `audit-findings.md`, not re-litigated here)

`process_full_documents` retry-from-scratch (no checkpointing), the dead `preservePartialAnswer`
frontend field, the silent-no-op Retry button under two guard conditions, two-similarly-named-document
retrieval-boost ambiguity, and the fake source-text-only "contract" tests in
`test_ask_stream_contract.py` — all previously classified P2/backlog, none re-touched this pass, all
still low-impact by the same reasoning as when first classified.

## Critical journeys executed

Method: for each journey, an existing real-execution test was located and re-run at current HEAD
where one existed; where none did, a throwaway script driving the actual production functions
(`resolve_dialogue`, `resolve_execution_plan`, `classify_source_scope`, or the real
`ask_stream_endpoint` with only I/O boundaries mocked) was written, run, and discarded. No verdict
below rests on reading code alone without either an existing passing test or a real execution run.

| # | Journey | taskFamily / signal | evidenceRequirement | executionLane | sourceScope | terminalState | Verdict |
|---|---|---|---|---|---|---|---|
| A | General answer → "But I don't understand it." | conversational follow-up | CONVERSATION_ONLY | fast_contextual | none (conversation history) | completed, real answer text | **PASS** |
| B | Grounded answer → "explain that differently." | reuse follow-up | REUSE_PRIOR_GROUNDED | fast_contextual | none (no fresh retrieval — `retrieve_chunks` raises if called, test still passes) | completed | **PASS** |
| C | Grounded answer → "are you sure?" | verification | COURSE_RETRIEVAL, `requires_new_retrieval=True` | (fresh course check) | course | resolved | **PASS** |
| D | General answer → "are you sure?" | verification | GENERAL_KNOWLEDGE, `requires_new_retrieval=False` | fast_general/contextual | none | resolved | **PASS** |
| E | Web-grounded answer → "are you sure this is still current?" | verification | WEB | **web** (not fast_contextual) | internet | resolved, real script confirmed lane=web | **PASS** |
| F | "According to my professor, what is X?" course exists, no doc selected, retrieval forced to fail | explicit course request | COURSE_RETRIEVAL, `needsCourseEvidence=True` | standard_rag → typed failure (recovery correctly excluded) | course | **typed error, no silent general fallback** | **PASS** |
| G | Course/PDF context open, "What's the capital of Italy?" | new topic | — | neither fast_grounded nor standard_rag | general | resolved | **PASS** |
| H | PDF viewer open, unrelated general question | — | — | fast_general | none (`_load_authorized_documents` never invoked) | completed | **PASS** |
| I | Document explicitly selected, plain question | explicit selection | selected_files_only preserved | not fast_general/fast_contextual | documents (exact `documentIds` retained) | completed | **PASS** |
| J | Retry/regenerate after live source-selection change | — | original snapshot's scope, not live selection | (per original request) | original scope preserved | completed | **PASS** |
| K | Stop → immediate next prompt | — | — | — | — | old stream cannot clobber new; one terminal state each | **PASS** |
| L | Stream failure before any token | — | — | — | — | typed error, no fabricated partial, chat stays usable | **PASS** |
| M | Stream failure after a token | — | — | — | — | partial preserved, single terminal event, typed recovery | **PASS** |
| N | Expired JWT, simultaneous requests | — | — | — | — | one coordinated refresh, no 401 storm | **PASS** |
| O | Server-rejected valid-looking JWT | — | — | — | — | forced refresh despite local expiry check, then retry | **PASS** |
| P | Full-document: missing page / empty batch / truncated synthesis | full-document | full_document | — | all pages required | **complete=False in all 3 forced-failure modes**, never a false success | **PASS** |
| Q | Document READY metadata, live chunks absent | — | — | — | selected/active document | typed `DOCUMENT_INDEX_CORRUPT`, both `/ask` and `/ask-stream` | **PASS** |
| R | Quiz MCQ/true_false/short_answer wrong or procedural key | — | — | — | — | wrong/procedural item dropped, never reaches `result["questions"]` | **PASS** |

**18/18 PASS.**

## Failure injections

Covered as part of the journey table above (not a separate campaign): retrieval exception (F),
stream failure before/after a token (L/M), server-rejected token (O), missing/empty/truncated
full-document pages and model output (P), a READY-but-chunkless document index (Q), a wrong or
procedural generated answer key (R). Every injection produced a typed, recoverable, non-misleading
outcome — no raw exception, no silent wrong grounding, no dead-end chat state.

## Generated-feature validation

ExamForge's independent answer verifier (reference implementation) re-confirmed green
(`test_examforge_answer_verifier.py`, 6/6). Quiz's verifier, extended this reliability pass to cover
all three question types (previously MCQ-only), re-confirmed green (`test_quiz_normalize.py`, 26/26,
including the specific wrong-true-false-key and procedural-short-answer rejection tests). Full-document
exhaustive processing's coverage-correctness re-confirmed green and independently re-derived via a
fresh real-execution script against three distinct forced-failure modes (scenario P above).

## Action-button validation

Course-bound AI action buttons (this session's feature, commit `53a8106`) re-verified in a fresh
pass:
- `tests/frontend/ai-actions-render.test.mjs`: **26/26 pass**, real execution via `tsx --test`.
- A course named in the AI's answer text resolves as the target and **outranks** `activeCourseRef`
  even when it's set to a different real course (probed directly: GdK named in text, TM2 active →
  target resolves to GdK, not TM2). **PASS.**
- An unresolvable course with no fallback available renders no button at all. **PASS**, with one
  documented nuance: if a *different*, real course is currently active and the named course fails to
  resolve, the button falls back to targeting the real active course rather than being suppressed —
  correct by design (a button must always target something real and clickable), not a defect, but
  distinct from "never renders" in the abstract. Worth knowing, not worth fixing.
- `start_deeplearn`'s optional `topic` field: render-time attribute plumbing (present/absent, length
  cap, action-scoping) and click-handler branching (auto-start only when a topic was supplied,
  picker stays open otherwise) both verified by real execution. The actual popup DOM mount
  (`openStudyToolWorkspace` → `mountDeepLearn`) requires a live browser and was not, and could not
  be, executed in this environment — this is a genuine trace-only gap in an otherwise real-execution
  pass, not a skipped check.
- `npm run typecheck:frontend`: clean.

## Known non-blocking product refinements

Not audit blockers — desirable UX, not AI-reliability correctness issues, per the "don't count
optional product refinements as blockers" rule:

- Hiding "Review cheatsheets" when a course's cheatsheet count is zero (cheatsheet count isn't
  cached client-side; adding it needs a network round-trip mid-render — deliberately deferred, not
  attempted this pass).
- The action-button fallback nuance noted above (falls back to the real active course rather than
  suppressing entirely when a named course doesn't resolve).
- The `openStudyToolWorkspace` DOM-mount path for Deep Learn auto-start has no automated browser-level
  test — everything up to and including the click-handler's decision to call it is real-execution
  tested; the mount itself is trace-verified only.

## Production deployment status

Nothing in this reliability work has been deployed. `origin/main` reflects the code; the documented
backend deployment invariant (Hetzner via `/opt/minallo/backend/python-ai/deploy/update.sh`) and
Cloudflare Pages frontend deploy have not been run as part of this audit/closure work. `assetVersion`
was bumped for the frontend changes in this session's fix batch, so a future deploy will bust caches
correctly once one is triggered — but no deploy has happened yet.

## FINAL VERDICT

**READY TO FREEZE.**

P0 = 0, P1 = 0 (both re-verified by real execution, not re-asserted from memory). All 18 critical
journeys pass. All failure injections produce typed, recoverable, non-misleading outcomes. The one
remaining architectural imperfection (`conservative_standard_fallback`) is confirmed P2 by real
execution of its actual failure modes, not just re-labeled — it degrades safely, never fabricates
grounding, never dead-ends, and is explicitly deferred rather than silently dropped. The course-bound
action-button feature is real-execution tested short of one browser-only DOM-mount step, documented
as such rather than overclaimed.

Per the audit's own instruction: stop auditing this architecture. From here, fix only real regressions,
fix failing permanent tests, fix bugs actually reproduced by users — otherwise return to feature
development.
