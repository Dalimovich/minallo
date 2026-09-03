"""Deterministic, privacy-safe user-facing execution commentary."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any


class CommentaryKind(StrEnum):
    ORIENTATION = "orientation"
    SOURCE_RESOLUTION = "source_resolution"
    RETRIEVAL = "retrieval"
    DOCUMENT_PROCESSING = "document_processing"
    WEB_SEARCH = "web_search"
    ANALYSIS = "analysis"
    VALIDATION = "validation"
    TOOL_ACTION = "tool_action"
    RECOVERY = "recovery"
    COMPLETION = "completion"


@dataclass
class CommentaryEmitter:
    request_id: str
    _sequence: int = field(default=0, init=False)

    def emit(self, *, kind: CommentaryKind | str, stage: str,
             facts: dict[str, Any] | None = None,
             progress: dict[str, Any] | None = None,
             replace_key: str | None = None) -> dict[str, Any]:
        facts = _safe_facts(facts or {})
        self._sequence += 1
        event: dict[str, Any] = {
            "type": "commentary", "eventId": f"{self.request_id}:commentary:{self._sequence}",
            "eventSequence": self._sequence, "requestId": self.request_id,
            "kind": CommentaryKind(kind).value, "stage": stage, "facts": facts,
            "message": format_commentary(stage, facts),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        if progress:
            event["progress"] = _safe_progress(progress)
        if replace_key:
            event["replaceKey"] = replace_key
        return event


def format_commentary(stage: str, facts: dict[str, Any]) -> str:
    pages, documents, page = (_count(facts, key) for key in
                               ("expected_pages", "document_count", "visible_page"))
    templates = {
        "request_received": "I'm checking the request and its selected sources first.",
        "full_document_selected": "This needs the complete source, so I'm using exhaustive document processing rather than relevance-only retrieval.",
        "visible_page_selected": f"I'm grounding this answer to page {page} and its document context." if page else "I'm using the page currently open in the PDF viewer and its document context.",
        "relevance_selected": "I'm searching the authorized course material for the sections most relevant to your question.",
        "documents_authorized": f"I found and authorized {_noun(documents, 'selected document')} with its indexed revision.",
        "manifest_verified": f"The index is ready. I'm processing all {_noun(pages, 'required page')} rather than using relevance-only retrieval.",
        "retrieval_started": "I'm searching the selected course material for relevant sections and their surrounding context.",
        "extraction_started": "I'm scanning the complete document for every requested item while preserving page references.",
        "summarization_started": "I'm building page-level summaries before combining them into a complete document summary.",
        "comparison_started": "I've processed the selected sources and I'm aligning their overlapping topics for comparison.",
        "generation_started": "I've finished reading the selected source material and I'm generating the requested material from that coverage.",
        "answer_validation_started": "I have the answer and I'm checking its source references before sending it.",
        "coverage_complete": f"Coverage verification passed: all {_noun(pages, 'required page')} were processed.",
        "coverage_incomplete": "Coverage verification is incomplete, so I won't present this as a complete-document result.",
        "recovery_started": "A processing step was interrupted. I'm retrying it with the same saved sources and revisions.",
        "answer_ready": "The grounded answer is ready.",
        "document_indexing": "The document has an identity, but its searchable index is still being prepared.",
        "web_search_started": "I'm checking current web sources because this question may depend on information that has changed.",
    }
    if stage not in templates:
        raise ValueError(f"unsupported commentary stage: {stage}")
    return templates[stage]


def _count(facts: dict[str, Any], key: str) -> int:
    value = facts.get(key)
    return int(value) if isinstance(value, int) and value >= 0 else 0


def _noun(count: int, singular: str) -> str:
    return f"{count} {singular if count == 1 else singular + 's'}"


def _safe_progress(progress: dict[str, Any]) -> dict[str, Any]:
    result = {key: int(progress[key]) for key in ("current", "total")
              if isinstance(progress.get(key), int) and progress[key] >= 0}
    if progress.get("unit") in {"pages", "documents", "batches", "sources", "items"}:
        result["unit"] = progress["unit"]
    return result


def _safe_facts(facts: dict[str, Any]) -> dict[str, Any]:
    allowed = {"expected_pages", "processed_pages", "document_count", "visible_page",
               "candidate_count", "failed_pages", "pipeline", "access_mode"}
    return {key: value for key, value in facts.items()
            if key in allowed and isinstance(value, (str, int, bool))}


__all__ = ["CommentaryEmitter", "CommentaryKind", "format_commentary"]
