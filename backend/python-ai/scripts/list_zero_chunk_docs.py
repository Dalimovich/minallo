"""Read-only helper: which documents have NO chunks (so the AI can't ground on
them)?

For every (user, course) — or a single --course / --user when given — this lists
each document with:
  * processing_status
  * chunk_count        (the stored column on `documents`, can be stale)
  * actual chunks      (live COUNT(*) on `document_chunks` for that document_id)

and flags every document whose live chunk count is 0. Those are the files that
contribute nothing to retrieval/exam coverage and need a re-upload / re-index.

STRICTLY READ-ONLY. No writes, no migrations, no jobs, no embedding calls.

Usage (from backend/python-ai, with .venv active):
    py scripts/list_zero_chunk_docs.py
    py scripts/list_zero_chunk_docs.py --course uc_1776947657158
    py scripts/list_zero_chunk_docs.py --course <uuid> --user <uuid-or-email>
"""
from __future__ import annotations

import argparse
import os
import re
import socket
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _pin_dns() -> None:
    """Work around a broken *local* DNS resolver (some resolvers return a
    malformed packet for *.supabase.co) by pinning host→IP at the socket layer.
    TLS is unaffected: httpx still sends the real hostname for SNI + Host header,
    only the socket target is overridden. Set SUPABASE_DNS_OVERRIDE="host=ip"
    (resolve the IP elsewhere, e.g. `Resolve-DnsName host -Server 8.8.8.8`)."""
    override = os.environ.get("SUPABASE_DNS_OVERRIDE", "").strip()
    if "=" not in override:
        return
    host, ip = (p.strip() for p in override.split("=", 1))
    if not host or not ip:
        return
    _orig = socket.getaddrinfo

    def _patched(node, *args, **kwargs):  # noqa: ANN001, ANN002
        if node == host:
            node = ip
        return _orig(node, *args, **kwargs)

    socket.getaddrinfo = _patched  # type: ignore[assignment]
    print(f"· DNS override active: {host} → {ip}")


_pin_dns()

from app.supabase_client import get_supabase  # noqa: E402


def _resolve_user_id(sb, user_arg: str | None) -> str | None:
    if not user_arg:
        return None
    if re.fullmatch(r"[0-9a-fA-F-]{36}", user_arg):
        return user_arg
    if "@" in user_arg:
        try:
            resp = sb.auth.admin.list_users()  # type: ignore[attr-defined]
            users = resp if isinstance(resp, list) else getattr(resp, "users", []) or []
            for u in users:
                email = getattr(u, "email", None) or (u.get("email") if isinstance(u, dict) else None)
                if email and email.lower() == user_arg.lower():
                    return getattr(u, "id", None) or (u.get("id") if isinstance(u, dict) else None)
        except Exception as exc:  # noqa: BLE001
            print(f"  ! could not resolve email to uuid: {exc}")
    return None


def _live_chunk_count(sb, document_id: str) -> int:
    """Authoritative live count of document_chunks for one document."""
    resp = (
        sb.table("document_chunks")
        .select("id", count="exact", head=True)
        .eq("document_id", document_id)
        .execute()
    )
    return resp.count or 0


def main() -> int:
    ap = argparse.ArgumentParser(description="List documents with zero chunks (read-only).")
    ap.add_argument("--course", default=None, help="restrict to one course_id")
    ap.add_argument("--user", default=None, help="restrict to one user (uuid or email)")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

    sb = get_supabase()
    user_id = _resolve_user_id(sb, args.user)
    if args.user and not user_id:
        print(f"  ! could not resolve --user '{args.user}'; ignoring user filter.")

    q = sb.table("documents").select(
        "id, course_id, user_id, file_name, processing_status, chunk_count"
    )
    if args.course:
        q = q.eq("course_id", args.course)
    if user_id:
        q = q.eq("user_id", user_id)
    docs = q.limit(5000).execute().data or []

    if not docs:
        print("No documents matched.")
        return 1

    by_course: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    for d in docs:
        by_course[(d.get("user_id"), d.get("course_id"))].append(d)

    print(f"{len(docs)} documents across {len(by_course)} (user,course) pair(s)\n")

    for (uid, cid), files in sorted(by_course.items(), key=lambda kv: -len(kv[1])):
        zero: list[str] = []
        print(f"course_id={cid}  user_id={uid}  docs={len(files)}")
        for d in sorted(files, key=lambda x: (x.get("file_name") or "")):
            live = _live_chunk_count(sb, d["id"])
            stored = d.get("chunk_count")
            status = d.get("processing_status")
            flag = "  ⚠ ZERO CHUNKS" if live == 0 else ""
            stale = "" if (stored == live or stored is None) else f" (stored={stored})"
            print(f"    [{live:>4} chunks]{stale}  status={status:<12} {d.get('file_name')}{flag}")
            if live == 0:
                zero.append(d.get("file_name") or d["id"])
        if zero:
            print(f"  → {len(zero)} file(s) with NO chunks (re-upload / re-index these):")
            for name in zero:
                print(f"      • {name}")
        else:
            print("  → all files have chunks ✓")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
