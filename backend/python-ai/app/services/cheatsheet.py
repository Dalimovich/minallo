"""Cheatsheet generation — Learning Agent Phase 4.

A cheatsheet is NOT a long study guide (that's notes.py). It is a dense,
exam-ready reference: the highest-value formulas, definitions and rules a
student wants on one page during revision. Two things make it a Learning
Agent feature rather than a second notes generator:

  * **Topic-Map driven.** Coverage and ordering come from the course Topic Map
    (``learning_agent.get_course_topic_map``) — high-importance topics first,
    so the densest page is spent on what matters most. An explicit ``topic``
    focuses the sheet on one area instead.
  * **Grounded retrieval.** Evidence is pooled per topic through
    ``retrieve_learning_context(purpose="cheatsheet")`` (broad fan-out), so
    every line traces back to the user's own chunks. No outside knowledge.

Output is markdown, stored via ``notes.save_note(note_type="cheatsheet")`` so
it reuses the notes table, RLS, CRUD endpoint and notes list — a cheatsheet is
just another generated document.
"""

from __future__ import annotations

import logging
from typing import Any

from .learning_agent import get_course_topic_map, retrieve_learning_context
from .llm_json import chat_json
from .notes import save_note
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

# A cheatsheet is dense but bounded. Generation runs ~40 tok/s on this account,
# so output length is the main driver of latency: keep topics/evidence modest so
# a full sheet generates in time for the edge proxy's upstream timeout.
_MAX_TOPICS = 10
_PER_TOPIC_TOP_K = 3
_MAX_EVIDENCE = 20

_SYSTEM = (
    "You are ExamForge by Minallo, writing a DENSE, exam-ready CHEATSHEET from a "
    "student's own course materials — a compressed, multi-column academic "
    "reference sheet (Hyperknow style), NOT a study guide or an AI summary.\n"
    "\n"
    "Use ONLY the provided COURSE CONTEXT. Do not use outside knowledge.\n"
    "\n"
    "STRUCTURE — organise by the topics given, in order (most important first), "
    "one `##` section per topic. Each section is a tight block:\n"
    "- Lead with a ONE-LINE definition / core idea.\n"
    "- Then the key FORMULAS (KaTeX: $...$ inline, $$...$$ display; name each "
    "symbol once; state assumptions/conditions).\n"
    "- Then SPECIAL CASES as a numbered list (e.g. `1. Uniform motion (a=0)`), "
    "each with its formula and the condition it needs.\n"
    "- Then terse notes / pitfalls. Bullets with a bold lead-in: "
    "`- **Term:** meaning`. One line each. No prose paragraphs, no intros.\n"
    "\n"
    "PRECISION (be slightly MORE precise than a generic cheatsheet):\n"
    "- Only formulas SUPPORTED BY THE CONTEXT. Never invent or guess a formula.\n"
    "- Distinguish general formulas from special cases; keep notation consistent; "
    "define a symbol the first time it is ambiguous; include key edge conditions.\n"
    "- If the context has nothing for a planned topic, OMIT it — never pad.\n"
    "- Match the language of the source material.\n"
    "\n"
    "EMPHASIS MARKERS (use exactly these; never inside a formula):\n"
    "- Wrap THE single most important fact/result of a block in ==double "
    "equals== (renders as a yellow highlight). At most one per block.\n"
    "- Begin a hard warning with `Important:` or `Critical:` (renders red).\n"
    "- Begin a soft remark with `Note:` (renders orange).\n"
    "- Wrap a key concept term in {{double braces}} (renders blue). Use "
    "sparingly — only genuinely central terms.\n"
    "\n"
    "SOURCES — keep them subtle: do NOT cite every line. Add a small "
    "`(filename, p.N)` only where a specific formula needs provenance, and end "
    "with one short `## Sources` list. Never spam citations.\n"
    "\n"
    'Return ONLY JSON: {"text":"<markdown cheatsheet>"}'
)


def _topic_names(topic_map: list[dict[str, Any]], topic_focus: str | None) -> list[str | None]:
    if topic_focus:
        return [topic_focus]
    names = [t.get("name") for t in (topic_map or []) if t.get("name")]
    return names[:_MAX_TOPICS] or [None]


def _pool_evidence(
    *,
    user_id: str,
    course_id: str,
    topics: list[str | None],
    document_ids: list[str] | None,
) -> list[dict[str, Any]]:
    """Retrieve a deduped, source-grounded evidence pool across the topics."""
    seen: set[str] = set()
    pooled: list[dict[str, Any]] = []
    for t in topics:
        try:
            chunks = retrieve_learning_context(
                user_id=user_id,
                course_id=course_id,
                topic=t,
                query=(t or "key formulas, definitions, rules, theorems"),
                document_ids=document_ids or None,
                purpose="cheatsheet",
                top_k=_PER_TOPIC_TOP_K,
            )
        except Exception:  # noqa: BLE001
            log.exception("cheatsheet evidence retrieval failed (topic=%s)", t)
            chunks = []
        for c in chunks:
            cid = c.get("chunkId")
            if cid and cid not in seen:
                seen.add(cid)
                pooled.append(c)
    return pooled[:_MAX_EVIDENCE]


def _backfill_doc_names(chunks: list[dict[str, Any]], doc_names: dict[str, str]) -> dict[str, str]:
    """Fill in filenames for any documentIds in ``chunks`` not already known.

    ``retrieve_learning_context`` returns ``to_api`` dicts, which carry no
    filename — so course-wide cheatsheets (no caller-supplied ``doc_names``)
    would otherwise cite "Unknown". Mirrors notes.backfill_doc_names but for
    dict chunks. Best-effort: lookup failures just leave "Unknown".
    """
    missing = {c.get("documentId") for c in chunks if c.get("documentId")} - set(doc_names)
    missing.discard(None)
    if not missing:
        return doc_names
    try:
        resp = (
            get_supabase().table("documents")
            .select("id, file_name")
            .in_("id", list(missing))
            .execute()
        )
        for row in (resp.data or []):
            if row.get("id") and row.get("file_name"):
                doc_names[row["id"]] = row["file_name"]
    except Exception:  # noqa: BLE001
        log.exception("cheatsheet doc-name backfill failed (non-fatal)")
    return doc_names


def _format_evidence(
    chunks: list[dict[str, Any]], doc_names: dict[str, str], topics: list[str | None]
) -> str:
    """Group evidence by planned topic so the model can write one section each.

    Each chunk is tagged with its filename + page for inline citation.
    """
    parts: list[str] = []
    topic_line = ", ".join(t for t in topics if t) or "the course"
    parts.append("TOPICS TO COVER (in this order): " + topic_line + "\n")
    for i, c in enumerate(chunks, 1):
        fn = doc_names.get(c.get("documentId") or "", "source")
        pg = c.get("pageStart")
        text = (c.get("text") or "").strip().replace("\r", " ")
        if len(text) > 700:
            text = text[:700] + " …"
        head = f"[Source {i}] {fn}" + (f", p.{pg}" if pg else "")
        parts.append(f"{head}\n{text}")
    return "\n\n---\n\n".join(parts)


def generate_cheatsheet(
    *,
    user_id: str,
    course_id: str,
    document_ids: list[str] | None,
    topic: str | None,
    doc_names: dict[str, str],
    save: bool = True,
) -> dict[str, Any]:
    """Generate (and optionally save) a grounded, Topic-Map-driven cheatsheet."""
    topic_query = (topic or "").strip() or None
    try:
        topic_map = get_course_topic_map(user_id, course_id)
    except Exception:  # noqa: BLE001
        log.exception("cheatsheet: topic map read failed")
        topic_map = []
    topics = _topic_names(topic_map, topic_query)

    evidence = _pool_evidence(
        user_id=user_id, course_id=course_id, topics=topics, document_ids=document_ids,
    )
    if not evidence:
        return {
            "text": "",
            "warning": "No relevant material found to build a cheatsheet from.",
            "groundedSources": [],
        }
    # Caller-supplied names (selected docs) take precedence; backfill the rest
    # so course-wide sheets still cite real filenames instead of "Unknown".
    merged_names = _backfill_doc_names(evidence, dict(doc_names or {}))

    title = (topic_query + " — Cheatsheet") if topic_query else "Course Cheatsheet"
    user = "COURSE CONTEXT:\n\n" + _format_evidence(evidence, merged_names, topics)
    try:
        # Keep output bounded: at ~40 tok/s a longer sheet blows the edge
        # proxy's upstream timeout. ~2800 tokens (a tight 1.5-page sheet) plus
        # the raised proxy timeout keeps generation inside the budget.
        res = chat_json(system=_SYSTEM, user=user, max_tokens=2800)
    except Exception as e:  # noqa: BLE001
        log.exception("cheatsheet LLM call failed")
        return {"text": "", "error": str(e), "groundedSources": []}

    text = (res.data.get("text") if isinstance(res.data, dict) else "") or ""
    sources = [
        {
            "documentId": c.get("documentId"),
            "fileName": merged_names.get(c.get("documentId") or "", "Unknown"),
            "pageStart": c.get("pageStart"),
            "pageEnd": c.get("pageEnd"),
            "chunkId": c.get("chunkId"),
        }
        for c in evidence
    ]

    note_id: str | None = None
    if save and text.strip():
        # Course-wide cheatsheets have no single document_id; per-doc selections
        # of exactly one document keep the FK so it shows under that document.
        single_doc = document_ids[0] if document_ids and len(document_ids) == 1 else None
        note_id = save_note(
            user_id=user_id,
            course_id=course_id,
            document_id=single_doc,
            title=title,
            text=text,
            sources=sources,
            note_type="cheatsheet",
        )

    return {
        "noteId": note_id,
        "title": title,
        "text": text,
        "topicsCovered": [t for t in topics if t],
        "groundedSources": sources[:20],
        "model": res.model,
        "promptTokens": res.prompt_tokens,
        "completionTokens": res.completion_tokens,
    }


__all__ = ("generate_cheatsheet",)
