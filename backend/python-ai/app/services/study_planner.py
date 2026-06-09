"""AI-Powered Weekly Mission Planner — Phase 1: document study profiles.

The deterministic TypeScript planner (``backend/lib/study-planner.ts``) pairs
files by filename numbers and fills time slots. This module gives the planner
real *study intelligence* about each document: what it teaches, at what depth,
what it presupposes, and how it should be used in a study plan.

To keep planning fast and cheap, each document is profiled **once** with a
single LLM call and cached in ``document_study_profiles``, keyed by the
document's content signature (``document_hash``/``indexed_at``). A profile is
rebuilt only when the document is re-indexed — never on a routine plan load.

Phase 2 (``generate-week``) consumes ``get_or_build_profiles`` to assemble the
weekly roadmap; this module owns only the per-file understanding layer.
"""

from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime, timezone
from typing import Any

from .document_intelligence import classify_document
from .llm_json import chat_json
from ..config import get_settings
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

# ── Profile contract ─────────────────────────────────────────────────────────
#
# A profile (the value stored in document_study_profiles.profile) is:
#   {
#     "documentId": str,
#     "fileName": str,
#     "documentRole": "lecture"|"exercise"|"solution"|"exam"|"summary"|"formula"|"other",
#     "topicsCovered": [ {"name", "confidence", "pageRange"?, "depth"} ],
#     "prerequisites": [str],
#     "estimatedStudyMinutes": int,
#     "recommendedUse": "learn_first"|"practice_after_lecture"|"check_after_exercise"
#                       |"review"|"exam_practice",
#     "summary": str,
#   }

_VALID_ROLES = {"lecture", "exercise", "solution", "exam", "summary", "formula", "other"}
_VALID_CONFIDENCE = {"confirmed", "high", "medium", "low"}
_VALID_DEPTH = {"intro", "core", "advanced", "exam"}
_VALID_USE = {
    "learn_first",
    "practice_after_lecture",
    "check_after_exercise",
    "review",
    "exam_practice",
}

# Map BOTH type vocabularies onto profile roles, so a missing/low-quality LLM
# read still gets a sane deterministic role. document_intelligence.classify_document
# emits the "*_sheet" vocabulary; documents.source_type uses the short one.
_TYPE_TO_ROLE = {
    # classifier (document_type) vocabulary
    "exercise_sheet": "exercise",
    "solution_sheet": "solution",
    "formula_sheet": "formula",
    "unknown": "other",
    # source_type vocabulary
    "exercise": "exercise",
    "solution": "solution",
    "notes": "summary",
    # shared
    "lecture": "lecture",
    "summary": "summary",
    "exam": "exam",
    "other": "other",
}


def _resolve_fallback_role(doc: dict[str, Any], file_name: str, digest: str) -> str:
    """Deterministic role when the LLM read is missing/unusable. Trusts an
    explicit stored type, else falls back to the filename+content classifier."""
    for key in (doc.get("document_type"), doc.get("source_type")):
        k = (key or "").strip().lower()
        # An explicit, non-default tag is trusted; a bare 'lecture' default is not.
        if k and k != "lecture" and k in _TYPE_TO_ROLE:
            return _TYPE_TO_ROLE[k]
    classified = classify_document(file_name, digest)
    return _TYPE_TO_ROLE.get(classified, "other")

_ROLE_DEFAULT_USE = {
    "lecture": "learn_first",
    "exercise": "practice_after_lecture",
    "solution": "check_after_exercise",
    "exam": "exam_practice",
    "summary": "review",
    "formula": "review",
    "other": "review",
}


def _signature(doc: dict[str, Any]) -> str:
    """Content-identity signature used to detect a stale cached profile."""
    return str(doc.get("document_hash") or doc.get("indexed_at") or doc.get("id") or "")


def _coerce_profile(raw: Any, doc: dict[str, Any], fallback_role: str) -> dict[str, Any]:
    """Validate + normalize the LLM's JSON into the profile contract.

    The planner trusts these fields, so anything malformed is repaired to a safe
    default rather than propagated. Never raises — a bad LLM read degrades to a
    deterministic profile, it does not break plan generation.
    """
    doc_id = str(doc.get("id") or "")
    file_name = str(doc.get("file_name") or "")
    obj = raw if isinstance(raw, dict) else {}

    role = str(obj.get("documentRole") or "").strip().lower()
    if role not in _VALID_ROLES:
        role = fallback_role

    topics_out: list[dict[str, Any]] = []
    raw_topics = obj.get("topicsCovered")
    if isinstance(raw_topics, list):
        for t in raw_topics:
            if not isinstance(t, dict):
                continue
            name = str(t.get("name") or "").strip()
            if not name:
                continue
            conf = str(t.get("confidence") or "medium").strip().lower()
            depth = str(t.get("depth") or "core").strip().lower()
            entry: dict[str, Any] = {
                "name": name[:160],
                "confidence": conf if conf in _VALID_CONFIDENCE else "medium",
                "depth": depth if depth in _VALID_DEPTH else "core",
            }
            page_range = t.get("pageRange")
            if isinstance(page_range, (str, int)) and str(page_range).strip():
                entry["pageRange"] = str(page_range).strip()[:32]
            topics_out.append(entry)
            if len(topics_out) >= 40:
                break

    prereqs_out: list[str] = []
    raw_prereqs = obj.get("prerequisites")
    if isinstance(raw_prereqs, list):
        for p in raw_prereqs:
            s = str(p or "").strip()
            if s:
                prereqs_out.append(s[:160])
            if len(prereqs_out) >= 20:
                break

    try:
        est = int(obj.get("estimatedStudyMinutes"))
    except (TypeError, ValueError):
        est = 0
    if est <= 0:
        # Fall back to a page-count heuristic (~2 min/page, clamped).
        pages = doc.get("page_count") or 0
        est = max(10, min(90, int(pages) * 2)) if pages else 30
    est = max(5, min(180, est))

    use = str(obj.get("recommendedUse") or "").strip().lower()
    if use not in _VALID_USE:
        use = _ROLE_DEFAULT_USE.get(role, "review")

    summary = str(obj.get("summary") or "").strip()[:600]

    return {
        "documentId": doc_id,
        "fileName": file_name,
        "documentRole": role,
        "topicsCovered": topics_out,
        "prerequisites": prereqs_out,
        "estimatedStudyMinutes": est,
        "recommendedUse": use,
        "summary": summary,
    }


def _chunk_digest(chunks: list[dict[str, Any]]) -> str:
    """Compact, LLM-friendly digest of a document's tagged chunks: topic →
    page span + chunk-type mix. Keeps the prompt small (we profile from the
    indexer's structured tags, not the full document text)."""
    by_topic: dict[str, dict[str, Any]] = {}
    for c in chunks:
        topic = (c.get("primary_topic") or "").strip()
        if not topic:
            continue
        agg = by_topic.setdefault(topic, {"pages": set(), "types": Counter()})
        ps, pe = c.get("page_start"), c.get("page_end")
        for p in (ps, pe):
            if isinstance(p, int):
                agg["pages"].add(p)
        ct = c.get("chunk_type")
        if ct:
            agg["types"][ct] += 1

    lines: list[str] = []
    for topic, agg in sorted(by_topic.items(), key=lambda kv: -sum(kv[1]["types"].values())):
        pages = sorted(agg["pages"])
        span = f"p.{pages[0]}-{pages[-1]}" if len(pages) >= 2 else (f"p.{pages[0]}" if pages else "")
        types = ", ".join(f"{k}×{v}" for k, v in agg["types"].most_common(3))
        lines.append(f"- {topic} ({span}; {types})" if span or types else f"- {topic}")
        if len(lines) >= 40:
            break
    return "\n".join(lines)


_PROFILE_SYSTEM = (
    "You are a study-planning analyst. Given a course document's metadata and the "
    "topics its indexed chunks cover, produce a concise STUDY PROFILE describing "
    "what the document teaches and how a student should use it. "
    "Return STRICT JSON only, matching this schema:\n"
    '{"documentRole":"lecture|exercise|solution|exam|summary|formula|other",'
    '"topicsCovered":[{"name":str,"confidence":"confirmed|high|medium|low",'
    '"pageRange":str?,"depth":"intro|core|advanced|exam"}],'
    '"prerequisites":[str],"estimatedStudyMinutes":int,'
    '"recommendedUse":"learn_first|practice_after_lecture|check_after_exercise|review|exam_practice",'
    '"summary":str}\n'
    "Rules: a solution sheet is NEVER an exercise (role=solution, use=check_after_exercise). "
    "Lectures teach (use=learn_first); exercise sheets are practiced after their lecture. "
    "Only list topics the document actually covers. Keep summary under 2 sentences."
)


def build_document_profile(doc: dict[str, Any], chunks: list[dict[str, Any]]) -> dict[str, Any]:
    """Build one document's study profile via a single LLM call, with a
    deterministic fallback. Pure w.r.t. the DB — caller persists the result."""
    file_name = str(doc.get("file_name") or "")
    digest = _chunk_digest(chunks)
    # Deterministic role seeds the fallback and gives the LLM a strong prior.
    stored_type = (doc.get("document_type") or doc.get("source_type") or "").strip().lower()
    fallback_role = _resolve_fallback_role(doc, file_name, digest)

    user_prompt = (
        f"File name: {file_name}\n"
        f"Declared type: {stored_type or 'unknown'}\n"
        f"Page count: {doc.get('page_count') or 'unknown'}\n"
        f"Topics covered by indexed chunks:\n{digest or '(no tagged topics)'}\n"
    )

    try:
        settings = get_settings()
        result = chat_json(
            system=_PROFILE_SYSTEM,
            user=user_prompt,
            model=settings.openai_generate_model,
            max_tokens=900,
        )
        return _coerce_profile(result.data, doc, fallback_role)
    except Exception:  # noqa: BLE001
        log.exception("profile LLM failed for document %s; using deterministic fallback", doc.get("id"))
        return _coerce_profile(None, doc, fallback_role)


def get_or_build_profiles(
    user_id: str,
    course_id: str,
    *,
    force: bool = False,
) -> list[dict[str, Any]]:
    """Return study profiles for every ready document in the course, building
    (and caching) any that are missing or stale. ``force`` rebuilds all.

    This is the planner's document-understanding entry point: cheap on repeat
    calls (only re-indexed documents trigger an LLM call)."""
    sb = get_supabase()

    docs = (
        sb.table("documents")
        .select("id, file_name, source_type, document_type, processing_status, page_count, document_hash, indexed_at")
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .eq("processing_status", "ready")
        .execute()
    ).data or []
    if not docs:
        return []

    existing_rows = (
        sb.table("document_study_profiles")
        .select("document_id, source_signature, profile")
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .execute()
    ).data or []
    cached: dict[str, dict[str, Any]] = {r["document_id"]: r for r in existing_rows}

    # Pull all chunks for the course once, grouped by document, to avoid an N+1.
    chunk_rows = (
        sb.table("document_chunks")
        .select("document_id, primary_topic, page_start, page_end, chunk_type")
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .not_.is_("primary_topic", "null")
        .execute()
    ).data or []
    chunks_by_doc: dict[str, list[dict[str, Any]]] = {}
    for c in chunk_rows:
        chunks_by_doc.setdefault(c.get("document_id"), []).append(c)

    settings = get_settings()
    now = datetime.now(timezone.utc).isoformat()
    out: list[dict[str, Any]] = []
    upserts: list[dict[str, Any]] = []

    for doc in docs:
        doc_id = doc["id"]
        sig = _signature(doc)
        prior = cached.get(doc_id)
        if not force and prior and prior.get("source_signature") == sig and isinstance(prior.get("profile"), dict) and prior["profile"]:
            out.append(prior["profile"])
            continue

        profile = build_document_profile(doc, chunks_by_doc.get(doc_id, []))
        out.append(profile)
        upserts.append(
            {
                "user_id": user_id,
                "course_id": course_id,
                "document_id": doc_id,
                "source_signature": sig,
                "profile": profile,
                "model": settings.openai_generate_model,
                "updated_at": now,
            }
        )

    if upserts:
        # on_conflict=document_id → refresh the cached profile in place.
        sb.table("document_study_profiles").upsert(upserts, on_conflict="document_id").execute()
        log.info(
            "study_planner: built %d/%d document profiles for course %s",
            len(upserts), len(docs), course_id,
        )

    return out


__all__ = (
    "build_document_profile",
    "get_or_build_profiles",
)
