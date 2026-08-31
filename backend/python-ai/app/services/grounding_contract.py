"""Canonical grounding contract shared by ask-stream routing and telemetry.

The four values model independent concerns.  In particular, neither viewer
context nor document access is allowed to narrow the retrieval scope.
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from .scoped_extraction import (
    EXTRACTION_TARGET_RE,
    _EXHAUSTIVE_QUANTIFIER_PHRASES,
    _EXHAUSTIVE_QUANTIFIER_WORDS,
)


class RequestedDocumentAccess(StrEnum):
    VISIBLE_PAGE = "visible_page"
    FULL_DOCUMENT = "full_document"


class ResolvedDocumentAccess(StrEnum):
    RELEVANCE = "relevance"
    VISIBLE_PAGE = "visible_page"
    FULL_DOCUMENT = "full_document"


class AccessResolutionReason(StrEnum):
    EXPLICIT_UI_HINT = "explicit_ui_hint"
    NATURAL_LANGUAGE_FULL_DOCUMENT_INTENT = "natural_language_full_document_intent"
    VISIBLE_PAGE_REFERENCE = "visible_page_reference"
    RELEVANCE_DEFAULT = "relevance_default"
    POLICY_OVERRIDE = "policy_override"


class RetrievalScope(BaseModel):
    type: Literal["course", "documents"]
    documentIds: list[str] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def validate_shape(self) -> "RetrievalScope":
        self.documentIds = list(dict.fromkeys(self.documentIds))
        if self.type == "course" and self.documentIds:
            raise ValueError("course retrieval scope cannot contain documentIds")
        if self.type == "documents" and not self.documentIds:
            raise ValueError("documents retrieval scope requires documentIds")
        return self


class ViewerContext(BaseModel):
    documentId: str
    revision: str | None = Field(default=None, max_length=200)
    visiblePage: int = Field(ge=1)


class DocumentAccessRequest(BaseModel):
    requested: RequestedDocumentAccess | None = None


class GroundingRequest(BaseModel):
    retrievalScope: RetrievalScope
    viewerContext: ViewerContext | None = None
    documentAccess: DocumentAccessRequest | None = None
    visiblePageContext: str | None = None


class GroundingResolution(BaseModel):
    documentIds: list[str]
    documentRevisions: dict[str, str]
    documentAccess: ResolvedDocumentAccess
    resolutionReason: AccessResolutionReason
    processingPipeline: Literal[
        "relevance", "visible_page", "extraction", "summarization",
        "synthesis", "comparison", "generation",
    ]


# Shares _EXHAUSTIVE_QUANTIFIER_WORDS/_PHRASES with scoped_extraction.py's
# EXHAUSTIVE_COVERAGE_RE (same vocabulary for "all of them") but does NOT
# just reuse that regex wholesale: EXHAUSTIVE_COVERAGE_RE is deliberately
# bare (paired with an extraction-target check by its own callers), while
# this decides "does the request concern the WHOLE DOCUMENT" and needs the
# quantifier tied to a document/item-referring noun — otherwise "I need ALL
# the details" would wrongly trigger full-document processing. A bounded
# (?:\s+\w+){0,2} gap tolerates an intervening article/adjective ("alle
# RESTLICHEN Aufgaben", "keine AUFGABE auslassen") without losing the
# adjacency requirement entirely.
_DOCUMENT_ITEM_NOUNS_EN = r"pdf|document|file|lecture|exam|script|page|chapter|section|question|exercise|kurzfrage"
_DOCUMENT_ITEM_NOUNS_DE = r"pdf|dokument|datei|skript|vorlesung|pr[üu]fung|seite|kapitel|frage|aufgabe|kurzfrage"
_FULL_DOCUMENT_RE = re.compile(
    rf"\b(?:{_EXHAUSTIVE_QUANTIFIER_WORDS})\b(?:\s+\w+){{0,2}}\s+"
    rf"(?:{_DOCUMENT_ITEM_NOUNS_EN})s?\b|"
    rf"\b(?:{_EXHAUSTIVE_QUANTIFIER_WORDS})\b(?:\s+\w+){{0,2}}\s+"
    rf"(?:{_DOCUMENT_ITEM_NOUNS_DE})[nrs]?\b|"
    r"\b(?:read|scan|process|summari[sz]e|analyse|analyze)\s+(?:the\s+)?(?:entire|whole|complete|full)\b|"
    rf"\b(?:{_EXHAUSTIVE_QUANTIFIER_PHRASES})\b",
    re.IGNORECASE,
)
_VISIBLE_PAGE_RE = re.compile(
    r"\b(?:this|current|visible)\s+(?:page|formula|figure|diagram|question|section)\b|"
    r"\b(?:diese[rnms]?|aktuelle[nmrs]?|sichtbare[nmrs]?)\s+"
    r"(?:seite|formel|abbildung|diagramm|frage|abschnitt)\b",
    re.IGNORECASE,
)
# By the time select_processing_pipeline runs, resolve_document_access has
# already confirmed this is a FULL_DOCUMENT request (an exhaustive
# quantifier matched) — so naming a find/list-able item type (the shared
# EXTRACTION_TARGET_RE — "exercises", "Kurzfragen", "questions", ...) is
# enough on its own to mean "extraction", without also requiring the
# explicit verb+all/every ordering the original pattern demanded. That
# ordering requirement is why "don't leave any exercises out" and "die
# gesamten Kurzfragen auflisten" used to fall through to the generic
# synthesis pipeline instead of the battle-tested Kurzfragen manifest/
# pairing engine, even though document_extraction.py's own classifier
# correctly called them extraction-shaped.
_EXTRACTION_RE = re.compile(
    rf"\b(?:extract|list|find|answer)\b.*\b(?:all|every)\b|\balle\b.*\b(?:fragen|aufgaben)\b|"
    rf"{EXTRACTION_TARGET_RE.pattern}",
    re.IGNORECASE,
)
_SUMMARY_RE = re.compile(r"\b(?:summari[sz]e|summary|zusammenfass)\w*\b", re.I)
_COMPARE_RE = re.compile(r"\b(?:compare|comparison|contrast|vergleich)\w*\b", re.I)
_GENERATE_RE = re.compile(r"\b(?:create|generate|make|erstelle|generiere)\w*\b", re.I)


def resolve_document_access(
    *, question: str, requested: RequestedDocumentAccess | None,
    viewer_context: ViewerContext | None,
) -> tuple[ResolvedDocumentAccess, AccessResolutionReason]:
    if requested is RequestedDocumentAccess.FULL_DOCUMENT:
        return ResolvedDocumentAccess.FULL_DOCUMENT, AccessResolutionReason.EXPLICIT_UI_HINT
    if _FULL_DOCUMENT_RE.search(question):
        return (
            ResolvedDocumentAccess.FULL_DOCUMENT,
            AccessResolutionReason.NATURAL_LANGUAGE_FULL_DOCUMENT_INTENT,
        )
    if requested is RequestedDocumentAccess.VISIBLE_PAGE:
        return ResolvedDocumentAccess.VISIBLE_PAGE, AccessResolutionReason.EXPLICIT_UI_HINT
    if viewer_context and _VISIBLE_PAGE_RE.search(question):
        return ResolvedDocumentAccess.VISIBLE_PAGE, AccessResolutionReason.VISIBLE_PAGE_REFERENCE
    return ResolvedDocumentAccess.RELEVANCE, AccessResolutionReason.RELEVANCE_DEFAULT


def select_processing_pipeline(question: str, access: ResolvedDocumentAccess) -> str:
    if access is ResolvedDocumentAccess.RELEVANCE:
        return "relevance"
    if access is ResolvedDocumentAccess.VISIBLE_PAGE:
        return "visible_page"
    if _EXTRACTION_RE.search(question):
        return "extraction"
    if _COMPARE_RE.search(question):
        return "comparison"
    if _GENERATE_RE.search(question):
        return "generation"
    if _SUMMARY_RE.search(question):
        return "summarization"
    return "synthesis"


def grounding_cache_payload(
    *, user_id: str, course_id: str, request: GroundingRequest,
    resolution: GroundingResolution, question: str,
    conversation_grounding_state: str = "",
    execution_lane: str = "",
) -> str:
    """Stable semantic cache identity; resolution reason is telemetry-only."""
    import hashlib
    import json

    payload: dict[str, Any] = {
        "userId": user_id,
        "courseId": course_id,
        "retrievalScopeType": request.retrievalScope.type,
        "documentIds": sorted(resolution.documentIds),
        "documentRevisions": {
            key: resolution.documentRevisions[key]
            for key in sorted(resolution.documentRevisions)
        },
        "requestedDocumentAccess": (
            request.documentAccess.requested.value
            if request.documentAccess and request.documentAccess.requested else None
        ),
        "resolvedDocumentAccess": resolution.documentAccess.value,
        "processingPipeline": resolution.processingPipeline,
        "executionLane": execution_lane,
        "question": " ".join(question.casefold().split()),
        "conversationGroundingState": conversation_grounding_state,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
