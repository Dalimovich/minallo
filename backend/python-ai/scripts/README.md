# scripts/

## run_math_eval.py

Fires the Phase 3 fixture (`tests/fixtures/math_eval_cases.json`) at a live
`/ask` endpoint and writes a markdown report under `scripts/eval_runs/`.

```
export MINALLO_EVAL_BASE_URL=https://minallo-ai.fly.dev
export MINALLO_EVAL_USER_ID=<supabase user uuid that owns the course>
export MINALLO_EVAL_JWT=<supabase access token>
# optional — overrides any TODO_COURSE in the fixture with one real course
export MINALLO_EVAL_COURSE_ID=<course uuid>

python scripts/run_math_eval.py
```

Cases whose `expectedSources.courseId` is still a `TODO_*` placeholder are
skipped (unless `MINALLO_EVAL_COURSE_ID` is set). Grade the output report by
hand, then tune Phase 8 ranking constants based on systematic failures.
