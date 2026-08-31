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
_LOCATION_RE = re.compile(
    # "where" alone means "which page/lecture/script location" — EXCEPT the
    # common math/physics idiom "where did the 2 come from?", which asks
    # about a derivation step's origin, not a document citation.
    r"\bwhere(?!\s+(?:did|do|does)\b.{0,40}\bcome from\b)\b|"
    r"\bwhich page\b|\bexact citation\b|\bsource\b|\bwo(?: genau)?\b|\bwelche seite\b|\bquelle\b",
    re.I,
)
_WEB_RE = re.compile(
    r"\b(?:current|currently|today|latest|recent|available now|jobs? near|"
    r"aktuell|heute|neueste|derzeit|stellenangebote|verf[üu]gbar)\b|https?://", re.I,
)
_WEB_ACTION_RE = re.compile(r"\b(?:search|find|check|look up|suche|finde|pr[üu]fe)\b", re.I)
_CALC_RE = re.compile(
    r"\b(?:calc(?:ulate|ulte|uate)|compute|solve|determine|berechne|bestimme|ermittle|l[öo]se)\b", re.I,
)
_DERIVE_RE = re.compile(r"\b(?:der(?:ive|ve)|prove|herleiten|beweisen|ableiten)\b", re.I)
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
# Follow-up phrasing students actually type — not just a bare "why?" (the
# old pattern required the ENTIRE message to be one of a few fixed short
# phrases). Grouped by shape rather than enumerated per-example: bare
# why/how, "what about X"/"what if X", "and the/if/for X", "same for/thing",
# "the other one/case", "where did X come from", "why did you use X",
# "why not X", plus German equivalents. Safety against over-broadening lives
# in classify_task_profile, not the regex: (1) requestsExactCitationOrLocation
# always wins over isFollowup at the resolve_execution_plan level, so a
# location/source request is never reclassified as a follow-up just because
# it also happens to start with "where"; (2) a length cap keeps this a
# SHORT-message signal, not something that fires deep inside a long,
# self-contained new question; (3) _shares_topic_with_previous keeps a
# structurally-followup-shaped message that names a clearly different topic
# ("what about rolling bearings?" right after a torsion explanation) from
# being treated as a continuation of stale context — it still gets
# classified normally by the other rules below, just not as isFollowup.
_FOLLOWUP_MARKER_RE = re.compile(
    r"\bwhy\b|\bhow\b|\bwhat do you mean\b|"
    r"\bwhat about\b|\bwhat if\b|\bwhat changes if\b|"
    r"\band (?:if|the|for)\b|\bsame (?:for|thing)\b|\bthe other (?:one|case)\b|"
    r"\bwhere did\b.{0,40}\bcome from\b|\bwhy (?:did|do|does) (?:you|we|they|it)\s+use\b|"
    r"\bhow (?:did|do|does) (?:you|we|they|it) (?:get|find|compute|obtain|arrive at)\b|"
    r"\bwarum\b|\bwieso\b|\bweshalb\b|\bwie (?:so|kam|kommt) (?:das|es)\b|"
    r"\bwas (?:ist mit|w[äa]re wenn|[äa]ndert sich wenn)\b|"
    r"\bund (?:wenn|bei|f[üu]r)\b|\bgleich bei\b|\b(?:der|die|das) andere\b|"
    r"\bwoher kommt\b",
    re.I,
)
_FOLLOWUP_MAX_WORDS = 16
_CHITCHAT_RE = re.compile(r"^(?:hi|hello|hey|thanks|thank you|hallo|guten (?:tag|morgen)|danke)[!. ]*$", re.I)

# Generic interrogative/referential words that show up INSIDE follow-up
# phrasing itself (why, minus, the other one, second case, ...) — these are
# grammatical scaffolding, not topic content, so they must not count as "a
# real term this question introduces" when checking topic continuity below.
# source_router._tokens' own stopword list is tuned for course-chunk
# relevance scoring, not this — "why"/"minus"/"second" aren't stopwords
# there, but they carry no topic identity here.
_FOLLOWUP_FUNCTION_WORDS = {
    "why", "how", "come", "about", "what", "changes", "same", "thing",
    "other", "one", "case", "where", "did", "you", "use", "not", "does",
    "second", "first", "third", "tho", "minus", "plus",
    "warum", "wieso", "weshalb", "kam", "kommt", "mit", "wenn", "bei",
    "gleich", "andere", "anderen", "anderer", "fall", "woher", "und",
}


def _shares_topic_with_previous(question: str, previous_question: str | None) -> bool:
    """Cheap continuity check: does a follow-up-shaped message plausibly
    continue the previous turn's topic, or does it name something else?
    A message with no substantial content words of its own ("why?", "what
    about c < 0?" once follow-up scaffolding/symbols/short tokens are
    stripped) has nothing to contradict the previous topic with, so it's
    treated as a continuation by default — only a REAL, non-overlapping
    topic word ("rolling bearings" right after a torsion explanation)
    blocks it."""
    if not previous_question:
        return True
    from .source_router import _tokens  # noqa: WPS433 — avoid a module-load cycle
    current_terms = _tokens(question) - _FOLLOWUP_FUNCTION_WORDS
    if not current_terms:
        return True
    return bool(current_terms & _tokens(previous_question))


def classify_task_profile(*, question: str, resolved_access: ResolvedDocumentAccess,
                          source_mode: str | None, has_previous_answer: bool,
                          previous_question: str | None = None) -> TaskProfile:
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
    followup = (
        has_previous_answer
        and len(q.split()) <= _FOLLOWUP_MAX_WORDS
        and bool(_FOLLOWUP_MARKER_RE.search(q))
        and _shares_topic_with_previous(q, previous_question)
    )
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
                           has_previous_answer: bool = False,
                           previous_question: str | None = None) -> tuple[TaskProfile, ExecutionPlan]:
    profile = classify_task_profile(
        question=question, resolved_access=resolved_access, source_mode=source_mode,
        has_previous_answer=has_previous_answer, previous_question=previous_question,
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


_LIST_OR_BROAD_RE = re.compile(
    r"\b(?:three|four|five|six|seven|eight|nine|ten|all|every|list|types? of|kinds? of|"
    r"forms? of|varieties? of|which \w+ are|compare|comparison|contrast|difference (?:between|to)|"
    r"drei|vier|f[üu]nf|sechs|sieben|acht|neun|zehn|alle|arten von|welche\w*\s+(?:gibt|sind))\b",
    re.I,
)
_STRONG_SINGLE_CHUNK_THRESHOLD = 0.55
_MODERATE_CHUNK_THRESHOLD = 0.30


def fast_grounded_evidence_is_sufficient(*, chunks: list[Any], question: str = "") -> bool:
    """Promotion rule for the bounded FAST_GROUNDED lane.

    A single mediocre chunk barely over a fixed threshold is not the same
    evidence quality as one excellent chunk (exact terminology, high
    confidence) or several consistent moderate ones — and a question asking
    for several items or a comparison needs corroborating breadth, not one
    lucky chunk, or an incomplete list gets answered as if it were complete.
    """
    from .source_router import _chunk_relevance_scores  # noqa: WPS433 — avoid a module-load cycle

    scores = _chunk_relevance_scores(question, chunks)
    if not scores:
        return False
    top = scores[0]
    moderate_or_better = sum(1 for s in scores if s >= _MODERATE_CHUNK_THRESHOLD)
    if _LIST_OR_BROAD_RE.search(question or ""):
        distinct_docs = len({getattr(c, "document_id", None) for c in (chunks or [])[:8]})
        return moderate_or_better >= 2 and (distinct_docs >= 2 or moderate_or_better >= 3)
    if top >= _STRONG_SINGLE_CHUNK_THRESHOLD:
        return True
    return moderate_or_better >= 2 and top >= _MODERATE_CHUNK_THRESHOLD


__all__ = ["EscalationReason", "ExecutionComplexity", "ExecutionLane", "ExecutionPlan",
           "GroundingMode", "TaskProfile", "classify_task_profile",
           "fast_grounded_evidence_is_sufficient", "resolve_execution_plan"]
