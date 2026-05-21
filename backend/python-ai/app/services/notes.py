"""Notes / summary generation.

The brief was very specific:
  - Length scales with document size — no shallow paragraphs for long PDFs.
  - Structured sections: Overview, Main concepts, Definitions, Theorems,
    Formulas, Examples, Exercise patterns, Common mistakes, Exam-relevant,
    Short summary.
  - Stored as markdown in `notes.content_markdown`, with source-chunk
    traceability in `note_sources`.

We pull a larger context window than ask/quiz because the model needs to
see the whole document shape to write a complete summary. Pull from every
chunk if the document is small; rank+cap for large documents.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from .llm_json import chat_json
from .retrieval import RetrievedChunk, backfill_doc_names, retrieve_chunks
from ..supabase_client import get_supabase

log = logging.getLogger(__name__)


def _length_target(total_chunks: int, total_pages: int) -> tuple[int, str]:
    """Pick max_tokens + a verbal length cue based on the document size."""
    pages = total_pages or 1
    if pages <= 8:
        return 2200, "concise but complete (about 500-800 words of notes)"
    if pages <= 25:
        return 4500, "detailed (about 1200-1800 words of notes)"
    if pages <= 60:
        return 7500, "thorough (about 2200-3200 words of notes)"
    return 11000, "comprehensive long-form study guide (about 3500-5000 words of notes)"


def _system_prompt(length_cue: str) -> str:
    return f"""You are an expert tutor writing exam-prep notes for a university student from their uploaded course materials.

Write a {length_cue} markdown study document strictly using the COURSE CONTEXT below.

Structure — use ALL of these sections in this order, with `##` markdown headings:

## Overview
A short orientation: what the document is about, why a student would care, what they should be able to do after studying it.

## Main concepts
The key ideas, in order of importance. Bullet points.

## Definitions
Term — precise definition. Cite source as (filename, p.N).

## Theorems & key results
Statement, conditions, and significance. Cite source.

## Formulas
KaTeX rendered ($...$ inline, $$...$$ display). Explain every symbol. Cite source.

## Examples
Worked examples from the material. Show the steps.

## Exercise patterns
Typical exercise types the student should be able to solve, with the recipe.

## Common mistakes
Pitfalls the source explicitly mentions, or that a careful reader would extract.

## Exam-relevant points
What's most likely to be tested. Make this section actionable.

## Summary
4-7 bullet "Key Takeaways" lines.

Rules:
1. Use ONLY material from the context. Do NOT invent.
2. Inline citations like (filename, p.N) on every non-trivial claim.
3. If a section has no material in the context, write a single italic line saying so — don't fabricate.
4. Math in KaTeX.
5. Match the language of the source.

Return JSON: {{"text": "<markdown document>"}}"""


def _context_block(chunks: list[RetrievedChunk], doc_names: dict[str, str]) -> str:
    parts: list[str] = []
    for i, c in enumerate(chunks, 1):
        file_name = doc_names.get(c.document_id, "Unknown")
        pages = (
            f"p.{c.page_start}"
            if c.page_start and c.page_start == c.page_end
            else (f"pp.{c.page_start}-{c.page_end}" if c.page_start and c.page_end else "no-page")
        )
        head = f"[Source {i}] {file_name}, {pages}"
        if c.section_title:
            head += f"\nSection: {c.section_title}"
        parts.append(f"{head}\n{c.text}")
    return "\n\n---\n\n".join(parts)


def _page_count_estimate(sb, document_ids: list[str] | None, chunks: list[RetrievedChunk]) -> int:
    """Best-effort estimate so length scaling works without an extra hop."""
    if document_ids:
        try:
            resp = sb.table("documents").select("page_count").in_("id", document_ids).execute()
            total = sum((row.get("page_count") or 0) for row in (resp.data or []))
            if total:
                return total
        except Exception:
            log.exception("page_count lookup failed; falling back to chunk-based estimate")
    if chunks:
        return max((c.page_end or 0) for c in chunks)
    return 0


def generate_notes(
    *,
    user_id: str,
    course_id: str,
    document_ids: list[str] | None,
    topic: str | None,
    doc_names: dict[str, str],
) -> dict[str, Any]:
    query = (topic or "overview main concepts definitions formulas theorems examples exercise patterns common mistakes exam relevant").strip()
    sb = get_supabase()

    # For notes we want broad coverage — retrieve more chunks than ask/quiz.
    chunks = retrieve_chunks(
        user_id=user_id, course_id=course_id,
        query=query,
        document_ids=document_ids,
        top_k=40,
    )
    # Review-2 finding #5 — backfill source filenames for course-wide
    # generation (documentIds=None means doc_names starts empty).
    backfill_doc_names(chunks, doc_names)
    if not chunks:
        return {"text": "", "warning": "No relevant material found in the selected documents."}

    total_pages = _page_count_estimate(sb, document_ids, chunks)
    max_tokens, length_cue = _length_target(len(chunks), total_pages)

    context = _context_block(chunks, doc_names)

    try:
        res = chat_json(
            system=_system_prompt(length_cue),
            user="COURSE CONTEXT:\n\n" + context,
            max_tokens=max_tokens,
        )
    except Exception as e:  # noqa: BLE001
        log.exception("notes LLM call failed")
        return {"text": "", "error": str(e)}

    text = (res.data.get("text") if isinstance(res.data, dict) else "") or ""
    return {
        "text": text,
        "pageCount": total_pages,
        "lengthCue": length_cue,
        # Review-2 finding #6: `save_note` writes `note_sources` rows
        # with a ``document_id`` column, but the response dict omitted it.
        # Result: every saved note had NULL document_id and lost the
        # chunk→source linkage. Include documentId in the payload so the
        # save path can populate the FK.
        "groundedSources": [
            {
                "documentId": c.document_id,
                "fileName": doc_names.get(c.document_id, "Unknown"),
                "pageStart": c.page_start,
                "pageEnd": c.page_end,
                "chunkId": c.chunk_id,
            }
            for c in chunks[:20]
        ],
        "model": res.model,
        "promptTokens": res.prompt_tokens,
        "completionTokens": res.completion_tokens,
    }


def save_note(
    *,
    user_id: str,
    course_id: str,
    document_id: str | None,
    title: str,
    text: str,
    sources: list[dict[str, Any]],
) -> str | None:
    if not text.strip():
        return None
    sb = get_supabase()
    try:
        row = sb.table("notes").insert({
            "user_id":          user_id,
            "course_id":        course_id,
            "document_id":      document_id,
            "title":            title[:180] or "Untitled notes",
            "type":             "notes",
            "content_markdown": text,
            "updated_at":       datetime.now(timezone.utc).isoformat(),
        }).execute()
        note_id = row.data[0]["id"]
        if sources:
            src_rows = [
                {
                    "note_id":    note_id,
                    "document_id": s.get("documentId") or s.get("document_id"),
                    "chunk_id":   s.get("chunkId") or s.get("chunk_id"),
                    "page_start": s.get("pageStart") or s.get("page_start"),
                    "page_end":   s.get("pageEnd") or s.get("page_end"),
                    "quote_preview": (s.get("fileName") or "")[:200],
                }
                for s in sources[:40]
            ]
            try:
                sb.table("note_sources").insert(src_rows).execute()
            except Exception:
                log.exception("note_sources insert failed (non-fatal)")
        return note_id
    except Exception:
        log.exception("save_note failed")
        return None
