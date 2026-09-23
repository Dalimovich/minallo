# Phase 7 — Content Qualification Harness

## What was built
`backend/python-ai/scripts/qa_correctness_harness.py` — a new, generic (any profile/module/part)
harness extending the `qa_testdaf_live.py`/`qa_budget.py` pattern. Reuses `QaBudget`,
`add_budget_args`, `labeled_usage` unchanged. For every sample it reports five independent
PASS/FAIL layers instead of one status:

| Layer | What it checks | How, in `--dry-run` | How, in `--execute` |
|---|---|---|---|
| STRUCTURE | deterministic validator accepts the content | Runs the REAL `german_exam_validator.validate_content`/`hard_issues` against mock content — real check, zero network | Same real validator, against real generated content |
| CONTENT | semantic verification accepts the content | **Mocked** — `{"passed": True, "mocked": True}`, clearly labelled `contentMocked: true` in every record | Real `verify_semantic_full` (an LLM call) |
| ANSWER_KEY | every `answerId` resolves to a real option of its own question; no leaked `answer`/`modelAnswer` on productive content | Real, pure-Python check against mock content | Real check against real content |
| GRADING | a production grading route actually exists for this part today | Static table derived from reading `routers/german_exam.py` (see `GRADING_AUDIT.md`) — same in both modes | Same |
| DELIVERY | task type is registered `True` in `german_exams/task_types.py` | Same real registry lookup in both modes | Same |

`--dry-run` is the default and makes **zero** provider/network calls — proven by a unit test that
monkeypatches `_execute_generate` to raise `AssertionError` if ever called, and asserts it never
is. `--execute` requires both `--execute` and a second, explicit `--confirm-execute` flag (defence
in depth beyond `qa_testdaf_live.py`'s single flag) and was **never invoked against a real
provider** in this task — proven by a unit test that asserts the code path stops before
`_execute_generate` is reached without `--confirm-execute`, even when `--execute` alone is passed.

## Budget enforcement
Identical to `qa_testdaf_live.py`: `budget.guard_new_sample()` is called immediately before every
sample; `QaBudget`'s own constructor refuses to build without both `--max-cost-usd`/`--max-samples`
and refuses values above the hard safe ceiling ($0.25 / 1 sample) — unchanged, not modified by this
phase.

## Known limitation (stated honestly, not fixed in this pass)
`--dry-run`'s mock content only covers two generic shapes (selection-style and productive-style).
Several task types (e.g. `speaker_statement_matching`'s `segments` array, media tasks' `media`
object) have a more specific real shape the generic mock doesn't reproduce — so STRUCTURE can
honestly FAIL in dry-run for those task types even though the real generator is fine. Confirmed by
a smoke run against TELC `hv1` (`speaker_statement_matching`): STRUCTURE correctly reported `false`
because the mock's generic `questions` array isn't that task type's real `segments` shape — the
harness surfaced this truthfully rather than masking it. Building per-task-type-accurate mocks for
all ~24 task types was judged out of scope for this documentation-focused audit; dry-run's proven
value here is the pipeline (budget circuit-breaker, five-layer reporting, record-writing) working
end to end with zero calls, not blanket STRUCTURE certification via a generic mock.

## Divergent existing pattern found (Phase 0/7 cross-reference)
`scripts/qa_goethe_live.py` predates `qa_budget.py`'s adoption for TestDaF: it enforces its own
inline `spent_usd >= max_cost_usd` check rather than using `QaBudget`, and has **no `--dry-run`
mode** at all. Not modified in this pass (out of scope — this audit builds a new harness rather
than refactoring an existing live-capable script, per the task's "never execute --execute yourself"
constraint applying equally to touching a script that could accidentally run for real). Flagged for
whoever next touches Goethe's live-QA tooling.

## Tests added
`backend/python-ai/tests/test_qa_correctness_harness.py` — 14 tests, all passing, zero real
provider calls (verified: `_execute_generate` is monkeypatched to raise in every test that could
reach it). Covers: dry-run makes no provider call; answer-key detection of a broken `answerId` and
of a leaked `modelAnswer`; answer-key never assumes PASS on an unrecognised shape; grading
reachability matches the Phase-5-derived static table exactly (TELC writing/speaking reachable,
Goethe/TestDaF not); delivery mirrors the real `task_types.py` registry; structure runs the real
validator (not a fabricated verdict); structure never crashes on malformed content; a full CLI
dry-run run writes a summary with `spentUsd: 0.0` and `releaseGatePassed: false`; the budget
circuit-breaker raises before a second sample once `max_samples=1` is spent; `--execute` without
`--confirm-execute` raises `SystemExit` before reaching the real generator, proven directly.

Full backend suite after this phase: **2493 passed, 10 skipped, 0 failed** (up from 2479 passed
before this phase — the +14 is exactly this new test file; no regression elsewhere).
