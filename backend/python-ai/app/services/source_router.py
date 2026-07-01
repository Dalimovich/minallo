"""Source-scope routing for Minallo answers.

This module decides where answer facts should come from. It is intentionally
separate from ``answer_intent.py``, which only decides answer format.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class SourceMode(str, Enum):
    AUTO = "auto"
    COURSE_FILES = "course_files"
    INTERNET = "internet"


class SourceScope(str, Enum):
    COURSE_FILES = "course_files"
    INTERNET = "internet"
    GENERAL_KNOWLEDGE = "general_knowledge"
    NEEDS_CLARIFICATION = "needs_clarification"


class CourseFileScope(str, Enum):
    ALL_COURSE_FILES = "all_course_files"
    SPECIFIC_FILES = "specific_files"


@dataclass(frozen=True)
class SourceDecision:
    selected_source_mode: SourceMode
    source_scope: SourceScope
    course_file_scope: CourseFileScope
    source_label: str
    used_document_ids: list[str] = field(default_factory=list)
    relevance_score: float | None = None
    web_search_used: bool = False
    sanitized_web_query: str | None = None
    needs_clarification_message: str | None = None

    def metadata(self, *, include_debug: bool = False, cache_hit: bool | None = None) -> dict[str, Any]:
        out: dict[str, Any] = {
            "selectedSourceMode": self.selected_source_mode.value,
            "sourceScope": self.source_scope.value,
            "courseFileScope": self.course_file_scope.value,
            "sourceLabel": self.source_label,
        }
        if include_debug:
            out["sourceDebug"] = {
                "selectedSourceMode": self.selected_source_mode.value,
                "resolvedSourceScope": self.source_scope.value,
                "courseFileScope": self.course_file_scope.value,
                "usedDocumentIds": self.used_document_ids,
                "relevanceScore": self.relevance_score,
                "webSearchUsed": self.web_search_used,
                "cacheHit": cache_hit,
            }
        return out


_COURSE_SIGNAL_RE = re.compile(
    r"\b("
    r"this|these|pdf|page|slide|lecture|uploaded|file|document|selected text|"
    r"course|professor|exercise|aufgabe|uebung|übung|formula|formel|figure|"
    r"according to|summari[sz]e this|explain this|solve this|from this"
    r")\b",
    re.IGNORECASE,
)
_INTERNET_SIGNAL_RE = re.compile(
    r"\b("
    r"latest|current|today|now|recent|newest|news|price|pricing|cost of|"
    r"competitors?|market|statistics?|law updates?|rule changes?|release date|"
    r"official website|online sources?|find sources online|202[5-9]|"
    r"youtube|website|webseite|wikipedia|google"
    r")\b",
    re.IGNORECASE,
)
# A pasted link is the strongest possible internet signal: the answer cannot
# come from course files or model knowledge, only from fetching the page. In
# AUTO mode it outranks every course signal — "can you watch THIS video"
# contains the course-signal word "this", which used to route URL questions
# into course retrieval and end in a "I can't access external content" shrug.
# Bare domains are limited to a few well-known content sites: generic TLD
# matching collides with study subjects that are literally named after
# domains (ASP.NET, socket.io) and German abbreviations ("z.B."). Pasted
# links carry https:// or www. anyway.
_URL_RE = re.compile(
    r"(?:https?://|www\.)\S+"
    r"|\byoutu\.be/\S+"
    r"|\b(?:youtube|wikipedia|github|stackoverflow)\.(?:com|org)\b",
    re.IGNORECASE,
)
# Auto-routing relevance gate: with no explicit file/context/keyword signal,
# route to course files only if retrieved chunks clear this bar. Only consulted
# when classify_source_scope is called WITH retrieved_chunks.
AUTO_ROUTE_RELEVANCE_THRESHOLD = 0.34
# Post-retrieval gate the routers use to KEEP a course answer instead of falling
# back to general knowledge. Lower than the routing bar above because by this
# point retrieval has already run and we are scoring real chunks in hand.
COURSE_ANCHOR_RELEVANCE_THRESHOLD = 0.18

_TOKEN_RE = re.compile(r"[a-zA-ZÀ-ÿ][a-zA-ZÀ-ÿ0-9_+-]{2,}")
_STOPWORDS = {
    "the", "and", "for", "with", "this", "that", "what", "does", "from", "your",
    "you", "are", "ist", "und", "der", "die", "das", "ein", "eine", "wie", "was",
    "explain", "summarize", "solve", "answer", "please", "course", "file", "pdf",
}


def normalise_source_mode(value: str | None) -> SourceMode:
    try:
        return SourceMode((value or SourceMode.AUTO.value).strip().lower())
    except ValueError:
        return SourceMode.AUTO


def normalise_course_file_scope(value: str | None) -> CourseFileScope:
    try:
        return CourseFileScope((value or CourseFileScope.ALL_COURSE_FILES.value).strip().lower())
    except ValueError:
        return CourseFileScope.ALL_COURSE_FILES


def source_label(scope: SourceScope) -> str:
    if scope == SourceScope.COURSE_FILES:
        return "Using: Course files"
    if scope == SourceScope.INTERNET:
        return "Using: Internet"
    if scope == SourceScope.GENERAL_KNOWLEDGE:
        return "Using: General knowledge"
    return ""


def effective_document_ids(
    *,
    document_ids: list[str] | None,
    active_document_id: str | None,
    course_file_scope: CourseFileScope,
) -> list[str] | None:
    """Resolve file eligibility. ``None`` means all course files."""

    if course_file_scope == CourseFileScope.ALL_COURSE_FILES:
        return None
    if document_ids:
        return list(dict.fromkeys(document_ids))
    if active_document_id:
        return [active_document_id]
    return []


def classify_source_scope(
    *,
    question: str,
    source_mode: str | None = None,
    course_file_scope: str | None = None,
    selected_course_id: str | None = None,  # kept for call-site clarity
    document_ids: list[str] | None = None,
    active_document_id: str | None = None,
    selected_text: str | None = None,
    open_file_context: str | None = None,
    retrieved_chunks: list[Any] | None = None,
    inside_pdf_side_rail: bool = False,
) -> SourceDecision:
    del selected_course_id
    mode = normalise_source_mode(source_mode)
    file_scope = normalise_course_file_scope(course_file_scope)
    used_ids = effective_document_ids(
        document_ids=document_ids,
        active_document_id=active_document_id,
        course_file_scope=file_scope,
    )

    if mode == SourceMode.COURSE_FILES:
        if file_scope == CourseFileScope.SPECIFIC_FILES and used_ids == []:
            return SourceDecision(
                mode,
                SourceScope.NEEDS_CLARIFICATION,
                file_scope,
                "",
                needs_clarification_message=(
                    "Which file should I use? Please select a PDF or switch to All course files."
                ),
            )
        return SourceDecision(mode, SourceScope.COURSE_FILES, file_scope, source_label(SourceScope.COURSE_FILES), used_ids or [])

    if mode == SourceMode.INTERNET:
        return SourceDecision(
            mode,
            SourceScope.INTERNET,
            file_scope,
            source_label(SourceScope.INTERNET),
            used_ids or [],
            sanitized_web_query=sanitize_web_query(question),
        )

    q = question or ""
    has_context = bool((selected_text or "").strip() or (open_file_context or "").strip())
    has_specific_file = bool(document_ids or active_document_id)
    # A URL in the question wins over EVERYTHING in auto mode — including an
    # active/selected file and the side rail. The user pasted a link; no course
    # chunk or open PDF can answer what's behind it.
    if _URL_RE.search(q):
        return SourceDecision(
            mode,
            SourceScope.INTERNET,
            file_scope,
            source_label(SourceScope.INTERNET),
            used_ids or [],
            sanitized_web_query=sanitize_web_query(q),
        )
    # An explicitly selected/active file is a deliberate "use this" signal, so
    # it outranks internet keywords that may just be part of a question *about*
    # that file (e.g. "explain the current method in this PDF" — "current"
    # shouldn't yank the answer to web search).
    if has_specific_file:
        return SourceDecision(mode, SourceScope.COURSE_FILES, file_scope, source_label(SourceScope.COURSE_FILES), used_ids or [])
    if _INTERNET_SIGNAL_RE.search(q):
        return SourceDecision(
            mode,
            SourceScope.INTERNET,
            file_scope,
            source_label(SourceScope.INTERNET),
            used_ids or [],
            sanitized_web_query=sanitize_web_query(q),
        )
    if has_context or inside_pdf_side_rail or _COURSE_SIGNAL_RE.search(q):
        if file_scope == CourseFileScope.SPECIFIC_FILES and not has_specific_file and not has_context:
            return SourceDecision(
                mode,
                SourceScope.NEEDS_CLARIFICATION,
                file_scope,
                "",
                needs_clarification_message=(
                    "Which file should I use? Please select a PDF or switch to All course files."
                ),
            )
        return SourceDecision(mode, SourceScope.COURSE_FILES, file_scope, source_label(SourceScope.COURSE_FILES), used_ids or [])

    if retrieved_chunks:
        rel = course_relevance_score(q, retrieved_chunks)
        if rel >= AUTO_ROUTE_RELEVANCE_THRESHOLD:
            return SourceDecision(
                mode,
                SourceScope.COURSE_FILES,
                file_scope,
                source_label(SourceScope.COURSE_FILES),
                used_ids or [],
                relevance_score=rel,
            )

    # Auto mode, no explicit internet / file / context / keyword signal. Default
    # to COURSE_FILES so retrieval actually RUNS — the router's post-retrieval
    # relevance gate (COURSE_ANCHOR_RELEVANCE_THRESHOLD) then downgrades to
    # general knowledge only when the course turns up nothing relevant. Deciding
    # "general" here, before retrieval, was a bug: auto questions without an
    # obvious course keyword (e.g. "what is urformen?") never consulted the
    # user's files at all. (No-course chats don't reach here — the frontend
    # routes those to the generic chat path instead of /ask-stream.)
    return SourceDecision(mode, SourceScope.COURSE_FILES, file_scope, source_label(SourceScope.COURSE_FILES), used_ids or [])


def sanitize_web_query(question: str, selected_text: str | None = None) -> str:
    del selected_text
    q = " ".join((question or "").split())[:300]
    return q


def _tokens(text: str) -> set[str]:
    return {
        t.lower()
        for t in _TOKEN_RE.findall(text or "")
        if t.lower() not in _STOPWORDS and len(t) >= 3
    }


def course_relevance_score(question: str, chunks: list[Any] | None) -> float:
    if not chunks:
        return 0.0
    q_tokens = _tokens(question)
    if not q_tokens:
        return 0.0
    best = 0.0
    for chunk in chunks[:8]:
        text = getattr(chunk, "text", "") or ""
        c_tokens = _tokens(text)
        overlap = len(q_tokens & c_tokens) / max(len(q_tokens), 1)
        similarity = float(getattr(chunk, "similarity", 0.0) or 0.0)
        type_bonus = 0.08 if (getattr(chunk, "chunk_type", "") or "") in {"exercise", "solution", "formula"} else 0.0
        best = max(best, min(1.0, overlap * 0.65 + similarity * 0.35 + type_bonus))
    return round(best, 4)


def course_not_found_answer() -> str:
    return (
        "I could not find this topic in your uploaded course files. "
        "You can switch to Internet mode if you want a general or current answer."
    )


def side_rail_unrelated_answer() -> str:
    return (
        "This does not seem related to the current PDF. "
        "Switch to Auto or Internet mode if you want a general answer."
    )


def auto_general_prefix() -> str:
    return "This does not seem to depend on your uploaded files, so I'll answer it generally.\n\n"


__all__ = (
    "AUTO_ROUTE_RELEVANCE_THRESHOLD",
    "COURSE_ANCHOR_RELEVANCE_THRESHOLD",
    "CourseFileScope",
    "SourceDecision",
    "SourceMode",
    "SourceScope",
    "auto_general_prefix",
    "classify_source_scope",
    "course_not_found_answer",
    "course_relevance_score",
    "effective_document_ids",
    "normalise_course_file_scope",
    "normalise_source_mode",
    "sanitize_web_query",
    "side_rail_unrelated_answer",
    "source_label",
)
