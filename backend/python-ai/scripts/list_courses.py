"""Read-only helper: list courses + document counts per user. No writes."""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from app.supabase_client import get_supabase  # noqa: E402


def main() -> int:
    sb = get_supabase()
    resp = (
        sb.table("documents")
        .select("course_id, user_id, file_name")
        .limit(5000)
        .execute()
    )
    rows = resp.data or []
    by_course: dict[tuple, list[str]] = {}
    for r in rows:
        key = (r.get("user_id"), r.get("course_id"))
        by_course.setdefault(key, []).append(r.get("file_name") or "?")
    print(f"{len(rows)} documents across {len(by_course)} (user,course) pairs\n")
    for (uid, cid), files in by_course.items():
        print(f"course_id={cid}  user_id={uid}  docs={len(files)}")
        for f in files[:8]:
            print(f"    - {f}")
        if len(files) > 8:
            print(f"    ... +{len(files) - 8} more")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
