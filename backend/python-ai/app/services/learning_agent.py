"""Learning Agent Core — Phase 1 foundation.

A thin orchestration layer over Minallo's existing systems. It deliberately
does NOT reimplement RAG, topic extraction, or mastery — it composes them:

  * ``retrieve_learning_context`` — purpose-aware wrapper over
    ``retrieval.retrieve_chunks`` (topic-as-query + document-type filter + a
    per-purpose ``top_k``). Every other learning feature retrieves through this
    so source grounding is uniform.
  * ``build_course_topic_map`` / ``get_course_topic_map`` — roll the per-chunk
    ``document_chunks.primary_topic`` tags up into one ranked, per-course map
    (stored in ``course_topics``). This is the artifact ExamForge, cheatsheets,
    the planner and weak-topic features build on.
  * ``get_next_best_action`` — combine weak topics (``mastery``) with the topic
    map into a proactive recommendation.

Grounding rule: outputs must trace back to the user's uploaded materials. The
topic map is derived purely from the user's own chunks; retrieval filters to
the user's course.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from datetime import datetime, timezone
from typing import Any

from ..supabase_client import get_supabase
from . import mastery
from .retrieval import retrieve_chunks

log = logging.getLogger(__name__)


# ── purpose-aware retrieval ───────────────────────────────────────────────────

# Per-purpose retrieval thresholds from the Learning Agent plan. NOTE: the
# existing ``retrieve_chunks`` ranks on raw cosine ``similarity`` (typically
# 0.2–0.6 for text-embedding-3-small) plus a study-score rerank, so these
# values cannot be applied as a cosine floor without filtering everything out.
# They are kept here as the intended "usefulness" thresholds for when retrieval
# moves to a normalised usefulness score; for now ``retrieve_learning_context``
# uses purpose to shape the query and ``top_k`` only. Do not pass these as
# ``min_similarity`` to ``retrieve_chunks``.
PURPOSE_THRESHOLDS: dict[str, float] = {
    "answer_question": 0.70,
    "study_planner": 0.70,
    "blind_spot": 0.72,
    "cheatsheet": 0.72,
    "deep_learn": 0.74,
    "exam_generation": 0.78,
    "validation": 0.85,
}
_DEFAULT_THRESHOLD = 0.70

# Per-purpose default fan-out. Cheatsheets/exams want broad topic coverage;
# a single deep-learn step wants a tight, high-signal set.
_PURPOSE_TOP_K: dict[str, int] = {
    "answer_question": 12,
    "deep_learn": 8,
    "exam_generation": 14,
    "cheatsheet": 18,
    "blind_spot": 16,
    "study_planner": 10,
    "validation": 8,
}


def purpose_threshold(purpose: str | None) -> float:
    """Intended usefulness threshold for a retrieval purpose (see note above)."""
    return PURPOSE_THRESHOLDS.get((purpose or "").lower(), _DEFAULT_THRESHOLD)


def _resolve_document_ids_by_type(
    sb, user_id: str, course_id: str, document_types: list[str] | None
) -> list[str] | None:
    """Map requested document types (e.g. ['lecture','formula_sheet','exercise'])
    to concrete document ids in the course. Matches against both ``source_type``
    and the classifier's ``document_type``.

    Returns ``None`` (no filter) when no types are requested OR when none match —
    falling back to course-wide retrieval rather than returning zero chunks.
    """
    if not document_types:
        return None
    wanted = {t.strip().lower() for t in document_types if t and t.strip()}
    if not wanted:
        return None
    try:
        resp = (
            sb.table("documents")
            .select("id, source_type, document_type")
            .eq("user_id", user_id)
            .eq("course_id", course_id)
            .execute()
        )
    except Exception:  # noqa: BLE001
        log.exception("document-type resolution failed; falling back to course-wide")
        return None
    ids = [
        r["id"]
        for r in (resp.data or [])
        if (r.get("source_type") or "").lower() in wanted
        or (r.get("document_type") or "").lower() in wanted
    ]
    if not ids:
        log.info(
            "learning_agent: no documents matched types %s in course %s — course-wide",
            sorted(wanted), course_id,
        )
        return None
    return ids


def retrieve_learning_context(
    *,
    user_id: str,
    course_id: str,
    topic: str | None = None,
    query: str | None = None,
    document_types: list[str] | None = None,
    document_ids: list[str] | None = None,
    purpose: str | None = None,
    top_k: int | None = None,
) -> list[dict[str, Any]]:
    """Purpose-aware retrieval for the learning features.

    Wraps ``retrieve_chunks`` (vector + keyword + study-rerank). ``topic`` is
    used as the query when ``query`` isn't given. ``document_ids`` is an explicit
    hard filter (e.g. the user's selected exam sources) and takes precedence;
    otherwise ``document_types`` restricts to matching documents. Returns
    enriched chunk dicts (``to_api`` shape plus ``topic``/``purpose``).
    """
    q = (query or topic or "").strip()
    if not q:
        return []
    sb = get_supabase()
    if document_ids:
        resolved_ids: list[str] | None = document_ids
    else:
        resolved_ids = _resolve_document_ids_by_type(sb, user_id, course_id, document_types)
    document_ids = resolved_ids
    effective_top_k = top_k or _PURPOSE_TOP_K.get((purpose or "").lower(), 12)
    chunks = retrieve_chunks(
        user_id=user_id,
        course_id=course_id,
        query=q,
        document_ids=document_ids,
        top_k=effective_top_k,
    )
    out: list[dict[str, Any]] = []
    for c in chunks:
        d = c.to_api()
        d["topic"] = topic
        d["purpose"] = purpose
        out.append(d)
    return out


# ── course topic map ──────────────────────────────────────────────────────────

_WS_RE = re.compile(r"\s+")


def _normalize_topic(name: str) -> str:
    return _WS_RE.sub(" ", (name or "").strip().lower())


def _pages_from_chunk(row: dict[str, Any]) -> set[int]:
    ps, pe = row.get("page_start"), row.get("page_end")
    if not ps and not pe:
        return set()
    lo = ps or pe
    hi = pe or ps
    if lo is None or hi is None or hi < lo:
        return {p for p in (lo, hi) if p}
    # Cap the span so a malformed (1, 9999) range can't explode the set.
    return set(range(lo, min(hi, lo + 200) + 1))


def _rank_importance(chunk_count: int, max_count: int) -> str:
    """Relative importance from how much of the course a topic occupies."""
    if max_count <= 0:
        return "medium"
    ratio = chunk_count / max_count
    if ratio >= 0.6 or chunk_count >= 12:
        return "high"
    if ratio >= 0.25 or chunk_count >= 4:
        return "medium"
    return "low"


def _difficulty_from_types(type_counts: Counter) -> str:
    """Heuristic: formula/exercise-dense topics read as harder."""
    total = sum(type_counts.values())
    if total <= 0:
        return "medium"
    hard = type_counts.get("formula", 0) + type_counts.get("exercise", 0)
    if hard / total >= 0.5:
        return "high"
    if hard / total >= 0.2:
        return "medium"
    return "low"


def build_course_topic_map(user_id: str, course_id: str) -> list[dict[str, Any]]:
    """Aggregate the course's per-chunk topics into ``course_topics`` and return
    the stored map. Idempotent: replaces any existing rows for the course.

    Derived entirely from the user's own ``document_chunks`` — no LLM call, no
    external data, so it is cheap and safe to regenerate (e.g. after indexing).
    """
    sb = get_supabase()
    rows = (
        sb.table("document_chunks")
        .select("id, document_id, primary_topic, page_start, page_end, chunk_type, exercise_id")
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .not_.is_("primary_topic", "null")
        .execute()
    ).data or []

    agg: dict[str, dict[str, Any]] = {}
    for r in rows:
        name = (r.get("primary_topic") or "").strip()
        if not name:
            continue
        key = _normalize_topic(name)
        t = agg.setdefault(
            key,
            {
                "name": name,
                "chunk_ids": [],
                "doc_ids": set(),
                "pages": set(),
                "exercise_ids": set(),
                "types": Counter(),
            },
        )
        t["chunk_ids"].append(r["id"])
        if r.get("document_id"):
            t["doc_ids"].add(r["document_id"])
        t["pages"].update(_pages_from_chunk(r))
        if r.get("exercise_id"):
            t["exercise_ids"].add(r["exercise_id"])
        if r.get("chunk_type"):
            t["types"][r["chunk_type"]] += 1

    if not agg:
        # Nothing tagged yet (course not indexed under topic-tagging). Clear any
        # stale rows and return empty rather than leaving a misleading old map.
        sb.table("course_topics").delete().eq("user_id", user_id).eq("course_id", course_id).execute()
        return []

    max_count = max(len(t["chunk_ids"]) for t in agg.values())
    now = datetime.now(timezone.utc).isoformat()
    out_rows: list[dict[str, Any]] = []
    for key, t in agg.items():
        chunk_count = len(t["chunk_ids"])
        out_rows.append(
            {
                "user_id": user_id,
                "course_id": course_id,
                "name": t["name"],
                "normalized_name": key,
                "importance": _rank_importance(chunk_count, max_count),
                "difficulty": _difficulty_from_types(t["types"]),
                "chunk_count": chunk_count,
                "source_pages": sorted(t["pages"]),
                "source_chunk_ids": t["chunk_ids"],
                "source_document_ids": sorted(t["doc_ids"]),
                "related_exercise_ids": sorted(t["exercise_ids"]),
                "related_formula_ids": [],
                "updated_at": now,
            }
        )

    # Replace the course's map atomically-ish: delete then insert.
    sb.table("course_topics").delete().eq("user_id", user_id).eq("course_id", course_id).execute()
    for start in range(0, len(out_rows), 100):
        sb.table("course_topics").insert(out_rows[start:start + 100]).execute()

    log.info(
        "build_course_topic_map user=%s course=%s topics=%d (from %d tagged chunks)",
        user_id, course_id, len(out_rows), len(rows),
    )
    return get_course_topic_map(user_id, course_id)


def get_course_topic_map(user_id: str, course_id: str) -> list[dict[str, Any]]:
    """Return the stored topic map, importance-ranked (high → low)."""
    sb = get_supabase()
    rows = (
        sb.table("course_topics")
        .select(
            "name, normalized_name, summary, importance, difficulty, chunk_count, "
            "source_pages, source_document_ids, related_exercise_ids"
        )
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .execute()
    ).data or []
    order = {"high": 0, "medium": 1, "low": 2}
    rows.sort(key=lambda r: (order.get(r.get("importance"), 1), -(r.get("chunk_count") or 0)))
    return rows


# ── proactive recommendation ──────────────────────────────────────────────────


def get_next_best_action(user_id: str, course_id: str) -> dict[str, Any]:
    """Combine weak-topic memory with the topic map into a small ranked list of
    recommended next actions. Best-effort and non-blocking.

    Priority: weak topics the student has actually struggled with come first
    (reteach + practice), then high-importance topics not yet exercised.
    """
    weak = mastery.fetch_weak_topics(user_id, course_id)
    topic_map = get_course_topic_map(user_id, course_id)
    by_norm = {t["normalized_name"]: t for t in topic_map}

    actions: list[dict[str, Any]] = []
    seen: set[str] = set()

    for w in weak:
        key = _normalize_topic(w)
        seen.add(key)
        actions.append(
            {
                "type": "deep_learn",
                "topic": w,
                "reason": "weak topic — you've struggled with this",
                "importance": (by_norm.get(key) or {}).get("importance", "medium"),
            }
        )

    # Then fill with the most important topics not already flagged weak.
    for t in topic_map:
        if t["normalized_name"] in seen:
            continue
        if t.get("importance") != "high":
            continue
        actions.append(
            {
                "type": "examforge",
                "topic": t["name"],
                "reason": "high-importance course topic",
                "importance": "high",
            }
        )
        if len(actions) >= 5:
            break

    return {
        "courseId": course_id,
        "weakTopics": weak,
        "topicCount": len(topic_map),
        "actions": actions[:5],
    }


__all__ = (
    "PURPOSE_THRESHOLDS",
    "purpose_threshold",
    "retrieve_learning_context",
    "build_course_topic_map",
    "get_course_topic_map",
    "get_next_best_action",
)
