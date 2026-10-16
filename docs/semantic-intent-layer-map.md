# Semantic Student Intent Layer — architecture map (PR 1)

Traced against the actual call graph (not inferred from filenames) as of
commit `035dcaca` on `main`. This is the map for the Semantic Student Intent
Interpreter PR series. PR 1 (this one) adds the typed contract, a
deterministic adapter, and feature-flagged (default **off**) wiring that
changes nothing when disabled. PR 2's plan is at the bottom.

## Where a message actually travels today

1. **HTTP entry — `backend/python-ai/app/routers/stream.py`,
   `ask_stream_endpoint` (`POST /ask-stream`, line ~1545).**
   - Auth: `Depends(verify_supabase_jwt)` — the only auth check; runs before
     anything else in the function body.
   - Validation/abuse control: `require_active_subscription`,
     `enforce_interactive_cap`, `enforce_rate_limit` (concurrent via
     `asyncio.gather` for the first two), then UUID validation on
     `documentIds`/`activeDocumentId`, then question length (`question`
     stripped, bounded by `_MAX_STREAM_QUESTION_CHARS`).
   - **Trusted PDF/page/selection context becomes available here**: the
     request's `GroundingRequest` (`payload.groundingRequest`) is the
     authoritative source for `retrievalScope` (course vs. specific
     `documentIds`), `viewerContext` (`activeDocumentId`, `revision`,
     `visiblePage`), and `visiblePageContext` (the extracted text slice of
     what's on screen). A legacy client without a `groundingRequest` gets one
     synthesized from the older flat fields for backward compatibility. This
     is the one place in the whole pipeline where "what PDF/page/selection is
     actually open" is established as trusted — everything downstream reads
     it from here, never re-derives it from the student's wording.
   - `resolve_document_access(...)` (`grounding_contract.py`) turns that into
     a `ResolvedDocumentAccess` enum (`RELEVANCE` / `VISIBLE_PAGE` /
     `FULL_DOCUMENT`) — this is the authoritative **scope** signal.
   - **Dialogue resolution** — `resolve_dialogue()` (deterministic regexes,
     `app/services/dialogue_state.py`) turns the message + trimmed
     `previousTurns` into a `DialogueResolution`: dialogue act, resolved
     request text, active/previous exercise labels, response language,
     requested depth, `TurnRelation`, `SpeechAct`, `TaskFamily`,
     `EvidenceRequirement`, and a confidence score.
   - **Existing semantic escalation** — `needs_semantic_resolution()` gates a
     *second*, already-existing, lightweight structured-output model call:
     `resolve_dialogue_semantically()`. This only fires for short,
     referential, or pending-task-shaped turns; on timeout/malformed
     JSON/low-confidence (`< 0.65`) it fails closed to
     `_safe_conversational_fallback`. **This is the precedent the new
     Semantic Student Intent layer's PR‑2 model call should follow** — same
     fail-closed shape, same cheap/low-effort model tier, same short timeout
     (`INTERACTIVE_CLASSIFIER_TIMEOUT`).
   - Pure-social short circuit (`is_pure_social_turn`) returns a static
     chitchat reply without touching retrieval.
   - **Execution planning** — `resolve_execution_plan()`
     (`app/services/execution_router.py`) turns the resolved request +
     `ResolvedDocumentAccess` + source mode + conversation signals into a
     `TaskProfile` (regex-derived booleans: `needsCourseEvidence`,
     `isCalculation`, `isFollowup`, …) and an `ExecutionPlan` (`groundingMode`,
     `executionLane`, `processingPipeline`, `complexity`, `confidence`,
     `reason`, `signals`, `mayEscalate`). **This module's docstring calls
     itself "the single authoritative execution-plan router" — its authority
     is explicitly preserved; the new interpreter is wired in as an
     additional, optional, non-authoritative signal (see "Integration
     point" below), never a second router.**
   - Durable-conversation bookkeeping (idempotency, `conversationId`
     recovery) follows, then the function dispatches into the SSE generator.

2. **SSE generator dispatch — further down `stream.py` (~line 6110),
   `stream_answer(...)`** (defined in `app/services/answer_stream.py`,
   2810 lines). The router passes `dialogue_overlay=turn_resolution.
   prompt_overlay()` among ~30 other keyword args (chunks, viewer context,
   problem-solver state, workspace block, grounding policy, …).

3. **Retrieval + grounding selection** happens inside `stream_answer()`
   before intent classification: `_context_strength(chunks)` grades the
   already-retrieved chunks, `wants_per_source_coverage`/`EXAM_GENERATION`
   detection decides whether to keep one chunk per source file instead of
   top-K, visible-page / problem-solver text gets folded into a separate
   `routing_chunks` list that is kept apart from the literal question text
   specifically so keyword intent regexes never fire on course material
   printed on the visible page (see the long comment at
   `answer_stream.py` ~line 1809 — this is the exact prompt-injection
   boundary the codebase already defends and the new `StudentIntent`
   contract keeps in place).

4. **Academic task classification** — `classify_academic_intent(question,
   routing_chunks, metadata)` (`app/services/answer_intent.py`, line ~1824 of
   `answer_stream.py`) returns an `AcademicIntent` enum member. This is the
   *task* classifier (what shape of answer: summary, quiz, exam, grading,
   translation, …), orthogonal to `dialogue_state`'s `TaskFamily` /
   `EvidenceRequirement` (which answer *where-from* and *continuation*
   questions).

5. **Prompt assembly** — `pick_system_prompt(...)` (`app/services/answer.py`,
   shared by both the streaming and non-streaming paths) picks a base
   template (math / strong / partial / weak / fallback) from retrieval
   strength + intent, then appends, in this exact cache-friendly order:
   tutor overlay → app context → user-intent/dignity/confidentiality rules →
   coaching overlay → **`intent_style_instruction(academic_intent, question)`**
   (`answer_intent.py`, line 676) → math-missing-context popup → professor-
   style overlay. **`intent_style_instruction` is the exact place the
   negation/prohibition guard text is injected** — it re-checks
   `_SUMMARY_PROHIBITION_RE`/`NEGATED_QUIZ_RE` against the raw question and
   appends "do NOT include a Summary heading" / "do not turn this into quiz
   questions" lines. The regression this whole initiative exists to fix
   ("Explain this page in detail. Do not summarize it.") was patched here
   and in `classify_academic_intent`'s own negation guards (commits
   `9cff2f07`, `eb48ca44`, `d4b9b14c`, `5cd00882` on `main`) — reactively,
   by regex, exactly the pattern this initiative replaces with a typed
   contract.
   Back in `answer_stream.py`, a second, independent runtime overlay —
   `_intent_resolution_runtime_overlay()` — handles *deictic* reference
   resolution ("this", "it", "the first problem") against `[Source 0]`
   (the visible-page block) and is unrelated to `AcademicIntent`; it is
   appended after `dialogue_overlay`.

6. **Frontend status labels** — `frontend/js/features/ai-chat/
   ai-thinking-status.ts` renders one of a small closed set of strings
   (`identifying_question`, `reading_question`, `writing_answer`,
   `checking_completeness`, …) sent as `{"status": "<key>"}` SSE events by
   `_status_sse()` in `answer_stream.py`. These keys are **pipeline-stage**
   labels, not a reflection of `AcademicIntent`/`TaskFamily` — the frontend
   never reads an intent/task field directly. This PR does not touch that
   contract.

## Where retrieval/vision/grounding is selected

`ExecutionPlan.groundingMode` (general / relevance / visible_page /
full_document / web) from step 1, refined again by `_context_strength`,
`effective_strength`, and the visual-assignment / figure-attachment checks
in `stream_answer()` (step 3) — vision attachment is a function of
`answer_mode` (math/strong) + figure-chunk presence + deictic/explicit-visual
wording, computed well after the router's plan, inside the generator.

## Integration point (this PR)

- **New module**: `app/services/student_intent.py` — `StudentIntent`
  dataclass + `interpret_student_intent()` deterministic adapter.
- **New flag**: `Settings.semantic_intent_mode` (`app/config.py`, env var
  `SEMANTIC_INTENT_MODE`), three states `"off"` (default) / `"shadow"` /
  `"enabled"` — same `Field(default, alias="ENV_VAR")` pydantic-settings
  convention as every other flag in that file (e.g.
  `writing_coach_persistence_enabled`), not a new flag system.
- **Call site**: `ask_stream_endpoint` in `stream.py`, immediately after
  `turn_resolution` (dialogue resolution, possibly semantically escalated)
  is finalized and immediately before `resolve_execution_plan(...)` is
  called (~line 1726). When the flag is `"off"`, this call is skipped
  entirely — not computed-and-discarded, literally not invoked — so the
  hot path performs zero extra work and the behavior is byte-for-byte
  identical to before this PR.
- **Router read point**: `resolve_execution_plan()` /
  `classify_task_profile()` (`execution_router.py`) each gain one new,
  optional, keyword-only parameter `student_intent: Any | None = None`
  (typed `Any` to avoid an import cycle, matching this file's own existing
  convention for `resolved_turn: Any | None = None`). When provided, its
  **only** effect is appending `"semantic_intent_available"` to the returned
  `ExecutionPlan.signals` tuple — an informational marker. It never changes
  `groundingMode`, `executionLane`, `complexity`, `confidence`, or `reason`.
  The router's authority is unchanged; this is strictly an additional,
  inert, optional signal it is free to read later.
- **Shadow mode**: when `semantic_intent_mode == "shadow"`, the computed
  `StudentIntent` is still passed through (so the inert signal above fires)
  but nothing about the actual response changes — the mode exists purely to
  produce the diagnostics log line below in production traffic before
  anything is allowed to affect behavior.
- **Diagnostics (shadow/enabled only, never "off")**: one `log.info` line —
  `interpretation_source`, `primary_task` (enum value), prohibited-task
  count, `needs_clarification`, `confidence`, latency — no message text, no
  document text, no student identifiers beyond what the existing request
  logging already carries.

## StudentIntent contract — invariants

Documented on the dataclass itself (`app/services/student_intent.py`); the
short version:

1. **Original message preserved.** `original_message` is the raw student
   text, untouched. `student_goal` is a paraphrase (reused from
   `DialogueResolution.resolved_request`); the two are never the same field.
2. **Prohibited tasks are not "cancelled" tasks.** `prohibited_tasks` is a
   separate tuple from `primary_task`. A negation never silently removes a
   task from consideration by omission — it is recorded explicitly so the
   prompt layer can say "do not do X" even when X isn't the primary task.
3. **Evidence boundary.** `interpret_student_intent()` has no parameter that
   accepts retrieved/course document text — by construction, not by
   discipline. It only ever sees the student's message and trusted
   conversation turns/UI metadata the router already trusts. This mirrors
   the existing `routing_chunks` separation in `answer_stream.py` noted
   above.
4. **Student instructions vs. trusted metadata.** `scope` comes from the
   router's own `ResolvedDocumentAccess` (computed from trusted viewer
   context), never re-derived from parsing the message for page numbers.
5. **Precedence on disagreement**: current message explicit wording >
   trusted UI/app metadata (what's actually open/selected) > older
   conversation history. Rationale: the student's current words are the
   freshest signal of intent; UI metadata is a hard fact about what's on
   screen right now; history can be stale (the student may have scrolled
   away, switched documents, or changed their mind since).
6. **No fabrication.** If a reference ("this problem", "that formula")
   cannot be resolved against an active exercise label or trusted visible
   context, `needs_clarification=True` — never a guessed resolution.

## PR 2 plan (not built in this PR)

- **Schema**: a small JSON schema mirroring `StudentIntent`'s fields
  (enum values as strings), returned via `response_format={"type":
  "json_object"}` the same way `resolve_dialogue_semantically()` already
  does — reuse that call shape rather than inventing a second one.
- **Model/cost**: cheapest available structured-output tier (mirrors
  `resolve_dialogue_semantically`'s use of `openai_generate_model` at
  `reasoning_effort="low"`), capped output tokens (~200), single
  `max_retries=1`.
- **Timeout**: reuse `INTERACTIVE_CLASSIFIER_TIMEOUT`
  (`openai_client.py`) rather than defining a second timeout constant.
- **Trigger conditions** (already stubbed as `_needs_semantic_path()` in
  this PR, always returning the heuristic signal but never calling a model):
  negation+conflicting instructions, multilingual/code-switched text,
  compound tasks, corrections ("no, I meant..."), ambiguous scope, low
  deterministic confidence (`< 0.7`).
- **Fail-closed contract**: malformed JSON, schema violation, or timeout →
  `interpretation_source="fallback"`, deterministic result kept, never a
  thrown exception up to the request handler — same shape as
  `resolve_dialogue_semantically`'s `except Exception` branch.
- **Offline eval harness**: a fixture file of (message, previous_turns,
  expected StudentIntent fields) tuples replayed against both the
  deterministic adapter and the semantic call in shadow mode, diffing
  agreement — lives in `tests/fixtures/` once PR 2 adds the model call,
  not before (no fixtures are needed to test a function that never calls
  out).
- **Where it plugs in**: `interpret_student_intent()`'s `_semantic_model_stub`
  function is the single seam — replacing its body with the real call is
  the entire PR 2 diff at the interpreter layer. No other file in this map
  needs to change shape again.
- **Deeper prompt wiring**: once trusted, thread `StudentIntent` into
  `pick_system_prompt()`/`intent_style_instruction()` as a second,
  cross-checked signal alongside `AcademicIntent` — not a replacement for
  it — probably by having `intent_style_instruction` accept an optional
  `student_intent` and use its `prohibited_tasks` as a second source of
  negation lines, falling back to its current regex-only behavior when
  absent (flag off or PR 1 only).
