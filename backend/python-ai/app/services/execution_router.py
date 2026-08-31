"""Single authoritative execution-plan router for ask-stream.

Grounding says what evidence is required.  This module only decides how much
work is justified and always falls back toward the safer, slower lane.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from enum import StrEnum
from typing import Any

from .grounding_contract import ResolvedDocumentAccess


class GroundingMode(StrEnum):
    GENERAL = "general"
    RELEVANCE = "relevance"
    VISIBLE_PAGE = "visible_page"
    FULL_DOCUMENT = "full_document"
    WEB = "web"


class ExecutionComplexity(StrEnum):
    FAST = "fast"
    STANDARD = "standard"
    DEEP = "deep"


class ExecutionLane(StrEnum):
    FAST_GENERAL = "fast_general"
    FAST_GROUNDED = "fast_grounded"
    FAST_CONTEXTUAL = "fast_contextual"
    STANDARD_RAG = "standard_rag"
    VISIBLE_PAGE = "visible_page"
    WEB = "web"
    DEEP_REASONING = "deep_reasoning"
    FULL_DOCUMENT = "full_document"


class EscalationReason(StrEnum):
    INSUFFICIENT_GROUNDED_EVIDENCE = "insufficient_grounded_evidence"


@dataclass(frozen=True)
class TaskProfile:
    needsCourseEvidence: bool = False
    needsVisiblePage: bool = False
    needsFullCoverage: bool = False
    needsCurrentWeb: bool = False
    isDefinition: bool = False
    isSimpleExplanation: bool = False
    isShortFactualQuestion: bool = False
    isFollowup: bool = False
    isCalculation: bool = False
    isDerivation: bool = False
    isComparison: bool = False
    isGeneration: bool = False
    isExtraction: bool = False
    isSummarization: bool = False
    requestsProfessorSpecificContent: bool = False
    requestsExactCitationOrLocation: bool = False
    estimatedComplexity: str = "medium"


@dataclass(frozen=True)
class ExecutionPlan:
    groundingMode: GroundingMode
    executionLane: ExecutionLane
    processingPipeline: str
    complexity: ExecutionComplexity
    confidence: float
    reason: str
    signals: tuple[str, ...]
    mayEscalate: bool
    initialLane: ExecutionLane

    def to_api(self) -> dict[str, Any]:
        data = asdict(self)
        data["signals"] = list(self.signals)
        return data


_COURSE_RE = re.compile(
    r"\b(?:my|our|the)\s+(?:lecture|course|professor|script|slides?|pdf|document)\b|"
    r"\b(?:according to|from)\s+(?:my|the)\s+(?:lecture|course|professor|script|pdf)\b|"
    r"\b(?:vorlesung|professor(?:in)?|skript|kursunterlagen|meine[rmn]?\s+unterlagen)\b",
    re.I,
)
_LOCATION_RE = re.compile(r"\b(?:where|which page|exact citation|source|wo(?: genau)?|welche seite|quelle)\b", re.I)
_WEB_RE = re.compile(
    r"\b(?:current|currently|today|latest|recent|available now|jobs? near|"
    r"aktuell|heute|neueste|derzeit|stellenangebote|verf[üu]gbar)\b|https?://", re.I,
)
_WEB_ACTION_RE = re.compile(r"\b(?:search|find|check|look up|suche|finde|pr[üu]fe)\b", re.I)
_CALC_RE = re.compile(r"\b(?:calculate|compute|solve|determine|berechne|bestimme|ermittle|l[öo]se)\b", re.I)
_DERIVE_RE = re.compile(r"\b(?:derive|prove|herleiten|beweisen|ableiten)\b", re.I)
_COMPARE_RE = re.compile(r"\b(?:compare|contrast|difference between|vergleich|vergleiche|unterschied)\b", re.I)
_GEN_RE = re.compile(r"\b(?:create|generate|make|erstelle|generiere)\b", re.I)
_EXTRACT_RE = re.compile(r"\b(?:find|list|extract|collect|finde|liste|extrahiere|erfasse)\b.*\b(?:every|all|alle|jede|s[äa]mtliche|kurzfragen?|questions?|exercises?|aufgaben?)\b", re.I)
_SUMMARY_RE = re.compile(r"\b(?:summari[sz]e|summary|zusammenfass(?:en|ung))\b", re.I)
_DEFINITION_RE = re.compile(
    r"^(?:please\s+)?(?:what (?:is|are|does)|what's|define|explain)\b|"
    r"^(?:was (?:ist|sind|bedeutet)|definiere|erkl[äa]re)\b", re.I,
)
_SIMPLE_RE = re.compile(r"\b(?:simply|briefly|in simple terms|einfach|kurz)\b", re.I)
_COURSE_FACT_RE = re.compile(
    r"^(?:what does|how does)\b.*\b(?:lecture|course|professor)\b|"
    r"^(?:was sagt|wie nennt|wie definiert)\b.*\b(?:vorlesung|professor|skript)\b", re.I,
)
_FOLLOWUP_RE = re.compile(
    r"^(?:why|how so|explain (?:that|it)|make (?:that|it) simpler|what do you mean|"
    r"warum|wieso|wie das|erkl[äa]r(?:e)? das|einfacher)\s*[?.!]*$", re.I,
)
_CHITCHAT_RE = re.compile(r"^(?:hi|hello|hey|thanks|thank you|hallo|guten (?:tag|morgen)|danke)[!. ]*$", re.I)


def classify_task_profile(*, question: str, resolved_access: ResolvedDocumentAccess,
                          source_mode: str | None, has_previous_answer: bool) -> TaskProfile:
    q = " ".join((question or "").split())
    course = bool(_COURSE_RE.search(q) or (source_mode or "").casefold() == "course_files")
    web = bool(_WEB_RE.search(q) and (_WEB_ACTION_RE.search(q) or "http" in q.casefold()))
    calculation, derivation = bool(_CALC_RE.search(q)), bool(_DERIVE_RE.search(q))
    extraction = bool(_EXTRACT_RE.search(q))
    definition = (
        bool(_DEFINITION_RE.search(q))
        and 2 <= len(q.split()) <= 18
        and not re.search(r"\b(?:this|that|it|these|those|hier|dies(?:e[rmns]?)?)\b", q, re.I)
    )
    followup = has_previous_answer and bool(_FOLLOWUP_RE.search(q))
    location = bool(_LOCATION_RE.search(q))
    high = calculation or derivation or resolved_access is ResolvedDocumentAccess.FULL_DOCUMENT
    low = (definition or bool(_SIMPLE_RE.search(q)) or followup or bool(_CHITCHAT_RE.search(q))
           or bool(_COURSE_FACT_RE.search(q))) and not high and not location
    return TaskProfile(
        needsCourseEvidence=course, needsVisiblePage=resolved_access is ResolvedDocumentAccess.VISIBLE_PAGE,
        needsFullCoverage=resolved_access is ResolvedDocumentAccess.FULL_DOCUMENT,
        needsCurrentWeb=web, isDefinition=definition, isSimpleExplanation=bool(_SIMPLE_RE.search(q)),
        isShortFactualQuestion=definition, isFollowup=followup, isCalculation=calculation,
        isDerivation=derivation, isComparison=bool(_COMPARE_RE.search(q)),
        isGeneration=bool(_GEN_RE.search(q)), isExtraction=extraction,
        isSummarization=bool(_SUMMARY_RE.search(q)), requestsProfessorSpecificContent=course,
        requestsExactCitationOrLocation=location,
        estimatedComplexity="high" if high else "low" if low else "medium",
    )


def resolve_execution_plan(*, question: str, resolved_access: ResolvedDocumentAccess,
                           processing_pipeline: str, source_mode: str | None = "auto",
                           has_previous_answer: bool = False) -> tuple[TaskProfile, ExecutionPlan]:
    profile = classify_task_profile(
        question=question, resolved_access=resolved_access, source_mode=source_mode,
        has_previous_answer=has_previous_answer,
    )
    signals = tuple(key for key, value in asdict(profile).items()
                    if value is True and key != "estimatedComplexity")
    if profile.needsFullCoverage:
        lane, mode, complexity, reason, confidence = (ExecutionLane.FULL_DOCUMENT, GroundingMode.FULL_DOCUMENT, ExecutionComplexity.DEEP, "resolved_full_document_access", 1.0)
    elif profile.needsVisiblePage:
        lane, mode, complexity, reason, confidence = (ExecutionLane.VISIBLE_PAGE, GroundingMode.VISIBLE_PAGE, ExecutionComplexity.STANDARD, "resolved_visible_page_access", 1.0)
    elif profile.needsCurrentWeb:
        lane, mode, complexity, reason, confidence = (ExecutionLane.WEB, GroundingMode.WEB, ExecutionComplexity.STANDARD, "current_external_information_required", 0.96)
    elif profile.isCalculation or profile.isDerivation:
        lane, mode, complexity, reason, confidence = (ExecutionLane.DEEP_REASONING, GroundingMode.RELEVANCE if profile.needsCourseEvidence else GroundingMode.GENERAL, ExecutionComplexity.DEEP, "calculation_or_derivation", 0.97)
    elif profile.isFollowup and not profile.requestsExactCitationOrLocation:
        lane, mode, complexity, reason, confidence = (ExecutionLane.FAST_CONTEXTUAL, GroundingMode.GENERAL, ExecutionComplexity.FAST, "sufficient_recent_conversation", 0.92)
    elif profile.estimatedComplexity == "low" and not profile.needsCourseEvidence:
        lane, mode, complexity, reason, confidence = (ExecutionLane.FAST_GENERAL, GroundingMode.GENERAL, ExecutionComplexity.FAST, "simple_general_academic_question", 0.95)
    elif profile.estimatedComplexity == "low" and profile.needsCourseEvidence:
        lane, mode, complexity, reason, confidence = (ExecutionLane.FAST_GROUNDED, GroundingMode.RELEVANCE, ExecutionComplexity.FAST, "simple_course_specific_question", 0.91)
    else:
        lane, mode, complexity, reason, confidence = (ExecutionLane.STANDARD_RAG, GroundingMode.RELEVANCE, ExecutionComplexity.STANDARD, "conservative_standard_fallback", 0.70)
    routed_pipeline = {
        ExecutionLane.FAST_GENERAL: "general",
        ExecutionLane.FAST_CONTEXTUAL: "general",
        ExecutionLane.WEB: "web",
        ExecutionLane.DEEP_REASONING: "calculation" if profile.isCalculation else "derivation",
    }.get(lane, processing_pipeline)
    return profile, ExecutionPlan(mode, lane, routed_pipeline, complexity, confidence,
                                  reason, signals, lane in {ExecutionLane.FAST_CONTEXTUAL, ExecutionLane.FAST_GROUNDED}, lane)


def fast_grounded_evidence_is_sufficient(*, chunk_count: int, relevance_score: float) -> bool:
    """Conservative promotion rule for the bounded grounded fast path."""
    return chunk_count > 0 and relevance_score >= 0.22


__all__ = ["EscalationReason", "ExecutionComplexity", "ExecutionLane", "ExecutionPlan",
           "GroundingMode", "TaskProfile", "classify_task_profile",
           "fast_grounded_evidence_is_sufficient", "resolve_execution_plan"]
