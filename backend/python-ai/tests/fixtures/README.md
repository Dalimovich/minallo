# Math evaluation fixture

Phase 3 of the AI/RAG plan. This is the source of truth for tuning Phase 7
(query expansion), Phase 8 (ranking constants), Phase 9 (math answer
format), and Phase 10 (verification status). Don't change those phases
without re-running the fixture.

## File

`math_eval_cases.json` — 15 cases covering exact exercise references
(German + English), formula lookups, solve-with-values, derivation,
proof, definition lookups, missing-context, and non-math control cases.

## Case schema

| Field                    | Required | Meaning |
|--------------------------|----------|---------|
| `id`                     | yes      | Stable slug. Used as the pytest parametrize id. |
| `question`               | yes      | The exact question text fed to the system. |
| `category`               | yes      | One of: `exact_exercise_reference`, `formula_lookup`, `solve_with_values`, `derivation`, `proof`, `definition`, `non_math`, `off_topic`. |
| `expectedDetector`       | no       | When set, the Phase 6 `find_exercise_reference` detector must return `{exerciseNumber, subpart}`. `null` means it must NOT match. |
| `expectedSources`        | no       | `{courseId, fileName, pages: [start, end]}` — placeholders prefixed with `TODO_` need real course-team values before live eval. |
| `expectedBehavior`       | yes      | Plain-English description of the correct answer behavior. Read by humans when grading. |
| `missingContextBehavior` | no       | What the system should say if no matching context is found. |

## What's wired up

- `test_math_eval_fixture.py` — runs three deterministic checks against
  every case today:
  1. Fixture shape is valid (required fields present, category in allowed
     enum).
  2. Cases with `expectedDetector` match the Phase 6 detector exactly;
     cases with `expectedDetector: null` must NOT match.
  3. The category set covers all eight buckets above (regression guard
     against accidental fixture pruning).

## What's deliberately deferred

- Live end-to-end eval against Supabase + OpenAI. Needs real course IDs
  and review credit. Run separately when tuning Phase 8 constants.
- Automatic grading of free-form answers. Until then, `expectedBehavior`
  is a human-grading rubric, not a machine check.

## How to fill in real course data

1. Pick the course the eval will represent.
2. Replace every `TODO_COURSE` with that course's `course_id`.
3. Replace `TODO_*.pdf` with the matching `file_name`s.
4. Adjust `pages` to actual page numbers.
5. Re-run `pytest tests/test_math_eval_fixture.py`. All cases still pass
   (the placeholders aren't validated against the DB — only the
   detector behavior is).
