"""Retrieval-only evaluation harness.

Runs each case in `tests/fixtures/rag_eval_cases.json` through the real
retrieval pipeline (vector + BM25 + exercise-exact + formula-exact +
rerank) but STOPS before answer generation. Measures:

  - top1_page_hit   — did the #1 chunk land on an expectedPages?
  - top3_page_hit   — did any of the top-3 chunks?
  - mustContain_hit — fraction of mustContain tokens found in the top-3
                      chunks combined
  - exercise_hit    — did retrieve_exercise_block fire when expected?
  - formula_hit     — did retrieve_formula_block fire when expected?

This is intentionally decoupled from the LLM: a regression in the
ranker or in a heuristic shows up here without waiting for a full
generation pass, and without any model-noise variance.

Usage (from backend/python-ai):
    python -m tests.scripts.eval_retrieval [--case <id>] [--user <uuid>]

The script needs a SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY pair in the
environment because retrieval hits the real DB. A USER_ID must be
provided either via --user or the EVAL_USER_ID env var — the cases
themselves don't carry one because the fixture is shared across devs.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

# Allow running as a script: `python -m tests.scripts.eval_retrieval` from
# the python-ai dir works; direct `python tests/scripts/eval_retrieval.py`
# also works thanks to the sys.path nudge below.
_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from app.services.retrieval import (  # noqa: E402
    retrieve_chunks,
    retrieve_exercise_block,
    retrieve_formula_block,
)


FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "rag_eval_cases.json"


@dataclass
class CaseResult:
    case_id: str
    top1_page_hit: bool
    top3_page_hit: bool
    must_contain_ratio: float
    exercise_hit_ok: bool
    formula_hit_ok: bool
    top_chunks: list[dict]


def _run_case(case: dict, user_id: str) -> CaseResult:
    course_id = case["courseId"]
    question = case["question"]
    expected_pages = set(case.get("expectedPages") or [])
    must_contain = [t.lower() for t in (case.get("mustContain") or [])]

    exercise_hit = retrieve_exercise_block(
        user_id=user_id, course_id=course_id, query=question,
    )
    formula_hits = retrieve_formula_block(
        user_id=user_id, course_id=course_id, query=question,
    )
    chunks = retrieve_chunks(
        user_id=user_id, course_id=course_id, query=question, top_k=10,
    )

    top1_page = chunks[0].page_start if chunks else None
    top3_pages = {c.page_start for c in chunks[:3] if c.page_start is not None}

    top1_hit = top1_page in expected_pages if expected_pages else False
    top3_hit = bool(expected_pages & top3_pages) if expected_pages else False

    top3_text = " ".join((c.text or "").lower() for c in chunks[:3])
    found = sum(1 for tok in must_contain if tok in top3_text)
    must_ratio = (found / len(must_contain)) if must_contain else 1.0

    expects_ex = bool(case.get("expectExerciseHit"))
    expects_fm = bool(case.get("expectFormulaHit"))
    ex_ok = (exercise_hit is not None) == expects_ex
    fm_ok = bool(formula_hits) == expects_fm

    return CaseResult(
        case_id=case["id"],
        top1_page_hit=top1_hit,
        top3_page_hit=top3_hit,
        must_contain_ratio=must_ratio,
        exercise_hit_ok=ex_ok,
        formula_hit_ok=fm_ok,
        top_chunks=[
            {
                "documentId": c.document_id,
                "page": c.page_start,
                "score": c.score,
                "similarity": c.similarity,
                "chunkType": c.chunk_type,
                "excerpt": (c.text or "")[:160],
            }
            for c in chunks[:5]
        ],
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="RAG retrieval-only evaluation")
    parser.add_argument("--case", help="Run only this case id", default=None)
    parser.add_argument("--user", help="Supabase user_id to retrieve as",
                        default=os.environ.get("EVAL_USER_ID"))
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of a table")
    args = parser.parse_args()

    if not args.user:
        print("error: provide --user <uuid> or set EVAL_USER_ID", file=sys.stderr)
        return 2

    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    cases = payload.get("cases", [])
    if args.case:
        cases = [c for c in cases if c.get("id") == args.case]
        if not cases:
            print(f"error: no case with id {args.case!r}", file=sys.stderr)
            return 2

    results: list[CaseResult] = []
    for case in cases:
        if str(case.get("courseId", "")).startswith("TODO_"):
            print(f"skip {case['id']}: courseId is a placeholder", file=sys.stderr)
            continue
        try:
            results.append(_run_case(case, args.user))
        except Exception as e:  # noqa: BLE001
            print(f"error in {case['id']}: {e}", file=sys.stderr)

    if args.json:
        print(json.dumps([r.__dict__ for r in results], indent=2, ensure_ascii=False))
    else:
        print(f"{'case':<32} {'top1':>5} {'top3':>5} {'must%':>7} {'ex':>4} {'fm':>4}")
        for r in results:
            print(
                f"{r.case_id:<32} "
                f"{'OK' if r.top1_page_hit else '.':>5} "
                f"{'OK' if r.top3_page_hit else '.':>5} "
                f"{int(round(r.must_contain_ratio * 100)):>6}% "
                f"{'OK' if r.exercise_hit_ok else '.':>4} "
                f"{'OK' if r.formula_hit_ok else '.':>4}"
            )
        if results:
            top1 = sum(r.top1_page_hit for r in results) / len(results)
            top3 = sum(r.top3_page_hit for r in results) / len(results)
            must = sum(r.must_contain_ratio for r in results) / len(results)
            print(
                f"\nsummary: top1={top1:.0%} top3={top3:.0%} "
                f"must_contain_avg={must:.0%} (n={len(results)})"
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
