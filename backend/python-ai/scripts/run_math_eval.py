"""Phase 3 eval runner — fires the fixture questions at a live /ask endpoint
and writes a markdown report you can grade by hand.

Usage:
    # 1. Fill in courseId / fileName / page placeholders in
    #    tests/fixtures/math_eval_cases.json for your real Minallo content.
    # 2. Set env:
    #       MINALLO_EVAL_BASE_URL   e.g. https://minallo-ai.fly.dev
    #       MINALLO_EVAL_USER_ID    a real Supabase user uuid that owns the course
    #       MINALLO_EVAL_JWT        Supabase access token for that user
    #       MINALLO_EVAL_COURSE_ID  (optional) overrides any TODO_COURSE in the fixture
    # 3. python scripts/run_math_eval.py
    #
    # Output: scripts/eval_runs/<timestamp>.md with the question, retrieved
    # sources, verification status, and the full answer for each case. Grade
    # each one manually and feed adjustments back into Phase 8 constants.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "math_eval_cases.json"
OUT_DIR = ROOT / "scripts" / "eval_runs"


def _env(name: str, *, required: bool = True) -> str:
    val = os.environ.get(name, "").strip()
    if required and not val:
        sys.exit(f"missing env: {name}")
    return val


def _looks_like_todo(value: str | None) -> bool:
    return bool(value) and value.startswith("TODO_")


def run() -> int:
    base = _env("MINALLO_EVAL_BASE_URL").rstrip("/")
    user_id = _env("MINALLO_EVAL_USER_ID")
    jwt = _env("MINALLO_EVAL_JWT")
    course_override = os.environ.get("MINALLO_EVAL_COURSE_ID", "").strip()

    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    cases = fixture.get("cases", [])

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = _dt.datetime.utcnow().strftime("%Y%m%d_%H%M%SZ")
    out_path = OUT_DIR / f"{stamp}.md"

    lines: list[str] = []
    lines.append(f"# Math eval run — {stamp}")
    lines.append("")
    lines.append(f"- base: `{base}`")
    lines.append(f"- cases: {len(cases)}")
    lines.append("")

    headers = {
        "Authorization": f"Bearer {jwt}",
        "Content-Type": "application/json",
    }
    skipped = 0
    failed = 0

    with httpx.Client(timeout=httpx.Timeout(120.0)) as client:
        for case in cases:
            cid = case.get("id", "?")
            question = case.get("question", "")
            expected = case.get("expectedSources") or {}
            course_id = course_override or expected.get("courseId")

            lines.append(f"## {cid} — `{case.get('category','')}`")
            lines.append("")
            lines.append(f"**Question:** {question}")
            lines.append("")

            if not course_id or _looks_like_todo(course_id):
                lines.append("_skipped — no real courseId resolved._")
                lines.append("")
                skipped += 1
                continue

            if expected:
                lines.append(
                    f"**Expected:** {expected.get('fileName','?')} "
                    f"pages {expected.get('pages','?')}"
                )
                lines.append("")

            body = {
                "userId": user_id,
                "courseId": course_id,
                "question": question,
                "bypassCache": True,
            }
            try:
                resp = client.post(f"{base}/ask", json=body, headers=headers)
            except httpx.HTTPError as exc:
                lines.append(f"_request error: {exc}_")
                lines.append("")
                failed += 1
                continue

            if resp.status_code != 200:
                lines.append(f"_HTTP {resp.status_code}: {resp.text[:300]}_")
                lines.append("")
                failed += 1
                continue

            data = resp.json()
            verification = data.get("verification") or {}
            sources = data.get("groundedSources") or []

            lines.append(
                f"**Verification:** `{verification.get('status','?')}` "
                f"— reasons: {verification.get('reasons') or 'none'}"
            )
            lines.append("")
            lines.append(f"**Retrieval mode:** `{data.get('retrievalMode','?')}` "
                         f"· answerMode: `{data.get('answerMode','-')}` "
                         f"· cache: `{data.get('cacheHit')}`")
            lines.append("")
            if sources:
                lines.append("**Grounded sources:**")
                for s in sources:
                    lines.append(
                        f"- {s.get('fileName','?')} "
                        f"pp.{s.get('pageStart','?')}-{s.get('pageEnd','?')} "
                        f"· {s.get('chunkType','-')} "
                        f"· sim={s.get('similarity')}"
                    )
                lines.append("")

            answer = (data.get("answer") or "").strip()
            lines.append("**Answer:**")
            lines.append("")
            lines.append("```")
            lines.append(answer)
            lines.append("```")
            lines.append("")
            lines.append("**Grade (fill in):** [ ] correct doc  [ ] correct pages  "
                         "[ ] accurate answer  notes: ____")
            lines.append("")
            lines.append("---")
            lines.append("")

    lines.append("")
    lines.append(f"_total: {len(cases)} · skipped: {skipped} · failed: {failed}_")
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(run())
