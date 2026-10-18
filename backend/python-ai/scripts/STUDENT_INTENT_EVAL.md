# Live student-intent evaluation

Run manually from `backend/python-ai`, with its Python development environment:

```powershell
python -m pytest tests/test_student_intent_live_runner.py tests/test_student_intent.py tests/test_student_intent_eval_fixture.py tests/test_execution_router.py tests/test_answer_intent.py tests/test_dialogue_state.py -q
python -m ruff check scripts/run_student_intent_eval.py tests/test_student_intent_live_runner.py app/services/student_intent.py
python -m pyright scripts/run_student_intent_eval.py tests/test_student_intent_live_runner.py app/services/student_intent.py
python -m scripts.run_student_intent_eval --live --env-file PATH_TO_LOCAL_ENV --output reports/student-intent-2026-10-17.json
```

The last command costs money: execute only with authorization. Do not add it to
CI. The program rejects CI, requires `--live`, and refuses existing report or
ledger paths. Do not bypass the ledger by choosing another filename to rerun an
authorized allocation. Interrupted runs require manual review of the ledger
before any newly authorized run. Concurrent invocations are not supported.

Only `OPENAI_API_KEY` and `OPENAI_GENERATE_MODEL` are read from the supplied env
file; environment variables take precedence. The production client factory is
used with instrumented HTTP transport. The production prompt, JSON-mode request,
validation, confidence threshold, timeout and one SDK retry remain unchanged.
Usage database writes are intercepted locally. No documents or student data are
read; all inputs come from the checked-in synthetic corpus. No answer generation,
embeddings, dialogue-model calls, deployments or feature-flag changes occur.

## Budget

Pricing checked 2026-10-17 at
https://developers.openai.com/api/docs/models/gpt-4o-mini:
$0.15/M input tokens, $0.60/M output tokens; 128,000-token context window.
Only `gpt-4o-mini` and its `2024-07-18` snapshot are approved by this runner.
Review pricing before any future run. The configured model is never substituted.
Production caps this model's output at 180 tokens. The reservation uses the full
128,000-token input window plus 180 output tokens (deliberately overcounting the
shared context): $0.019308 per HTTP attempt, $0.77232 for all 40 allowed attempts.
Each attempt, including SDK retries, is reserved and fsynced BEFORE transmission.
Failed/unknown attempts retain their entire reservation. The transport rejects
other endpoints, generation token limits, tools, streams and unknown parameters.
Actual cost estimates use uncached input pricing, conservatively ignoring cache
discounts; provider billing remains the authoritative invoice.

## Method and interpretation

All 23 fixture entries run. The two `simulateModelFailure` entries are injected
offline rather than wasting paid calls on duplicates that cannot reliably cause
real provider failures. They are excluded from model accuracy and live latency.
For each of the other 21 entries (including both known gaps), invoke the actual
production `_semantic_model_call` once. This directly measures classification
even when the unchanged production gate would skip it. Reuse that exact result
through `interpret_student_intent` in enabled and shadow modes, without more
network calls. Direct-model cost is NOT a measurement of gated production cost.

Compare expected labels, deterministic baseline, validated model result, effective
gated result and serialized execution plans. Scope/reference preservation is a
comparison against supplied trusted synthetic context, not a test of upstream
PDF/page-resolution correctness. Shadow payload equality means the serialized
`ExecutionPlan.to_api()` payload at the router seam; a full answer SSE stream is
not generated. Enabled mode currently adds only `semantic_intent_available`;
there is no evidence of improved student-facing answers.

Existing primary/prohibition/clarification fixture labels are retained verbatim.
They describe baseline behavior and are NOT independently adjudicated semantic
ground truth (e.g. Newton-law explanations labeled application reasoning).
Depth labels are declared before calls in `expected()`: detailed for both BWL
requests, brief for summaries/code-switch/follow-up, one_step for hints, otherwise
normal. The solve case retains the fixture's documented normal-depth expectation.
Only the diagram case explicitly requests a visual. Known-gap labels encode
existing defects; the runner marks those cases failed even if fixture labels match.
The answer-hiding constraint has no field in the current schema.

Prohibition recall/precision are micro-averaged sets; accuracy denominators are
21 non-injected cases including known gaps. Successful structured-output rate
means production validation succeeded (a low-confidence valid response counts).
Fallback rate and escalation frequency refer to the effective gated lane.
Latency is wall time around each direct model invocation, including SDK retries;
p95 uses nearest rank. Per-attempt latency and usage are also retained. These are
initial diagnostic measurements, not representative estimates of production quality.

JSON contains all per-case fields and raw synthetic model responses, plus totals.
The adjacent Markdown gives a quick summary. Review every mismatch before
attributing it to the model: fixture issues, confidence rejection, merge losses,
missed escalation and unresolved trusted references are distinct causes.

## PR3 adjudication (2026-10-18)

Independent review of all 23 fixture entries, as required before PR3's typed
answer-constraint policy and `_DEICTIC_RE` fix could be considered complete.
The `reports/student-intent-2026-10-17*` files above are the historical
baseline from the live evaluation that first surfaced these issues — **not
edited by this adjudication**; they remain the record of what the real model
and the pre-PR3 code actually did on that date. Only the fixture
(`tests/fixtures/student_intent_eval_cases.json`) itself was updated, where
justified below.

**Real student-facing failures, now fixed by this PR:**

- `quiz-answer-hiding-known-gap` — "do not show me the answers yet" previously
  reached no typed field at all (`knownGap: true`). Fixed: the new
  deterministic `_WITHHOLD_ANSWER_RE` sets `answer_constraints.withhold_answer
  =True`, independent of `prohibited_tasks`/`NEGATED_QUIZ_RE` (this is "quiz me
  but hide the answer", not "do not quiz me" — verified not to cross-fire with
  either). `_needs_semantic_path` escalation is unchanged (still false) — that
  is a separate, pre-existing heuristic-tuning question, not touched here.
  Fixture updated: `expectedAnswerConstraints: {"withholdAnswer": true}`,
  `knownGap` removed.
- `ordinal-deictic-false-positive-known-gap` — "the second law of
  thermodynamics" was flagged as an unresolved back-reference
  (`needs_clarification=True`) for a fully self-contained question. Fixed: a
  narrow negative-lookahead exclusion on `_DEICTIC_RE`'s ordinal branch (named
  concept nouns — law/theorem/postulate/principle/rule/equation/formula/
  axiom/derivative/integral + plurals), verified not to affect the sibling
  `missing-context-deictic`/`missing-context-resolved-via-visible-context`
  cases (bare "this"/"that" references, and "the second problem/question/one"
  phrasing, still correctly flagged). Fixture updated:
  `expectedNeedsClarification: false`, `knownGap` removed. Id intentionally
  left unchanged (same message, same case — only the previously-buggy
  observed behavior changed; relabeling the id itself would not be justified
  by a behavior fix).

**Incidental improvement, not a gap fix:**

- `hint-request` — "Can I get a hint for exercise 4.2?" already correctly set
  `depth="one_step"`. Now also sets `answer_constraints.hint_only=True` (reuses
  `dialogue_state.wants_hint_only`, the same detection the depth field already
  relied on) — this is the same underlying signal gaining a second, explicit
  typed representation, not a new detection. Fixture updated:
  `expectedAnswerConstraints: {"hintOnly": true}`.

**Ambiguous taxonomy, reviewed and NOT changed (out of this PR's scope):**

- `explain-request` ("Explain Newton's third law of motion.") and
  `negative-instruction-quiz` ("Explain Newton's third law. Do not quiz me on
  it.") both classify as `case_or_application_reasoning` rather than
  `definition_or_theorem` or `conceptual_explanation`, which would arguably fit
  "explain this law" phrasing at least as well. This is `classify_academic_
  intent`'s existing regex-priority behavior in `answer_intent.py` — a
  deterministic-routing question entirely orthogonal to PR3 (typed answer
  constraints + wiring them into generation). Changing it would mean editing
  the core intent classifier, a materially larger and unrelated surface, with
  its own regression risk across every other caller of `classify_academic_
  intent`. Left as-is; flagged here for a future, separate taxonomy-tuning
  pass, per "do not relabel cases simply to improve reported accuracy."

**All remaining 18 cases** (`historical-bwl-page6`, `positive-summary-request`,
`summarize-task`, `contradictory-instruction`, `german-negative-instruction`,
`english-plain-question`, `mixed-language-code-switch`, `follow-up-why`,
`correction`, `malformed-model-output`, `timeout`, `diagram-reference`,
`page-reference`, `quiz-request`, `solve-request`, `compare-request`,
`missing-context-deictic`, `missing-context-resolved-via-visible-context`)
were reviewed against their existing `expectedBehavior` rubric and found
correctly labeled; no changes.
