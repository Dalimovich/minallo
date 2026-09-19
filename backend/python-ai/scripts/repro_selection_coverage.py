"""Read-only repro: when many sources are SELECTED in the chatbot, how many of
them actually surface chunks in retrieval?

Simulates the /ask-stream "specific_files" path: take every document in a course
(or a given list), treat them as the user's selection, run retrieve_chunks the
same way stream.py does, and report how many distinct selected docs appear in
the returned chunks vs how many were selected.

STRICTLY READ-ONLY (one embedding call per question, no writes).

Usage (backend/python-ai, .venv active, with SUPABASE_DNS_OVERRIDE if needed):
    py scripts/repro_selection_coverage.py --course uc_1777906910748 \
        --user b1f54590-3be9-4ef7-8235-f877befaccb3 \
        --q "Erkläre die wichtigsten Konzepte aus diesen Unterlagen"
"""
from __future__ import annotations

import argparse
import logging
import os
import socket
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="LOG %(name)s %(message)s")

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _pin_dns() -> None:
    override = os.environ.get("SUPABASE_DNS_OVERRIDE", "").strip()
    if "=" not in override:
        return
    host, ip = (p.strip() for p in override.split("=", 1))
    if not host or not ip:
        return
    _orig = socket.getaddrinfo

    def _patched(node, *a, **k):  # noqa: ANN001, ANN002
        return _orig(ip if node == host else node, *a, **k)

    socket.getaddrinfo = _patched  # type: ignore[assignment]


_pin_dns()

from app.services.retrieval import retrieve_chunks  # noqa: E402
from app.supabase_client import get_supabase  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--course", required=True)
    ap.add_argument("--user", required=True, help="user uuid")
    ap.add_argument("--q", required=True, help="the chat question")
    ap.add_argument("--limit-docs", type=int, default=0, help="cap selection to N docs (0=all)")
    ap.add_argument("--coverage", action="store_true", help="simulate a coverage-intent request (guarantee_documents)")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

    sb = get_supabase()
    docs = (
        sb.table("documents")
        .select("id, file_name")
        .eq("course_id", args.course)
        .eq("user_id", args.user)
        .limit(5000)
        .execute()
        .data
        or []
    )
    if args.limit_docs:
        docs = docs[: args.limit_docs]
    doc_ids = [d["id"] for d in docs if d.get("id")]
    name_by_id = {d["id"]: d.get("file_name") for d in docs}
    n = len(doc_ids)
    if not n:
        print("no docs")
        return 1

    # Mirror stream.py's breadth scaling.
    top_k = 18 if n <= 6 else min(48, n * 3)
    chunks = retrieve_chunks(
        user_id=args.user,
        course_id=args.course,
        query=args.q,
        document_ids=doc_ids,
        preferred_document_ids=doc_ids,
        document_name_query=args.q,
        top_k=top_k,
        guarantee_documents=args.coverage,
    )
    covered = {c.document_id for c in chunks if c.document_id}
    missing = [i for i in doc_ids if i not in covered]

    print(f"question : {args.q!r}")
    print(f"selected : {n} docs   top_k={top_k}   chunks returned={len(chunks)}")
    print(f"covered  : {len(covered)} / {n} selected docs surfaced a chunk (RETRIEVAL)")
    print(f"MISSING  : {len(missing)} selected docs contributed NOTHING:")
    for i in missing:
        print(f"    • {name_by_id.get(i)}")

    if args.coverage:
        # Simulate the prompt's used_chunks: the MAX_PROMPT_CHUNKS=10 cap vs the
        # coverage-aware selection. The exam writes one Aufgabe per distinct doc
        # that survives into used_chunks, so this is what the model actually sees.
        from app.services.answer import MAX_PROMPT_CHUNKS
        from app.services.answer_stream import _coverage_chunk_selection

        topn = chunks[:MAX_PROMPT_CHUNKS]
        cov = _coverage_chunk_selection(chunks)
        print(
            f"PROMPT   : top-{MAX_PROMPT_CHUNKS} cap → "
            f"{len({c.document_id for c in topn})} docs in prompt (old behavior)"
        )
        print(
            f"PROMPT   : coverage selection → {len(cov)} chunks across "
            f"{len({c.document_id for c in cov})} docs in prompt (new behavior)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
