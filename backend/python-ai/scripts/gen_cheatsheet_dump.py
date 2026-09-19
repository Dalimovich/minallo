"""Read-only driver: generate a cheatsheet (save=False) and dump markdown + quality.

Usage:
  py scripts/gen_cheatsheet_dump.py --course <id> --user <uuid> [--preset balanced]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from app.services.cheatsheet import generate_cheatsheet  # noqa: E402

OUT = _ROOT / "scripts" / "diag_runs"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--course", required=True)
    ap.add_argument("--user", required=True)
    ap.add_argument("--preset", default="balanced")
    args = ap.parse_args()

    res = generate_cheatsheet(
        user_id=args.user,
        course_id=args.course,
        document_ids=None,
        topic=None,
        doc_names={},
        save=False,
        settings={"preset": args.preset},
    )
    text = res.get("text") or ""
    quality = res.get("quality") or {}
    diag = res.get("diagnostics") or res.get("diag") or {}

    OUT.mkdir(parents=True, exist_ok=True)
    md_path = OUT / f"cheatsheet_{args.course}_{args.preset}.md"
    md_path.write_text(text, encoding="utf-8")

    print(f"=== keys: {sorted(res.keys())}")
    print(f"=== subjectType: {res.get('subjectType')}")
    print(f"=== topicsCovered: {res.get('topicsCovered')}")
    print(f"=== chars: {len(text)}  sections(##): {text.count(chr(10) + '## ') + text.startswith('## ')}")
    print("=== quality ===")
    print(json.dumps(quality, indent=2, default=str)[:2000])
    gate = quality.get("gate") if isinstance(quality, dict) else None
    if gate:
        print("=== gate ===")
        print(json.dumps(gate, indent=2, default=str))
    if diag:
        print("=== diagnostics ===")
        print(json.dumps(diag, indent=2, default=str)[:1500])
    for k in ("warning", "error", "citationWarning"):
        if res.get(k):
            print(f"=== {k}: {res[k]}")
    print(f"\nmarkdown -> {md_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
