# Staged retrieval early-termination — design proposal (not implemented)

Status: **proposal only**. No production code changed. This is Phase 2D /
Phase 4-deferred from the AI-pipeline routing audit (`audit/ai-pipeline-routing`).
Whether to build this, and when, is a product decision, not something this
proposal resolves on its own.

## The confirmed waste

`retrieve_routed_chunks()` (`app/services/retrieval.py:790`) runs every stage
in `plan.source_stages` (3–5 stages depending on academic intent, built by
`_stages()` in `app/services/question_routing.py:137`) unconditionally, and
for each stage calls `retrieve_chunks` up to 3 times (with `chunk_types`
filter → without it → a course-wide topic fallback). `evidence_is_sufficient`
is computed after every stage into `stage_trace`, but that value is **only
logged, never used to `break`**. A 5-stage plan can issue up to 15 retrieval
calls even when the first stage already had everything needed.

## Why the obvious fix is unsafe (already proven, not assumed)

The existing `evidence_is_sufficient(plan, chunks)` is a **question-level**
heuristic — it looks at the union of all chunk types collected so far and
asks "does this look like enough evidence for this kind of question," e.g.
for a calculation: `has_problem and has_method and has_units`. Reproduced
directly against real code: a course-topic-matched `exercise_sheet` chunk
for a calculation question can satisfy `has_method`/`has_units` purely from
the exercise's own "given" values (a unit and an `=` sign in the raw
problem text) — before the solution method, worked example, or formula
stages have run at all. Gating early-stop on this signal would silently
skip stages 2–4 for exactly the case the original audit brief calls out
("calculations... may genuinely require several distinct evidence types")
and already breaks `test_calculation_reserves_one_candidate_from_every_evidence_stage`
(`tests/test_question_routing.py:74`), which exists specifically to pin
that every stage contributes to the final chunk set for a calculation
question.

## What a safe criterion would need to look like

The stages themselves already carry the right granularity to do this
properly — `_stages()` builds a fixed, ordered list of
`(document_types, chunk_types, purpose)` per academic intent (see the table
below). A stage is a candidate for skipping only when **both**:

1. **This stage's own `chunk_types`** are already represented among the
   chunks already collected from an *earlier* stage for *this request*
   (not a cross-question heuristic) — e.g. stage 2 of the calculation plan
   wants `{"solution_step", "worked_example"}`; skip it only if a chunk with
   one of those exact types is already in `collected`, not just "some
   evidence exists."
2. **The academic intent's overall required-evidence list**
   (`QuestionRoutingPlan.required_elements`, already computed in
   `build_question_routing_plan`) has no outstanding item that only this
   stage's `purpose` can satisfy. `required_elements` for a calculation is
   `["exact question identity", "givens", "required quantity", "formula",
   "solution method", "units"]` — each stage's `purpose` string
   (`"exact problem and givens"`, `"official or worked solution"`,
   `"method explanation"`, `"formula and notation"`) maps roughly 1:1 to
   one or more of those. A stage whose purpose nobody else has covered
   yet must never be skipped, regardless of (1).

Concretely this means the check becomes **"is this exact stage's evidence
type already satisfied by an earlier stage,"** not "does the combined
evidence look sufficient" — the current `evidence_is_sufficient` function
stays exactly as-is for its current use (overall plan completion / tracing)
and is NOT reused as the early-stop gate.

### Stage-purpose map (current `_stages()`, for reference)

| Academic intent | Stages (doc types → chunk types, purpose) |
|---|---|
| EXAM_PREPARATION | exam→exercise_question (exact wording) · solution_sheet→solution_step/worked_example (official solution) · lecture→definition/general_explanation (terminology) · formula_sheet→formula (allowed formulas) · exercise_sheet→exercise_question/worked_example (practice) |
| CALCULATION / EXERCISE_SOLUTION | exercise_sheet/exam→exercise_question (problem+givens) · solution_sheet→solution_step/worked_example (official/worked solution) · lecture→worked_example/derivation/general_explanation (method) · formula_sheet→formula (formula+notation) |
| FORMULA_LOOKUP (no EXPLANATION) | formula_sheet→formula (authoritative) · lecture→formula/definition/derivation (meaning) · solution_sheet→solution_step/worked_example (in use) · exercise_sheet→exercise_question (application) |
| EXPLANATION / DERIVATION | lecture→definition/general_explanation/derivation/diagram/table · professor_notes→definition/general_explanation/diagram · solution_sheet→worked_example/solution_step · exercise_sheet→exercise_question/worked_example · formula_sheet→formula |
| default (definition/list/etc.) | lecture→definition/classification/general_explanation/advantage_list/comparison/diagram · professor_notes→definition/general_explanation · formula_sheet→formula/classification · solution_sheet→worked_example/solution_step · exercise_sheet→exercise_question |

## Request types that must always collect from every stage, regardless of any sufficiency signal

- **Calculations** (`AcademicIntent.CALCULATION`/`EXERCISE_SOLUTION`): the
  existing test already pins this — problem+givens, solution method, and
  formula/notation are three *distinct* evidence types a single chunk can't
  substitute for each other.
- **Multi-document / cross-document comparisons** and **full-coverage
  requests** (`resolved_access is ResolvedDocumentAccess.FULL_DOCUMENT`,
  or an explicit multi-file selection per item E's fix): by definition these
  need evidence from more than one source; an early-stop tuned for "found
  one good chunk" is the wrong shape of optimization for this class
  entirely and should be excluded from any early-stop path outright, not
  just handled carefully.
- **EXAM_PREPARATION**: the "official exam solution" stage specifically
  must never be skipped in favor of a cheaper lecture/formula stage
  surfacing first — precedence here is a correctness property (item E/H's
  territory: official-solution vs. ordinary-worked-answer), not just a
  latency one.

## How to benchmark a reduction without sacrificing correctness

1. **Instrument first, change nothing**: log, per request, the stage
   index at which each `chunk_type` actually needed by
   `required_elements` first appeared in `collected`. This requires zero
   behavior change and directly answers "how many of the later stages ever
   contributed anything new" from real traffic, not synthetic guesses.
2. Only after that data exists, implement the per-stage/per-chunk-type skip
   described above, gated behind a flag (e.g.
   `RETRIEVAL_STAGE_EARLY_STOP_ENABLED`, default off) — matching this
   project's existing pattern for Milestone-4-style experimental gates.
3. Compare, on the same request set, both **retrieval-call count** (the
   cost metric) and **final chunk-set equality** (the correctness metric:
   the skip-enabled run's final `collected` set must be a superset-or-equal
   match against the baseline run's set of `chunk_type`s per request, not
   merely "the answer still looked fine").
4. Roll out only on intents other than CALCULATION/EXERCISE_SOLUTION and
   full-coverage requests first (the ones proven above to be safe to skip
   when a chunk_type is already covered), with calculation-class requests
   kept on the current unconditional-all-stages behavior until there's a
   separate, explicit decision to extend it there.

## Tests that must exist and pass before anyone implements this

- A parametrized regression over every row in the stage-purpose table above:
  for each academic intent, assert that collecting from only the first
  stage never satisfies all of `required_elements`, so the optimization's
  "is this chunk_type already covered" check is meaningfully exercised
  (not vacuously true because the first stage already covers everything).
- `test_calculation_reserves_one_candidate_from_every_evidence_stage` must
  continue to pass unmodified.
- A new test proving the *opposite* case the existing test doesn't cover:
  a calculation question where stage 1's chunk already happens to satisfy
  `evidence_is_sufficient`'s question-level heuristic, asserting stages 2–4
  **still run** under the new per-stage criterion (this is the exact
  regression this proposal exists to prevent).
- A new test for a genuinely redundant case: a definition/explanation
  question where an early lecture-stage chunk's `chunk_type` already
  matches a later stage's `chunk_types`, asserting that later, truly
  redundant stage is skipped and the retrieval-call count drops.
- The full-coverage / multi-document exclusion must have its own explicit
  test asserting early-stop is inert for those request shapes regardless
  of how much evidence a single stage returns.

## Explicit non-decision

This proposal does not recommend a target percentage reduction or a
timeline. Whether the latency/cost savings justify the added complexity of
a second, finer-grained sufficiency concept living alongside the existing
one is the product call this document is deferring.
