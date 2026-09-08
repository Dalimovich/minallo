"""Deterministic, privacy-safe user-facing execution commentary."""
from __future__ import annotations

from collections.abc import Callable
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


def _count(facts: dict[str, Any], key: str) -> int:
    value = facts.get(key)
    return int(value) if isinstance(value, int) and value >= 0 else 0


def _noun(count: int, singular: str) -> str:
    return f"{count} {singular if count == 1 else singular + 's'}"


def _label(facts: dict[str, Any], key: str) -> str | None:
    value = facts.get(key)
    return value if isinstance(value, str) and value else None


def _names(facts: dict[str, Any], key: str) -> list[str]:
    value = facts.get(key)
    return value if isinstance(value, list) and value else []


def _join(names: list[str]) -> str:
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    return f"{', '.join(names[:-1])}, and {names[-1]}"


# ── Per-stage formatters ──────────────────────────────────────────────────
# Each formatter follows the same specificity order: exact exercise/section
# → document+topic → document → course+topic → course → generic fallback.
# A detail is only ever mentioned when the corresponding fact key is present
# — nothing here invents a document, page, or exercise that wasn't resolved.

def _request_received(facts: dict[str, Any]) -> str:
    document = _label(facts, "document_name")
    course = _label(facts, "course_name")
    if document:
        return f"I'm checking your question against {document} and its selected sources."
    if course:
        return f"I'm checking your question against {course} and its selected sources."
    return "I'm checking the request and its selected sources first."


def _full_document_selected(facts: dict[str, Any]) -> str:
    document = _label(facts, "document_name")
    if document:
        return (f"This needs the complete document, so I'm processing {document} "
                "page by page rather than using relevance-only retrieval.")
    return ("This needs the complete source, so I'm using exhaustive document "
            "processing rather than relevance-only retrieval.")


def _visible_page_selected(facts: dict[str, Any]) -> str:
    page = _count(facts, "visible_page")
    document = _label(facts, "document_name")
    if page and document:
        return f"I'm grounding this answer to page {page} of {document} and its surrounding context."
    if page:
        return f"I'm grounding this answer to page {page} and its document context."
    return "I'm using the page currently open in the PDF viewer and its document context."


def _relevance_selected(facts: dict[str, Any]) -> str:
    course = _label(facts, "course_name")
    if course:
        return f"I'm searching {course} for the sections most relevant to your question."
    return "I'm searching the authorized course material for the sections most relevant to your question."


def _documents_authorized(facts: dict[str, Any]) -> str:
    names = _names(facts, "document_names")
    if names:
        verb = "its" if len(names) == 1 else "their"
        return f"I found and authorized {_join(names)} with {verb} indexed revision."
    count = _count(facts, "document_count")
    return f"I found and authorized {_noun(count, 'selected document')} with its indexed revision."


def _manifest_verified(facts: dict[str, Any]) -> str:
    pages = _count(facts, "expected_pages")
    document = _label(facts, "document_name")
    base = f"The index is ready. I'm processing all {_noun(pages, 'required page')}"
    if document:
        return f"{base} of {document} rather than using relevance-only retrieval."
    return f"{base} rather than using relevance-only retrieval."


def _retrieval_started(facts: dict[str, Any]) -> str:
    target = _label(facts, "exercise_label") or _label(facts, "section_label")
    document = _label(facts, "document_name")
    topic = _label(facts, "topic_label")
    course = _label(facts, "course_name")
    documents = _count(facts, "document_count")
    if document and target:
        return f"I'm searching {document} for {target} and its surrounding solution steps."
    if document and topic:
        return f"I'm searching {document} for the sections about {topic}."
    if document:
        return f"I'm searching {document} for the parts relevant to your question."
    if course and topic:
        return f"I'm searching {course} for {topic}."
    if course:
        return f"I'm searching the {course} material for the relevant sections."
    if topic:
        return f"I'm searching your course material for {topic}."
    if documents > 1:
        return f"I'm searching across your {documents} selected documents for the parts relevant to your question."
    return "I'm searching the selected course material for relevant sections and their surrounding context."


def _extraction_started(facts: dict[str, Any]) -> str:
    document = _label(facts, "document_name")
    topic = _label(facts, "topic_label")
    if document:
        return f"I'm scanning {document} for every requested item while preserving page references."
    if topic:
        return f"I'm scanning the course material for {topic}, preserving page references."
    return "I'm scanning the complete document for every requested item while preserving page references."


def _summarization_started(facts: dict[str, Any]) -> str:
    document = _label(facts, "document_name")
    if document:
        return f"I'm building page-level summaries of {document} before combining them into a complete summary."
    return "I'm building page-level summaries before combining them into a complete document summary."


def _comparison_started(facts: dict[str, Any]) -> str:
    names = _names(facts, "document_names")
    if len(names) >= 2:
        return f"I've processed {_join(names)} and I'm aligning their overlapping topics for comparison."
    return "I've processed the selected sources and I'm aligning their overlapping topics for comparison."


def _generation_started(facts: dict[str, Any]) -> str:
    topic = _label(facts, "topic_label")
    if topic:
        return f"I've finished reading the selected source material and I'm generating {topic} from that coverage."
    return ("I've finished reading the selected source material and I'm generating "
            "the requested material from that coverage.")


def _answer_validation_started(facts: dict[str, Any]) -> str:
    exercise = _label(facts, "exercise_label")
    document = _label(facts, "document_name")
    if exercise:
        return f"I have the answer for {exercise} and I'm checking its source references before sending it."
    if document:
        return f"I have the answer from {document} and I'm checking its source references before sending it."
    return "I have the answer and I'm checking its source references before sending it."


def _coverage_complete(facts: dict[str, Any]) -> str:
    pages = _count(facts, "expected_pages")
    return f"Coverage verification passed: all {_noun(pages, 'required page')} were processed."


def _recovery_started(facts: dict[str, Any]) -> str:
    document = _label(facts, "document_name")
    if document:
        return (f"A processing step for {document} was interrupted. I'm retrying it "
                "with the same saved sources and revisions.")
    return "A processing step was interrupted. I'm retrying it with the same saved sources and revisions."


def _web_search_started(facts: dict[str, Any]) -> str:
    topic = _label(facts, "topic_label")
    if topic:
        return f"I'm checking current web sources for {topic}."
    return "I'm checking current web sources because this question may depend on information that has changed."


_STAGE_FORMATTERS: dict[str, Callable[[dict[str, Any]], str]] = {
    "request_received": _request_received,
    "full_document_selected": _full_document_selected,
    "visible_page_selected": _visible_page_selected,
    "relevance_selected": _relevance_selected,
    "documents_authorized": _documents_authorized,
    "manifest_verified": _manifest_verified,
    "retrieval_started": _retrieval_started,
    "extraction_started": _extraction_started,
    "summarization_started": _summarization_started,
    "comparison_started": _comparison_started,
    "generation_started": _generation_started,
    "answer_validation_started": _answer_validation_started,
    "coverage_complete": _coverage_complete,
    "coverage_incomplete": lambda facts: (
        "Coverage verification is incomplete, so I won't present this as a complete-document result."
    ),
    "recovery_started": _recovery_started,
    "answer_ready": lambda facts: "The grounded answer is ready.",
    "document_indexing": lambda facts: (
        "The document has an identity, but its searchable index is still being prepared."
    ),
    "web_search_started": _web_search_started,
}


def format_commentary(stage: str, facts: dict[str, Any]) -> str:
    formatter = _STAGE_FORMATTERS.get(stage)
    if formatter is None:
        raise ValueError(f"unsupported commentary stage: {stage}")
    return formatter(facts)


def _safe_progress(progress: dict[str, Any]) -> dict[str, Any]:
    result = {key: int(progress[key]) for key in ("current", "total")
              if isinstance(progress.get(key), int) and progress[key] >= 0}
    if progress.get("unit") in {"pages", "documents", "batches", "sources", "items"}:
        result["unit"] = progress["unit"]
    return result


_MAX_LABEL_LENGTH = 80
_MAX_LIST_ITEMS = 3
_LABEL_KEYS = {
    "task", "intent", "course_name", "document_name",
    "section_label", "exercise_label", "topic_label", "pipeline", "access_mode",
}
_INT_KEYS = {"visible_page", "expected_pages", "processed_pages", "document_count"}


def _clean_label(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.split()).strip()
    return cleaned[:_MAX_LABEL_LENGTH] if cleaned else None


def _safe_facts(facts: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in facts.items():
        if key in _LABEL_KEYS:
            cleaned = _clean_label(value)
            if cleaned:
                result[key] = cleaned
        elif key == "document_names" and isinstance(value, list):
            cleaned_names = [name for name in (_clean_label(item) for item in value) if name]
            if cleaned_names:
                result[key] = cleaned_names[:_MAX_LIST_ITEMS]
        elif key in _INT_KEYS and isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            result[key] = value
    return result


__all__ = ["CommentaryEmitter", "CommentaryKind", "format_commentary"]
