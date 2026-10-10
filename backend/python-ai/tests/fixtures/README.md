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
