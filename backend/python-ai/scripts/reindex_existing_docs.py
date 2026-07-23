"""Flip indexed documents back to ``processing_status='pending'`` so the
indexer reruns Markdown conversion + formula/exercise detection on them.

Why: Phase 2 tightened ``markdown_indexing._looks_like_math``,
``_looks_like_heading``, and ``_grade_extraction``. The Markdown those
functions produce is only generated at index time and stored on the
``document_pages`` row — so improvements don't reach already-indexed
documents until a fresh indexing pass runs.

This script ONLY toggles the status column. It does not queue jobs,
does not call OpenAI, and does not delete chunks. The existing indexer
picks the pending row up on its next sweep (or you can trigger
``/index-document`` manually per row).

Usage::

    py scripts/reindex_existing_docs.py --dry-run
    py scripts/reindex_existing_docs.py --user dalimovich.pp@gmail.com
    py scripts/reindex_existing_docs.py --course <uuid>
    py scripts/reindex_existing_docs.py --all
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

# Make `app.*` importable when invoked as `py scripts/reindex_existing_docs.py`
# from the backend/python-ai/ directory. Mirrors how scripts/run_math_eval.py
# expects to be run.
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# Import order: keep the heavy app imports inside main() so `--help` works
# without the backend env loaded.


def _build_query(sb, args: argparse.Namespace):
    q = (
        sb.table("documents")
        .select("id, file_name, user_id, course_id, processing_status, chunk_count")
        .eq("processing_status", "ready")
    )
    if args.course:
        q = q.eq("course_id", args.course)
    if args.user_id:
        q = q.eq("user_id", args.user_id)
    return q


def _resolve_user_id_by_email(sb, email: str) -> str | None:
    """Look up the auth.users row for a given email. Best-effort — RLS may
    block this depending on the service-role key in use; on failure we fall
    back to a None and let the caller print a friendly message."""
    try:
        # The supabase-py admin API exposes the user list under auth.admin.
        resp = sb.auth.admin.list_users()  # type: ignore[attr-defined]
        for u in resp:
            if getattr(u, "email", None) == email:
                return getattr(u, "id", None)
    except Exception as exc:  # noqa: BLE001
        print(f"warn: could not resolve email {email!r} via auth admin ({exc})", file=sys.stderr)
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would change without writing.")
    parser.add_argument("--user", dest="email", default=None,
                        help="Restrict to documents owned by this user email.")
    parser.add_argument("--course", default=None,
                        help="Restrict to this course UUID.")
    parser.add_argument("--all", action="store_true",
                        help="Required if neither --user nor --course is given.")
    args = parser.parse_args()

    if not (args.email or args.course or args.all):
        parser.error("pass --user, --course, or --all (safety guard).")

    from app.supabase_client import get_supabase  # noqa: WPS433

    sb = get_supabase()

    args.user_id = None
    if args.email:
        args.user_id = _resolve_user_id_by_email(sb, args.email)
        if not args.user_id:
            print(f"no auth user found for {args.email!r}", file=sys.stderr)
            return 2

    resp = _build_query(sb, args).execute()
    rows: list[dict[str, Any]] = resp.data or []
    if not rows:
        print("nothing matched — no documents in 'ready' state for the given filter.")
        return 0

    print(f"{len(rows)} document(s) will be flipped to 'pending':")
    for r in rows:
        print(f"  - {r['id']}  ({r.get('file_name') or '?'})  chunks={r.get('chunk_count')}")

    if args.dry_run:
        print("\n--dry-run set; no writes performed.")
        return 0

    ids = [r["id"] for r in rows]
    update_resp = (
        sb.table("documents")
        .update({"processing_status": "pending", "processing_error": None})
        .in_("id", ids)
        .execute()
    )
    written = len(update_resp.data or [])
    print(f"\nupdated {written}/{len(ids)} rows. The indexer will pick them up on its next pass.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
