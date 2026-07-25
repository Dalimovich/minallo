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
    r"\b(kurzfragen?|wissensfragen?|theoriefragen?|questions?|fragen|aufgaben)\b",
    re.IGNORECASE,
)
_ITEM_ID_RE = re.compile(r"^\s*(\d+(?:\.\d+)*(?:[a-z])?)\s*$", re.IGNORECASE)


def classify_document_extraction(
    question: str,
    previous_turns: list[dict[str, str]] | None = None,
) -> tuple[bool, bool, str | None]:
    """Return (is_extraction, is_correction, target)."""
    current = question or ""
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
    target_match = _TARGET_RE.search(source)
    target = target_match.group(1) if target_match else None
    return bool(exhaustive or (correction and prior_request)), correction, target


@dataclass
class ExtractedQAItem:
    item_id: str
    question: str
    answer: str
    question_page: int
    answer_page: int | None = None
    confidence: float = 0.0


@dataclass
class ExtractedQuestion:
    item_id: str
    normalized_item_id: str
    question_text: str
    question_page: int
    section: str | None = None
    question_fingerprint: str = ""
    confidence: float = 0.0


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


@dataclass(frozen=True)
class PageClassificationResult:
    kind: ExtractionPageKind
    confidence: float
    signals: list[str] = field(default_factory=list)


@dataclass
class GapSearchCoverage:
    nearby_pages_searched: list[int] = field(default_factory=list)
    question_section_pages_searched: list[int] = field(default_factory=list)
    solution_section_pages_searched: list[int] = field(default_factory=list)
    full_document_text_searched: bool = False
    existing_visual_results_reviewed: bool = False
    targeted_visual_pages_required: list[int] = field(default_factory=list)
    targeted_visual_pages_searched: list[int] = field(default_factory=list)


@dataclass
class GapReviewResult:
    exact_text_search_performed: bool = False
    full_section_search_performed: bool = False
    solution_section_search_performed: bool = False
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
    conflicting_item_ids: list[str] = field(default_factory=list)
    earliest_source_page: int | None = None
    latest_source_page: int | None = None
    earliest_scanned_page: int | None = None
    latest_scanned_page: int | None = None
    earliest_item_page: int | None = None
    latest_item_page: int | None = None
    complete: bool = False
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
    model: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    status: str = "completed"
    message: str | None = None
    new_item_count: int = 0


_EXTRACTION_CONTEXTS: dict[tuple[str, str], DocumentExtractionContext] = {}


def normalise_item_id(item_id: str) -> str:
    return re.sub(r"[^0-9.]", "", item_id or "").strip(".")


def question_fingerprint(text: str) -> str:
    normalized = re.sub(r"\W+", " ", text or "").casefold().strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]


def pair_questions_and_solutions(
    questions: list[ExtractedQuestion],
    solutions: list[ExtractedSolutionEvidence],
) -> list[PairedQAItem]:
    """Deterministically pair exact IDs first, then fingerprints/text."""
    unused = list(solutions)
    paired: list[PairedQAItem] = []
    for question in questions:
        candidate = next(
            (
                item for item in unused
                if item.normalized_item_id
                and item.normalized_item_id == question.normalized_item_id
            ),
            None,
        )
        method = "normalized_item_id" if candidate else None
        if candidate is None and question.question_fingerprint:
            candidate = next(
                (
                    item for item in unused
                    if item.question_fingerprint == question.question_fingerprint
                ),
                None,
            )
            method = "question_fingerprint" if candidate else None
        if candidate is None:
            question_tokens = set(re.findall(r"\w+", question.question_text.casefold()))
            scored = [
                (
                    len(question_tokens.intersection(set(re.findall(
                        r"\w+", (item.referenced_question_text or "").casefold(),
                    )))) / max(1, len(question_tokens)),
                    item,
                )
                for item in unused
                if item.referenced_question_text
            ]
            if scored:
                score, possible = max(scored, key=lambda value: value[0])
                if score >= 0.72:
                    candidate, method = possible, "referenced_question_similarity"
        if candidate:
            unused.remove(candidate)
        paired.append(PairedQAItem(
            item_id=question.item_id,
            question_text=question.question_text,
            answer_text=candidate.answer_text if candidate else None,
            question_page=question.question_page,
            answer_page=candidate.answer_page if candidate else None,
            pairing_method=method,
            pairing_confidence=min(question.confidence, candidate.confidence) if candidate else 0.0,
            answer_evidence_type=candidate.evidence_type if candidate else None,
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
            ExtractedQuestion(**item) for item in payload.get("extracted_questions", [])
        ]
        payload["solution_evidence"] = [
            ExtractedSolutionEvidence(**item)
            for item in payload.get("solution_evidence", [])
        ]
        payload["paired_items"] = [
            PairedQAItem(**item) for item in payload.get("paired_items", [])
        ]
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
    variants = tuple(re.escape(value) for value in gap_id_variants(item_id))
    explicit = review_result or GapReviewResult(
        exact_text_search_performed=True,
        full_section_search_performed=False,
        exact_matches=(reviewed_pages if any(
            re.search(rf"(?<![\d.]){variant}(?![\d.])", neighbouring_text, re.I)
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
        and explicit.full_section_search_performed
        and explicit.solution_section_search_performed
        and explicit.coverage.full_document_text_searched
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


def gap_id_variants(item_id: str) -> list[str]:
    return list(dict.fromkeys([
        item_id, f"Aufgabe {item_id}", f"Frage {item_id}", f"Nr. {item_id}",
        item_id.replace(".", ""), item_id.replace(".", " "),
    ]))


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
        return []
    from .openai_client import get_openai_client
    from .storage import download_document_bytes
    from .vision_ocr import _render_page_to_png, _try_import_pypdfium2

    pdfium = _try_import_pypdfium2()
    if pdfium is None:
        return []
    png = _render_page_to_png(
        pdfium,
        download_document_bytes(storage_path),
        page_number - 1,
        260,
    )
    if not png:
        return []
    response = get_openai_client().chat.completions.create(
        model=get_settings().openai_generate_model,
        temperature=0,
        max_tokens=3000,
        response_format={"type": "json_object"},
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        f"Extract {target!r} questions and separate solution evidence from "
                        f"this scanned PDF page {page_number}. Detect IDs, exact question "
                        "text, printed answers, worked solutions, checked boxes, green "
                        "checkmarks and annotations. Never invent missing text. Return "
                        '{"items":[{"item_id":"...","question":"...","answer":"...",'
                        '"question_page":1,"answer_page":1,"evidence_type":"checked_option",'
                        '"confidence":0.9}]}.'
                    ),
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": "data:image/png;base64,"
                        + base64.b64encode(png).decode("ascii"),
                        "detail": "high",
                    },
                },
            ],
        }],
    )
    try:
        data = json.loads(str(response.choices[0].message.content or "{}"))
    except (TypeError, ValueError):
        return []
    return [
        item
        for item in (
            _normalise_item(raw, page_number)
            for raw in (data.get("items", []) if isinstance(data, dict) else [])
        )
        if item is not None
    ]


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
    )


def _normalise_question(raw: Any, fallback_page: int) -> ExtractedQuestion | None:
    item = _normalise_item(raw, fallback_page)
    if item is None:
        return None
    return ExtractedQuestion(
        item_id=item.item_id,
        normalized_item_id=normalise_item_id(item.item_id),
        question_text=item.question,
        question_page=item.question_page,
        section=str(raw.get("section") or "").strip() or None,
        question_fingerprint=question_fingerprint(item.question),
        confidence=item.confidence,
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
) -> DocumentExtractionResult:
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
        try:
            stored_quality = float(row.get("extraction_quality") or 0.0)
        except (TypeError, ValueError):
            stored_quality = 0.0
        if len(text) < 20 or (stored_quality and stored_quality < 0.75):
            weak_pages.append(page)
            if text:
                usable.append((page, text))
        else:
            usable.append((page, text))
            result.scanned_pages.append(page)
    result.unreadable_pages.extend(
        page
        for page in target_pages
        if page not in seen_pages
    )
    result.unreadable_pages = sorted(set(result.unreadable_pages))

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
    visual_item_pages_by_id: dict[str, set[int]] = {}
    for page in weak_pages:
        try:
            visual_items = _extract_visual_page(
                document=document,
                page_number=page,
                target=target,
            )
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
            result.scanned_pages.append(page)
        else:
            result.unreadable_pages.append(page)
    result.scanned_pages = sorted(set(result.scanned_pages))
    result.unreadable_pages = sorted(set(result.unreadable_pages))
    # Keep every map prompt bounded while scanning all pages in order.
    groups: list[list[tuple[int, str]]] = []
    current: list[tuple[int, str]] = []
    current_chars = 0
    for page, text in usable:
        clipped = text[:16000]
        if current and (len(current) >= 5 or current_chars + len(clipped) > 30000):
            groups.append(current)
            current, current_chars = [], 0
        current.append((page, clipped))
        current_chars += len(clipped)
    if current:
        groups.append(current)

    settings = get_settings()
    for index, group in enumerate(groups, start=1):
        if status:
            status("extracting_items")
        classified = [
            (page, text, classify_extraction_page(text, target))
            for page, text in group
        ]
        question_pages = [
            (page, text) for page, text, kind in classified
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
                "\"question_page\":9,\"section\":\"Kurzfragen\",\"confidence\":0.9}]}. "
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
    # Deduplicate the independent passes, then pair them deterministically.
    unique_questions: dict[str, ExtractedQuestion] = {}
    for item in extracted_questions:
        key = item.normalized_item_id or item.question_fingerprint
        existing = unique_questions.get(key)
        if existing is None or len(item.question_text) > len(existing.question_text):
            unique_questions[key] = item
    unique_solutions: dict[tuple[str, int, str], ExtractedSolutionEvidence] = {}
    for item in solution_evidence:
        key = (
            item.normalized_item_id or item.question_fingerprint or "",
            item.answer_page,
            item.answer_text,
        )
        unique_solutions[key] = item
    result.extracted_questions = list(unique_questions.values())
    result.solution_evidence = list(unique_solutions.values())
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
        variants = tuple(re.escape(value) for value in gap_id_variants(item_id))
        exact_matches = [
            page for page in search_pages
            if any(re.search(rf"(?<![\d.]){variant}(?![\d.])", all_text_by_page.get(page, ""), re.I)
                   for variant in variants)
        ]
        targeted_visual_pages: list[int] = []
        if not exact_matches:
            for page in weak_pages:
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
            targeted_visual_pages_required=weak_pages,
            targeted_visual_pages_searched=targeted_visual_pages,
        )
        result.gaps.append(review_numbering_gap(
            item_id,
            neighbouring_text=neighbouring_text,
            reviewed_pages=search_pages,
            review_result=GapReviewResult(
                exact_text_search_performed=True,
                full_section_search_performed=True,
                solution_section_search_performed=True,
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
    expected_pages = set(target_pages)
    result.all_relevant_pages_scanned = bool(
        expected_pages
        and expected_pages.issubset(set(result.scanned_pages) | set(result.unreadable_pages))
        and not set(result.unreadable_pages).intersection(expected_pages)
    )
    result.all_items_have_answers = bool(
        result.items and not result.unanswered_item_ids
    )
    result.complete = bool(
        result.all_relevant_pages_scanned
        and result.all_items_have_answers
        and not result.duplicate_item_ids
        and not result.conflicting_item_ids
        and not any(
            gap.status in {GapStatus.CONFIRMED_MISSING, GapStatus.UNRESOLVED}
            for gap in result.gaps
        )
    )
    return result


def format_document_extraction(result: DocumentExtractionResult, language: str) -> str:
    english = language != "de"
    heading = (
        f"## All {result.target} and answers"
        if english else f"## Alle {result.target} mit Antworten"
    )
    blocks = [heading]
    for item in result.items:
        answer = item.answer or (
            "No official answer was readable in the document."
            if english else "Im Dokument war keine offizielle Antwort lesbar."
        )
        blocks.append(
            f"### {item.item_id}\n\n"
            f"**{'Question' if english else 'Frage'}:** {item.question}\n\n"
            f"**{'Answer' if english else 'Antwort'}:** {answer}"
        )
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
    "ExtractedSolutionEvidence",
    "ExtractionPageKind",
    "GapSearchCoverage",
    "GapReviewResult",
    "GapStatus",
    "NumberingGap",
    "PageExtractionResult",
    "PageClassificationResult",
    "PairedQAItem",
    "classify_document_extraction",
    "classify_extraction_page",
    "classify_extraction_page_result",
    "extract_page_with_fallback",
    "extract_document_qa",
    "extraction_pages_for_direction",
    "extraction_context_from_api",
    "extraction_context_to_api",
    "format_document_extraction",
    "gap_id_variants",
    "identify_suspicious_numbering_gaps",
    "infer_extraction_rescan_direction",
    "load_extraction_context",
    "normalise_item_id",
    "pair_questions_and_solutions",
    "question_fingerprint",
    "review_numbering_gap",
    "save_extraction_context",
]
