"""Read-only integrity audit across documents: for each row, compares cached
processing_status/page_count/chunk_count metadata against the ACTUAL live
document_pages/document_chunks/document_page_manifests rows for its active
revision (via services.document_health.validate_active_document_index), and
separately flags duplicate physical uploads (same user_id/course_id/
storage_path — the class of bug documents_user_course_storage_uniq now
prevents going forward, see supabase/migrations/20260831_000001_*).

This is the tool the 2026-08-31 incident (25 documents in one course marked
'ready' with a stale chunk_count but zero live chunks) should have caught
before a user did. Run it periodically, or whenever "the AI can't find
anything in this file" is reported.

STRICTLY READ-ONLY. No writes, no migrations, no jobs, no embedding calls.

Usage (from backend/python-ai, with .venv active):
    py scripts/audit_document_health.py
    py scripts/audit_document_health.py --course uc_1776947657158
    py scripts/audit_document_health.py --course <uuid> --user <uuid-or-email>
"""
from __future__ import annotations

import argparse
import os
import re
import socket
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _pin_dns() -> None:
    """See scripts/list_zero_chunk_docs.py for why this exists."""
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
    print(f"· DNS override active: {host} -> {ip}")


_pin_dns()

from app.services.document_health import DocumentIndexHealth, validate_active_document_index  # noqa: E402
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


def main() -> int:
    ap = argparse.ArgumentParser(description="Read-only document index integrity audit.")
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
        "id, course_id, user_id, file_name, storage_path, processing_status, "
        "page_count, chunk_count, active_index_revision"
    )
    if args.course:
        q = q.eq("course_id", args.course)
    if user_id:
        q = q.eq("user_id", user_id)
    docs = q.limit(5000).execute().data or []

    if not docs:
        print("No documents matched.")
        return 1

    print(f"Auditing {len(docs)} document(s)...\n")

    health_counts: Counter[str] = Counter()
    unhealthy_rows: list[dict[str, Any]] = []
    for d in docs:
        health = validate_active_document_index(d["id"])
        outcome = str(health.get("health"))
        health_counts[outcome] += 1
        row = {
            "documentId": d["id"],
            "courseId": d.get("course_id"),
            "fileName": d.get("file_name"),
            "processingStatus": d.get("processing_status"),
            "activeRevision": d.get("active_index_revision") or None,
            "metadataPageCount": d.get("page_count"),
            "actualPageCount": health.get("actualPageCount"),
            "metadataChunkCount": d.get("chunk_count"),
            "actualChunkCount": health.get("actualChunkCount"),
            "manifestPageCount": health.get("manifestPageCount"),
            "healthStatus": outcome,
            "reason": health.get("reason"),
        }
        if outcome != DocumentIndexHealth.READY.value:
            unhealthy_rows.append(row)

    if unhealthy_rows:
        print(f"{len(unhealthy_rows)} document(s) NOT healthy:\n")
        for row in unhealthy_rows:
            print(
                f"  [{row['healthStatus']:<20}] {row['fileName']}  "
                f"(course={row['courseId']} id={row['documentId']})"
            )
            print(
                f"      status={row['processingStatus']} "
                f"pages(meta={row['metadataPageCount']} actual={row['actualPageCount']}) "
                f"chunks(meta={row['metadataChunkCount']} actual={row['actualChunkCount']}) "
                f"manifest={row['manifestPageCount']}"
            )
            if row["reason"]:
                print(f"      reason: {row['reason']}")
    else:
        print("All documents healthy (READY or a legitimate SEMANTIC_EMPTY/INDEXING state).")

    print("\n--- health summary ---")
    for state, count in sorted(health_counts.items(), key=lambda kv: -kv[1]):
        print(f"  {state:<20} {count}")

    # Duplicate physical uploads: same (user_id, course_id, storage_path).
    # documents_user_course_storage_uniq (20260831_000001) prevents new ones
    # once applied — this still catches any that predate it or slipped
    # through before the constraint was live.
    by_identity: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for d in docs:
        key = (d.get("user_id"), d.get("course_id"), d.get("storage_path"))
        by_identity[key].append(d)
    dupes = {k: v for k, v in by_identity.items() if len(v) > 1}
    print(f"\n--- duplicate physical uploads: {len(dupes)} group(s) ---")
    for (uid, cid, path), rows in dupes.items():
        print(f"  user={uid} course={cid} storage_path={path}")
        for r in rows:
            print(f"    id={r['id']} file_name={r.get('file_name')}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
