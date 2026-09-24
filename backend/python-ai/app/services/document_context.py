"""Shared Document Understanding context for AI features.

Every feature that grounds on selected documents loads this BEFORE prompting so
its behaviour adapts to what the sources actually are — an exam is understood,
a lecture is taught, a solution sheet's reasoning is explained, etc. Reads the
persisted document_understanding + user_document_type_override (Stages 1–2); no
LLM, resilient to a not-yet-applied migration.

Typical use in a feature:

    from .document_context import understanding_block_for_ids
    block = understanding_block_for_ids(document_ids, user_id=user_id)
    user_message = (block + "\\n\\n" if block else "") + "COURSE CONTEXT:\\n\\n" + context
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Iterable

from .document_intelligence import LOW_CONFIDENCE_THRESHOLD, effective_document_type
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

_TYPE_LABEL = {
    "exam": "Exam",
    "lecture": "Lecture",
    "slides": "Slides",
    "textbook_chapter": "Textbook chapter",
    "exercise_sheet": "Exercise sheet",
    "solution_sheet": "Solution sheet",
    "summary": "Summary",
    "cheat_sheet": "Cheat sheet / Formula sheet",
    "formula_sheet": "Cheat sheet / Formula sheet",
    "assignment": "Assignment",
    "unknown": "Unknown",
}

# A concrete type maps to one behaviour-rule bucket.
_RULE_BUCKET = {
    "exam": "exam",
    "lecture": "lecture", "slides": "lecture", "textbook_chapter": "lecture",
    "exercise_sheet": "exercise", "assignment": "exercise",
    "solution_sheet": "solution",
    "summary": "reference", "cheat_sheet": "reference", "formula_sheet": "reference",
    "unknown": "unknown",
}

# Only the rules for buckets actually present in the selection are emitted.
_BEHAVIOUR_RULES = {
    "exam": (
        "Exam: treat as ONE uploaded exam. Explain what each task tests, the "
        "methods/knowledge required, common traps, and what course context is "
        "needed — do NOT infer broad course predictions from a single exam, and "
        "make clear the explanation is based on one uploaded exam."
    ),
    "lecture": (
        "Lecture/slides/textbook: TEACH the material — definitions, core concepts, "
        "worked examples, and how topics connect."
    ),
    "exercise": (
        "Exercise sheet/assignment: explain the underlying concepts and how to set "
        "up each problem. Produce full step-by-step solutions ONLY when explicitly "
        "asked."
    ),
    "solution": (
        "Solution sheet: explain the REASONING behind the provided solutions; do "
        "NOT treat a solved problem as a fresh unsolved task."
    ),
    "reference": (
        "Summary/cheat sheet/formula sheet: compressed reference material — use it "
        "for recall and lookups; do NOT over-extrapolate full-course coverage."
    ),
    "unknown": (
        "Some sources have an uncertain type — use cautious, generic behaviour and "
        "avoid strong type-specific assumptions."
    ),
}


@dataclass
class DocContext:
    document_id: str
    file_name: str | None
    effective_type: str
    confidence: float
    low_confidence: bool
    user_override: bool
    detected_language: str | None = None
    subject_name: str | None = None
    topic_area: str | None = None
    content_flags: dict[str, bool] = field(default_factory=dict)


def _confidence_word(c: float) -> str:
    if c >= 0.85:
        return "high"
    if c >= LOW_CONFIDENCE_THRESHOLD:
        return "medium"
    return "low"


def _effective_bucket(c: DocContext) -> str:
    # A low-confidence classifier guess (with no user override) is treated as
    # 'unknown' so we don't apply strong type behaviour we're not sure about.
    if c.low_confidence and not c.user_override:
        return "unknown"
    return _RULE_BUCKET.get(c.effective_type, "unknown")


def load_document_understanding(
    document_ids: Iterable[str] | None,
    *,
    user_id: str | None = None,
) -> dict[str, DocContext]:
    """Load understanding for the given documents. Resilient: if the Stage-1
    columns don't exist yet, falls back to the always-present ones."""
    ids = [d for d in (document_ids or []) if d]
    if not ids:
        return {}
    sb = get_supabase()
    full_cols = (
        "id, file_name, source_type, document_type, document_type_confidence, "
        "user_document_type_override, document_understanding"
    )

    def _query(cols: str):
        q = sb.table("documents").select(cols).in_("id", ids)
        if user_id:
            q = q.eq("user_id", user_id)
        return (q.execute().data) or []

    try:
        rows = _query(full_cols)
    except Exception:  # noqa: BLE001 — migration may not be applied yet
        log.exception("load_document_understanding: full select failed, falling back")
        try:
            rows = _query("id, file_name, source_type, document_type")
        except Exception:  # noqa: BLE001
            log.exception("load_document_understanding: fallback select failed")
            return {}

    out: dict[str, DocContext] = {}
    for r in rows:
        u = r.get("document_understanding")
        u = u if isinstance(u, dict) else {}
        classifier_type = r.get("document_type") or u.get("document_type")
        override = r.get("user_document_type_override")
        eff = effective_document_type(classifier_type, override, r.get("source_type"))
        conf = r.get("document_type_confidence")
        if conf is None:
            conf = u.get("document_type_confidence")
        conf = float(conf) if conf is not None else 0.0
        out[r["id"]] = DocContext(
            document_id=r["id"],
            file_name=r.get("file_name"),
            effective_type=eff,
            confidence=conf,
            low_confidence=(not override and conf < LOW_CONFIDENCE_THRESHOLD),
            user_override=bool(override),
            detected_language=u.get("detected_language"),
            subject_name=u.get("subject_name"),
            topic_area=u.get("topic_area"),
            content_flags=u.get("content_flags") or {},
        )
    return out


def build_understanding_prompt_block(contexts: Iterable[DocContext]) -> str:
    """Render the shared 'selected source types + behaviour rules' prompt block.
    Empty string when there's nothing useful to add."""
    ctxs = [c for c in contexts if c]
    if not ctxs:
        return ""
    type_parts: list[str] = []
    buckets: list[str] = []
    for c in ctxs:
        label = _TYPE_LABEL.get(c.effective_type, c.effective_type)
        conf = "user-set" if c.user_override else f"{_confidence_word(c.confidence)} confidence"
        type_parts.append(f"{label} ({conf})")
        b = _effective_bucket(c)
        if b not in buckets:
            buckets.append(b)
    lines = ["SELECTED SOURCE TYPES: " + "; ".join(type_parts) + "."]
    lines.append("SOURCE-TYPE BEHAVIOR RULES:")
    lines.extend("- " + _BEHAVIOUR_RULES[b] for b in buckets)
    return "\n".join(lines)


def understanding_block_for_ids(
    document_ids: Iterable[str] | None,
    *,
    user_id: str | None = None,
) -> str:
    """Load + render in one call. Safe to call inline before prompting; returns
    '' (and never raises) when there's nothing to add."""
    try:
        ctxs = load_document_understanding(document_ids, user_id=user_id)
        return build_understanding_prompt_block(ctxs.values())
    except Exception:  # noqa: BLE001 — understanding is additive, never fatal
        log.exception("understanding_block_for_ids failed")
        return ""


def source_type_buckets(
    document_ids: Iterable[str] | None,
    *,
    user_id: str | None = None,
) -> dict[str, int]:
    """Count selected documents per behaviour bucket (exam/lecture/exercise/
    solution/reference/unknown). Lets a feature adapt to WHAT the selection is
    — e.g. exam generation choosing a calculation vs theory style. Best-effort:
    returns ``{}`` on any failure or when the migration isn't applied yet."""
    try:
        ctxs = load_document_understanding(document_ids, user_id=user_id)
    except Exception:  # noqa: BLE001 — additive, never fatal
        log.exception("source_type_buckets failed")
        return {}
    counts: dict[str, int] = {}
    for c in ctxs.values():
        bucket = _effective_bucket(c)
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


__all__ = (
    "DocContext",
    "build_understanding_prompt_block",
    "load_document_understanding",
    "source_type_buckets",
    "understanding_block_for_ids",
)
