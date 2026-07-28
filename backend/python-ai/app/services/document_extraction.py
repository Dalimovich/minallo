"""Exhaustive, active-document question/answer extraction.

Unlike semantic top-k retrieval, this path scans every stored page in document
order and uses small map batches before deterministically merging the result.
"""

from __future__ import annotations

import logging
import re
import hashlib
import base64
import json
import time
from dataclasses import asdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Awaitable, Callable

from ..config import get_settings
from ..supabase_client import get_supabase
from .llm_json import chat_json

log = logging.getLogger(__name__)

_EXHAUSTIVE_RE = re.compile(
    r"\b(?:all|every|complete|entire|full\s+list|without\s+missing|"
    r"alle|sämtliche|vollständig|gesamte|komplett)\b",
    re.IGNORECASE,
)
_EXTRACTION_RE = re.compile(
    r"\b(?:extract|list|find|collect|questions?|answers?|items?|exercises?|"
    r"fragen|antworten|aufgaben|kurzfragen)\b",
    re.IGNORECASE,
)
_CONTINUATION_RE = re.compile(
    r"\b(?:you\s+missed|missing|keep\s+extracting|continue|earlier\s+ones|"
    r"first\s+ones|not\s+all|incomplete|check\s+again|"
    r"du\s+hast.+vergessen|weitermachen|die\s+ersten|nicht\s+alle|unvollständig)\b",
    re.IGNORECASE,
)
_TARGET_RE = re.compile(
    r"\b(?:(\d+)\s*\.\s*)?"
    r"(kurzfragen?|wissensfragen?|theoriefragen?|questions?|fragen|aufgaben)\b",
    re.IGNORECASE,
)
_ITEM_ID_RE = re.compile(r"^\s*(\d+(?:\.\d+)*(?:[a-z])?)\s*$", re.IGNORECASE)


def requested_section_number(target: str) -> str | None:
    match = re.match(r"^\s*(\d+)\s*\.\s*", target or "")
    return match.group(1) if match else None


def item_belongs_to_requested_section(item_id: str, target: str) -> bool:
    section = requested_section_number(target)
    if section is None:
        return True
    return normalise_item_id(item_id).startswith(f"{section}.")


@dataclass(frozen=True)
class ResolvedDocumentSection:
    requested_number: str | None
    requested_title: str
    matched_heading: str
    start_page: int
    end_page: int
    expected_item_prefix: str | None
    confidence: float
    start_position: int = 0
    end_position: int | None = None
    discovery_method: str = "text"
    verification_status: str = "verified"

    @property
    def question_pages(self) -> list[int]:
        return list(range(self.start_page, self.end_page + 1))


@dataclass(frozen=True)
class ResolvedSectionFamily:
    family_name: str
    matched_sections: list[ResolvedDocumentSection]
    excluded_sections: list[str]
    confidence: float

    @property
    def section_numbers(self) -> list[str]:
        return [section.requested_number or "" for section in self.matched_sections]


def resolve_section_family(
    target: str,
    text_by_page: dict[int, str],
    *,
    total_pages: int,
    visual_headings: list[dict[str, Any]] | None = None,
) -> ResolvedSectionFamily | None:
    """Resolve every numbered main section whose heading names one family."""
    family_match = re.search(r"\b(kurzfragen?|short\s+questions?)\b", target, re.IGNORECASE)
    if not family_match or requested_section_number(target):
        return None
    family_name = "Kurzfragen" if "kurz" in family_match.group(1).casefold() else "Short questions"
    heading_re = re.compile(
        r"(?im)^\s*(?P<number>\d+)\s*\.\s*"
        r"(?P<family>Kurzfragen?|Short\s+Questions?)\b"
        r"\s*(?:[-â€“â€”:]\s*)?(?P<title>[^\n\r]{0,160})$"
    )
    # Require whitespace after the dot so question IDs such as ``2.1`` are
    # never mistaken for a new top-level document section.
    any_heading_re = re.compile(r"(?im)^\s*(?P<number>\d+)\s*\.\s+[^\n\r]{1,200}$")
    matches: list[tuple[int, int, str, str, str, str, float]] = []
    all_headings: list[tuple[int, int, int, str]] = []
    for page, text in sorted(text_by_page.items()):
        for match in any_heading_re.finditer(text or ""):
            all_headings.append((page, match.start(), int(match.group("number")), match.group(0).strip()))
        for match in heading_re.finditer(text or ""):
            matches.append((page, match.start(), match.group("number"), match.group("title").strip(), match.group(0).strip(), "text", 0.96))
    # Text extraction can omit image-only headings.  The caller may supply
    # document-wide visual/OCR discoveries; keep their page-relative order so
    # two top-level sections beginning on the same page remain distinct.
    visual_pages = {
        int(raw.get("page") or 0)
        for raw in (visual_headings or [])
        if isinstance(raw, dict) and str(raw.get("page") or "").isdigit()
    }
    if visual_pages:
        # Visual discovery supplies one coordinate system for the whole page;
        # do not mix its ordinal positions with OCR character offsets.
        all_headings = [heading for heading in all_headings if heading[0] not in visual_pages]
    for raw in visual_headings or []:
        try:
            page = int(raw.get("page") or 0)
            number = str(int(raw.get("number")))
        except (TypeError, ValueError):
            continue
        if page < 1 or page > total_pages:
            continue
        heading = str(raw.get("heading") or "").strip()
        title = str(raw.get("title") or "").strip()
        position = int(raw.get("position") or 0)
        if re.search(
            r"\.{3}|\b(?:fortsetzung|continuation|thema\s*\d*)\b|\[",
            title,
            re.IGNORECASE,
        ):
            continue
        exact_top_level = re.match(
            rf"^\s*{re.escape(number)}\s*\.\s+[^\r\n]+$",
            heading,
            re.IGNORECASE,
        )
        if not exact_top_level:
            continue
        all_headings.append((page, position, int(number), heading))
        exact_family_heading = re.match(
            rf"^\s*{re.escape(number)}\s*\.\s+"
            r"(?:Kurzfragen?|Short\s+Questions?)\b"
            r"\s*(?:[-–—:]\s*)?[^\r\n]*$",
            heading,
            re.IGNORECASE,
        )
        if not exact_family_heading:
            continue
        if re.search(
            r"\b(?:kurzfragen?|short\s+questions?)\b",
            f"{heading} {title}",
            re.IGNORECASE,
        ):
            confidence = max(0.0, min(1.0, float(raw.get("confidence") or 0.82)))
            matches.append((page, position, number, title, heading or f"{number}. {title}", "visual_ocr", confidence))
    if not matches:
        return None
    # A top-level section number identifies one structural section. Repeated
    # running headers on later pages are not new sections.
    deduplicated_matches: dict[tuple[int, str], tuple[int, int, str, str, str, str, float]] = {}
    for value in matches:
        key = (0, value[2])
        current = deduplicated_matches.get(key)
        if current is None or (value[0], value[1]) < (current[0], current[1]):
            deduplicated_matches[key] = value
    matches = list(deduplicated_matches.values())
    earliest_heading_by_number: dict[int, tuple[int, int, int, str]] = {}
    for heading_value in all_headings:
        number_value = heading_value[2]
        current = earliest_heading_by_number.get(number_value)
        if current is None or heading_value[:2] < current[:2]:
            earliest_heading_by_number[number_value] = heading_value
    all_headings = sorted(
        earliest_heading_by_number.values(),
        key=lambda value: (value[0], value[1], value[2]),
    )
    sections: list[ResolvedDocumentSection] = []
    for page, position, number, title, heading, method, confidence in matches:
        later = [candidate for candidate in all_headings if (candidate[0], candidate[1]) > (page, position)]
        next_heading = min(later, default=None, key=lambda value: (value[0], value[1]))
        # When the next section starts on the same page, both sections include
        # that page and item-prefix filtering separates their questions.
        end_page = (next_heading[0] if next_heading and next_heading[0] == page else next_heading[0] - 1) if next_heading else total_pages
        sections.append(ResolvedDocumentSection(
            requested_number=number,
            requested_title=title or family_name,
            matched_heading=heading,
            start_page=page,
            end_page=max(page, end_page),
            expected_item_prefix=f"{number}.",
            confidence=confidence,
            start_position=position,
            end_position=(next_heading[1] if next_heading and next_heading[0] == page else None),
            discovery_method=method,
        ))
    sections.sort(key=lambda section: int(section.requested_number or 0))
    included = {int(section.requested_number or 0) for section in sections}
    excluded = sorted({
        str(number) for _page, _position, number, _heading in all_headings
        if number not in included
    }, key=int)
    return ResolvedSectionFamily(family_name, sections, excluded, min(section.confidence for section in sections))


def resolve_document_section(
    target: str,
    text_by_page: dict[int, str],
    *,
    total_pages: int,
    visible_page: int | None = None,
) -> ResolvedDocumentSection | None:
    """Resolve a numbered heading without substring matches (section 2 is not 12)."""
    section = requested_section_number(target)
    if section is None:
        return None
    label = re.sub(r"^\s*\d+\s*\.\s*", "", target).strip()
    heading_re = re.compile(
        rf"(?im)^\s*{re.escape(section)}\s*\.\s*"
        rf"(?P<title>[^\n\r]{{0,160}}\b{re.escape(label)}\b[^\n\r]{{0,160}})$"
    )
    matches: list[tuple[int, str]] = []
    for page, text in text_by_page.items():
        match = heading_re.search(text or "")
        if match:
            matches.append((page, match.group(0).strip()))
    if not matches:
        return None
    start_page, heading = min(
        matches,
        key=lambda value: (0 if visible_page == value[0] else 1, value[0]),
    )
    next_heading_re = re.compile(r"(?im)^\s*(?P<number>\d+)\s*\.\s*[^\n\r]{0,200}$")
    boundary_pages = [
        page for page, text in text_by_page.items()
        if page > start_page and any(
            int(match.group("number")) > int(section)
            for match in next_heading_re.finditer(text or "")
        )
    ]
    end_page = min(boundary_pages) - 1 if boundary_pages else total_pages
    end_page = max(start_page, end_page)
    return ResolvedDocumentSection(
        requested_number=section,
        requested_title=label,
        matched_heading=heading,
        start_page=start_page,
        end_page=end_page,
        expected_item_prefix=f"{section}.",
        confidence=0.98 if visible_page == start_page else 0.93,
    )


def classify_document_extraction(
    question: str,
    previous_turns: list[dict[str, str]] | None = None,
) -> tuple[bool, bool, str | None]:
    """Return (is_extraction, is_correction, target)."""
    current = question or ""
    # A user-provided list of concrete questions is a bounded QA request, not
    # permission to enumerate the document's entire exam inventory.
    explicit_question_list = (
        current.count("?") >= 2
        and bool(re.search(
            r"\b(?:these|following|diese[nr]?|folgenden)\b",
            current,
            re.IGNORECASE,
        ))
    )
    if explicit_question_list:
        return False, False, None
    exhaustive = bool(_EXHAUSTIVE_RE.search(current) and _EXTRACTION_RE.search(current))
    correction = bool(_CONTINUATION_RE.search(current))
    prior_request = ""
    if correction:
        prior_request = next(
            (
                str(turn.get("text") or "")
                for turn in reversed(previous_turns or [])
                if turn.get("role") == "user"
                and _EXHAUSTIVE_RE.search(str(turn.get("text") or ""))
                and _EXTRACTION_RE.search(str(turn.get("text") or ""))
            ),
            "",
        )
    source = current if exhaustive else prior_request
    target_matches = list(_TARGET_RE.finditer(source))
    target_match = max(
        target_matches,
        key=lambda match: (
            bool(match.group(1)),
            "kurzfrag" in match.group(2).casefold(),
            match.start(),
        ),
        default=None,
    )
    target = (
        f"{target_match.group(1)}. {target_match.group(2)}"
        if target_match and target_match.group(1)
        else target_match.group(2) if target_match else None
    )
    return bool(exhaustive or (correction and prior_request)), correction, target


@dataclass
class ExtractedQAItem:
    item_id: str
    question: str
    answer: str
    question_page: int
    answer_page: int | None = None
    confidence: float = 0.0
    evidence_type: str | None = None


@dataclass
class ExtractedQuestionOption:
    label: str | None
    text: str
    order: int


@dataclass
class ExtractedQuestion:
    item_id: str
    normalized_item_id: str
    question_text: str
    question_page: int
    section: str | None = None
    question_fingerprint: str = ""
    confidence: float = 0.0
    options: list[ExtractedQuestionOption] = field(default_factory=list)
    answer_type: str | None = None
    document_id: str | None = None
    document_revision: str | None = None
    scope_fingerprint: str | None = None
    source_structure: str | None = None


@dataclass
class ExtractedSolutionEvidence:
    item_id: str | None
    normalized_item_id: str | None
    answer_text: str
    answer_page: int
    evidence_type: str
    referenced_question_text: str | None = None
    question_fingerprint: str | None = None
    confidence: float = 0.0
    document_id: str | None = None
    document_revision: str | None = None
    scope_fingerprint: str | None = None
    source_structure: str | None = None
    evidence_origin: str = "official_source_answer"
    pairing_schema_version: int = 2
    answer_validation_version: int = 2


@dataclass
class PairedQAItem:
    item_id: str
    question_text: str
    answer_text: str | None
    question_page: int
    answer_page: int | None
    pairing_method: str | None
    pairing_confidence: float
    answer_evidence_type: str | None
    answer_origin: str = "unresolved"
    validation_result: str = "unresolved"
    error_code: str | None = None
    question_fingerprint: str | None = None
    document_revision: str | None = None


class GapStatus(StrEnum):
    POTENTIAL = "potential"
    REVIEWED_NOT_FOUND = "reviewed_not_found"
    CONFIRMED_MISSING = "confirmed_missing"
    INTENTIONAL = "intentional"
    UNRESOLVED = "unresolved"


class ExtractionPageKind(StrEnum):
    QUESTION = "question"
    SOLUTION = "solution"
    MIXED = "mixed"
    IRRELEVANT = "irrelevant"
    UNCERTAIN = "uncertain"


class PageProcessingStatus(StrEnum):
    TEXT_PROCESSED = "text_processed"
    VISION_PROCESSED = "vision_processed"
    VERIFIED_IRRELEVANT = "verified_irrelevant"
    UNREADABLE = "unreadable"
    FAILED = "failed"


class AnswerResolutionStatus(StrEnum):
    PAIRED_TEXT = "paired_text"
    PAIRED_VISUAL = "paired_visual"
    SEARCH_PENDING = "search_pending"
    NO_CANDIDATES = "no_candidates"
    VISUAL_BUDGET_EXHAUSTED = "visual_budget_exhausted"
    VISUAL_RENDER_FAILED = "visual_render_failed"
    VISION_EXTRACTION_FAILED = "vision_extraction_failed"
    AMBIGUOUS_EVIDENCE = "ambiguous_evidence"
    NOT_FOUND_AFTER_FULL_SEARCH = "not_found_after_full_search"


@dataclass
class AnswerRecoveryRecord:
    item_id: str
    candidate_pages: list[int] = field(default_factory=list)
    inspected_pages: list[int] = field(default_factory=list)
    remaining_pages: list[int] = field(default_factory=list)
    status: AnswerResolutionStatus = AnswerResolutionStatus.SEARCH_PENDING
    evidence_page: int | None = None
    evidence_type: str | None = None
    calls_used: int = 0


@dataclass(frozen=True)
class PageClassificationResult:
    kind: ExtractionPageKind
    confidence: float
    signals: list[str] = field(default_factory=list)


class SearchAvailability(StrEnum):
    SEARCHED = "searched"
    NOT_AVAILABLE = "not_available"
    NOT_SEARCHED = "not_searched"


@dataclass
class GapSearchCoverage:
    nearby_pages_searched: list[int] = field(default_factory=list)
    question_section_pages_searched: list[int] = field(default_factory=list)
    solution_section_pages_searched: list[int] = field(default_factory=list)
    full_document_text_searched: bool = False
    existing_visual_results_reviewed: bool = False
    targeted_visual_pages_required: list[int] = field(default_factory=list)
    targeted_visual_pages_searched: list[int] = field(default_factory=list)
    question_section_detected: bool = False
    solution_section_detected: bool = False
    visual_search_budget_exhausted: bool = False
    unsearched_candidate_pages: list[int] = field(default_factory=list)
    targeted_visual_calls_used: int = 0


@dataclass(frozen=True)
class GapIdVariant:
    value: str
    confidence: float
    requires_question_context: bool


MAX_TARGETED_VISUAL_GAP_CALLS_PER_DOCUMENT = 12
MAX_TARGETED_VISUAL_PAGES_PER_GAP = 3
DOCUMENT_EXTRACTION_BATCH_SIZE = 10
DOCUMENT_EXTRACTION_BATCH_CHAR_LIMIT = 60_000


@dataclass
class GapReviewResult:
    exact_text_search_performed: bool = False
    full_section_search_performed: bool = False
    solution_section_search_performed: bool = False
    question_section_status: SearchAvailability = SearchAvailability.NOT_SEARCHED
    solution_section_status: SearchAvailability = SearchAvailability.NOT_SEARCHED
    visual_search_performed: bool = False
    exact_matches: list[int] = field(default_factory=list)
    intentional_omission_pages: list[int] = field(default_factory=list)
    reviewed_pages: list[int] = field(default_factory=list)
    coverage: GapSearchCoverage = field(default_factory=GapSearchCoverage)


@dataclass
class NumberingGap:
    item_id: str
    status: GapStatus = GapStatus.POTENTIAL
    reviewed_pages: list[int] = field(default_factory=list)
    search_performed: bool = False
    evidence_pages: list[int] = field(default_factory=list)
    full_section_search_performed: bool = False
    solution_section_search_performed: bool = False
    visual_search_performed: bool = False
    coverage: GapSearchCoverage = field(default_factory=GapSearchCoverage)


@dataclass
class DocumentExtractionContext:
    conversation_id: str
    document_id: str
    document_revision: str | None
    source_fingerprint: str
    target_section: str
    requested_scope: str
    scanned_pages: list[int] = field(default_factory=list)
    extracted_questions: list[ExtractedQuestion] = field(default_factory=list)
    solution_evidence: list[ExtractedSolutionEvidence] = field(default_factory=list)
    paired_items: list[PairedQAItem] = field(default_factory=list)
    unresolved_item_ids: list[str] = field(default_factory=list)
    unresolved_pages: list[int] = field(default_factory=list)
    answer_recovery_records: dict[str, AnswerRecoveryRecord] = field(default_factory=dict)
    conflicting_item_ids: list[str] = field(default_factory=list)
    earliest_source_page: int | None = None
    latest_source_page: int | None = None
    earliest_scanned_page: int | None = None
    latest_scanned_page: int | None = None
    earliest_item_page: int | None = None
    latest_item_page: int | None = None
    complete: bool = False
    scope_extraction_complete: bool = False
    answer_verification_complete: bool = False
    cumulative_scanned_pages: list[int] = field(default_factory=list)
    scope_fingerprint: str | None = None
    resolved_family: ResolvedSectionFamily | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass
class PageExtractionResult:
    page_number: int
    questions: list[ExtractedQuestion] = field(default_factory=list)
    solutions: list[ExtractedSolutionEvidence] = field(default_factory=list)
    extraction_methods: list[str] = field(default_factory=list)


@dataclass
class DocumentExtractionResult:
    document_id: str
    target: str
    total_pages: int
    scanned_pages: list[int] = field(default_factory=list)
    unreadable_pages: list[int] = field(default_factory=list)
    page_statuses: dict[int, PageProcessingStatus] = field(default_factory=dict)
    items: list[ExtractedQAItem] = field(default_factory=list)
    unanswered_item_ids: list[str] = field(default_factory=list)
    duplicate_item_ids: list[str] = field(default_factory=list)
    conflicting_item_ids: list[str] = field(default_factory=list)
    suspicious_numbering_gaps: list[str] = field(default_factory=list)
    gaps: list[NumberingGap] = field(default_factory=list)
    extracted_questions: list[ExtractedQuestion] = field(default_factory=list)
    solution_evidence: list[ExtractedSolutionEvidence] = field(default_factory=list)
    paired_items: list[PairedQAItem] = field(default_factory=list)
    all_relevant_pages_scanned: bool = False
    all_items_have_answers: bool = False
    complete: bool = False
    scope_extraction_complete: bool = False
    answer_verification_complete: bool = False
    cumulative_scanned_pages: list[int] = field(default_factory=list)
    scope_fingerprint: str | None = None
    model: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    status: str = "completed"
    message: str | None = None
    new_item_count: int = 0
    section_resolved: bool = True
    resolved_heading: str | None = None
    resolved_start_page: int | None = None
    resolved_end_page: int | None = None
    invalid_item_ids_rejected: list[str] = field(default_factory=list)
    unprocessed_pages: list[int] = field(default_factory=list)
    answer_recovery_pages: dict[str, list[int]] = field(default_factory=dict)
    answer_recovery_incomplete: bool = False
    answer_recovery_records: dict[str, AnswerRecoveryRecord] = field(default_factory=dict)
    resolved_family: ResolvedSectionFamily | None = None
    out_of_scope_items_rejected: list[str] = field(default_factory=list)


_EXTRACTION_CONTEXTS: dict[tuple[str, str], DocumentExtractionContext] = {}


def normalise_item_id(item_id: str) -> str:
    return re.sub(r"[^0-9.]", "", item_id or "").strip(".")


def _natural_item_id_key(item_id: str) -> tuple[int, ...]:
    return tuple(int(part) for part in normalise_item_id(item_id).split(".") if part.isdigit())


def question_fingerprint(text: str) -> str:
    normalized = re.sub(r"\W+", " ", text or "").casefold().strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]


class QuestionIdentityConflict(ValueError):
    """One printed item id identifies different canonical questions."""


def canonicalize_questions(questions: list[ExtractedQuestion]) -> list[ExtractedQuestion]:
    """Merge true duplicates and reject an id reused for different questions."""
    canonical: dict[tuple[str, str], ExtractedQuestion] = {}
    fingerprints_by_id: dict[str, set[str]] = {}
    for question in questions:
        fingerprint = question.question_fingerprint or question_fingerprint(question.question_text)
        question.question_fingerprint = fingerprint
        normalized_id = question.normalized_item_id or normalise_item_id(question.item_id)
        fingerprints_by_id.setdefault(normalized_id, set()).add(fingerprint)
        canonical.setdefault((normalized_id, fingerprint), question)
    conflicting = [item_id for item_id, values in fingerprints_by_id.items() if len(values) > 1]
    if conflicting:
        log.error("question_identity_conflict item_ids=%s", sorted(conflicting))
        raise QuestionIdentityConflict(
            "same item id has different question fingerprints: " + ", ".join(sorted(conflicting))
        )
    return sorted(
        canonical.values(),
        key=lambda item: (_natural_item_id_key(item.item_id), item.question_page),
    )


_SCORE_MARKER_RE = re.compile(r"^\s*[01]\s*(?:P|Pkt\.?|Punkte?)\s*$", re.IGNORECASE)


def _compatible_solution(question: ExtractedQuestion, solution: ExtractedSolutionEvidence) -> bool:
    checks = (
        ("document", question.document_id, solution.document_id),
        ("revision", question.document_revision, solution.document_revision),
        ("scope", question.scope_fingerprint, solution.scope_fingerprint),
        ("source_structure", question.source_structure, solution.source_structure),
    )
    for label, expected, actual in checks:
        if expected is not None and actual != expected:
            log.warning("solution_candidate_rejected_%s_mismatch item=%s", label, question.item_id)
            return False
    if solution.question_fingerprint and solution.question_fingerprint != question.question_fingerprint:
        log.warning("solution_candidate_rejected_fingerprint_mismatch item=%s", question.item_id)
        return False
    if solution.evidence_origin not in {"official_source_answer", "verified_visual_mark"}:
        log.warning("previous_evidence_discarded item=%s origin=%s", question.item_id, solution.evidence_origin)
        return False
    if solution.pairing_schema_version != 2 or solution.answer_validation_version != 2:
        log.warning("contaminated_cache_invalidated item=%s", question.item_id)
        return False
    return True


def _validated_answer(
    question: ExtractedQuestion, solution: ExtractedSolutionEvidence,
) -> tuple[str | None, str | None]:
    answer = re.sub(r"\s+", " ", solution.answer_text).strip()
    if _SCORE_MARKER_RE.fullmatch(answer):
        marked = [option.text for option in question.options if _SCORE_MARKER_RE.fullmatch(option.label or "") and (option.label or "").lstrip().startswith("1")]
        if len(marked) == 1:
            return marked[0], None
        log.warning("score_marker_rejected_as_answer item=%s", question.item_id)
        return None, "score_marker_is_not_answer"
    if question.answer_type == "multiple_choice" and question.options:
        normalized = re.sub(r"\W+", " ", answer.casefold()).strip()
        option_values = [re.sub(r"\W+", " ", option.text.casefold()).strip() for option in question.options]
        if normalized not in option_values:
            log.warning("answer_shape_validation_failed item=%s", question.item_id)
            return None, "answer_shape_mismatch"
    return answer, None


def pair_questions_and_solutions(
    questions: list[ExtractedQuestion],
    solutions: list[ExtractedSolutionEvidence],
) -> list[PairedQAItem]:
    """Pair only identity-compatible, non-conflicting verified evidence."""
    questions = canonicalize_questions(questions)
    unused = list(solutions)
    paired: list[PairedQAItem] = []
    for question in questions:
        exact_candidates = [
            item for item in unused
            if item.normalized_item_id == question.normalized_item_id
            and _compatible_solution(question, item)
        ]
        distinct_answers = {
            re.sub(r"\s+", " ", item.answer_text).casefold().strip()
            for item in exact_candidates
        }
        conflict = len(distinct_answers) > 1
        if conflict:
            log.error("solution_conflict_detected item=%s", question.item_id)
        candidate = None if conflict else (exact_candidates[0] if exact_candidates else None)
        method = "normalized_item_id" if candidate else None
        if candidate is None and not conflict and question.question_fingerprint:
            candidate = next(
                (
                    item for item in unused
                    if item.question_fingerprint == question.question_fingerprint
                    and _compatible_solution(question, item)
                ),
                None,
            )
            method = "question_fingerprint" if candidate else None
        if candidate is None and not conflict:
            question_tokens = set(re.findall(r"\w+", question.question_text.casefold()))
            scored = [
                (
                    len(question_tokens.intersection(set(re.findall(
                        r"\w+", (item.referenced_question_text or "").casefold(),
                    )))) / max(1, len(question_tokens)),
                    item,
                )
                for item in unused
                if item.referenced_question_text and _compatible_solution(question, item)
            ]
            if scored:
                score, possible = max(scored, key=lambda value: value[0])
                if score >= 0.72:
                    candidate, method = possible, "referenced_question_similarity"
        if candidate is None and not conflict and question.options:
            option_texts = {
                re.sub(r"\W+", " ", option.text.casefold()).strip()
                for option in question.options if option.text.strip()
            }
            candidate = next((
                item for item in unused if _compatible_solution(question, item)
                if any(
                    option and (
                        option in re.sub(r"\W+", " ", item.answer_text.casefold()).strip()
                        or re.sub(r"\W+", " ", item.answer_text.casefold()).strip() in option
                    )
                    for option in option_texts
                )
            ), None)
            method = "option_text_match" if candidate else None
        answer_text, validation_error = _validated_answer(question, candidate) if candidate else (None, None)
        if candidate:
            unused.remove(candidate)
        paired.append(PairedQAItem(
            item_id=question.item_id,
            question_text=question.question_text,
            answer_text=answer_text,
            question_page=question.question_page,
            answer_page=candidate.answer_page if candidate else None,
            pairing_method=method,
            pairing_confidence=min(question.confidence, candidate.confidence) if candidate else 0.0,
            answer_evidence_type=candidate.evidence_type if candidate else None,
            answer_origin=candidate.evidence_origin if candidate and answer_text else "unresolved",
            validation_result="valid" if answer_text else "unresolved",
            error_code=("conflicting_solution_evidence" if conflict else validation_error),
            question_fingerprint=question.question_fingerprint,
            document_revision=question.document_revision,
        ))
    return paired


async def extract_page_with_fallback(
    *,
    document_id: str,
    page_number: int,
    page_text: str,
    extract_from_text: Callable[..., Awaitable[PageExtractionResult]],
    render_page_image: Callable[..., Awaitable[Any]],
    extract_from_page_image: Callable[..., Awaitable[PageExtractionResult]],
) -> PageExtractionResult:
    from .reliability import assess_text_quality

    text_result = await extract_from_text(
        page_text=page_text,
        page_number=page_number,
    )
    if assess_text_quality(page_text) >= 0.75:
        return text_result
    page_image = await render_page_image(
        document_id=document_id,
        page_number=page_number,
        dpi=260,
        format="png",
    )
    visual_result = await extract_from_page_image(
        image=page_image,
        page_number=page_number,
    )
    return PageExtractionResult(
        page_number=page_number,
        questions=text_result.questions + visual_result.questions,
        solutions=text_result.solutions + visual_result.solutions,
        extraction_methods=list(dict.fromkeys(
            text_result.extraction_methods + visual_result.extraction_methods
        )),
    )


def extraction_pages_for_direction(
    direction: str,
    *,
    context: DocumentExtractionContext,
    section_start_page: int,
    section_end_page: int,
) -> list[int]:
    earliest_item = context.earliest_item_page
    latest_item = context.latest_item_page
    if earliest_item is None:
        earliest_item = context.earliest_source_page
    if latest_item is None:
        latest_item = context.latest_source_page
    if direction == "earlier" and earliest_item is not None:
        return list(range(section_start_page, earliest_item))
    if direction == "later" and latest_item is not None:
        return list(range(latest_item + 1, section_end_page + 1))
    if direction in {"full", "full_scope_rebuild"}:
        return list(range(section_start_page, section_end_page + 1))
    return context.unresolved_pages or list(range(section_start_page, section_end_page + 1))


def save_extraction_context(context: DocumentExtractionContext) -> None:
    context.updated_at = datetime.now(UTC)
    _EXTRACTION_CONTEXTS[(context.conversation_id, context.document_id)] = context


def extraction_context_to_api(context: DocumentExtractionContext) -> dict[str, Any]:
    data = asdict(context)
    data["created_at"] = context.created_at.isoformat()
    data["updated_at"] = context.updated_at.isoformat()
    return data


def extraction_context_from_api(data: Any) -> DocumentExtractionContext | None:
    if not isinstance(data, dict):
        return None
    try:
        payload = dict(data)
        payload["created_at"] = datetime.fromisoformat(str(payload["created_at"]))
        payload["updated_at"] = datetime.fromisoformat(str(payload["updated_at"]))
        payload["extracted_questions"] = [
            ExtractedQuestion(
                **{
                    **item,
                    "options": [
                        ExtractedQuestionOption(**option)
                        for option in item.get("options", [])
                    ],
                }
            )
            for item in payload.get("extracted_questions", [])
        ]
        payload["solution_evidence"] = [
            ExtractedSolutionEvidence(**item)
            for item in payload.get("solution_evidence", [])
        ]
        payload["paired_items"] = [
            PairedQAItem(**item) for item in payload.get("paired_items", [])
        ]
        payload["answer_recovery_records"] = {
            str(item_id): AnswerRecoveryRecord(
                **{
                    **record,
                    "status": AnswerResolutionStatus(record.get("status", "search_pending")),
                }
            )
            for item_id, record in payload.get("answer_recovery_records", {}).items()
            if isinstance(record, dict)
        }
        family = payload.get("resolved_family")
        if isinstance(family, dict):
            family_payload = dict(family)
            family_payload["matched_sections"] = [
                ResolvedDocumentSection(**section)
                for section in family_payload.get("matched_sections", [])
            ]
            payload["resolved_family"] = ResolvedSectionFamily(**family_payload)
        return DocumentExtractionContext(**payload)
    except (KeyError, TypeError, ValueError):
        return None


def load_extraction_context(
    conversation_id: str,
    document_id: str,
    *,
    source_fingerprint: str | None = None,
    target_section: str | None = None,
) -> DocumentExtractionContext | None:
    context = _EXTRACTION_CONTEXTS.get((conversation_id, document_id))
    if context is None:
        return None
    if source_fingerprint and context.source_fingerprint != source_fingerprint:
        return None
    if target_section and context.target_section.casefold() != target_section.casefold():
        return None
    return context


def infer_extraction_rescan_direction(follow_up: str) -> str:
    if re.search(
        r"\b(not\s+all|all\s+of\s+them|every(?:thing)?|whole\s+document|"
        r"only\s+a\s+fraction|do(?:n't|\s+not)\s+leave|nicht\s+alle|alle\s+davon|"
        r"gesamte[ns]?\s+dokument|vollst[aÃ¤]ndig)\b",
        follow_up or "",
        re.IGNORECASE,
    ):
        return "full_scope_rebuild"
    if re.search(
        r"\b(first ones|earlier ones|beginning|before|die ersten|früheren|am anfang)\b",
        follow_up or "",
        re.IGNORECASE,
    ):
        return "earlier"
    if re.search(
        r"\b(more|continue|next|later ones|weiter|mehr|nächsten)\b",
        follow_up or "",
        re.IGNORECASE,
    ):
        return "later"
    return "full"


def identify_suspicious_numbering_gaps(item_ids: list[str]) -> list[str]:
    """Return review candidates; gaps trigger review but are not proof of loss."""
    by_section: dict[str, set[int]] = {}
    for item_id in item_ids:
        normal = normalise_item_id(item_id)
        match = re.fullmatch(r"(\d+)\.(\d+)", normal)
        if match:
            by_section.setdefault(match.group(1), set()).add(int(match.group(2)))
    gaps: list[str] = []
    for section, numbers in by_section.items():
        if numbers and min(numbers) > 1:
            gaps.extend(f"{section}.{number}" for number in range(1, min(numbers)))
        if len(numbers) >= 2:
            gaps.extend(
                f"{section}.{number}"
                for number in range(min(numbers), max(numbers) + 1)
                if number not in numbers
            )
    return gaps


def review_numbering_gap(
    item_id: str,
    *,
    neighbouring_text: str,
    reviewed_pages: list[int],
    review_result: GapReviewResult | None = None,
) -> NumberingGap:
    """Classify a gap only after explicit, appropriately broad searches."""
    variants = gap_id_variants(item_id)
    explicit = review_result or GapReviewResult(
        exact_text_search_performed=True,
        full_section_search_performed=False,
        exact_matches=(reviewed_pages if any(
            variant.confidence >= 0.9
            and _gap_variant_matches_text(variant, neighbouring_text)
            for variant in variants
        ) else []),
        reviewed_pages=reviewed_pages,
    )
    if explicit.intentional_omission_pages or re.search(
        r"\b(cancelled|omitted|not used|variant|entf[aä]llt|gestrichen|variante)\b",
        neighbouring_text or "",
        re.IGNORECASE,
    ):
        status = GapStatus.INTENTIONAL
    elif explicit.exact_matches:
        status = GapStatus.CONFIRMED_MISSING
    elif (
        explicit.exact_text_search_performed
        and (
            explicit.full_section_search_performed
            or explicit.question_section_status in {
                SearchAvailability.SEARCHED,
                SearchAvailability.NOT_AVAILABLE,
            }
        )
        and (
            explicit.solution_section_search_performed
            or explicit.solution_section_status in {
                SearchAvailability.SEARCHED,
                SearchAvailability.NOT_AVAILABLE,
            }
        )
        and explicit.coverage.full_document_text_searched
        and not explicit.coverage.visual_search_budget_exhausted
        and set(explicit.coverage.targeted_visual_pages_required).issubset(
            explicit.coverage.targeted_visual_pages_searched
        )
    ):
        status = GapStatus.REVIEWED_NOT_FOUND
    else:
        status = GapStatus.UNRESOLVED
    return NumberingGap(
        item_id=item_id,
        status=status,
        reviewed_pages=explicit.reviewed_pages or reviewed_pages,
        search_performed=explicit.exact_text_search_performed,
        evidence_pages=explicit.exact_matches if status is GapStatus.CONFIRMED_MISSING else [],
        full_section_search_performed=explicit.full_section_search_performed,
        solution_section_search_performed=explicit.solution_section_search_performed,
        visual_search_performed=explicit.visual_search_performed,
        coverage=explicit.coverage,
    )


def gap_id_variants(item_id: str) -> list[GapIdVariant]:
    return [
        GapIdVariant(item_id, 1.0, False),
        GapIdVariant(f"Aufgabe {item_id}", 1.0, False),
        GapIdVariant(f"Frage {item_id}", 1.0, False),
        GapIdVariant(f"Nr. {item_id}", 0.95, False),
        GapIdVariant(item_id.replace(".", " "), 0.55, True),
        GapIdVariant(item_id.replace(".", ""), 0.35, True),
    ]


_QUESTION_CONTEXT_RE = re.compile(
    r"\b(?:Aufgabe|Frage|Kurzfrage|question|item|Nr\.)\b", re.IGNORECASE,
)


def _gap_variant_matches_text(variant: GapIdVariant, text: str) -> bool:
    pattern = re.compile(
        rf"(?<![\d.]){re.escape(variant.value)}(?![\d.])", re.IGNORECASE,
    )
    for match in pattern.finditer(text or ""):
        if not variant.requires_question_context:
            return True
        context = (text or "")[max(0, match.start() - 32):match.end() + 20]
        if _QUESTION_CONTEXT_RE.search(context):
            return True
    return False


def classify_extraction_page_result(text: str, target: str) -> PageClassificationResult:
    """Route conservatively: weak answer words alone never imply a solution page."""
    value = text or ""
    if not value.strip():
        return PageClassificationResult(ExtractionPageKind.IRRELEVANT, 0.95, [])
    signals: list[str] = []
    if re.search(rf"\b(?:{re.escape(target)}|kurzfragen?|fragen?|aufgaben?|question)\b|\?", value, re.I):
        signals.append("question_structure")
    if re.search(r"\b(?:musterl(?:ö|oe|Ã¶)sung|l(?:ö|oe|Ã¶)sung(?:en)?|answer key|solutions?)\b", value, re.I):
        signals.append("solution_heading")
    if re.search(r"[\u2611\u2713\u2714]|\[[xX]\]", value):
        signals.append("selected_options")
    if len(re.findall(r"(?m)^\s*\d+(?:\.\d+)+\s*(?::|[-.)])", value)) >= 2:
        signals.append("repeated_answer_patterns")
    if len(re.findall(r"(?:=|â‰ˆ)\s*[+âˆ’-]?\d+(?:[.,]\d+)?\s*(?:mm|cm|m|N|Pa)", value, re.I)) >= 2:
        signals.append("completed_calculations")
    if re.search(r"\b(?:antwort|richtig|korrekt)\b", value, re.I):
        signals.append("weak_solution_word")
    question = "question_structure" in signals
    solution_score = (
        (2 if "solution_heading" in signals else 0)
        + (1 if "selected_options" in signals else 0)
        + (1 if "repeated_answer_patterns" in signals else 0)
        + (1 if "completed_calculations" in signals else 0)
        + (0.5 if "weak_solution_word" in signals else 0)
    )
    strong_solution = solution_score >= 2
    if question and strong_solution:
        return PageClassificationResult(ExtractionPageKind.MIXED, 0.9, signals)
    if question and not any(signal in signals for signal in (
        "solution_heading", "selected_options", "completed_calculations",
    )):
        return PageClassificationResult(ExtractionPageKind.QUESTION, 0.88, signals)
    if strong_solution:
        return PageClassificationResult(ExtractionPageKind.SOLUTION, 0.88, signals)
    return PageClassificationResult(ExtractionPageKind.UNCERTAIN, 0.55, signals)


def classify_extraction_page(text: str, target: str) -> ExtractionPageKind:
    return classify_extraction_page_result(text, target).kind


def _load_document_pages(
    *, user_id: str, course_id: str, document_id: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    sb = get_supabase()
    doc_response = (
        sb.table("documents")
        .select("id,file_name,page_count,active_index_revision,storage_path")
        .eq("id", document_id)
        .eq("user_id", user_id)
        .eq("course_id", course_id)
        .limit(1)
        .execute()
    )
    docs = doc_response.data or []
    if not docs:
        raise ValueError("active document is unavailable")
    rows: list[dict[str, Any]] = []
    offset = 0
    page_size = 200
    while True:
        response = (
            sb.table("document_pages")
            .select("page_number,cleaned_text,raw_text,extraction_quality")
            .eq("document_id", document_id)
            .eq("user_id", user_id)
            .eq("course_id", course_id)
            .order("page_number")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        batch = list(response.data or [])
        rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    return dict(docs[0]), rows


def _extract_visual_page(
    *,
    document: dict[str, Any],
    page_number: int,
    target: str,
) -> list[ExtractedQAItem]:
    """Render and inspect a weak/scanned page for marks, questions and answers."""
    storage_path = str(document.get("storage_path") or "")
    if not storage_path:
        raise RuntimeError("document storage path is unavailable for visual extraction")
    from .storage import download_document_bytes
    from .vision_ocr import _render_page_to_png, _try_import_pypdfium2

    pdfium = _try_import_pypdfium2()
    if pdfium is None:
        raise RuntimeError("PDF renderer is unavailable for visual extraction")
    png = _render_page_to_png(
        pdfium,
        download_document_bytes(storage_path),
        page_number - 1,
        260,
    )
    if not png:
        raise RuntimeError(f"PDF page {page_number} could not be rendered")
    return _extract_visual_image(
        image_bytes=png,
        media_type="image/png",
        page_number=page_number,
        target=target,
        pace=True,
    )


def _discover_visual_section_headings(
    *, document: dict[str, Any], total_pages: int, target: str,
) -> list[dict[str, Any]]:
    """Discover top-level headings when the stored OCR cannot resolve a family."""
    storage_path = str(document.get("storage_path") or "")
    if not storage_path:
        raise RuntimeError("document storage path is unavailable for heading discovery")
    from .openai_client import get_openai_client
    from .storage import download_document_bytes
    from .vision_ocr import _render_page_to_png, _try_import_pypdfium2

    pdfium = _try_import_pypdfium2()
    if pdfium is None:
        raise RuntimeError("PDF renderer is unavailable for heading discovery")
    pdf_bytes = download_document_bytes(storage_path)
    headings: list[dict[str, Any]] = []
    for page_number in range(1, total_pages + 1):
        png = _render_page_to_png(pdfium, pdf_bytes, page_number - 1, 180)
        if not png:
            continue
        request_kwargs = {
            "model": get_settings().openai_generate_model,
            "temperature": 0,
            "max_tokens": 500,
            "response_format": {"type": "json_object"},
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": (
                        f"Inspect PDF page {page_number} only. Find every TOP-LEVEL section banner, "
                        f"including the family named by {target!r} and the first later banner that "
                        "ends that family (for example a calculation/task section). Use visual "
                        "hierarchy, not merely "
                        "the words: when the page uses wide dark-gray horizontal section bars, only "
                        "text inside those bars is a top-level banner. Return no heading for ordinary "
                        "text lines, bold subsection "
                        "labels, running headers, continuation labels, or question IDs. A valid family "
                        "family banner has the exact printed form 'N. Kurzfragen - Topic' (or 'N. "
                        "Short Questions - Topic'), while a non-family top-level banner keeps its "
                        "own exact title. Read every digit exactly; 10 and 11 must not become 1. "
                        "Never infer a banner from nearby content such as 2.1 or 12.20. Transcribe the "
                        "full banner exactly. Return JSON with "
                        "headings in top-to-bottom order "
                        "as {\"headings\":[{\"number\":2,\"heading\":\"2. Kurzfragen - ...\","
                        "\"title\":\"...\",\"position\":0,\"y_position\":0.25,"
                        "\"confidence\":0.9}]}. "
                        "position is the zero-based top-to-bottom heading order on this page."
                    )},
                    {"type": "image_url", "image_url": {
                        "url": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
                        "detail": "high",
                    }},
                ],
            }],
        }
        response = None
        for attempt in range(10):
            try:
                response = get_openai_client().chat.completions.create(**request_kwargs)
                # High-detail page images can consume most of the per-minute
                # vision budget in a short burst. Pace the one-time structural
                # rebuild; later requests use the verified scope cache.
                time.sleep(3.0)
                break
            except Exception as exc:
                if getattr(exc, "status_code", None) != 429 or attempt == 9:
                    raise
                delay = min(5.0, 1.5 * (attempt + 1))
                log.warning(
                    "visual_heading_discovery_rate_limited page=%s attempt=%s delay=%.2f",
                    page_number, attempt + 1, delay,
                )
                time.sleep(delay)
        if response is None:
            raise RuntimeError(f"visual heading discovery failed on page {page_number}")
        try:
            payload = json.loads(str(response.choices[0].message.content or "{}"))
        except (TypeError, ValueError):
            log.warning("visual_heading_discovery_invalid_json page=%s", page_number)
            continue
        for position, raw in enumerate(payload.get("headings", []) if isinstance(payload, dict) else []):
            if not isinstance(raw, dict):
                continue
            headings.append({**raw, "page": page_number, "position": raw.get("position", position)})
    return headings


def _extract_visual_image(
    *,
    image_bytes: bytes,
    media_type: str,
    page_number: int,
    target: str,
    pace: bool = False,
) -> list[ExtractedQAItem]:
    """Inspect the exact browser-captured visible page without re-rendering it."""
    from .openai_client import get_openai_client

    request_kwargs = {
        "model": get_settings().openai_generate_model,
        "temperature": 0,
        "max_tokens": 7000,
        "response_format": {"type": "json_object"},
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        f"Exhaustively extract EVERY numbered {target!r} question from this "
                        f"scanned PDF page {page_number}, in reading order. Preserve the exact "
                        "multi-level item ID (for example 2.1, 7.4), the full question text, and "
                        "all visible multiple-choice options inside the question text. A top-level "
                        "section heading such as '2. Kurzfragen' is not a question. Do not skip "
                        "questions merely because they have no answer. The answer field must be "
                        "empty unless this exact page visibly contains official solution evidence, "
                        "a checked box, correction mark, worked solution, or annotation. Never use "
                        "an unmarked option as the answer and never invent missing text. Return JSON as "
                        '{"items":[{"item_id":"...","question":"...","answer":"...",'
                        '"question_page":1,"answer_page":1,"evidence_type":"checked_option",'
                        '"confidence":0.9}]}.'
                    ),
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{media_type};base64,"
                        + base64.b64encode(image_bytes).decode("ascii"),
                        "detail": "high",
                    },
                },
            ],
        }],
    }
    response = None
    for attempt in range(10):
        try:
            response = get_openai_client().chat.completions.create(**request_kwargs)
            if pace:
                time.sleep(3.0)
            break
        except Exception as exc:
            if getattr(exc, "status_code", None) != 429 or attempt == 9:
                raise
            delay = min(5.0, 1.5 * (attempt + 1))
            log.warning(
                "visual_page_extraction_rate_limited page=%s attempt=%s delay=%.2f",
                page_number, attempt + 1, delay,
            )
            time.sleep(delay)
    if response is None:
        raise RuntimeError(f"visual extraction failed on page {page_number}")
    try:
        data = json.loads(str(response.choices[0].message.content or "{}"))
    except (TypeError, ValueError):
        raise RuntimeError(f"visual extraction returned invalid JSON for page {page_number}")
    items = [
        item
        for item in (
            _normalise_item(raw, page_number)
            for raw in (data.get("items", []) if isinstance(data, dict) else [])
        )
        if item is not None
    ]
    # Page provenance comes from the rendered page we supplied, never from the
    # model's JSON. Models commonly copy a schema example such as page 1; that
    # used to make valid visual questions fail the final section-scope filter.
    for item in items:
        item.question_page = page_number
        if item.answer:
            item.answer_page = page_number
        else:
            item.answer_page = None
    return items


def _normalise_item(raw: Any, fallback_page: int) -> ExtractedQAItem | None:
    if not isinstance(raw, dict):
        return None
    item_id = str(raw.get("item_id") or raw.get("number") or "").strip()
    question = str(raw.get("question") or "").strip()
    answer = str(raw.get("answer") or "").strip()
    if not item_id or not question or not _ITEM_ID_RE.match(item_id):
        return None
    try:
        question_page = int(raw.get("question_page") or fallback_page)
    except (TypeError, ValueError):
        question_page = fallback_page
    try:
        answer_page = int(raw["answer_page"]) if raw.get("answer_page") else None
    except (TypeError, ValueError):
        answer_page = None
    try:
        confidence = max(0.0, min(1.0, float(raw.get("confidence") or 0.7)))
    except (TypeError, ValueError):
        confidence = 0.7
    return ExtractedQAItem(
        item_id=item_id,
        question=question,
        answer=answer,
        question_page=question_page,
        answer_page=answer_page,
        confidence=confidence,
        evidence_type=str(raw.get("evidence_type") or "").strip() or None,
    )


def _normalise_question(raw: Any, fallback_page: int) -> ExtractedQuestion | None:
    item = _normalise_item(raw, fallback_page)
    if item is None:
        return None
    raw_options = raw.get("options") if isinstance(raw, dict) else []
    options: list[ExtractedQuestionOption] = []
    if isinstance(raw_options, list):
        for index, option in enumerate(raw_options):
            if isinstance(option, dict):
                text = str(option.get("text") or "").strip()
                label = str(option.get("label") or "").strip() or None
            else:
                text, label = str(option or "").strip(), None
            if text:
                options.append(ExtractedQuestionOption(label=label, text=text, order=index))
    return ExtractedQuestion(
        item_id=item.item_id,
        normalized_item_id=normalise_item_id(item.item_id),
        question_text=item.question,
        question_page=item.question_page,
        section=str(raw.get("section") or "").strip() or None,
        question_fingerprint=question_fingerprint(item.question),
        confidence=item.confidence,
        options=options,
        answer_type=str(raw.get("answer_type") or "").strip() or None,
    )


def _normalise_solution(
    raw: Any,
    fallback_page: int,
) -> ExtractedSolutionEvidence | None:
    if not isinstance(raw, dict):
        return None
    answer = str(raw.get("answer_text") or raw.get("answer") or "").strip()
    if not answer:
        return None
    item_id = str(raw.get("item_id") or raw.get("number") or "").strip() or None
    try:
        answer_page = int(raw.get("answer_page") or fallback_page)
    except (TypeError, ValueError):
        answer_page = fallback_page
    referenced = str(
        raw.get("referenced_question_text") or raw.get("question") or ""
    ).strip() or None
    try:
        confidence = max(0.0, min(1.0, float(raw.get("confidence") or 0.7)))
    except (TypeError, ValueError):
        confidence = 0.7
    return ExtractedSolutionEvidence(
        item_id=item_id,
        normalized_item_id=normalise_item_id(item_id or "") or None,
        answer_text=answer,
        answer_page=answer_page,
        evidence_type=str(raw.get("evidence_type") or "printed_answer"),
        referenced_question_text=referenced,
        question_fingerprint=(
            question_fingerprint(referenced) if referenced else None
        ),
        confidence=confidence,
    )


def _item_sort_key(item: ExtractedQAItem) -> tuple[int, tuple[Any, ...]]:
    parts: list[Any] = []
    for token in re.findall(r"\d+|[a-z]+", item.item_id.casefold()):
        parts.append(int(token) if token.isdigit() else token)
    return item.question_page, tuple(parts)


def _merge_items(items: list[ExtractedQAItem]) -> list[ExtractedQAItem]:
    merged: dict[str, ExtractedQAItem] = {}
    for item in items:
        key = normalise_item_id(item.item_id) or item.item_id.casefold()
        existing = merged.get(key)
        if existing is None:
            merged[key] = item
            continue
        # Prefer the fuller source transcription and fill an official answer
        # discovered later in a solution-page batch.
        if len(item.question) > len(existing.question):
            existing.question = item.question
            existing.question_page = min(existing.question_page, item.question_page)
        if item.answer and (not existing.answer or len(item.answer) > len(existing.answer)):
            existing.answer = item.answer
            existing.answer_page = item.answer_page or item.question_page
        existing.confidence = max(existing.confidence, item.confidence)
    return sorted(merged.values(), key=_item_sort_key)


@dataclass
class AnswerRecoveryResult:
    solution_evidence: list[ExtractedSolutionEvidence] = field(default_factory=list)
    inspected_pages: dict[str, list[int]] = field(default_factory=dict)
    incomplete: bool = False
    records: dict[str, AnswerRecoveryRecord] = field(default_factory=dict)


def recover_unanswered_answers(
    *,
    document: dict[str, Any],
    questions: list[ExtractedQuestion],
    paired_items: list[PairedQAItem],
    text_by_page: dict[int, str],
    page_statuses: dict[int, PageProcessingStatus],
    max_visual_calls: int | None = None,
    previous_records: dict[str, AnswerRecoveryRecord] | None = None,
) -> AnswerRecoveryResult:
    """Target visual answer marks for existing questions with missing answers.

    Text quality is deliberately not a gate: a page may have perfect option
    text while its checked box, colour, circle, or annotation is visual-only.
    """
    recovery = AnswerRecoveryResult()
    questions_by_id = {question.normalized_item_id: question for question in questions}
    unanswered_count = sum(not item.answer_text for item in paired_items)
    if max_visual_calls is None:
        settings = get_settings()
        hard_limit = int(getattr(settings, "document_answer_recovery_hard_limit", 90) or 90)
        per_question = 3 if unanswered_count <= 5 else 2 if unanswered_count <= 15 else 1
        max_visual_calls = min(hard_limit, max(12, unanswered_count * per_question))
    calls = 0
    previous_records = previous_records or {}
    for pair in (item for item in paired_items if not item.answer_text):
        question = questions_by_id.get(normalise_item_id(pair.item_id))
        if question is None:
            continue
        question_tokens = set(re.findall(r"\w{4,}", question.question_text.casefold()))
        option_tokens = [
            set(re.findall(r"\w{4,}", option.text.casefold()))
            for option in question.options
        ]
        ranked: list[tuple[float, int]] = []
        for page, text in text_by_page.items():
            normalized = text.casefold()
            tokens = set(re.findall(r"\w{4,}", normalized))
            score = 0.0
            if re.search(
                rf"(?<![\d.]){re.escape(question.item_id)}(?![\d.])", text
            ):
                score += 5.0
            overlap = len(question_tokens & tokens) / max(1, len(question_tokens))
            score += 4.0 * overlap
            option_overlap = max(
                (len(values & tokens) / max(1, len(values)) for values in option_tokens),
                default=0.0,
            )
            score += 3.0 * option_overlap
            if re.search(
                r"\b(?:l[oÃ¶]sung(?:en)?|solution|antworten?|answer\s*key)\b",
                normalized,
            ):
                score += 2.5
            if len(question.options) >= 2 and option_overlap >= 0.35:
                score += 2.0
            if score > 0:
                ranked.append((score, page))
        candidate_pages = [page for _score, page in sorted(ranked, reverse=True)[:3]]
        prior = previous_records.get(pair.item_id)
        record = AnswerRecoveryRecord(
            item_id=pair.item_id,
            candidate_pages=candidate_pages,
            inspected_pages=list(prior.inspected_pages) if prior else [],
            calls_used=prior.calls_used if prior else 0,
        )
        candidate_pages = [page for page in candidate_pages if page not in record.inspected_pages]
        record.remaining_pages = list(candidate_pages)
        recovery.records[pair.item_id] = record
        recovery.inspected_pages[pair.item_id] = record.inspected_pages
        if not candidate_pages:
            record.status = (
                prior.status if prior and prior.candidate_pages
                else AnswerResolutionStatus.NO_CANDIDATES
            )
            recovery.incomplete = record.status not in {
                AnswerResolutionStatus.NOT_FOUND_AFTER_FULL_SEARCH,
                AnswerResolutionStatus.PAIRED_VISUAL,
            }
            continue
        if calls >= max_visual_calls:
            record.status = AnswerResolutionStatus.VISUAL_BUDGET_EXHAUSTED
            recovery.incomplete = True
            continue
        options = "\n".join(
            f"{option.label or option.order + 1}. {option.text}"
            for option in question.options
        ) or "No structured choices were extracted."
        for page in candidate_pages:
            if calls >= max_visual_calls:
                record.status = AnswerResolutionStatus.VISUAL_BUDGET_EXHAUSTED
                record.remaining_pages = [p for p in candidate_pages if p not in record.inspected_pages]
                recovery.incomplete = True
                break
            calls += 1
            record.calls_used += 1
            record.inspected_pages.append(page)
            record.remaining_pages = [p for p in candidate_pages if p not in record.inspected_pages]
            try:
                visual_items = _extract_visual_page(
                    document=document,
                    page_number=page,
                    target=(
                        f"Find official visible answer evidence for question {question.item_id}. "
                        f"Question: {question.question_text}\nKnown answer choices:\n{options}\n"
                        "Inspect checked boxes, coloured ticks, circles, underlining, "
                        "highlighting, handwritten corrections, and answer-key rows. "
                        "Return an answer only when a visible mark supports it. Never "
                        "solve from general knowledge."
                    ),
                )
                page_statuses[page] = PageProcessingStatus.VISION_PROCESSED
            except Exception:
                record.status = AnswerResolutionStatus.VISION_EXTRACTION_FAILED
                recovery.incomplete = True
                log.exception(
                    "document_answer_visual_recovery_failed document=%s item=%s page=%s",
                    document.get("id"), pair.item_id, page,
                )
                continue
            accepted: list[ExtractedQAItem] = []
            for item in visual_items:
                if not item.answer.strip() or item.confidence < 0.65:
                    continue
                id_match = normalise_item_id(item.item_id) == question.normalized_item_id
                answer_norm = re.sub(r"\W+", " ", item.answer.casefold()).strip()
                option_match = any(
                    re.sub(r"\W+", " ", option.text.casefold()).strip() in answer_norm
                    or answer_norm in re.sub(r"\W+", " ", option.text.casefold()).strip()
                    for option in question.options
                    if option.text.strip() and answer_norm
                )
                if not (id_match or option_match):
                    continue
                accepted.append(item)
            distinct_answers = {
                re.sub(r"\s+", " ", item.answer.casefold()).strip()
                for item in accepted
            }
            if len(distinct_answers) > 1:
                record.status = AnswerResolutionStatus.AMBIGUOUS_EVIDENCE
                recovery.incomplete = True
                break
            for item in accepted[:1]:
                recovery.solution_evidence.append(ExtractedSolutionEvidence(
                    item_id=question.item_id,
                    normalized_item_id=question.normalized_item_id,
                    answer_text=item.answer,
                    answer_page=item.answer_page or page,
                    evidence_type=item.evidence_type or "visual_answer_mark",
                    referenced_question_text=question.question_text,
                    question_fingerprint=question.question_fingerprint,
                    confidence=item.confidence,
                ))
                record.status = AnswerResolutionStatus.PAIRED_VISUAL
                record.evidence_page = item.answer_page or page
                record.evidence_type = item.evidence_type or "visual_answer_mark"
                break
            if any(
                item.normalized_item_id == question.normalized_item_id
                for item in recovery.solution_evidence
            ):
                break
        if record.status == AnswerResolutionStatus.SEARCH_PENDING:
            record.status = AnswerResolutionStatus.NOT_FOUND_AFTER_FULL_SEARCH
    return recovery


def extract_document_qa(
    *,
    user_id: str,
    course_id: str,
    document_id: str,
    target: str,
    status: Callable[[str], None] | None = None,
    pages_to_scan: list[int] | None = None,
    previous_items: list[ExtractedQAItem] | None = None,
    previous_context: DocumentExtractionContext | None = None,
    checkpoint: Callable[[dict[str, Any]], None] | None = None,
    discovery_checkpoint: Callable[[dict[str, Any]], None] | None = None,
    visible_page: int | None = None,
    visible_page_text: str | None = None,
    visible_page_image: bytes | None = None,
    visible_page_image_media_type: str = "image/png",
    active_document_id: str | None = None,
    active_file_name: str | None = None,
) -> DocumentExtractionResult:
    if active_document_id and active_document_id != document_id:
        raise ValueError("active document does not match extraction document")
    document, page_rows = _load_document_pages(
        user_id=user_id, course_id=course_id, document_id=document_id,
    )
    all_text_by_page = {
        int(row.get("page_number") or 0): str(
            row.get("cleaned_text") or row.get("raw_text") or ""
        ).strip()
        for row in page_rows
        if int(row.get("page_number") or 0) >= 1
    }
    if visible_page and (visible_page_text or "").strip():
        # The stable browser snapshot is authoritative for the page the student
        # is actually looking at, even while its background index is incomplete.
        all_text_by_page[visible_page] = str(visible_page_text).strip()
        visible_row = next(
            (row for row in page_rows if int(row.get("page_number") or 0) == visible_page),
            None,
        )
        if visible_row is None:
            page_rows.append({
                "page_number": visible_page,
                "cleaned_text": str(visible_page_text).strip(),
                "raw_text": "",
                "extraction_quality": "good",
            })
        else:
            visible_row["cleaned_text"] = str(visible_page_text).strip()
            visible_row["extraction_quality"] = "good"
    total_pages = int(document.get("page_count") or len(page_rows) or 0)
    target_pages = (
        list(range(1, total_pages + 1))
        if pages_to_scan is None
        else list(pages_to_scan)
    )
    result = DocumentExtractionResult(
        document_id=document_id,
        target=target or "questions",
        total_pages=total_pages,
    )
    numbered_section = requested_section_number(target)
    family_requested = bool(
        not numbered_section
        and re.search(
            r"\b(?:kurzfragen?|short\s+questions?)\b", target, re.IGNORECASE,
        )
    )
    resolved_family = resolve_section_family(
        target, all_text_by_page, total_pages=total_pages,
    )
    if (
        not target_pages
        and previous_context
        and previous_context.resolved_family
        and previous_context.scope_extraction_complete
    ):
        resolved_family = previous_context.resolved_family
    visual_heading_error: str | None = None
    enforce_family_resolution = family_requested
    if (
        enforce_family_resolution and resolved_family is None and target_pages
        and document.get("storage_path")
    ):
        try:
            visual_headings = _discover_visual_section_headings(
                document=document, total_pages=total_pages, target=target,
            )
            resolved_family = resolve_section_family(
                target, all_text_by_page, total_pages=total_pages,
                visual_headings=visual_headings,
            )
        except Exception as exc:
            visual_heading_error = type(exc).__name__
            log.exception(
                "document_family_visual_heading_discovery_failed document=%s target=%s",
                document_id, target,
            )
    result.resolved_family = resolved_family
    if resolved_family:
        scope_payload = {
            "document_revision": str(document.get("active_index_revision") or document.get("updated_at") or ""),
            "target": resolved_family.family_name.casefold(),
            "sections": [
                [section.requested_number, section.matched_heading, section.start_page, section.end_page]
                for section in resolved_family.matched_sections
            ],
        }
        result.scope_fingerprint = hashlib.sha256(
            json.dumps(scope_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()[:24]
        if (
            previous_context
            and previous_context.scope_fingerprint
            and previous_context.scope_fingerprint != result.scope_fingerprint
        ):
            log.info(
                "document_scope_context_invalidated document=%s old=%s new=%s",
                document_id, previous_context.scope_fingerprint, result.scope_fingerprint,
            )
            previous_context = None
    resolved_section = resolve_document_section(
        target,
        all_text_by_page,
        total_pages=total_pages,
        visible_page=visible_page,
    ) if numbered_section else None
    bootstrap_visual_items: list[ExtractedQAItem] = []
    if numbered_section and visible_page and visible_page_image:
        try:
            bootstrap_visual_items = [
                item for item in _extract_visual_image(
                    image_bytes=visible_page_image,
                    media_type=visible_page_image_media_type,
                    page_number=visible_page,
                    target=target,
                )
                if item_belongs_to_requested_section(item.item_id, target)
            ]
        except Exception:
            log.exception(
                "document_visible_snapshot_read_failed document=%s page=%s target=%s",
                document_id, visible_page, target,
            )
    if numbered_section and resolved_section is None and visible_page:
        try:
            visual_items = bootstrap_visual_items or (
                _extract_visual_page(
                    document=document, page_number=visible_page, target=target,
                )
            )
            bootstrap_visual_items = [
                item for item in visual_items
                if item_belongs_to_requested_section(item.item_id, target)
            ]
        except Exception:
            log.exception(
                "document_section_visual_anchor_failed document=%s page=%s target=%s",
                document_id, visible_page, target,
            )
        if bootstrap_visual_items:
            resolved_section = ResolvedDocumentSection(
                requested_number=numbered_section,
                requested_title=re.sub(r"^\s*\d+\s*\.\s*", "", target).strip(),
                matched_heading=target,
                start_page=visible_page,
                end_page=visible_page,
                expected_item_prefix=f"{numbered_section}.",
                confidence=0.86,
            )
    if (numbered_section and resolved_section is None) or (
        enforce_family_resolution and resolved_family is None and target_pages
    ):
        result.section_resolved = False
        result.status = (
            "section_not_found" if numbered_section else
            "section_heading_verification_failed" if visual_heading_error else
            "section_family_not_found"
        )
        result.message = (
            f'Minallo found the document, but it could not reliably verify section "{target}". '
            "No questions were silently omitted."
        )
        result.unprocessed_pages = sorted(
            set(range(1, total_pages + 1)) - set(all_text_by_page)
        )
        return result
    if resolved_family and not any(
        section.question_pages for section in resolved_family.matched_sections
    ):
        result.section_resolved = False
        result.status = "section_scope_has_no_question_pages"
        result.message = (
            f'Minallo could not verify question pages for "{target}". '
            "It did not extract questions from unrelated pages."
        )
        log.error(
            "zero_question_page_invariant_triggered document=%s target=%s",
            document_id, target,
        )
        return result
    question_page_scope = set(
        resolved_section.question_pages if resolved_section else
        [page for section in resolved_family.matched_sections for page in section.question_pages]
        if resolved_family else target_pages
    )
    if resolved_section:
        result.resolved_heading = resolved_section.matched_heading
        result.resolved_start_page = resolved_section.start_page
        result.resolved_end_page = resolved_section.end_page
    if not target_pages:
        result.status = "no_pages_in_requested_direction"
        result.message = (
            "There are no pages left to scan in the requested direction."
        )
        if previous_context:
            result.extracted_questions = list(previous_context.extracted_questions)
            result.solution_evidence = list(previous_context.solution_evidence)
            result.paired_items = list(previous_context.paired_items)
            result.items = [ExtractedQAItem(
                item_id=item.item_id,
                question=item.question_text,
                answer=item.answer_text or "",
                question_page=item.question_page,
                answer_page=item.answer_page,
                confidence=item.pairing_confidence,
            ) for item in result.paired_items]
            return result
        result.items = list(previous_items or [])
        result.extracted_questions = [
            ExtractedQuestion(
                item_id=item.item_id,
                normalized_item_id=normalise_item_id(item.item_id),
                question_text=item.question,
                question_page=item.question_page,
                question_fingerprint=question_fingerprint(item.question),
                confidence=item.confidence,
            )
            for item in result.items
        ]
        result.solution_evidence = [
            ExtractedSolutionEvidence(
                item_id=item.item_id,
                normalized_item_id=normalise_item_id(item.item_id),
                answer_text=item.answer,
                answer_page=item.answer_page or item.question_page,
                evidence_type="printed_answer",
                referenced_question_text=item.question,
                question_fingerprint=question_fingerprint(item.question),
                confidence=item.confidence,
            )
            for item in result.items
            if item.answer
        ]
        result.paired_items = pair_questions_and_solutions(
            result.extracted_questions,
            result.solution_evidence,
        )
        if previous_context:
            result.scope_extraction_complete = previous_context.scope_extraction_complete
            result.answer_verification_complete = previous_context.answer_verification_complete
            result.complete = previous_context.complete
            result.scope_fingerprint = previous_context.scope_fingerprint
            result.resolved_family = previous_context.resolved_family or result.resolved_family
            result.cumulative_scanned_pages = list(previous_context.cumulative_scanned_pages)
            result.scanned_pages = list(previous_context.scanned_pages)
        return result
    requested_pages = set(target_pages)
    page_rows = [
        row for row in page_rows
        if int(row.get("page_number") or 0) in requested_pages
    ]
    usable: list[tuple[int, str]] = []
    weak_pages: list[int] = []
    seen_pages: set[int] = set()
    for row in page_rows:
        page = int(row.get("page_number") or 0)
        if page < 1:
            continue
        seen_pages.add(page)
        text = str(row.get("cleaned_text") or row.get("raw_text") or "").strip()
        raw_quality = row.get("extraction_quality")
        if isinstance(raw_quality, str):
            stored_quality = {
                "good": 1.0,
                "weak": 0.5,
                "failed": 0.0,
            }.get(raw_quality.casefold(), 0.0)
        else:
            try:
                stored_quality = float(raw_quality or 0.0)
            except (TypeError, ValueError):
                stored_quality = 0.0
        if len(text) < 20 or raw_quality is not None and stored_quality < 0.75:
            weak_pages.append(page)
            if text:
                usable.append((page, text))
        else:
            usable.append((page, text))
            result.scanned_pages.append(page)
            result.page_statuses[page] = PageProcessingStatus.TEXT_PROCESSED
    # Missing index rows were never processed; do not misreport them as unreadable.
    result.unprocessed_pages.extend(
        page
        for page in target_pages
        if page not in seen_pages
    )
    result.unprocessed_pages = sorted(set(result.unprocessed_pages))

    extracted_questions: list[ExtractedQuestion] = list(
        previous_context.extracted_questions if previous_context else []
    ) + [
        ExtractedQuestion(
            item_id=item.item_id,
            normalized_item_id=normalise_item_id(item.item_id),
            question_text=item.question,
            question_page=item.question_page,
            question_fingerprint=question_fingerprint(item.question),
            confidence=item.confidence,
        )
        for item in (previous_items or [])
    ]
    extracted_questions.extend(
        question for question in (
            _normalise_question({
                "item_id": item.item_id,
                "question": item.question,
                "question_page": item.question_page,
                "confidence": item.confidence,
                "section": target,
            }, visible_page or item.question_page)
            for item in bootstrap_visual_items
        ) if question is not None
    )
    solution_evidence: list[ExtractedSolutionEvidence] = list(
        previous_context.solution_evidence if previous_context else []
    ) + [
        ExtractedSolutionEvidence(
            item_id=item.item_id,
            normalized_item_id=normalise_item_id(item.item_id),
            answer_text=item.answer,
            answer_page=item.answer_page or item.question_page,
            evidence_type="printed_answer",
            referenced_question_text=item.question,
            question_fingerprint=question_fingerprint(item.question),
            confidence=item.confidence,
        )
        for item in (previous_items or [])
        if item.answer.strip()
    ]
    solution_evidence.extend(
        solution for solution in (
            _normalise_solution({
                "item_id": item.item_id,
                "question": item.question,
                "answer": item.answer,
                "answer_page": item.answer_page or item.question_page,
                "evidence_type": "visible_page_visual_anchor",
                "confidence": item.confidence,
            }, visible_page or item.question_page)
            for item in bootstrap_visual_items if item.answer
        ) if solution is not None
    )
    visual_item_pages_by_id: dict[str, set[int]] = {}
    # This pass discovers questions, so it must remain inside the verified
    # question-family scope. Answer evidence outside this range is handled by
    # the separate answer-recovery pass below.
    visual_pages = sorted(
        set(weak_pages + result.unprocessed_pages).intersection(question_page_scope)
    )
    for page in visual_pages:
        visual_processed = False
        try:
            visual_items = _extract_visual_page(
                document=document,
                page_number=page,
                target=target,
            )
            visual_processed = True
        except Exception:
            log.exception(
                "document_visual_fallback_failed document=%s page=%s",
                document_id,
                page,
            )
            visual_items = []
        if visual_items:
            for item in visual_items:
                visual_item_pages_by_id.setdefault(
                    normalise_item_id(item.item_id), set()
                ).add(page)
            extracted_questions.extend(
                question
                for question in (
                    _normalise_question(
                        {
                            "item_id": item.item_id,
                            "question": item.question,
                            "question_page": item.question_page,
                            "confidence": item.confidence,
                        },
                        page,
                    )
                    for item in visual_items
                )
                if question is not None
            )
            solution_evidence.extend(
                solution
                for solution in (
                    _normalise_solution(
                        {
                            "item_id": item.item_id,
                            "question": item.question,
                            "answer": item.answer,
                            "answer_page": item.answer_page or page,
                            "evidence_type": "visual_mark",
                            "confidence": item.confidence,
                        },
                        page,
                    )
                    for item in visual_items
                )
                if solution is not None
            )
        if visual_processed:
            result.scanned_pages.append(page)
            result.page_statuses[page] = PageProcessingStatus.VISION_PROCESSED
            if page in result.unprocessed_pages:
                result.unprocessed_pages.remove(page)
        else:
            result.page_statuses[page] = PageProcessingStatus.FAILED
    result.scanned_pages = sorted(set(result.scanned_pages))
    result.unreadable_pages = sorted(set(result.unreadable_pages))
    result.unprocessed_pages = sorted(set(result.unprocessed_pages))
    # Keep every map prompt bounded while scanning all pages in order. The
    # limit controls one map call, never total document coverage.
    groups: list[list[tuple[int, str]]] = []
    current: list[tuple[int, str]] = []
    current_chars = 0
    for page, text in usable:
        clipped = text[:16000]
        if current and (
            len(current) >= DOCUMENT_EXTRACTION_BATCH_SIZE
            or current_chars + len(clipped) > DOCUMENT_EXTRACTION_BATCH_CHAR_LIMIT
        ):
            groups.append(current)
            current, current_chars = [], 0
        current.append((page, clipped))
        current_chars += len(clipped)
    if current:
        groups.append(current)

    settings = get_settings()
    checkpoint_scanned_pages = set(
        previous_context.scanned_pages if previous_context else []
    )
    checkpoint_scanned_pages.update(
        page for page in result.scanned_pages if page in weak_pages
    )
    for index, group in enumerate(groups, start=1):
        if status:
            status("extracting_items")
        classified = [
            (page, text, classify_extraction_page(text, target))
            for page, text in group
        ]
        for page, _text, kind in classified:
            if kind == ExtractionPageKind.IRRELEVANT:
                result.page_statuses[page] = PageProcessingStatus.VERIFIED_IRRELEVANT
        question_pages = [
            (page, text) for page, text, kind in classified
            if page in question_page_scope
            if kind in {ExtractionPageKind.QUESTION, ExtractionPageKind.MIXED,
                        ExtractionPageKind.UNCERTAIN}
        ]
        solution_pages = [
            (page, text) for page, text, kind in classified
            if kind in {ExtractionPageKind.SOLUTION, ExtractionPageKind.MIXED,
                        ExtractionPageKind.UNCERTAIN}
        ]
        question_response = chat_json(
            model=settings.openai_generate_model,
            max_tokens=5000,
            system=(
                "You extract exam QUESTIONS ONLY from source pages. "
                f"Target only the section/category {target!r}. Scan every supplied page; "
                "do not cap the number of items. Preserve German or other source wording "
                "exactly. Do not extract, infer, or invent answers. Return JSON "
                "{\"questions\":[{\"item_id\":\"9.2\",\"question\":\"...\","
                "\"question_page\":9,\"section\":\"Kurzfragen\","
                "\"answer_type\":\"multiple_choice\",\"options\":["
                "{\"label\":\"A\",\"text\":\"...\"}],\"confidence\":0.9}]}. "
                "Ignore solution-only content and unrelated long calculations."
            ),
            user="\n\n".join(
                f"--- PAGE {page} ---\n{text}" for page, text in question_pages
            ),
        ) if question_pages else None
        solution_response = chat_json(
            model=settings.openai_generate_model,
            max_tokens=5000,
            system=(
                "You extract SOLUTION EVIDENCE ONLY from source pages. Do not create "
                "question records. Detect printed answers, checked options, worked "
                "solutions, annotations, green ticks, and visual marks. Preserve exact "
                "source wording and never invent missing evidence. Return JSON "
                "{\"solutions\":[{\"item_id\":\"9.2\",\"answer_text\":\"...\","
                "\"answer_page\":20,\"evidence_type\":\"checked_option\","
                "\"referenced_question_text\":null,\"confidence\":0.9}]}."
            ),
            user="\n\n".join(
                f"--- PAGE {page} ---\n{text}" for page, text in solution_pages
            ),
        ) if solution_pages else None
        result.model = (
            getattr(solution_response, "model", None)
            or getattr(question_response, "model", None)
            or result.model
        )
        for response in (question_response, solution_response):
            if response is not None:
                result.prompt_tokens += int(response.prompt_tokens or 0)
                result.completion_tokens += int(response.completion_tokens or 0)
        question_data = (
            question_response.data
            if question_response is not None and isinstance(question_response.data, dict)
            else {}
        )
        solution_data = (
            solution_response.data
            if solution_response is not None and isinstance(solution_response.data, dict)
            else {}
        )
        raw_questions = question_data.get("questions", question_data.get("items", []))
        raw_solutions = solution_data.get("solutions", solution_data.get("items", []))
        fallback_page = group[0][0]
        extracted_questions.extend(
            question
            for question in (
                _normalise_question(raw, fallback_page) for raw in raw_questions
            )
            if question is not None
        )
        solution_evidence.extend(
            solution
            for solution in (
                _normalise_solution(raw, fallback_page) for raw in raw_solutions
            )
            if solution is not None
        )
        log.info(
            "document_extraction_batch document=%s batch=%d/%d pages=%s "
            "questions=%d solutions=%d",
            document_id, index, len(groups), [p for p, _ in group],
            len(raw_questions), len(raw_solutions),
        )
        if checkpoint:
            checkpoint_scanned_pages.update(page for page, _ in group)
            completed_pages = sorted(checkpoint_scanned_pages)
            checkpoint({
                "batch_index": index,
                "batch_count": len(groups),
                "batch_pages": [page for page, _ in group],
                "scanned_pages": completed_pages,
                "unreadable_pages": sorted(set(result.unreadable_pages)),
                "extracted_questions": list(extracted_questions),
                "solution_evidence": list(solution_evidence),
                "paired_items": pair_questions_and_solutions(
                    extracted_questions, solution_evidence,
                ),
            })

    questions_by_id: dict[str, set[str]] = {}
    for item in extracted_questions:
        normal_id = item.normalized_item_id
        if normal_id and item.question_text.strip():
            questions_by_id.setdefault(normal_id, set()).add(
                re.sub(r"\W+", "", item.question_text.casefold())
            )
    result.duplicate_item_ids = sorted(
        item_id for item_id, questions in questions_by_id.items()
        if len(questions) > 1
    )
    # Seal a canonical inventory. An id reused for different question text is
    # a structural conflict, never a reason to keep whichever transcription is
    # longer.
    canonical_questions = canonicalize_questions(extracted_questions)
    unique_solutions: dict[tuple[str, int, str], ExtractedSolutionEvidence] = {}
    for item in solution_evidence:
        key = (
            item.normalized_item_id or item.question_fingerprint or "",
            item.answer_page,
            item.answer_text,
        )
        unique_solutions[key] = item
    result.extracted_questions = canonical_questions
    result.solution_evidence = list(unique_solutions.values())
    document_revision = str(
        document.get("active_index_revision") or document.get("updated_at") or ""
    )
    source_structure = result.resolved_heading or (
        resolved_family.family_name if resolved_family else target
    )
    for item in result.extracted_questions:
        item.document_id = document_id
        item.document_revision = document_revision
        item.scope_fingerprint = result.scope_fingerprint
        item.source_structure = source_structure
    for item in result.solution_evidence:
        item.document_id = document_id
        item.document_revision = document_revision
        item.scope_fingerprint = result.scope_fingerprint
        item.source_structure = source_structure
        if item.evidence_type in {"visual_mark", "green_checkmark", "checked_option", "visual_answer_mark"}:
            item.evidence_origin = "verified_visual_mark"
    if numbered_section:
        result.invalid_item_ids_rejected = sorted({
            item.item_id for item in result.extracted_questions
            if not item_belongs_to_requested_section(item.item_id, target)
        })
        if result.invalid_item_ids_rejected:
            result.status = "section_result_mismatch"
            log.warning(
                "section_result_mismatch document=%s file=%s target=%s heading=%s "
                "rejected_ids=%s",
                document_id, active_file_name, target,
                resolved_section.matched_heading if resolved_section else None,
                result.invalid_item_ids_rejected,
            )
        result.extracted_questions = [
            item for item in result.extracted_questions
            if item_belongs_to_requested_section(item.item_id, target)
            and item.question_page in question_page_scope
        ]
        allowed_ids = {
            item.normalized_item_id for item in result.extracted_questions
        }
        result.solution_evidence = [
            item for item in result.solution_evidence
            if not item.normalized_item_id or item.normalized_item_id in allowed_ids
        ]
    if resolved_family:
        allowed_prefixes = tuple(
            f"{number}." for number in resolved_family.section_numbers if number
        )
        rejected = [
            item.item_id for item in result.extracted_questions
            if not normalise_item_id(item.item_id).startswith(allowed_prefixes)
        ]
        result.out_of_scope_items_rejected = sorted(
            set(rejected), key=_natural_item_id_key,
        )
        if result.out_of_scope_items_rejected:
            log.warning(
                "out_of_scope_items_rejected document=%s family=%s items=%s",
                document_id, resolved_family.family_name,
                result.out_of_scope_items_rejected,
            )
        result.extracted_questions = [
            item for item in result.extracted_questions
            if normalise_item_id(item.item_id).startswith(allowed_prefixes)
            and item.question_page in question_page_scope
        ]
        allowed_ids = {item.normalized_item_id for item in result.extracted_questions}
        result.solution_evidence = [
            item for item in result.solution_evidence
            if not item.normalized_item_id or item.normalized_item_id in allowed_ids
        ]
    if family_requested and resolved_family is None and result.extracted_questions:
        log.error(
            "questions_returned_without_resolved_question_scope document=%s target=%s count=%d",
            document_id, target, len(result.extracted_questions),
        )
        result.section_resolved = False
        result.status = "questions_returned_without_resolved_question_scope"
        result.message = (
            "Minallo rejected an extraction because its complete section scope "
            "could not be verified. No partial question list was shown."
        )
        result.extracted_questions = []
        result.solution_evidence = []
        result.paired_items = []
        result.items = []
        return result

    # A dense page can end one section and begin the next. A general "extract
    # everything" vision pass occasionally misses the first one or two items
    # below that transition. Re-read only nearby in-scope pages for each exact
    # numbering gap and merge a question only when its printed ID is visible.
    question_gap_visual_calls = 0
    initial_question_gaps = identify_suspicious_numbering_gaps(
        [item.item_id for item in result.extracted_questions]
    )
    for missing_id in initial_question_gaps:
        if question_gap_visual_calls >= MAX_TARGETED_VISUAL_GAP_CALLS_PER_DOCUMENT:
            break
        section_prefix = missing_id.split(".", 1)[0] + "."
        related_pages = sorted({
            item.question_page
            for item in result.extracted_questions
            if item.normalized_item_id.startswith(section_prefix)
        })
        candidate_pages = sorted(
            question_page_scope,
            key=lambda page: (
                min((abs(page - known) for known in related_pages), default=999),
                page,
            ),
        )[:MAX_TARGETED_VISUAL_PAGES_PER_GAP]
        for page in candidate_pages:
            if question_gap_visual_calls >= MAX_TARGETED_VISUAL_GAP_CALLS_PER_DOCUMENT:
                break
            question_gap_visual_calls += 1
            try:
                targeted_items = _extract_visual_page(
                    document=document,
                    page_number=page,
                    target=(
                        f"Find and fully transcribe exact Kurzfragen item {missing_id}. "
                        "Inspect the entire page, including below an earlier section. "
                        "Return it only when that exact printed ID is visibly present; "
                        "never infer it from the surrounding numbering."
                    ),
                )
            except Exception:
                log.exception(
                    "document_question_gap_recovery_failed document=%s gap=%s page=%s",
                    document_id, missing_id, page,
                )
                continue
            recovered = next((
                item for item in targeted_items
                if normalise_item_id(item.item_id) == normalise_item_id(missing_id)
            ), None)
            if recovered is None:
                continue
            question = _normalise_question({
                "item_id": recovered.item_id,
                "question": recovered.question,
                "question_page": page,
                "confidence": recovered.confidence,
            }, page)
            if question is not None:
                result.extracted_questions.append(question)
                visual_item_pages_by_id.setdefault(
                    question.normalized_item_id, set()
                ).add(page)
                log.info(
                    "document_question_gap_recovered document=%s item=%s page=%s",
                    document_id, missing_id, page,
                )
            break
    result.extracted_questions.sort(
        key=lambda item: (_natural_item_id_key(item.item_id), item.question_page)
    )

    # Phase boundary: the complete ordered question inventory is sealed and
    # durably persisted by the caller before answer recovery may alter answer
    # state. The callback receives no generated prose or answer evidence.
    if discovery_checkpoint and resolved_family:
        discovery_question_pages = sorted({
            page
            for section in resolved_family.matched_sections
            for page in section.question_pages
        })
        remaining_gaps = identify_suspicious_numbering_gaps(
            [item.item_id for item in result.extracted_questions]
        )
        discovery_scanned_pages = set(result.scanned_pages)
        if previous_context:
            discovery_scanned_pages.update(previous_context.scanned_pages)
            discovery_scanned_pages.update(previous_context.cumulative_scanned_pages)
        discovery_complete = bool(
            discovery_question_pages
            and not remaining_gaps
            and not set(result.unprocessed_pages).intersection(discovery_question_pages)
            and set(discovery_question_pages).issubset(discovery_scanned_pages)
            and not result.out_of_scope_items_rejected
            and all(any(
                item.normalized_item_id.startswith(f"{section.requested_number}.")
                for item in result.extracted_questions
            ) for section in resolved_family.matched_sections)
        )
        discovery_checkpoint({
            "discovery_complete": discovery_complete,
            "manifest_sealed": discovery_complete,
            "questions": list(result.extracted_questions),
            "question_pages": discovery_question_pages,
            "resolved_family": resolved_family,
            "scope_fingerprint": result.scope_fingerprint,
            "out_of_scope_items_rejected": list(result.out_of_scope_items_rejected),
            "numbering_gaps": remaining_gaps,
        })

    answers_by_id: dict[str, set[str]] = {}
    for evidence in result.solution_evidence:
        if evidence.normalized_item_id:
            answers_by_id.setdefault(evidence.normalized_item_id, set()).add(
                re.sub(r"\s+", " ", evidence.answer_text.casefold()).strip()
            )
    result.conflicting_item_ids = sorted(
        item_id for item_id, answers in answers_by_id.items() if len(answers) > 1
    )
    result.paired_items = pair_questions_and_solutions(
        result.extracted_questions,
        result.solution_evidence,
    )
    answer_recovery = recover_unanswered_answers(
        document=document,
        questions=result.extracted_questions,
        paired_items=result.paired_items,
        text_by_page=all_text_by_page,
        page_statuses=result.page_statuses,
        previous_records=(
            previous_context.answer_recovery_records if previous_context else None
        ),
    )
    if answer_recovery.solution_evidence:
        result.solution_evidence.extend(answer_recovery.solution_evidence)
        result.paired_items = pair_questions_and_solutions(
            result.extracted_questions,
            result.solution_evidence,
        )
    result.answer_recovery_pages = answer_recovery.inspected_pages
    result.answer_recovery_incomplete = answer_recovery.incomplete
    result.answer_recovery_records = answer_recovery.records
    result.items = [
        ExtractedQAItem(
            item_id=item.item_id,
            question=item.question_text,
            answer=item.answer_text or "",
            question_page=item.question_page,
            answer_page=item.answer_page,
            confidence=item.pairing_confidence,
        )
        for item in result.paired_items
    ]
    result.unanswered_item_ids = [
        item.item_id for item in result.paired_items if not item.answer_text
    ]
    result.suspicious_numbering_gaps = identify_suspicious_numbering_gaps(
        [item.item_id for item in result.items]
    )
    text_by_page = {page: text for page, text in usable}
    gap_visual_calls_used = 0
    for item_id in result.suspicious_numbering_gaps:
        section_match = re.match(r"(\d+)\.", item_id)
        related_items = [
            item for item in result.items
            if section_match and normalise_item_id(item.item_id).startswith(section_match.group(1) + ".")
        ]
        nearby_pages = sorted({
            page
            for item in related_items
            for page in range(max(1, item.question_page - 1), min(total_pages, item.question_page + 1) + 1)
            if page in text_by_page
        })
        section_pages = sorted(
            page for page, text in text_by_page.items()
            if re.search(
                rf"\b(?:{re.escape(target)}|kurzfragen?|fragen?|aufgaben?)\b",
                text,
                re.IGNORECASE,
            )
        )
        solution_pages = sorted(
            page for page, text in text_by_page.items()
            if re.search(
                r"\b(?:lösung(?:en)?|loesung(?:en)?|musterlösung|solution|antworten?)\b",
                text,
                re.IGNORECASE,
            )
        )
        # Final deterministic pass scans every available text page, independent
        # of imperfect section classification.
        full_document_pages = sorted(all_text_by_page)
        search_pages = sorted(set(
            nearby_pages + section_pages + solution_pages + full_document_pages
        ))
        variants = gap_id_variants(item_id)
        exact_matches = [
            page for page in search_pages
            if any(variant.confidence >= 0.9 and _gap_variant_matches_text(
                variant, all_text_by_page.get(page, "")
            )
                   for variant in variants)
        ]
        targeted_visual_pages: list[int] = []
        existing_visual_matches = sorted(
            visual_item_pages_by_id.get(normalise_item_id(item_id), set())
        )
        ranked_candidates = sorted(
            weak_pages,
            key=lambda page: (
                0 if page in nearby_pages else 1,
                0 if page in section_pages else 1,
                min((abs(page - candidate) for candidate in nearby_pages), default=999),
                page,
            ),
        )
        candidate_pages = ranked_candidates[:MAX_TARGETED_VISUAL_PAGES_PER_GAP]
        budget_exhausted = False
        if not exact_matches and not existing_visual_matches:
            remaining_budget = max(
                0, MAX_TARGETED_VISUAL_GAP_CALLS_PER_DOCUMENT - gap_visual_calls_used,
            )
            budget_exhausted = remaining_budget < len(candidate_pages)
            for page in candidate_pages[:remaining_budget]:
                gap_visual_calls_used += 1
                try:
                    targeted_items = _extract_visual_page(
                        document=document,
                        page_number=page,
                        target=(
                            f"Find exact item {item_id!r}. Return it only if the ID is "
                            "visibly present; do not infer nearby numbering."
                        ),
                    )
                    targeted_visual_pages.append(page)
                except Exception:
                    log.exception(
                        "document_gap_visual_search_failed document=%s gap=%s page=%s",
                        document_id, item_id, page,
                    )
                    continue
                for item in targeted_items:
                    if normalise_item_id(item.item_id) == normalise_item_id(item_id):
                        visual_item_pages_by_id.setdefault(
                            normalise_item_id(item_id), set()
                        ).add(page)
        visual_matches = sorted(visual_item_pages_by_id.get(normalise_item_id(item_id), set()))
        exact_matches = sorted(set(exact_matches + visual_matches))
        intentional_pages = [
            page for page in search_pages
            if re.search(
                rf"(?<![\d.]){re.escape(item_id)}(?![\d.]).{{0,80}}"
                r"(?:entfällt|gestrichen|omitted|cancelled|not used)",
                all_text_by_page.get(page, ""),
                re.IGNORECASE,
            )
        ]
        neighbouring_text = "\n".join(all_text_by_page.get(page, "") for page in search_pages)
        coverage = GapSearchCoverage(
            nearby_pages_searched=nearby_pages,
            question_section_pages_searched=section_pages,
            solution_section_pages_searched=solution_pages,
            full_document_text_searched=True,
            existing_visual_results_reviewed=True,
            targeted_visual_pages_required=candidate_pages,
            targeted_visual_pages_searched=targeted_visual_pages,
            question_section_detected=bool(section_pages),
            solution_section_detected=bool(solution_pages),
            visual_search_budget_exhausted=(
                not exact_matches and not visual_matches and budget_exhausted
            ),
            unsearched_candidate_pages=[
                page for page in ranked_candidates if page not in targeted_visual_pages
            ],
            targeted_visual_calls_used=gap_visual_calls_used,
        )
        log.info(
            "document_gap_search document=%s gap=%s visual_calls_used=%s "
            "visual_call_budget=%s budget_exhausted=%s "
            "question_section_status=%s solution_section_status=%s",
            document_id,
            item_id,
            gap_visual_calls_used,
            MAX_TARGETED_VISUAL_GAP_CALLS_PER_DOCUMENT,
            coverage.visual_search_budget_exhausted,
            (
                SearchAvailability.SEARCHED.value if section_pages
                else SearchAvailability.NOT_AVAILABLE.value
            ),
            (
                SearchAvailability.SEARCHED.value if solution_pages
                else SearchAvailability.NOT_AVAILABLE.value
            ),
        )
        result.gaps.append(review_numbering_gap(
            item_id,
            neighbouring_text=neighbouring_text,
            reviewed_pages=search_pages,
            review_result=GapReviewResult(
                exact_text_search_performed=True,
                full_section_search_performed=bool(section_pages),
                solution_section_search_performed=bool(solution_pages),
                question_section_status=(
                    SearchAvailability.SEARCHED if section_pages
                    else SearchAvailability.NOT_AVAILABLE
                ),
                solution_section_status=(
                    SearchAvailability.SEARCHED if solution_pages
                    else SearchAvailability.NOT_AVAILABLE
                ),
                visual_search_performed=bool(targeted_visual_pages),
                exact_matches=exact_matches,
                intentional_omission_pages=intentional_pages,
                reviewed_pages=search_pages,
                coverage=coverage,
            ),
        ))

    previous_count = (
        len(previous_context.paired_items) if previous_context else len(previous_items or [])
    )
    result.new_item_count = max(0, len(result.items) - previous_count)
    expected_pages = question_page_scope if (numbered_section or resolved_family) else set(target_pages)
    cumulative_scanned = set(result.scanned_pages)
    if previous_context:
        cumulative_scanned.update(previous_context.scanned_pages)
    result.cumulative_scanned_pages = sorted(cumulative_scanned)
    result.all_relevant_pages_scanned = bool(
        expected_pages
        and expected_pages.issubset(cumulative_scanned | set(result.unreadable_pages))
        and not set(result.unreadable_pages).intersection(expected_pages)
    )
    result.all_items_have_answers = bool(
        result.items and not result.unanswered_item_ids
    )
    result.scope_extraction_complete = bool(
        result.section_resolved
        and result.all_relevant_pages_scanned
        and not set(result.unprocessed_pages).intersection(expected_pages)
        and not result.invalid_item_ids_rejected
        and not result.duplicate_item_ids
        and not any(
            gap.status in {GapStatus.CONFIRMED_MISSING, GapStatus.UNRESOLVED}
            for gap in result.gaps
        )
        and (
            not resolved_family
            or all(any(
                item.normalized_item_id.startswith(f"{section.requested_number}.")
                for item in result.extracted_questions
            ) for section in resolved_family.matched_sections)
        )
    )
    result.answer_verification_complete = bool(
        result.items
        and result.all_items_have_answers
        and not result.conflicting_item_ids
        and not result.answer_recovery_incomplete
    )
    result.complete = bool(
        result.scope_extraction_complete
        and result.answer_verification_complete
        and not any(
            gap.status in {GapStatus.CONFIRMED_MISSING, GapStatus.UNRESOLVED}
            for gap in result.gaps
        )
    )
    return result


def build_learning_journey(
    result: DocumentExtractionResult,
    *,
    scoped_job_state: Any | None = None,
    scoped_job_id: str | None = None,
    manifest_id: str | None = None,
) -> dict[str, Any] | None:
    family = result.resolved_family
    if not family:
        return None
    sections: list[dict[str, Any]] = []
    for section in family.matched_sections:
        number = section.requested_number or ""
        questions = [
            item for item in result.paired_items
            if normalise_item_id(item.item_id).startswith(f"{number}.")
        ]
        questions.sort(key=lambda item: _natural_item_id_key(item.item_id))
        question_payload = []
        for item in questions:
            recovery_record = result.answer_recovery_records.get(item.item_id)
            if item.answer_text:
                visual = bool(re.search(
                    r"visual|check|mark|circle|highlight|annotation", item.answer_evidence_type or "", re.I,
                ))
                answer_status = "visually_verified" if visual else "verified"
            elif item.question_page in result.unprocessed_pages:
                answer_status = "source_unavailable"
            else:
                answer_status = (
                    recovery_record.status.value
                    if recovery_record else "unresolved"
                )
            question_payload.append({
                "questionId": item.item_id,
                "number": item.item_id,
                "question": item.question_text,
                "answer": item.answer_text,
                "answerStatus": answer_status,
                "questionPage": item.question_page,
                "answerPage": item.answer_page,
                "confidence": item.pairing_confidence,
                "pairingMethod": item.pairing_method,
                "candidatePages": recovery_record.candidate_pages if recovery_record else [],
                "inspectedPages": recovery_record.inspected_pages if recovery_record else [],
                "remainingPages": recovery_record.remaining_pages if recovery_record else [],
                "visualCallsUsed": recovery_record.calls_used if recovery_record else 0,
                "retryable": bool(recovery_record and recovery_record.status in {
                    AnswerResolutionStatus.SEARCH_PENDING,
                    AnswerResolutionStatus.VISUAL_BUDGET_EXHAUSTED,
                    AnswerResolutionStatus.VISUAL_RENDER_FAILED,
                    AnswerResolutionStatus.VISION_EXTRACTION_FAILED,
                    AnswerResolutionStatus.AMBIGUOUS_EVIDENCE,
                }),
            })
        verified = sum(
            item["answerStatus"] in {"verified", "visually_verified"}
            for item in question_payload
        )
        unresolved = len(question_payload) - verified
        section_error = None if question_payload else {
            "code": "section_questions_not_found",
            "message": (
                f'Section {number} ("{section.requested_title or family.family_name}") '
                "was resolved, but no questions were verified in its source range."
            ),
            "retryable": section.discovery_method != "visual_ocr",
        }
        sections.append({
            "sectionId": number,
            "sectionNumber": number,
            "title": section.requested_title or family.family_name,
            "pageStart": section.start_page,
            "pageEnd": section.end_page,
            "questions": question_payload,
            "status": (
                "failed" if not question_payload else
                "complete" if not unresolved else "partial"
            ),
            "error": section_error,
            "headingVerification": {
                "status": section.verification_status,
                "method": section.discovery_method,
                "confidence": section.confidence,
                "startPosition": section.start_position,
                "endPosition": section.end_position,
            },
            "statistics": {
                "questionsFound": len(question_payload),
                "answersVerified": verified,
                "unresolved": unresolved,
            },
        })
    discovered_count = sum(len(section["questions"]) for section in sections)
    answered_count = sum(section["statistics"]["answersVerified"] for section in sections)
    unresolved_count = discovered_count - answered_count
    question_pages_total = len({
        page for section in family.matched_sections for page in section.question_pages
    })
    from .scoped_extraction import assert_result_invariants  # noqa: WPS433
    assert_result_invariants(
        question_pages_total=question_pages_total,
        discovered_count=discovered_count,
    )
    manifest_sealed = bool(result.scope_extraction_complete and question_pages_total > 0 and discovered_count > 0)
    processing_finished = bool(manifest_sealed and not result.unprocessed_pages)
    authoritative = scoped_job_state
    return {
        "title": family.family_name,
        "jobId": scoped_job_id,
        "manifestId": manifest_id,
        "scopeFingerprint": result.scope_fingerprint,
        "scope": {
            "type": "section_family",
            "requestedLabel": result.target,
            "includedSectionNumbers": family.section_numbers,
            "excludedSections": family.excluded_sections,
        },
        "sections": sections,
        "manifestSealed": authoritative.manifest_sealed if authoritative else manifest_sealed,
        "discoveryComplete": authoritative.discovery_complete if authoritative else manifest_sealed,
        "processingFinished": authoritative.processing_finished if authoritative else processing_finished,
        "allAnswersVerified": authoritative.all_answers_verified if authoritative else bool(processing_finished and result.answer_verification_complete),
        "discoveredCount": authoritative.discovered_count if authoritative else discovered_count,
        "pendingCount": authoritative.pending_count if authoritative else (0 if processing_finished else len(result.unprocessed_pages)),
        "processingCount": authoritative.processing_count if authoritative else 0,
        "answeredCount": authoritative.answered_count if authoritative else answered_count,
        "unresolvedCount": authoritative.unresolved_count if authoritative else unresolved_count,
        "failedCount": authoritative.failed_count if authoritative else 0,
        "coverage": {
            "totalPages": result.total_pages,
            "pagesScanned": len(result.cumulative_scanned_pages or result.scanned_pages),
            "thisRunPagesProcessed": len(result.scanned_pages),
            "answerSearchPagesProcessed": len(result.cumulative_scanned_pages or result.scanned_pages),
            "questionPagesTotal": question_pages_total,
            "questionPagesProcessed": len(set(result.cumulative_scanned_pages or result.scanned_pages).intersection({
                page for section in family.matched_sections for page in section.question_pages
            })),
            "unprocessedPages": result.unprocessed_pages,
            "complete": result.complete,
            "scopeExtractionComplete": result.scope_extraction_complete,
            "answerVerificationComplete": result.answer_verification_complete,
        },
        "outOfScopeItemsRejected": result.out_of_scope_items_rejected,
    }


def format_document_extraction(result: DocumentExtractionResult, language: str) -> str:
    english = language != "de"
    scanned_count = len(result.cumulative_scanned_pages or result.scanned_pages)
    if result.items and scanned_count == 0:
        log.error(
            "impossible_coverage_state_blocked document=%s questions=%d",
            result.document_id, len(result.items),
        )
        return (
            "I could not verify the document coverage. No extracted answers were shown."
            if english else
            "Die Dokumentabdeckung konnte nicht verifiziert werden. Es wurden keine extrahierten Antworten angezeigt."
        )
    if not result.section_resolved:
        return result.message or (
            f'Minallo found the document, but it could not reliably read section "{result.target}".'
        )
    heading = (
        (f"## All {result.target} and answers" if result.complete else
         f"## Extracted {result.target} and answers")
        if english else
        (f"## Alle {result.target} mit Antworten" if result.complete else
         f"## Extrahierte {result.target} mit Antworten")
    )
    blocks = [heading]
    rendered_section: str | None = None
    family_sections = result.resolved_family.matched_sections if result.resolved_family else []
    for item in result.items:
        item_section = next(
            (
                section for section in family_sections
                if section.expected_item_prefix
                and normalise_item_id(item.item_id).startswith(section.expected_item_prefix)
            ),
            None,
        )
        section_heading = item_section.matched_heading if item_section else None
        if section_heading and section_heading != rendered_section:
            blocks.append(f"### {section_heading}")
            rendered_section = section_heading
        if item.answer:
            answer = item.answer
        elif result.answer_recovery_incomplete:
            answer = (
                "Answer recovery is incomplete because one or more candidate pages could not be inspected."
                if english else
                "Die Antwortsuche ist unvollstÃ¤ndig, weil nicht alle Kandidatenseiten visuell geprÃ¼ft werden konnten."
            )
        else:
            answer = (
                "Official answer not found after text and targeted visual search."
                if english else
                "Nach Textsuche und gezielter visueller PrÃ¼fung wurde keine offizielle Antwort gefunden."
            )
        blocks.append(
            f"{'####' if section_heading else '###'} {item.item_id}\n\n"
            f"**{'Question' if english else 'Frage'}:** {item.question}\n\n"
            f"**{'Answer' if english else 'Antwort'}:** {answer}"
        )
    unresolved_count = len(set(result.unanswered_item_ids) | {
        gap.item_id for gap in result.gaps
        if gap.status in {GapStatus.CONFIRMED_MISSING, GapStatus.UNRESOLVED}
    })
    coverage_lines = [
        f"**Coverage:** {len(result.cumulative_scanned_pages or result.scanned_pages)}/{result.total_pages} pages scanned"
        if english else
        f"**Abdeckung:** {len(result.cumulative_scanned_pages or result.scanned_pages)}/{result.total_pages} Seiten geprÃ¼ft",
        f"Questions found: {len(result.extracted_questions)}" if english else
        f"Gefundene Fragen: {len(result.extracted_questions)}",
        f"Answers paired: {sum(1 for item in result.paired_items if item.answer_text)}"
        if english else
        f"Zugeordnete Antworten: {sum(1 for item in result.paired_items if item.answer_text)}",
        f"Unresolved: {unresolved_count}" if english else f"UngeklÃ¤rt: {unresolved_count}",
    ]
    blocks.append("\n".join(coverage_lines))
    if result.complete:
        blocks.append(
            f"I scanned all {result.total_pages} pages and found {len(result.items)} items."
            if english else
            f"Ich habe alle {result.total_pages} Seiten geprüft und {len(result.items)} Einträge gefunden."
        )
    else:
        reasons: list[str] = []
        if result.unreadable_pages:
            pages = ", ".join(map(str, result.unreadable_pages))
            reasons.append(
                f"Unreadable pages: {pages}" if english else f"Unlesbare Seiten: {pages}"
            )
        if result.unprocessed_pages:
            details = ", ".join(
                f"{page} ({result.page_statuses.get(page, PageProcessingStatus.UNREADABLE).value})"
                for page in result.unprocessed_pages
            )
            reasons.append(
                f"Pages requiring retry: {details}" if english else
                f"Erneut zu verarbeitende Seiten: {details}"
            )
        if result.unanswered_item_ids:
            item_ids = ", ".join(result.unanswered_item_ids)
            reasons.append(
                f"Answers were not found for: {item_ids}"
                if english else f"Keine Antworten gefunden für: {item_ids}"
            )
        if result.duplicate_item_ids:
            item_ids = ", ".join(result.duplicate_item_ids)
            reasons.append(
                f"Duplicate or conflicting items: {item_ids}"
                if english else f"Doppelte oder widersprüchliche Einträge: {item_ids}"
            )
        unresolved = [
            gap.item_id for gap in result.gaps
            if gap.status in {GapStatus.CONFIRMED_MISSING, GapStatus.UNRESOLVED}
        ]
        if unresolved:
            item_ids = ", ".join(unresolved)
            reasons.append(
                f"Possible missing items: {item_ids}"
                if english else f"Möglicherweise fehlende Einträge: {item_ids}"
            )
        if not reasons:
            reasons.append(
                "The extraction did not satisfy all completeness checks."
                if english else "Die Extraktion erfüllte nicht alle Vollständigkeitsprüfungen."
            )
        intro = (
            "I scanned the document, but I cannot guarantee that the extraction is complete:"
            if english else
            "Ich habe das Dokument geprüft, kann die Vollständigkeit aber nicht garantieren:"
        )
        blocks.append(intro + "\n- " + "\n- ".join(reasons))
    return "\n\n".join(blocks)


__all__ = [
    "DocumentExtractionContext",
    "DocumentExtractionResult",
    "ExtractedQuestion",
    "ExtractedQuestionOption",
    "ExtractedSolutionEvidence",
    "ExtractionPageKind",
    "GapSearchCoverage",
    "GapIdVariant",
    "GapReviewResult",
    "GapStatus",
    "NumberingGap",
    "PageExtractionResult",
    "PageProcessingStatus",
    "PageClassificationResult",
    "PairedQAItem",
    "ResolvedSectionFamily",
    "SearchAvailability",
    "classify_document_extraction",
    "classify_extraction_page",
    "classify_extraction_page_result",
    "build_learning_journey",
    "extract_page_with_fallback",
    "extract_document_qa",
    "extraction_pages_for_direction",
    "extraction_context_from_api",
    "extraction_context_to_api",
    "format_document_extraction",
    "gap_id_variants",
    "MAX_TARGETED_VISUAL_GAP_CALLS_PER_DOCUMENT",
    "MAX_TARGETED_VISUAL_PAGES_PER_GAP",
    "DOCUMENT_EXTRACTION_BATCH_SIZE",
    "identify_suspicious_numbering_gaps",
    "infer_extraction_rescan_direction",
    "load_extraction_context",
    "normalise_item_id",
    "resolve_section_family",
    "pair_questions_and_solutions",
    "recover_unanswered_answers",
    "question_fingerprint",
    "review_numbering_gap",
    "save_extraction_context",
]
