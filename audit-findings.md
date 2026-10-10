> **2026-09-10 update:** a parallel session (`minallo-ef`/`minallo-7f`) has been running an overlapping audit and has landed 8 fix commits (`b4404ea`..`7ad61e7`) covering their R1-R8, which map onto most of the P1 cluster below. Verified against current code (see per-item status tags):
> - P0-1 (execution lane bypasses explicit evidence): **partially fixed** — their fix (`0a446ba`) only covers `source_mode=="internet"`; `classify_task_profile` still never checks `document_ids`/`active_document_id`, so explicit course-file selection is still bypassable. **Still open.**
> - P0-2 (correction misattaches to stale exercise label): `_active_questions` in `dialogue_state.py` is unchanged. **Still open.** Note: this file has active WIP from the other session as of this update (new `test_semantic_followup_gate.py`) — do not edit concurrently.
> - P0-3 (session-expiry dead listener): not covered by the other session. **Still open, no conflict, safe to fix.**
> - Agent-8 F1 (regenerate/retry clobbers live source scope): fixed (`b4404ea`).
> - Agent-6 auth findings: token-refresh mechanism fixed (`14deb70`); legacy bypass sites (ai.js, practice/examforge/flashcards.js) independently confirmed by their own audit (`auth-transport.md`) as still-open, unfixed — **still open**.
> - Agent-5 streaming findings: terminal ownership / partial-answer preservation fixed (`f5ca162`).
> - Provenance-through-clarification loss: fixed (`0c9b69a`).
> - Agent-4 full-document coverage-counting: fixed (`29bf8b1`).
> - Agent-3 viewer-blocks-unrelated-question style issue: fixed (`984cb9d`).
> - Agent-7 error-typing findings: fixed (`7ad61e7`).
> - **Confirmed NOT covered by the other session at all:** Agent-9 Quiz MCQ-only verification gap (their `study-features.md` only checked ExamForge); Agent-3 `/ask` endpoint missing document-health gate for `activeDocumentId`-only requests (not mentioned in their `documents.md`); Agent-10 chaos findings (compound URL+course routing, freshness-without-verb web routing, long-paste truncation, page-number visible-page precision, multi-intent hallucination risk); Agent-11 test-quality findings (fake "contract" tests in `test_ask_stream_contract.py`, though their own `test-coverage-gaps.md` independently flags several of the same mocked/overstated-coverage issues from a different angle).

# Minallo AI Reliability Audit — Findings (Phase A)

Baseline: origin/main `fc89e1b` ("Separate conversational evidence requirement from task intent"), plus uncommitted WIP on `dialogue_state.py` / `execution_router.py` / `test_conversational_evidence_resolution.py` (not modified by this audit, read-only).

11 read-only investigation agents ran in parallel. Full per-agent reports (routing matrices, error-mapping tables, 55-journey chaos table, test-quality table) are archived in `scratchpad/audit-findings/agent{1-11}-*.md`. This file groups their findings by root cause per the coordinator instructions.

---

## P0 — fix first

### P0-1. Execution lane is chosen before source/evidence resolution runs, so explicit document selection and course-grounding requirements can be silently ignored
**Root cause (one architectural issue behind two scenarios):** `execution_router.classify_task_profile` (`backend/python-ai/app/services/execution_router.py`) derives its own narrow "is this course/document-grounded" signal (`needsCourseEvidence`, driven only by a text regex or `source_mode=="course_files"`) and can terminate the request (`FAST_GENERAL`/`FAST_CONTEXTUAL`, `stream.py:1562-1651`) **before** `source_router.classify_source_scope` — the module that is actually supposed to be authoritative on evidence requirement, and that correctly treats an explicitly selected file as the strongest signal — ever runs (first called at `stream.py:3279`).
- **Scenario A:** student selects a specific file, asks a plain definitional question ("What is entropy?") with no possessive phrasing ("my/the lecture") → resolves to `FAST_GENERAL`, the selected file is never read, no indication given to the student. (Agent 2, Finding 1)
- **Scenario B:** same setup, mid-conversation follow-up ("why?") to a document-grounded answer → also reachable via `FAST_CONTEXTUAL`, again never re-touching the selected document. (Agent 2, Finding 2)
- **Files:** `execution_router.py` (`classify_task_profile`, `resolve_execution_plan`), `source_router.py` (`classify_source_scope`), `stream.py` (early-return branch 1562-1651, late `classify_source_scope` call at 3279).
- **Fix:** fold `has_specific_file`/`course_file_scope=="specific_files"` into `needsCourseEvidence`, or (better, longer-term) run execution planning strictly after source resolution and consume its output instead of re-deriving evidence need from scratch.
- **⚠️ Coordination note:** `execution_router.py` currently has uncommitted WIP from another session. This fix cannot proceed until that WIP is committed or coordinated — see "Open coordination issue" below.

### P0-2. Correction/rejection misattributes to a stale labeled exercise instead of the actual previous answer
Student solves "Aufgabe 3.2," then asks an unrelated question ("What is entropy?"), gets an answer, then says "No, that's not right." `dialogue_state.resolve_dialogue`'s `active_question` tracking only recognizes structured exercise labels and never expires once set — the correction is misattached to exercise 3.2 (several turns back) instead of the entropy answer the student is actually objecting to, and this wrong text is fed verbatim into the model prompt.
- **File:** `backend/python-ai/app/services/dialogue_state.py` (`_active_questions`, `resolve_dialogue`'s `_CORRECTION_RE`/`_REJECTION_RE` branches).
- **Fix:** correction branch must check whether the *immediately preceding assistant turn* actually concerned the labeled exercise before naming it; fall back to "the immediately previous answer" (no label) otherwise.
- **⚠️ Coordination note:** same file as P0-1, has uncommitted WIP from another session.

### P0-3. Session death (revoked/rejected refresh token) leaves the UI silently signed-in with no recovery path
`refreshSession()`'s hard-rejection branch (expired/revoked refresh token) clears the session but never fires the `_sbAuthCallbacks` fanout that the explicit sign-out path uses. Two event mechanisms exist to signal this (`auth:signed-out` bus event, `minallo:session-expired` DOM event) — **neither has a single listener anywhere in the frontend.** Net effect: the app internally becomes signed-out (`window._sbToken = null`) while the UI renders as if still logged in; every subsequent AI/course action just fails with no explanation, and the only recovery is a manual page refresh.
- **Files:** `frontend/js/supabase.js:391-411`, `frontend/js/minallo.js:68-79`, `frontend/js/services/ai-service.ts:20-31`, `frontend/js/features/auth/auth-modal.ts:431-441`.
- **Fix:** make `refreshSession()`'s hard-rejection branch fire the same `_sbAuthCallbacks` list explicit sign-out uses (reuses existing reload logic), or add a real listener that shows a "session expired, please sign in again" prompt.
- No WIP conflict — safe to fix immediately.

---

## P1 — fix after P0

Grouped by root cause; full per-finding detail (repro, exact lines, tests) is in the per-agent files referenced.

**Conversation understanding — regex fast-paths too narrow, drop to LLM or drop entirely** (dialogue_state.py, WIP file, same coordination note as above):
- A >12-word confirmation with no pronoun after an offered task never reaches semantic resolution → offered plan silently dropped. (Agent 1, F3)
- `_infer_pending_assistant_task` scans the whole assistant reply for task-shaped nouns instead of the clause containing the offer → false-positive pending task on the LLM-fallback path. (Agent 1, F4)
- "Show me exactly where the professor says that" (a paraphrased explicit source-verification request) doesn't match `_EXPLICIT_COURSE_SOURCE_RE` → resolves to `REUSE_PRIOR_GROUNDED` instead of fresh retrieval, silently violating "grounded requests must stay grounded" for an explicit citation check. (Agent 1, F2)
- Natural correction openers ("wait, I meant...") don't match `_CORRECTION_RE`/`_REJECTION_RE` → correction/invalidation semantics lost even when the exercise-label extractor happens to recover the number by luck. (Agent 10, F4)

**Auth transport migration is incomplete — several call sites still bypass the coordinated-refresh transport**, reproducing the exact "reads 401 instead of refreshing" bug the 17cce29 migration was meant to fix:
- `frontend/js/ai.js`'s legacy vision-attachment `askAI` (live path for any image-attached question) does a raw fetch with no refresh, and on 401 falls through to a misleading "No response" instead of a session-expired message. (Agent 6, F2)
- `practice.js`, `examforge.js`, `flashcards.js` are still classic-script IIFEs on the pre-migration raw-fetch pattern (2 of 5 known call sites were fixed in 787dfc8, 3 were missed). (Agent 6, F3)
- 20+ additional non-AI call sites also bypass `authenticatedFetch` (dashboard-widget.js, notes-panel.js, settings.js, subscription.js, affiliate.js, app-storage.js) — lower priority, listed in `agent6-auth.md`.

**Backend error codes and frontend typed-error map have drifted apart** — ~25 of ~40 backend error codes have no frontend mapping and collapse into one generic "Could not finish" message; worse, 3 of those (`ambiguous_document_name`, `FULL_DOCUMENT_SCOPE_REQUIRED`, `GROUNDING_REVISION_UNAVAILABLE`) are `retryable:false` on the backend but the frontend's generic fallback hardcodes `action:'retry'` regardless — rendering a Retry button that is guaranteed to fail identically every time. (Agent 7, F1/F2)
- **Fix:** backfill `typedErrors` entries (prioritize the `retryable:false` ones), fix the fallback branch to compute `action` from `retryable` instead of hardcoding `'retry'`, and add a contract test diffing backend `code=` literals against `typedErrors` keys so this can't silently drift further.

**Full-document/exhaustive extraction under-triggers for section-bounded or non-enumerated requests:**
- "Answer all the questions in exercise 7.2" is classified as a single bounded target and forced onto the top-k `RELEVANCE` path, not `COVERAGE` — sub-questions can be silently dropped with no incomplete-coverage signal (that signal only exists on the COVERAGE path). (Agent 4, F1)
- "List every formula in this course" doesn't trigger `FULL_DOCUMENT` because "formula" is missing from the document-item noun list (unlike "exercise", which works correctly). (Agent 10, F3)

**Quiz's independent answer-verification pass only covers MCQ** — true/false and short-answer quiz items are never independently re-derived/checked (short-answer has no `validate_final_answer` call at all), unlike ExamForge which verifies all three types and fails closed. A wrong true/false key or a non-answer short-answer key can reach the student as ground truth. (Agent 9, F1) — `backend/python-ai/app/services/quiz.py`.

**Frontend chat-state races on the shared mutable "active chat" object:**
- Regenerate/retry snapshot-and-restore the live chat's source-scope fields around the async call with no staleness check — if the user changes source selection (clicks a different file) while the regenerate is still streaming, their live choice is silently discarded when `.finally()` restores the pre-regenerate value. (Agent 8, F1)
- A general-mode (non-RAG) chat never acquires a `persistedId`; if the page reloads while such a message is still "processing," no repair path exists (the orphan-repair guard requires `!requestId`, which is never true) — the message is stuck "processing" forever with no Retry. (Agent 8, F2)

**Course-rail (`ai-ask.ts`) SSE consumer is materially weaker than the main Chatbot's (`shell.ts`)** — no per-event `requestId`/`conversationId` verification (only a local generation counter that navigation never invalidates), so a stale in-flight rail stream's tokens can potentially land in whatever context the user has since navigated to. `shell.ts` already has the correct pattern; `ai-ask.ts` should be unified onto it. (Agent 5, F1)

**Document-readiness check is not applied everywhere a document is actually in play:**
- `/ask` and `/retrieve-context` have zero index-health gating at all (no `validate_active_document_index` call anywhere) — a corrupted/stale index degrades silently instead of surfacing the typed error `/ask-stream` already has for this.
- `/ask-stream`'s own gate only checks `documentIds`, not `activeDocumentId` — a PDF that's open-but-not-multi-selected gets the same silent-degrade treatment even on the streaming endpoint. (Agent 3, F1)

**Compound/ambiguous source-routing signals dropped instead of handled:**
- A message containing both a URL and a real course question routes 100% to web search; the course half is silently dropped, not answered and not flagged. (Agent 10, F1)
- Freshness language ("what's the *current* DIN standard...") without an explicit search verb never reaches web routing at all — falls through to a stale/course-only answer with no freshness disclaimer offered. (Agent 10, F2)

**Long pasted content in plain chat is silently truncated per-turn (~1.2k chars) instead of being routed through `openFileContext`** — a student who pastes a previously-generated cheatsheet/exam directly into the composer (a natural, unblocked action) gets it silently truncated a few turns later, with later detail questions answered against garbled/truncated text and no warning. (Agent 10, F6)

---

## P2 — fix if small/clear, else defer

- `process_full_documents` has no checkpointing — every retry re-runs the entire batch pipeline from scratch, including pages that already succeeded; a permanently-missing page makes the request unrecoverable via this lane. (Agent 4, F2)
- `preservePartialAnswer` is defined on every typed error but never actually read anywhere — the real partial-answer-preservation decision is a separate, unrelated runtime check. Dead field that looks load-bearing. (Agent 7, F3)
- `POST /chat` (standalone Chatbot backend) catches every OpenAI SDK exception (rate-limit, auth, timeout, content-policy) in one bare `except Exception` → flat 502 "Internal error" with no `code` field at all — same generic-catch anti-pattern flagged elsewhere in the audit. (Agent 7, F4)
- `automatic_resume_exhausted` is untyped and not special-cased on retry — a naive Retry after the server has already given up on auto-resume risks silently repeating the same failed resume instead of starting fresh. (Agent 7, F5)
- Retry/"Continue" button silently no-ops (no toast, no feedback) in two guard conditions (already sending, unresolvable parent message). (Agent 7, F6)
- Quiz/flashcard deterministic backfill items (used when generation partially fails) are pedagogically trivial (verbatim-quote MCQs / generic flashcard fronts) and are blended invisibly into the "real" question set with no tag or UI distinction. (Agent 9, F2)
- Two similarly-named documents in the same course both get retrieval's `+0.75` "named document" boost with no disambiguation — chunks from both are blended under one boost with no signal to the model that the name was ambiguous. (Agent 3, F2)
- Course-rail SSE consumer has no "already finalized" short-circuit within a single network chunk — a duplicate/malformed trailing event in the same TCP read as `done` could theoretically append text after finalize. Requires an adversarial/duplicated SSE payload, not an everyday action. (Agent 5, F2)
- Multi-worker deployment: cross-process stale-request cancellation is DB-polled and throttled to once per 2s — a narrow window exists where a superseded request on a different worker can still persist a stale `final_answer`. (Agent 5, F3)
- Numeric page references ("explain the exercise on page 12") don't get visible-page precision — only deictic "this/current page" phrasing does; falls back to unscoped course-wide search. (Agent 10, F5)
- Multi-intent rambled messages (four unrelated asks in one message) have no splitter; specific risk of a hallucinated confident answer to an ungroundable sub-question like "is my exam on Friday" (no calendar data source, no refusal guard). (Agent 10, F7)

---

## Backlog (brief — no reproduction, low impact, or already-known/mitigated)

- `NEW_TOPIC` defaulting to `COURSE_RETRIEVAL` — already a documented, deliberate gap in-code with existing regression tests and a known mitigation path; latency/architecture-purity, not correctness.
- `isGeneration`/`isExtraction` task-profile flags aren't in the execution-lane precedence chain — theoretically a short generative request could hit `FAST_GENERAL`, not reproduced with a concrete phrase.
- Cross-revision manifest promotion skips regression checks when the document is reindexed mid-job — appears safe by construction (fresh manifest, revision-scoped joins), no live repro.
- `SseParser.dispatch()` doesn't reset `eventId` between events — spec-faithful behavior, zero current consumers read `.id`.
- Possible false-positive on the AI-internals-guard for a course literally about databases/information-retrieval — guard regex not read this pass, flagged for a follow-up live test only.
- Quiz mini-model verification's acknowledged residual false-negative risk — by design, already documented as an accepted trade-off.

---

## Test-quality findings (Agent 11) — feeds directly into which P1/P2 fixes need a *new* test vs. can trust an existing one

- **Most misleading finding of the whole audit:** `test_ask_stream_contract.py`'s three "contract" tests (including `test_every_focused_response_stage_has_an_absolute_terminal_deadline`, which directly claims to protect the streaming-terminal-state invariant) read `stream.py` as raw text and assert substrings exist in it. **No code executes.** They would stay green even if the terminal-deadline logic were dead or unreachable.
- **Auth/401 handling has zero dedicated tests anywhere**, front or back end — every backend test stubs `require_active_subscription` away entirely, and there is no frontend test suite at all. The entire auth-transport migration (17cce29) and single-flight refresh guard have no regression protection.
- **Frontend chat-state has zero automated tests** — confirmed no `*.test.ts`/`*.spec.ts` files exist anywhere under `frontend/`. Every "fixed" regression currently documented only in memory (origin-chat binding, refresh single-flight, PDF re-render destructiveness, view-dispatcher fetch retry) has no test guarding it from recurring.
- Score: **5 of 8 core invariants have a real-execution test; 2 are partial (source-scope-never-broadens, streaming-terminal-state — the dedicated deadline test is fake); 1 (auth-owns-auth) is effectively untested.**
- Otherwise the backend suite (1571 tests, 188 sampled in depth, all green, no regressions from this audit's reading) is genuinely well-built — dialogue routing, evidence resolution, execution routing, source routing, grounding contract, multi-turn stream state, indexing recovery, and document health are all real execution or solid integration tests, not just wiring.

---

## Open coordination issue (must resolve before Phase B on two P0s)

**P0-1 and P0-2 both require editing `execution_router.py` / `dialogue_state.py`, which currently carry 156 lines of uncommitted WIP from another session** (per your instruction, left untouched during this investigation). Per the audit's own "no overlapping production file edits" working rule, Phase B cannot start fixing these two P0s until you tell me how to proceed with that WIP — commit it as a baseline first, coordinate with whoever owns it, or explicitly authorize editing on top of it.

P0-3 (session-expiry dead-listener) has no such conflict and can be fixed immediately.
