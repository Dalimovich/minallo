# PR 2 semantic intent evaluation — 2026-10-17

**Recommendation: keep production off. Do not treat PR 2 as an answer-quality improvement.**
The historical regression fails constraint preservation in the evaluated commit.
The interpreter is diagnostic only, including enabled mode. Fix merging and
constraint representation, adjudicate the corpus, then separately implement and
test authoritative consumption before any rollout.

Evaluated application: `2f8f2400` on `feature/semantic-intent-model`, explicitly
selected by the user after concurrent uncommitted review edits were discovered.
All paid calls ran in an isolated checkout with unchanged application source.
Runner at execution: `62b4d512`. No later review fixes were evaluated.
Configured model: `gpt-4o-mini`; returned snapshot: `gpt-4o-mini-2024-07-18`.

## Measurements

23 corpus entries: 21 distinct live interpretation cases, including both known
gaps; two duplicate synthetic failure-injection cases exercised offline.
Each live case was called exactly once. The same validated result was replayed
through the production escalation/merge/router path in shadow and enabled modes.

| Metric | Direct production model call | Effective production gate |
|---|---:|---:|
| Primary-task fixture agreement | 12/21 (57.14%) | 19/21 (90.48%) |
| Exact prohibition-set agreement | 19/21 (90.48%) | 20/21 (95.24%) |
| Prohibition recall | 2/4 (50%) | 3/4 (75%) |
| Prohibition precision | 2/2 (100%) | 3/3 (100%) |
| Depth agreement | 18/21 (85.71%) | 19/21 (90.48%) |
| Visual requirement agreement | 20/21 (95.24%) | 21/21 (100%) |
| All six fixture fields agree | 9/21 | 16/21 |
| Production validation succeeds | 20/21 (95.24%) | — |
| Semantic escalation | forced for measurement | 6/21 (28.57%) |
| Fallback | — | 1/21 (4.76%) |

The invalid direct model output counts as a failed interpretation for every field;
its inherited scope is not evidence of a scope mutation. **Effective trusted
scope/reference preservation: 23/23 (100%)**. On the four cases with explicit
task prohibitions, the effective merge preserves three; 22/23 cases preserve all
baseline prohibitions when empty-prohibition cases are included.

Both known gaps match their baseline-oriented fixture fields but remain product
failures. Excluding injected failures, 14/21 pass all effective fields and the
known-gap check. These are fixture-agreement metrics, not independently validated
semantic accuracy or statistically representative production-quality estimates.

| Resource | Observed |
|---|---:|
| Model invocations / HTTP attempts | 21 / 21 |
| SDK retries / auxiliary model calls / answer-generation calls | 0 / 0 / 0 |
| Input / output tokens | 10,725 / 1,080 |
| Total tokens | 11,805 |
| Cached / reasoning tokens | 0 / 0 |
| Estimated API cost | **$0.00225675** |
| Unknown usage attempts | 0 |
| Mean / median / nearest-rank p95 latency | 1,166 / 947 / 1,357 ms |
| Sum of model-call wall times | 24.494 s |
| Maximum observed latency | 4,317 ms |

Prices: $0.15/M input and $0.60/M output, checked against
[official model documentation](https://developers.openai.com/api/docs/models/gpt-4o-mini).
The conservative pre-call reservation was $0.019308 per attempt (full 128k input
context plus 180 output tokens), $0.405468 reserved for 21 attempts. Even 40
attempts would reserve $0.77232, below the $5 authorization. No reruns occurred.
One initial startup failed on a missing synthetic required setting, before any
client creation, ledger creation or request; it incurred zero API expenditure.

## Historical BWL case

Exact message: **“Explain the concept on this page in detail. Do not summarize it.”**

Expected: conceptual explanation, detailed, prohibit `course_summary`, trusted
visible-page scope. Deterministic baseline recorded the prohibition correctly.
The model returned conceptual explanation/detailed, **empty prohibitedTasks**, and
confidence **0.95**. Production replaced the baseline prohibition list with that
empty list. This is both **incorrect semantic interpretation** and
**deterministic/semantic merge lost information**. Scope remained `visible_page`;
references stayed empty, and no PDF/page number was invented. The German
equivalent passed, including its prohibition.

## Failure review (labels unchanged)

This table covers every model/effective mismatch and known gap. Unlisted cases
pass both measured interpretations. More than one cause can apply.

| Case | Observed result and adjudication | Cause category |
|---|---|---|
| historical-bwl-page6 | Empty prohibition list despite explicit negative instruction; effective merge loses baseline constraint. | Incorrect semantic interpretation; deterministic/semantic merge lost information |
| negative-instruction-quiz | Model/effective chooses conceptual explanation; fixture says application reasoning for “Explain Newton's third law.” Quiz prohibition preserved. Conceptual explanation is defensible; clarification on trailing “it” is also a baseline false positive. | Evaluation fixture issue; trusted context/reference resolution issue |
| positive-summary-request | Direct model correctly chooses brief; gate skips it and effective depth remains normal. | Escalation heuristic did not trigger |
| summarize-task | Same brevity loss for German “kurz”. | Escalation heuristic did not trigger |
| contradictory-instruction | Raw JSON sets course_summary as BOTH primary and prohibited, confidence 0.9. Production rejects it; fallback preserves prohibition and clarification. | Contradictory instructions; invalid structured output |
| english-plain-question | Model chooses formula_extraction for “What is the formula for torsion?”; fixture says definition_or_theorem. Effective baseline matches fixture. Requires human taxonomy adjudication, not automatic relabeling. | Evaluation fixture issue |
| follow-up-why | Model chooses normal rather than fixture's brief. Request does not explicitly demand brevity; fixture reflects prior dialogue behavior. Effective baseline retains brief. | Evaluation fixture issue (depth policy ambiguity) |
| correction | Model/effective chooses answer_correction_or_grading for “No, that's wrong.” Fixture says general_course_qa. Model choice is more specific and defensible. | Evaluation fixture issue |
| timeout (injected) | Fallback executes correctly, but baseline normal depth does not honor the code-switch request's “kurz”. No paid timeout occurred. | Timeout or API error (injected); baseline depth limitation |
| diagram-reference | Model chooses conceptual explanation for a drawing request; fixture says general_course_qa. Both retain visualRequirement=true; enum lacks a drawing task. Effective baseline matches fixture. | Evaluation fixture issue (taxonomy ambiguity) |
| page-reference | Model chooses source_finding for “What does it say on page 6?”; fixture says general_course_qa. Trusted scope remains unchanged. | Evaluation fixture issue (taxonomy ambiguity) |
| hint-request | Model chooses math_problem vs fixture's general_course_qa; both use one_step. Exercise content is unknown, so the math assumption needs adjudication. | Incorrect semantic interpretation / evaluation fixture issue |
| solve-request | Model chooses detailed for “show all steps”; fixture prose specifies normal. Both choose math_problem. Model depth is defensible. | Evaluation fixture issue |
| explain-request | Model chooses conceptual_explanation for Newton's law vs application reasoning in fixture. Effective baseline matches fixture. | Evaluation fixture issue |
| quiz-answer-hiding-known-gap | Direct model and effective result lack an answer-hiding field. No production escalation. | Escalation heuristic did not trigger; schema cannot represent the constraint |
| ordinal-deictic-false-positive-known-gap | “The second law” incorrectly leaves references_unresolved and needs_clarification true. Model chooses conceptual explanation, unlike fixture, but cannot alter those trusted-derived fields. | Trusted context/reference resolution issue; escalation heuristic did not trigger; evaluation fixture issue |

No correct result was rejected by the confidence threshold; accepted results had
confidence 0.9–1.0. No live transport errors, timeouts, retries or truncations were
observed. Malformed-output injection correctly falls back; the live contradiction
also independently exercises the validation/fallback path.

## Both known gaps, separately

1. **Quiz answer hiding: unresolved.** Production does not escalate; a forced
   direct model call still cannot represent the constraint in this schema.
   Widening the trigger alone cannot fix this. Add an explicit answer-release or
   hint/solution policy and test its consumption by generation.
2. **Ordinal deictic false positive: unresolved.** Production does not escalate,
   and even a forced model call preserves the incorrect clarification flag by
   design. Tighten deterministic reference resolution with negative controls such
   as “the second law,” rather than asking an untrusted model to invent context.

## Implementation and integration assessment

- Default `SEMANTIC_INTENT_MODE=off` confirmed in Settings and deterministic tests.
- Shadow forwards no intent. Serialized execution-plan payloads are identical to
  off for all 23 cases; trusted fields are preserved for all 23. The production
  stream wiring uses that helper. This is a router/payload seam test, **not a full
  generated SSE transcript test**. Shadow still adds latency and usage logging.
- Enabled forwards the object but adds only `semantic_intent_available`. All 23
  plans are otherwise unchanged. Existing execution routing remains authoritative;
  no semantic task/depth/prohibition is consumed for prompt selection here.
- Production client factory, configured model, prompt and runtime validation are
  reused. The API uses JSON-object mode with application validation, not a strict
  server-side JSON schema. Current-model output cap is 180 tokens; reasoning
  models would receive a 12,000-token floor from the existing helper, which is why
  the runner rejects unpriced models.
- Timeout is 7-second read / 3-second connect / 2-second pool, with one SDK retry.
  These are bounded per-phase timeouts, not a strict total wall-clock deadline.
- Classifier payload contains current student message, synthetic recent turns and
  prior resolved request. It receives no document text or UI scope metadata.
  Trusted scope/reference fields remain inherited. The corpus covers relevance
  and visible-page scope but has **no full-document case**; this live pass makes
  no claim of broad document-scope coverage.
- No production deployment, feature-flag edit, database access by the live runner,
  full-answer model invocation or unrelated application change was made.

**Trigger adequacy: insufficient.** It escalates negative summary/quiz constraints
and corrections, but misses explicit brevity and both known gaps. Code-switch
matching also conflates German diacritics with mixed-language input. Prioritize
constraint representation and safe merging before widening triggers and costs.
Do not infer that 90.48% effective fixture agreement is better semantic accuracy
than 57.14% direct agreement: the fixtures are largely baseline regression labels.

Next implementation step: union independently detected prohibitions with validated
model prohibitions, reject primary/prohibition conflicts, add answer-hiding and
solution-release constraints, and independently adjudicate expected task/depth
labels. Then implement explicit, tested consumption by the existing router/prompt
builder. Re-evaluate that revision only under a new explicit run authorization.

## Verification and artifacts

Before paid calls: 442 focused deterministic tests passed; scoped Ruff and Pyright
passed. Full-project baseline scans found 43 unrelated Ruff findings and two
Pyright errors in `german_exam_media_tasks.py:49`; no unrelated fixes were made.
The entire repository suite was not run; checks covered interpreter, fixtures,
runner safety, execution router, answer intent and dialogue state.

- `student-intent-2026-10-17.json`: expected/actual per-case fields, confidence,
  sources, latency, usage, costs, raw responses and serialized integration plans.
- `student-intent-2026-10-17.md`: generated aggregate metrics and case summary.
- `student-intent-2026-10-17.ledger.jsonl`: durable pre-call reservations.
- `../scripts/STUDENT_INTENT_EVAL.md`: method, limits and reproduction command.

Post-run reporting edits clarify provenance/failure annotation and protect settings
errors from printing credentials. They do not change observed responses, labels,
metrics or application code, and no paid calls were repeated.
