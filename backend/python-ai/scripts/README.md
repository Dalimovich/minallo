# Python AI Scripts

Utility scripts for live evaluation and manual tuning of the Python AI service.

## `diagnose_cheatsheet_source.py`

Read-only Stage 0 diagnostic for the cheatsheet upgrade. Answers **where**
formulas are being lost — indexing, retrieval, or generation — before any
generation work is done. Makes no writes; embedding calls only for the
optional per-topic retrieval probe.

```bash
cd backend/python-ai
py scripts/diagnose_cheatsheet_source.py --course <uuid> --user dalimovich.pp@gmail.com
py scripts/diagnose_cheatsheet_source.py --course <uuid> --topics 10
py scripts/diagnose_cheatsheet_source.py --course <uuid> --no-retrieval   # skip embeddings
```

Reads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` from
`backend/python-ai/.env`. Writes a Markdown report to `scripts/diag_runs/` and
prints a one-line **VERDICT**:

- **INDEXING** — formulas weren't extracted cleanly at upload. Per the no-reindex
  rule, fix the ingestion path for future uploads or re-upload the key lecture.
- **RETRIEVAL** — formulas are indexed but don't surface per topic. Cheap to fix
  (formula-aware queries / ranking), no reindex.
- **GENERATION** — indexing + retrieval are healthy; proceed to Stage 1.

The verdict is a heuristic over: `document_formulas` count + LaTeX cleanliness,
formula-bearing chunk density, page extraction quality, and per-topic retrieval
coverage. Read the full report, don't act on the headline alone.

## `run_math_eval.py`

Runs the math/RAG fixture at a live `/ask` endpoint and writes a Markdown report under `scripts/eval_runs/`.

Use it when tuning:

- exercise reference detection
- document/chunk scoring
- formula-sheet retrieval
- lecture-vs-exercise source selection
- missing-context behavior
- answer formatting for engineering/math problems

## Required Environment

```bash
export MINALLO_EVAL_BASE_URL=https://minallo-ai.fly.dev
export MINALLO_EVAL_USER_ID=<supabase-user-uuid-that-owns-the-course>
export MINALLO_EVAL_JWT=<supabase-access-token>
```

Optional:

```bash
export MINALLO_EVAL_COURSE_ID=<course-uuid>
```

`MINALLO_EVAL_COURSE_ID` overrides `TODO_COURSE` placeholders in the fixture so you can run the same cases against one real course.

## Run

```bash
cd backend/python-ai
python scripts/run_math_eval.py
```

## Reading The Report

Cases with unresolved `TODO_*` expected sources are skipped unless `MINALLO_EVAL_COURSE_ID` is set.

After a run:

1. Open the generated Markdown report in `scripts/eval_runs/`.
2. Check whether the answer used the expected lecture/exercise/formula sources.
3. Check whether the final answer followed the expected structure.
4. Mark failures by category.
5. Tune retrieval/ranking/prompt behavior based on repeated failure patterns.

Do not tune ranking constants from a single case. Look for systematic failures across buckets.
