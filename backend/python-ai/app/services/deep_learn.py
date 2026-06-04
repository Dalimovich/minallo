"""Deep Learn — Learning Agent Phase 5.

A guided, single-topic deep-dive built entirely from the student's own
materials. Given a topic (normally chosen from the course Topic Map), it
retrieves the most relevant chunks via ``retrieve_learning_context(
purpose="deep_learn")`` and produces a structured, grounded lesson:

    explanation  →  worked example  →  one self-check question

Every non-trivial claim cites a source page; nothing is invented. The lesson
is returned structured (so the UI can render the parts distinctly) plus a
grounded source list with the same index/documentId/pageStart shape the answer
pipeline uses, so the sources are clickable.

Deep Learn is read-only/ephemeral for now: it does not persist lessons or write
mastery (the self-check is reveal-only). That keeps it additive and safe.
"""

from __future__ import annotations

import logging
from typing import Any

from .learning_agent import retrieve_learning_context
from .llm_json import chat_json
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)

_TOP_K = 8

_SYSTEM = (
    "You are ExamForge by Minallo, teaching ONE topic to a university student "
    "using ONLY their uploaded course materials.\n"
    "\n"
    "Use ONLY the provided COURSE CONTEXT. Do not use outside knowledge. Cite the "
    "source of each non-trivial claim inline as (filename, p.N). Math in KaTeX "
    "($...$ inline, $$...$$ display). Match the language of the source material.\n"
    "\n"
    "Produce a focused, exam-oriented deep-dive on the requested topic with three "
    "parts:\n"
    "1. lesson — a clear, structured explanation of the topic: the key idea(s), "
    "the definitions and formulas that matter, and when/why they apply. Use `##` "
    "subheadings and bullets. Build understanding, don't just list.\n"
    "2. workedExample — ONE concrete worked example taken from or directly "
    "supported by the context, solved step by step. If the context has no "
    "example, construct the simplest faithful one from the cited formulas and say "
    "so.\n"
    "3. check — ONE self-check question that tests the core of the topic, with a "
    "concise model answer and a one-line explanation.\n"
    "\n"
    "If the context does not actually cover the topic, set lesson to a short "
    "honest note saying the materials don't cover it and leave workedExample "
    "empty.\n"
    "\n"
    'Return ONLY JSON: {"title":"","lesson":"<markdown>","workedExample":"<markdown>",'
    '"check":{"question":"","answer":"","explanation":""}}'
)


def _backfill_doc_names(chunks: list[dict[str, Any]], doc_names: dict[str, str]) -> dict[str, str]:
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
        log.exception("deep_learn doc-name backfill failed (non-fatal)")
    return doc_names


def _format_evidence(chunks: list[dict[str, Any]], doc_names: dict[str, str]) -> str:
    out: list[str] = []
    for i, c in enumerate(chunks, 1):
        fn = doc_names.get(c.get("documentId") or "", "source")
        pg = c.get("pageStart")
        text = (c.get("text") or "").strip().replace("\r", " ")
        if len(text) > 900:
            text = text[:900] + " …"
        out.append(f"[Source {i}] {fn}" + (f", p.{pg}" if pg else "") + f"\n{text}")
    return "\n\n---\n\n".join(out)


def _sources(chunks: list[dict[str, Any]], doc_names: dict[str, str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, c in enumerate(chunks, 1):
        out.append({
            "index": i,
            "documentId": c.get("documentId"),
            "fileName": doc_names.get(c.get("documentId") or "", "Unknown"),
            "pageStart": c.get("pageStart"),
            "pageEnd": c.get("pageEnd"),
        })
    return out


def generate_deep_learn(
    *,
    user_id: str,
    course_id: str,
    topic: str,
    document_ids: list[str] | None,
    doc_names: dict[str, str],
) -> dict[str, Any]:
    """Generate a grounded, single-topic deep-dive lesson."""
    topic = (topic or "").strip()
    if not topic:
        return {"error": "A topic is required for Deep Learn.", "topic": topic}

    try:
        chunks = retrieve_learning_context(
            user_id=user_id,
            course_id=course_id,
            topic=topic,
            query=topic,
            document_ids=document_ids or None,
            purpose="deep_learn",
            top_k=_TOP_K,
        )
    except Exception:  # noqa: BLE001
        log.exception("deep_learn retrieval failed (topic=%s)", topic)
        chunks = []

    if not chunks:
        return {
            "topic": topic,
            "title": topic,
            "lesson": "",
            "workedExample": "",
            "check": None,
            "warning": "No material found for this topic in your uploaded files.",
            "groundedSources": [],
        }

    merged_names = _backfill_doc_names(chunks, dict(doc_names or {}))
    user = (
        "TOPIC TO TEACH: " + topic + "\n\nCOURSE CONTEXT:\n\n"
        + _format_evidence(chunks, merged_names)
    )
    try:
        res = chat_json(system=_SYSTEM, user=user, max_tokens=3000)
    except Exception as e:  # noqa: BLE001
        log.exception("deep_learn generation failed")
        return {"topic": topic, "title": topic, "error": str(e), "groundedSources": []}

    data = res.data if isinstance(res.data, dict) else {}
    check_raw = data.get("check") if isinstance(data.get("check"), dict) else {}
    check = None
    if check_raw and str(check_raw.get("question") or "").strip():
        check = {
            "question": str(check_raw.get("question") or ""),
            "answer": str(check_raw.get("answer") or ""),
            "explanation": str(check_raw.get("explanation") or ""),
        }

    return {
        "topic": topic,
        "title": str(data.get("title") or topic),
        "lesson": str(data.get("lesson") or ""),
        "workedExample": str(data.get("workedExample") or ""),
        "check": check,
        "groundedSources": _sources(chunks, merged_names),
        "model": res.model,
        "promptTokens": res.prompt_tokens,
        "completionTokens": res.completion_tokens,
    }


__all__ = ("generate_deep_learn",)
