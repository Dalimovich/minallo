# Python AI Test Fixtures

Fixtures in this directory support deterministic tests and live/manual evaluation of retrieval and answer quality.

## `math_eval_cases.json`

Source of truth for math/RAG evaluation cases.

The fixture covers:

- exact exercise references
- formula lookups
- solve-with-values tasks
- derivations
- proofs
- definitions
- non-math control prompts
- off-topic or missing-context behavior

## Case Schema

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable slug used by pytest and reports |
| `question` | yes | Prompt sent to the system |
| `category` | yes | Evaluation bucket |
| `expectedDetector` | no | Expected exercise-reference detector output, or `null` |
| `expectedSources` | no | Expected course/file/page references |
| `expectedBehavior` | yes | Human-readable grading rubric |
| `missingContextBehavior` | no | Expected behavior when context is absent |

## What Is Tested Automatically

`test_math_eval_fixture.py` checks:

1. Fixture shape is valid.
2. Categories are allowed.
3. Exercise detector expectations match.
4. Required category coverage has not been accidentally removed.

These tests do not call Supabase or OpenAI.

## Live Evaluation

Live answer quality evaluation requires a real course, real files, and a real access token.

Use:

```bash
cd backend/python-ai
python scripts/run_math_eval.py
```

See [../../scripts/README.md](../../scripts/README.md).

## Filling Real Course Data

1. Pick a representative course.
2. Replace `TODO_COURSE` with the real course ID.
3. Replace `TODO_*.pdf` with actual uploaded file names.
4. Adjust page ranges to the source PDFs.
5. Run the deterministic fixture tests.
6. Run the live eval if tuning retrieval or answer prompts.

Keep the fixture small enough to review manually, but broad enough to catch ranking regressions.

## `student_intent_eval_cases.json`

Offline evaluation corpus for the Semantic Student Intent Interpreter (see
`docs/semantic-intent-layer-map.md` and `app/services/student_intent.py`).

Covers: positive/negative/contradictory instructions, German/English/mixed-
language (code-switched) phrasing, follow-ups and corrections, diagram and
page references, quiz/hint/solve/explain/compare/summarize tasks, missing
context, and malformed-model-output/timeout fallback. Includes the
historical BWL page-6 request ("Explain the concept on this page in detail.
Do not summarize it.") that the whole initiative exists to fix. Two cases
are tagged `"knownGap": true` — documented, pre-existing limitations the
corpus surfaces rather than silently fixes (see their `expectedBehavior`
text): an answer-hiding quiz constraint the negation regex doesn't catch,
and a pre-existing `_DEICTIC_RE` false positive on "the second law" style
phrasing. Neither is in this PR's scope (tuning the deterministic trigger
heuristics vs. adding the model call).

### Case Schema

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable slug used by pytest |
| `category` | yes | Evaluation bucket (19 required, see the test file's `_ALLOWED_CATEGORIES`) |
| `message` | yes | The student's message |
| `previousTurns` | no | `[{"role", "text"}, ...]`, default `[]` |
| `resolvedAccess` | yes | `"relevance"` \| `"visible_page"` \| `"full_document"` |
| `hasVisibleContext` | no | Trusted viewer/open-file signal, default `false` |
| `expectedPrimaryTask` | yes | `AcademicIntent` value the deterministic adapter must produce |
| `expectedProhibitedTasks` | yes | List of `AcademicIntent` values, in order |
| `expectedNeedsClarification` | yes | Expected no-fabrication outcome |
| `expectedEscalates` | yes | Expected `_needs_semantic_path` result |
| `simulateModelFailure` | no | `null` \| `"malformed"` \| `"timeout"` — only meaningful when `expectedEscalates: true` |
| `knownGap` | no | `true` marks a documented, not-fixed-here limitation |
| `expectedBehavior` | yes | Human-readable rubric |

### What Is Tested Automatically

`test_student_intent_eval_fixture.py` checks, with **zero model calls**:

1. Fixture shape is valid; every required category is still covered.
2. The deterministic adapter's classification matches `expectedPrimaryTask`/`expectedProhibitedTasks`/`expectedNeedsClarification`.
3. `_needs_semantic_path`'s escalation decision matches `expectedEscalates`.
4. For every escalating case, the semantic call is monkeypatched to fail (per `simulateModelFailure`) or decline, and the result must fail closed to `interpretation_source="fallback"` with the SAME fields as the deterministic case — never a propagated exception, never silently different fields.
5. The resulting `StudentIntent` is accepted by `execution_router.resolve_execution_plan` and serializes via `ExecutionPlan.to_api()` without raising.

### Live Evaluation (not yet wired up)

Evaluating whether the REAL model's judgment agrees with `expectedPrimaryTask`
when actually invoked needs a configured OpenAI key and separate
authorization for paid calls. No script does this yet — add
`scripts/run_student_intent_eval.py` mirroring `scripts/run_math_eval.py`'s
shape (load this fixture, call `interpret_student_intent` with
`mode="shadow"` against the real client, diff against `expectedPrimaryTask`)
once that authorization is given.
