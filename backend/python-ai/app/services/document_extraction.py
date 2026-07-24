"""Exhaustive, active-document question/answer extraction.

Unlike semantic top-k retrieval, this path scans every stored page in document
order and uses small map batches before deterministically merging the result.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Callable

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
class DocumentExtractionResult:
    document_id: str
    target: str
    total_pages: int
    scanned_pages: list[int] = field(default_factory=list)
    unreadable_pages: list[int] = field(default_factory=list)
    items: list[ExtractedQAItem] = field(default_factory=list)
    unanswered_item_ids: list[str] = field(default_factory=list)
    duplicate_item_ids: list[str] = field(default_factory=list)
    suspicious_numbering_gaps: list[str] = field(default_factory=list)
    all_relevant_pages_scanned: bool = False
    all_items_have_answers: bool = False
    complete: bool = False
    model: str | None = None
    prompt_tokens: int = 0
    completion_tokens: int = 0


def normalise_item_id(item_id: str) -> str:
    return re.sub(r"[^0-9.]", "", item_id or "").strip(".")


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


def _load_document_pages(
    *, user_id: str, course_id: str, document_id: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    sb = get_supabase()
    doc_response = (
        sb.table("documents")
        .select("id,file_name,page_count,active_index_revision")
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
) -> DocumentExtractionResult:
    document, page_rows = _load_document_pages(
        user_id=user_id, course_id=course_id, document_id=document_id,
    )
    total_pages = int(document.get("page_count") or len(page_rows) or 0)
    result = DocumentExtractionResult(
        document_id=document_id,
        target=target or "questions",
        total_pages=total_pages,
    )
    usable: list[tuple[int, str]] = []
    seen_pages: set[int] = set()
    for row in page_rows:
        page = int(row.get("page_number") or 0)
        if page < 1:
            continue
        seen_pages.add(page)
        text = str(row.get("cleaned_text") or row.get("raw_text") or "").strip()
        if len(text) < 20:
            result.unreadable_pages.append(page)
        else:
            usable.append((page, text))
            result.scanned_pages.append(page)
    result.unreadable_pages.extend(
        page for page in range(1, total_pages + 1) if page not in seen_pages
    )
    result.unreadable_pages = sorted(set(result.unreadable_pages))

    all_items: list[ExtractedQAItem] = []
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
        page_block = "\n\n".join(
            f"--- PAGE {page} ---\n{text}" for page, text in group
        )
        response = chat_json(
            model=settings.openai_generate_model,
            max_tokens=5000,
            system=(
                "You extract exam question/answer pairs from source pages. "
                f"Target only the section/category {target!r}. Scan every supplied page; "
                "do not cap the number of items. Preserve German or other source wording "
                "exactly. Prefer printed/official solutions and checked options. Never "
                "invent an answer. Return JSON {\"items\":[{\"item_id\":\"9.2\","
                "\"question\":\"...\",\"answer\":\"...\",\"question_page\":9,"
                "\"answer_page\":20,\"confidence\":0.9}]}. An answer may be empty when "
                "it is not present in this batch. Ignore unrelated long calculations."
            ),
            user=page_block,
        )
        result.model = response.model
        result.prompt_tokens += int(response.prompt_tokens or 0)
        result.completion_tokens += int(response.completion_tokens or 0)
        raw_items = response.data.get("items", []) if isinstance(response.data, dict) else []
        fallback_page = group[0][0]
        all_items.extend(
            item
            for item in (_normalise_item(raw, fallback_page) for raw in raw_items)
            if item is not None
        )
        log.info(
            "document_extraction_batch document=%s batch=%d/%d pages=%s items=%d",
            document_id, index, len(groups), [p for p, _ in group], len(raw_items),
        )

    questions_by_id: dict[str, set[str]] = {}
    for item in all_items:
        normal_id = normalise_item_id(item.item_id)
        if normal_id and item.question.strip():
            questions_by_id.setdefault(normal_id, set()).add(
                re.sub(r"\W+", "", item.question.casefold())
            )
    result.duplicate_item_ids = sorted(
        item_id for item_id, questions in questions_by_id.items()
        if len(questions) > 1
    )
    result.items = _merge_items(all_items)
    result.unanswered_item_ids = [
        item.item_id for item in result.items if not item.answer.strip()
    ]
    result.suspicious_numbering_gaps = identify_suspicious_numbering_gaps(
        [item.item_id for item in result.items]
    )
    result.all_relevant_pages_scanned = bool(
        total_pages
        and len(result.scanned_pages) + len(result.unreadable_pages) >= total_pages
        and not result.unreadable_pages
    )
    result.all_items_have_answers = bool(
        result.items and not result.unanswered_item_ids
    )
    result.complete = bool(
        result.all_relevant_pages_scanned
        and result.all_items_have_answers
        and not result.duplicate_item_ids
        and not result.suspicious_numbering_gaps
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
        pages = ", ".join(map(str, result.unreadable_pages))
        blocks.append(
            f"I scanned the document and found {len(result.items)} items, but pages {pages} "
            "were unreadable, so completeness is not guaranteed."
            if english else
            f"Ich habe {len(result.items)} Einträge gefunden; die Seiten {pages} waren "
            "jedoch unlesbar, daher ist die Vollständigkeit nicht garantiert."
        )
    return "\n\n".join(blocks)


__all__ = [
    "DocumentExtractionResult",
    "classify_document_extraction",
    "extract_document_qa",
    "format_document_extraction",
    "identify_suspicious_numbering_gaps",
    "infer_extraction_rescan_direction",
    "normalise_item_id",
]
