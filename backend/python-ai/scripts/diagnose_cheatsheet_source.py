"""Stage 0 diagnostic — is the cheatsheet weak because of INDEXING, RETRIEVAL,
or GENERATION?

The cheatsheet "misses many important formulas" complaint is almost always a
garbage-in problem, not a prompting one. Before touching generation we want to
know *where* the formulas are being lost:

  * INDEXING   — the formulas were never extracted cleanly at upload. Few
                 ``document_formulas`` rows, low formula density in chunks, many
                 weak/failed pages. Per the project's no-reindex rule this can
                 only be fixed for FUTURE uploads (re-upload the lecture).
  * RETRIEVAL  — the formulas ARE in the index, but the per-topic cheatsheet
                 queries don't surface them. Fixable cheaply (query/ranking).
  * GENERATION — indexing and retrieval both look healthy; the lever really is
                 the prompt/structure. Proceed to Stage 1.

This script is STRICTLY READ-ONLY. It runs no migrations, queues no jobs,
deletes nothing, and (unless ``--no-retrieval``) makes embedding calls only to
replay the cheatsheet's own retrieval for a few topics.

Usage::

    cd backend/python-ai
    py scripts/diagnose_cheatsheet_source.py --course <uuid>
    py scripts/diagnose_cheatsheet_source.py --user dalimovich.pp@gmail.com --course <uuid>
    py scripts/diagnose_cheatsheet_source.py --course <uuid> --topics 10
    py scripts/diagnose_cheatsheet_source.py --course <uuid> --no-retrieval

Env (read from backend/python-ai/.env like the rest of the service):
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY (retrieval only).

Output: a Markdown report under scripts/diag_runs/<timestamp>.md plus a console
verdict.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

# Make `app.*` importable when run as `py scripts/diagnose_cheatsheet_source.py`
# from backend/python-ai/. Mirrors scripts/reindex_existing_docs.py.
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

OUT_DIR = _ROOT / "scripts" / "diag_runs"

# How many chunk rows we pull to measure formula density. The diagnostic only
# needs a representative sample, not the whole course; bounded so a huge course
# doesn't blow memory. Reported as "(sampled)" when the cap is hit.
_CHUNK_SAMPLE_CAP = 8000
_PAGE_SIZE = 1000

# Reuse the SAME formula detector the ranker uses (retrieval._FORMULA_TOKEN_RE)
# so "formula-bearing chunk" means here exactly what it means in scoring.
_FORMULA_TOKEN_RE = re.compile(r"[=≈∑∫∂√π]|\b[a-z]_?\{?[a-z0-9]\}?\s*=")

# Cheatsheet retrieval replays this query per topic (mirrors cheatsheet.py's
# _pool_evidence fallback query).
_FORMULA_QUERY = "key formulas, definitions, rules, theorems"


# ── LaTeX cleanliness heuristic ──────────────────────────────────────────────


def _latex_suspect(formula: str) -> str | None:
    """Return a short reason string if a stored formula looks corrupted/garbled,
    else None. Mechanical only — this is the same class of check Stage 4's
    broken-LaTeX cull will use, surfaced early so we can measure how much clean
    material actually exists.
    """
    s = (formula or "").strip()
    if not s:
        return "empty"
    if "�" in s:
        return "replacement-char (\\ufffd) — OCR could not decode glyphs"
    # Control chars (other than tab/newline) usually mean binary/garbled text.
    if any(ord(c) < 32 and c not in "\t\n\r" for c in s):
        return "control characters"
    if s.count("$") % 2 != 0:
        return "unbalanced $ delimiters"
    if s.count("{") != s.count("}"):
        return "unbalanced braces"
    # A formula that is mostly non-math word characters with no operator at all
    # is probably a mis-captured prose line, not a formula.
    if not re.search(r"[=+\-*/^_\\∑∫∂√π<>±≈≤≥]", s):
        return "no math operator (likely prose mis-tagged as formula)"
    # Long runs of the same punctuation = dotted leaders / table noise / OCR mush.
    if re.search(r"([.\-_·•])\1{6,}", s):
        return "repeated-punctuation run (table/leader noise)"
    return None


# ── env / args ───────────────────────────────────────────────────────────────


def _resolve_user_id(sb, user_arg: str | None) -> str | None:
    """user_arg may be a uuid, an email, or None. Returns a uuid or None."""
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


# ── data gathering (all read-only) ───────────────────────────────────────────


def _fetch_documents(sb, course_id: str, user_id: str | None) -> list[dict[str, Any]]:
    q = (
        sb.table("documents")
        .select(
            "id, file_name, document_type, source_type, extraction_quality, "
            "page_count, chunk_count, processing_status"
        )
        .eq("course_id", course_id)
    )
    if user_id:
        q = q.eq("user_id", user_id)
    return q.execute().data or []


def _fetch_page_quality(sb, doc_ids: list[str]) -> Counter:
    """Distribution of document_pages.extraction_quality across the course."""
    dist: Counter = Counter()
    if not doc_ids:
        return dist
    start = 0
    while True:
        resp = (
            sb.table("document_pages")
            .select("extraction_quality")
            .in_("document_id", doc_ids)
            .range(start, start + _PAGE_SIZE - 1)
            .execute()
        )
        rows = resp.data or []
        for r in rows:
            dist[r.get("extraction_quality") or "unknown"] += 1
        if len(rows) < _PAGE_SIZE:
            break
        start += _PAGE_SIZE
    return dist


def _fetch_chunk_stats(sb, doc_ids: list[str]) -> dict[str, Any]:
    """Total chunks, formula-bearing count, and chunk_type distribution.
    Sampled up to _CHUNK_SAMPLE_CAP rows."""
    total = 0
    formula_bearing = 0
    types: Counter = Counter()
    truncated = False
    if not doc_ids:
        return {"total": 0, "formulaBearing": 0, "types": types, "truncated": False}
    start = 0
    while start < _CHUNK_SAMPLE_CAP:
        resp = (
            sb.table("document_chunks")
            .select("chunk_text, chunk_type")
            .in_("document_id", doc_ids)
            .range(start, start + _PAGE_SIZE - 1)
            .execute()
        )
        rows = resp.data or []
        for r in rows:
            total += 1
            types[r.get("chunk_type") or "general"] += 1
            if _FORMULA_TOKEN_RE.search(r.get("chunk_text") or ""):
                formula_bearing += 1
        if len(rows) < _PAGE_SIZE:
            break
        start += _PAGE_SIZE
    else:
        truncated = True
    return {"total": total, "formulaBearing": formula_bearing, "types": types, "truncated": truncated}


def _fetch_formula_stats(sb, course_id: str, user_id: str | None) -> dict[str, Any]:
    """document_formulas count + LaTeX cleanliness + a few garbled samples."""
    q = (
        sb.table("document_formulas")
        .select("formula_name, formula_markdown, symbols, page_number, document_id")
        .eq("course_id", course_id)
    )
    if user_id:
        q = q.eq("user_id", user_id)
    rows: list[dict[str, Any]] = []
    start = 0
    while True:
        resp = q.range(start, start + _PAGE_SIZE - 1).execute()
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < _PAGE_SIZE:
            break
        start += _PAGE_SIZE
    clean = 0
    suspect_samples: list[tuple[str, str]] = []
    reasons: Counter = Counter()
    for r in rows:
        reason = _latex_suspect(r.get("formula_markdown") or "")
        if reason:
            reasons[reason.split(" —")[0].split(" (")[0]] += 1
            if len(suspect_samples) < 8:
                fm = (r.get("formula_markdown") or "").replace("\n", " ")[:120]
                suspect_samples.append((fm, reason))
        else:
            clean += 1
    return {
        "total": len(rows),
        "clean": clean,
        "suspect": len(rows) - clean,
        "reasons": reasons,
        "samples": suspect_samples,
    }


def _fetch_topics(sb, course_id: str, user_id: str | None, limit: int) -> list[dict[str, Any]]:
    from app.services.learning_agent import get_course_topic_map  # noqa: WPS433

    if not user_id:
        return []
    topics = get_course_topic_map(user_id, course_id)
    return topics[:limit]


def _retrieval_probe(
    user_id: str, course_id: str, topics: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Replay the cheatsheet's per-topic retrieval and measure how many of the
    returned chunks actually carry formulas."""
    from app.services.learning_agent import retrieve_learning_context  # noqa: WPS433

    out: list[dict[str, Any]] = []
    for t in topics:
        name = t.get("name") or ""
        try:
            chunks = retrieve_learning_context(
                user_id=user_id,
                course_id=course_id,
                topic=name,
                query=f"{name} {_FORMULA_QUERY}",
                purpose="cheatsheet",
                top_k=6,
            )
        except Exception as exc:  # noqa: BLE001
            out.append({"topic": name, "error": str(exc)})
            continue
        formula_hits = sum(1 for c in chunks if _FORMULA_TOKEN_RE.search(c.get("text") or ""))
        sims = [c.get("similarity") for c in chunks if isinstance(c.get("similarity"), (int, float))]
        out.append({
            "topic": name,
            "importance": t.get("importance"),
            "returned": len(chunks),
            "formulaBearing": formula_hits,
            "simMax": max(sims) if sims else None,
            "simMin": min(sims) if sims else None,
            "docs": len({c.get("documentId") for c in chunks if c.get("documentId")}),
        })
    return out


# ── verdict ──────────────────────────────────────────────────────────────────


def _verdict(
    formula_stats: dict[str, Any],
    chunk_stats: dict[str, Any],
    page_dist: Counter,
    probes: list[dict[str, Any]],
) -> tuple[str, list[str]]:
    notes: list[str] = []

    total_pages = sum(page_dist.values()) or 1
    bad_pages = page_dist.get("weak", 0) + page_dist.get("failed", 0)
    bad_page_ratio = bad_pages / total_pages

    chunk_total = chunk_stats["total"] or 1
    formula_density = chunk_stats["formulaBearing"] / chunk_total

    f_total = formula_stats["total"]
    clean_ratio = (formula_stats["clean"] / f_total) if f_total else 0.0

    valid_probes = [p for p in probes if "error" not in p and p.get("returned")]
    if valid_probes:
        avg_formula_hits = sum(p["formulaBearing"] for p in valid_probes) / len(valid_probes)
        topics_with_formulas = sum(1 for p in valid_probes if p["formulaBearing"] > 0)
        retrieval_coverage = topics_with_formulas / len(valid_probes)
    else:
        avg_formula_hits = 0.0
        retrieval_coverage = None

    # ── classify ──
    indexing_bad = (
        f_total < 5
        or clean_ratio < 0.5
        or formula_density < 0.08
        or bad_page_ratio > 0.35
    )
    if indexing_bad:
        notes.append(
            f"document_formulas rows: {f_total} (clean {clean_ratio:.0%}); "
            f"formula-bearing chunks: {formula_density:.0%}; "
            f"weak/failed pages: {bad_page_ratio:.0%}"
        )
        notes.append(
            "→ Per the no-reindex rule, existing garbled docs won't improve without "
            "re-upload. Fixing this means the ingestion/OCR path for FUTURE uploads, "
            "or asking the student to re-upload the key lecture/Formelzettel."
        )
        return "INDEXING", notes

    if retrieval_coverage is not None and (retrieval_coverage < 0.6 or avg_formula_hits < 1.5):
        notes.append(
            f"Indexing looks OK (formulas={f_total}, clean {clean_ratio:.0%}, "
            f"density {formula_density:.0%}) BUT per-topic retrieval surfaces formulas "
            f"for only {retrieval_coverage:.0%} of topics "
            f"(avg {avg_formula_hits:.1f} formula chunks/topic)."
        )
        notes.append(
            "→ Fixable cheaply with no reindex: formula-aware queries, raise the "
            "formula-sheet boost for cheatsheet retrieval, widen per-topic top_k."
        )
        return "RETRIEVAL", notes

    if retrieval_coverage is None:
        notes.append(
            "Indexing looks healthy, but retrieval was not probed (no topic map / "
            "--no-retrieval). Re-run with --user and a built topic map to confirm "
            "retrieval before concluding generation is the lever."
        )
        return "INDEXING-OK / RETRIEVAL-UNKNOWN", notes

    notes.append(
        f"Indexing healthy (formulas={f_total}, clean {clean_ratio:.0%}, density "
        f"{formula_density:.0%}) and retrieval healthy (coverage {retrieval_coverage:.0%}, "
        f"avg {avg_formula_hits:.1f} formula chunks/topic). The lever is GENERATION — "
        "proceed to Stage 1 (terse-markdown → structured + renderer)."
    )
    return "GENERATION", notes


# ── report ───────────────────────────────────────────────────────────────────


def _write_report(
    *,
    course_id: str,
    user_id: str | None,
    docs: list[dict[str, Any]],
    page_dist: Counter,
    chunk_stats: dict[str, Any],
    formula_stats: dict[str, Any],
    probes: list[dict[str, Any]],
    verdict: str,
    verdict_notes: list[str],
) -> Path:
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%d_%H%M%SZ")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{stamp}.md"

    L: list[str] = []
    L.append(f"# Cheatsheet source diagnostic — {stamp}")
    L.append("")
    L.append(f"- course: `{course_id}`")
    L.append(f"- user: `{user_id or '(not resolved — retrieval probe skipped)'}`")
    L.append("")
    L.append(f"## VERDICT: **{verdict}**")
    L.append("")
    for n in verdict_notes:
        L.append(f"- {n}")
    L.append("")

    L.append("## Documents")
    L.append("")
    L.append(f"- count: {len(docs)}")
    dt_dist = Counter(d.get("document_type") or d.get("source_type") or "?" for d in docs)
    L.append(f"- types: {dict(dt_dist)}")
    eq_dist = Counter(d.get("extraction_quality") or "unknown" for d in docs)
    L.append(f"- extraction_quality (doc-level): {dict(eq_dist)}")
    not_ready = [d for d in docs if d.get("processing_status") != "ready"]
    if not_ready:
        L.append(f"- ⚠ {len(not_ready)} not 'ready': "
                 + ", ".join(f"{d.get('file_name')}={d.get('processing_status')}" for d in not_ready[:10]))
    L.append("")

    L.append("## Page extraction quality")
    L.append("")
    L.append(f"- distribution: {dict(page_dist)}")
    L.append("")

    L.append("## Chunks")
    L.append("")
    L.append(f"- total{' (sampled)' if chunk_stats['truncated'] else ''}: {chunk_stats['total']}")
    fb = chunk_stats["formulaBearing"]
    ratio = (fb / chunk_stats["total"]) if chunk_stats["total"] else 0
    L.append(f"- formula-bearing: {fb} ({ratio:.0%})")
    L.append(f"- chunk_type distribution: {dict(chunk_stats['types'])}")
    L.append("")

    L.append("## Extracted formulas (document_formulas)")
    L.append("")
    L.append(f"- total: {formula_stats['total']}")
    L.append(f"- clean LaTeX: {formula_stats['clean']}")
    L.append(f"- suspect/garbled: {formula_stats['suspect']}")
    if formula_stats["reasons"]:
        L.append(f"- suspect reasons: {dict(formula_stats['reasons'])}")
    if formula_stats["samples"]:
        L.append("")
        L.append("Sample suspect formulas:")
        for fm, reason in formula_stats["samples"]:
            L.append(f"  - `{fm}` — {reason}")
    L.append("")

    L.append("## Per-topic retrieval probe")
    L.append("")
    if not probes:
        L.append("_skipped (no topic map resolved / --no-retrieval)_")
    else:
        L.append("| topic | imp | returned | formula-bearing | docs | sim range |")
        L.append("|---|---|---|---|---|---|")
        for p in probes:
            if "error" in p:
                L.append(f"| {p['topic']} | — | error | {p['error'][:40]} | | |")
                continue
            sim = (f"{p['simMin']:.2f}–{p['simMax']:.2f}"
                   if p.get("simMax") is not None else "—")
            L.append(
                f"| {p['topic']} | {p.get('importance','?')} | {p['returned']} | "
                f"{p['formulaBearing']} | {p['docs']} | {sim} |"
            )
    L.append("")

    out.write_text("\n".join(L), encoding="utf-8")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Read-only cheatsheet source diagnostic.")
    ap.add_argument("--course", required=True, help="course_id (text/uuid)")
    ap.add_argument("--user", default=None, help="user uuid or email (enables retrieval probe)")
    ap.add_argument("--topics", type=int, default=8, help="how many top topics to probe")
    ap.add_argument("--no-retrieval", action="store_true", help="skip embedding/retrieval probe")
    args = ap.parse_args()

    # The report file is UTF-8, but the Windows console defaults to cp1252 and
    # chokes on → / · / OCR glyphs in the verdict. Never let console encoding
    # crash the run (the report is the real output).
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

    from app.supabase_client import get_supabase  # noqa: WPS433

    sb = get_supabase()
    user_id = _resolve_user_id(sb, args.user)
    if args.user and not user_id:
        print(f"  ! could not resolve --user '{args.user}' to a uuid; "
              "indexing stats will span all users for this course, retrieval probe skipped.")

    print("· fetching documents …")
    docs = _fetch_documents(sb, args.course, user_id)
    doc_ids = [d["id"] for d in docs if d.get("id")]
    if not docs:
        print(f"No documents found for course {args.course}"
              + (f" / user {user_id}" if user_id else "") + ". Nothing to diagnose.")
        return 1

    print(f"· {len(docs)} documents — measuring page quality, chunks, formulas …")
    page_dist = _fetch_page_quality(sb, doc_ids)
    chunk_stats = _fetch_chunk_stats(sb, doc_ids)
    formula_stats = _fetch_formula_stats(sb, args.course, user_id)

    probes: list[dict[str, Any]] = []
    if not args.no_retrieval and user_id:
        print("· probing per-topic retrieval (embeddings) …")
        topics = _fetch_topics(sb, args.course, user_id, args.topics)
        if topics:
            probes = _retrieval_probe(user_id, args.course, topics)
        else:
            print("  ! no topic map found for this course — retrieval probe skipped.")
    elif not user_id:
        print("· retrieval probe skipped (no resolved --user).")

    verdict, notes = _verdict(formula_stats, chunk_stats, page_dist, probes)
    out = _write_report(
        course_id=args.course,
        user_id=user_id,
        docs=docs,
        page_dist=page_dist,
        chunk_stats=chunk_stats,
        formula_stats=formula_stats,
        probes=probes,
        verdict=verdict,
        verdict_notes=notes,
    )

    print("")
    print(f"VERDICT: {verdict}")
    for n in notes:
        print(f"  - {n}")
    print("")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
