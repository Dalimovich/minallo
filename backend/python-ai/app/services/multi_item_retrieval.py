"""Coverage-first retrieval for requests containing several academic items."""

from __future__ import annotations

import logging
import re
import unicodedata
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any

from ..supabase_client import get_supabase
from .retrieval import RetrievedChunk, retrieve_chunks

log = logging.getLogger(__name__)


class EvidenceStatus(StrEnum):
    SUPPORTED = "supported"
    PARTIAL = "partial"
    NOT_FOUND = "not_found"
    INDEX_GAP = "index_gap"
    RETRIEVAL_FAILED = "retrieval_failed"
    CONFLICTING = "conflicting_evidence"


class IndexHealthStatus(StrEnum):
    HEALTHY = "healthy"
    INCOMPLETE = "incomplete"
    STALE = "stale"
    FAILED = "failed"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class RequestedItem:
    id: str
    original_text: str
    item_type: str
    expected_answer_shape: str
    search_terms: tuple[str, ...]
    requirements: tuple["AnswerRequirement", ...] = ()


@dataclass(frozen=True)
class AnswerRequirement:
    category: str
    expected_count: int
    polarity: str | None = None
    per_item_count: int | None = None


@dataclass(frozen=True)
class RequestManifest:
    original_text: str
    language: str
    requested_items: tuple[RequestedItem, ...]
    global_constraints: tuple[str, ...] = ()


@dataclass
class RequestedItemEvidence:
    item_id: str
    query: str
    searched_document_ids: list[str] = field(default_factory=list)
    searched_pages: list[int] = field(default_factory=list)
    candidate_chunk_ids: list[str] = field(default_factory=list)
    supporting_chunk_ids: list[str] = field(default_factory=list)
    status: EvidenceStatus = EvidenceStatus.NOT_FOUND
    missing_requirements: list[str] = field(default_factory=list)
    error_code: str | None = None
    index_health: IndexHealthStatus = IndexHealthStatus.UNKNOWN


@dataclass
class MultiItemRetrievalResult:
    manifest: RequestManifest
    chunks: list[RetrievedChunk]
    evidence: list[RequestedItemEvidence]

    def to_dict(self) -> dict[str, Any]:
        return {
            "manifest": asdict(self.manifest),
            "evidence": [asdict(item) for item in self.evidence],
            "complete": all(item.status in {
                EvidenceStatus.SUPPORTED,
                EvidenceStatus.PARTIAL,
                EvidenceStatus.NOT_FOUND,
                EvidenceStatus.INDEX_GAP,
                EvidenceStatus.CONFLICTING,
            } for item in self.evidence),
        }


@dataclass(frozen=True)
class FinalAnswerValidation:
    expected_item_ids: tuple[str, ...]
    rendered_item_ids: tuple[str, ...]
    missing_item_ids: tuple[str, ...]
    contains_internal_status_labels: bool
    extra_item_ids: tuple[str, ...] = ()
    duplicate_item_ids: tuple[str, ...] = ()

    @property
    def complete(self) -> bool:
        return not (self.missing_item_ids or self.extra_item_ids or self.duplicate_item_ids or self.contains_internal_status_labels)


_QUESTION_START_RE = re.compile(
    r"^(?:what|how|why|which|name|list|explain|compare|calculate|"
    r"was|wie|warum|welche|welcher|nennen|erkl[aä]r|vergleichen|berechnen)\b",
    re.IGNORECASE,
)
_INSTRUCTION_RE = re.compile(
    r"^(?:answer|use|keep|respond|do not|don't|please|antworte|verwende|benutze|"
    r"lass|bitte|terms?|language|sprache)\b",
    re.IGNORECASE,
)
_ENUM_PREFIX_RE = re.compile(r"^\s*(?:[-*•§]|\d+[.)])\s*")
_CONTINUATION_RE = re.compile(
    r"^(?:nennen sie|give|name|erkl[aä]ren sie|begr[uü]nden sie)\b", re.IGNORECASE,
)
_COUNT_WORDS = {"one": 1, "ein": 1, "eine": 1, "two": 2, "zwei": 2, "three": 3, "drei": 3, "six": 6, "sechs": 6}


_CONTROLLED_CONCEPTS: tuple[tuple[str, ...], ...] = (
    (
        "main groups of forming processes", "three main groups of forming processes",
        "hauptgruppen der umformverfahren", "einteilung der umformverfahren",
        "massivumformen", "blechumformen", "inkrementelles umformen",
    ),
    (
        "din 8582", "stress-state classification", "classification according to din 8582",
        "spannungszustand", "druckumformen", "zugdruckumformen", "zugumformen",
        "biegeumformen", "schubumformen",
    ),
    (
        "gesenkschmieden", "die forging", "arten des gesenkschmiedens",
        "gesenkschmieden mit grat", "gesenkschmieden ohne grat", "präzisionsschmieden",
    ),
    (
        "verzahnungswalzen", "gear rolling", "vorteile verzahnungswalzen",
        "eigenschaften gewalzter verzahnungen", "kaltverfestigung", "faserverlauf",
        "oberflächengüte",
    ),
)


def _normalise(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "").casefold()
    value = value.replace("ß", "ss")
    value = re.sub(r"-\s*(?:\r?\n|\s)+", "", value)
    value = "".join(char for char in value if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def controlled_course_terms(text: str) -> tuple[str, ...]:
    normalized = _normalise(text)
    terms: list[str] = [text.strip()]
    for group in _CONTROLLED_CONCEPTS:
        if any(_normalise(term) in normalized or normalized in _normalise(term) for term in group):
            terms.extend(group)
    return tuple(dict.fromkeys(term for term in terms if term))


def _item_shape(text: str) -> tuple[str, str]:
    value = _normalise(text)
    if any(token in value for token in ("advantage", "vorteil")):
        return "advantages", "named list with course-supported explanations"
    if any(token in value for token in ("classif", "einteil", "gruppen", "din 8582")):
        return "classification", "hierarchical named classification"
    if any(token in value for token in ("compare", "unterschied", "unterscheid")):
        return "comparison", "comparison with distinguishing criteria"
    if any(token in value for token in ("calculate", "berechn")):
        return "calculation", "course method with formula, values and units"
    return "explanation", "definition and detailed course explanation"


def _requirements(text: str) -> tuple[AnswerRequirement, ...]:
    normalized = _normalise(text)
    found: list[AnswerRequirement] = []
    for word, count in _COUNT_WORDS.items():
        if not re.search(rf"\b{word}\b", normalized):
            continue
        tail = normalized[normalized.find(word) + len(word):]
        category, polarity = "item", None
        if re.search(r"\bvorteil|\badvantage", tail): category, polarity = "advantage", "positive"
        elif re.search(r"\bnachteil|\bdisadvantage", tail): category, polarity = "disadvantage", "negative"
        elif re.search(r"\bgruppe|\bgroup", tail): category = "group"
        elif re.search(r"\bzone", tail): category = "zone"
        elif re.search(r"\bschneidenart|\bcutting edge", tail): category = "cutting_edge_type"
        elif re.search(r"\bbeispiel|\bexample", tail): category = "example"
        found.append(AnswerRequirement(category, count, polarity, count if " je " in f" {normalized} " else None))
    if re.search(r"\bzwei\s+vor", normalized) and re.search(r"\bzwei\s+nachteil", normalized):
        found.extend((
            AnswerRequirement("advantage", 2, "positive"),
            AnswerRequirement("disadvantage", 2, "negative"),
        ))
    return tuple(dict.fromkeys(found))


def analyse_request(text: str) -> RequestManifest:
    cleaned = re.sub(r"[§●◦]", "\n- ", text or "")
    raw_lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
    candidates: list[str] = []
    for line in raw_lines:
        stripped = _ENUM_PREFIX_RE.sub("", line).strip()
        if _INSTRUCTION_RE.match(stripped) and "?" not in stripped:
            continue
        if "?" in stripped:
            parts = [part.strip() for part in stripped.split("?") if part.strip()]
            line_candidates: list[str] = []
            for part in parts:
                question_start = re.search(
                    r"\b(?:what|how|why|which|name|list|explain|compare|calculate|"
                    r"was|wie|warum|welche|welcher|nennen|erkl[aä]r|vergleichen|berechnen)\b",
                    part, re.IGNORECASE,
                )
                question_part = part[question_start.start():] if question_start else part
                if line_candidates and _CONTINUATION_RE.match(question_part):
                    line_candidates[-1] += " " + question_part.rstrip(".") + "."
                elif line_candidates and re.fullmatch(r"\([^)]{2,80}\)", question_part):
                    line_candidates[-1] += " " + question_part
                elif _QUESTION_START_RE.match(question_part):
                    line_candidates.append(question_part + "?")
            candidates.extend(line_candidates)
        elif _ENUM_PREFIX_RE.match(line) and _QUESTION_START_RE.match(stripped):
            candidates.append(stripped)
    if len(candidates) < 2:
        candidates = [text.strip()] if text.strip() else []
    items: list[RequestedItem] = []
    for index, candidate in enumerate(dict.fromkeys(candidates), start=1):
        item_type, shape = _item_shape(candidate)
        items.append(RequestedItem(
            id=f"item-{index}", original_text=candidate,
            item_type=item_type, expected_answer_shape=shape,
            search_terms=controlled_course_terms(candidate),
            requirements=_requirements(candidate),
        ))
    language = "de" if re.search(
        r"\b(?:wie|was|nennen|erklären|vorteile)\b", text, re.IGNORECASE,
    ) else "en"
    constraints = tuple(filter(None, (
        "answer in German" if re.search(
            r"\b(?:german|deutsch)\b", text, re.IGNORECASE,
        ) else "",
        "use course files only" if re.search(
            r"\b(?:course files?|kursdateien)\b", text, re.IGNORECASE,
        ) else "",
        "answer every requested item" if len(items) > 1 else "",
    )))
    return RequestManifest(text, language, tuple(items), constraints)


def is_multi_item_request(text: str) -> bool:
    return len(analyse_request(text).requested_items) > 1


def _row_to_chunk(row: dict[str, Any], *, score: float) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=str(row.get("id") or row.get("chunk_id") or ""),
        document_id=str(row.get("document_id") or ""),
        page_start=int(row["page_start"]) if row.get("page_start") is not None else None,
        page_end=int(row["page_end"]) if row.get("page_end") is not None else None,
        text=str(row.get("chunk_text") or row.get("text") or ""),
        score=score,
        similarity=float(row.get("similarity") or 0.0),
        chunk_type=str(row.get("chunk_type") or "general"),
        section_title=str(row.get("section_title") or "") or None,
    )


def _lexical_matches(
    item: RequestedItem, rows: list[dict[str, Any]],
) -> list[RetrievedChunk]:
    normalized_terms = [_normalise(term) for term in item.search_terms if len(_normalise(term)) >= 4]
    direct: list[dict[str, Any]] = []
    for row in rows:
        haystack = _normalise(f"{row.get('section_title') or ''} {row.get('chunk_text') or ''}")
        matches = sum(term in haystack for term in normalized_terms)
        if matches:
            enriched = dict(row)
            enriched["_exact_matches"] = matches
            direct.append(enriched)
    direct.sort(key=lambda row: (row["_exact_matches"], bool(row.get("section_title"))), reverse=True)
    selected = direct[:4]
    page_keys = {
        (row.get("document_id"), int(row.get("page_start") or 0))
        for row in selected if row.get("page_start")
    }
    section_keys = {
        (row.get("document_id"), row.get("section_title"))
        for row in selected if row.get("section_title")
    }
    neighbours = [
        row for row in rows
        if row not in selected and (
            any(row.get("document_id") == doc and abs(int(row.get("page_start") or 0) - page) <= 1 for doc, page in page_keys)
            or (row.get("document_id"), row.get("section_title")) in section_keys
        )
    ]
    return [
        _row_to_chunk(row, score=2.0 + float(row.get("_exact_matches") or 0))
        for row in (selected + neighbours[:6]) if row.get("id")
    ]


def _load_course_inventory(
    *, user_id: str, course_id: str, document_ids: list[str] | None,
) -> tuple[list[str], list[dict[str, Any]], bool]:
    sb = get_supabase()
    documents_query = (
        sb.table("documents").select(
            "id,page_count,active_index_revision,processing_status",
        )
        .eq("user_id", user_id).eq("course_id", course_id)
    )
    if document_ids:
        documents_query = documents_query.in_("id", document_ids)
    documents = list(documents_query.execute().data or [])
    authorized_ids = [str(row["id"]) for row in documents]
    if not authorized_ids:
        return [], [], False
    response = (
        sb.table("document_chunks")
        .select("id,document_id,page_start,page_end,chunk_text,chunk_type,section_title,index_revision")
        .in_("document_id", authorized_ids).limit(5000).execute()
    )
    active_revisions = {str(row["id"]): str(row.get("active_index_revision") or "") for row in documents}
    rows = [
        row for row in (response.data or [])
        if not active_revisions.get(str(row.get("document_id")))
        or str(row.get("index_revision") or "") == active_revisions[str(row.get("document_id"))]
    ]
    # Empty/textless PDF pages are valid and need not produce chunks. A mere
    # difference between PDF page_count and chunk-bearing pages therefore does
    # not prove an index defect. Only positive document/index state does.
    index_gap = bool(any(
        str(row.get("processing_status") or "") != "ready"
        or not str(row.get("active_index_revision") or "").strip()
        for row in documents
    ))
    return authorized_ids, rows, index_gap


def retrieve_multi_item_course_evidence(
    *, user_id: str, course_id: str, question: str,
    document_ids: list[str] | None = None,
    active_document_id: str | None = None,
    initial_chunks: list[RetrievedChunk] | None = None,
    semantic_retriever: Callable[..., list[RetrievedChunk]] = retrieve_chunks,
    inventory_loader: Callable[..., tuple[list[str], list[dict[str, Any]], bool]] = _load_course_inventory,
) -> MultiItemRetrievalResult:
    manifest = analyse_request(question)
    if len(manifest.requested_items) <= 1:
        return MultiItemRetrievalResult(manifest, list(initial_chunks or []), [])
    try:
        authorized_ids, rows, index_gap = inventory_loader(
            user_id=user_id, course_id=course_id, document_ids=document_ids,
        )
    except Exception:
        log.exception("multi_item_inventory_load_failed")
        return MultiItemRetrievalResult(manifest, list(initial_chunks or []), [
            RequestedItemEvidence(
                item.id, item.original_text, status=EvidenceStatus.RETRIEVAL_FAILED,
                error_code="course_inventory_load_failed",
            ) for item in manifest.requested_items
        ])
    merged: dict[str, RetrievedChunk] = {chunk.chunk_id: chunk for chunk in initial_chunks or []}
    evidence: list[RequestedItemEvidence] = []
    for item in manifest.requested_items:
        lexical = _lexical_matches(item, rows)
        try:
            semantic = semantic_retriever(
                user_id=user_id, course_id=course_id,
                query=" ".join(item.search_terms), document_ids=document_ids,
                preferred_document_ids=document_ids,
                active_document_id=active_document_id, top_k=8,
            )
            error_code = None
        except Exception:
            log.exception("multi_item_semantic_retrieval_failed item=%s", item.id)
            semantic, error_code = [], "semantic_retrieval_failed"
        candidates = lexical + semantic
        for chunk in candidates:
            merged.setdefault(chunk.chunk_id, chunk)
        supporting = lexical or [
            chunk for chunk in semantic
            if any(_normalise(term) in _normalise(f"{chunk.section_title or ''} {chunk.text}") for term in item.search_terms[1:])
        ]
        if supporting:
            status = EvidenceStatus.SUPPORTED
        elif error_code:
            status = EvidenceStatus.RETRIEVAL_FAILED
        elif index_gap:
            status = EvidenceStatus.INDEX_GAP
        elif semantic:
            status = EvidenceStatus.PARTIAL
        else:
            status = EvidenceStatus.NOT_FOUND
        evidence.append(RequestedItemEvidence(
            item_id=item.id,
            query=item.original_text,
            searched_document_ids=authorized_ids,
            searched_pages=sorted({chunk.page_start for chunk in candidates if chunk.page_start}),
            candidate_chunk_ids=list(dict.fromkeys(chunk.chunk_id for chunk in candidates)),
            supporting_chunk_ids=list(dict.fromkeys(chunk.chunk_id for chunk in supporting)),
            status=status,
            missing_requirements=[] if status is EvidenceStatus.SUPPORTED else [item.expected_answer_shape],
            error_code=error_code,
            index_health=(
                IndexHealthStatus.INCOMPLETE if index_gap
                else IndexHealthStatus.HEALTHY
            ),
        ))
    ordered: list[RetrievedChunk] = []
    for item_evidence in evidence:
        for chunk_id in item_evidence.supporting_chunk_ids + item_evidence.candidate_chunk_ids:
            if chunk_id in merged and merged[chunk_id] not in ordered:
                ordered.append(merged[chunk_id])
    ordered.extend(chunk for chunk in merged.values() if chunk not in ordered)
    log.info(
        "multi_item_retrieval_completed items=%d supported=%d partial=%d unresolved=%d",
        len(evidence), sum(item.status is EvidenceStatus.SUPPORTED for item in evidence),
        sum(item.status is EvidenceStatus.PARTIAL for item in evidence),
        sum(item.status in {EvidenceStatus.NOT_FOUND, EvidenceStatus.INDEX_GAP, EvidenceStatus.RETRIEVAL_FAILED} for item in evidence),
    )
    return MultiItemRetrievalResult(manifest, ordered, evidence)


def answer_plan_overlay(result: MultiItemRetrievalResult) -> str:
    if not result.evidence:
        return ""
    lines = [
        "\n\nMULTI-ITEM ANSWER CONTRACT:",
        "Answer each requested item in this exact order. Cite only that item's supporting chunks.",
        "Do not let an unresolved item suppress supported items.",
        f"Produce exactly {len(result.manifest.requested_items)} numbered sections, one for every item.",
        "Use each original question verbatim as its section heading.",
        "Never print internal enum names or diagnostic labels in the student answer.",
        "Begin each section with a compact Kurzantwort, then explain it. Satisfy every explicit requested count.",
    ]
    by_id = {item.id: item for item in result.manifest.requested_items}
    for evidence in result.evidence:
        item = by_id[evidence.item_id]
        lines.append(
            f"- {item.id}: {item.original_text} | shape={item.expected_answer_shape} | "
            f"requirements={','.join(f'{r.category}:{r.expected_count}' for r in item.requirements) or 'none'} | "
            f"evidence={evidence.status.value} | chunks={','.join(evidence.supporting_chunk_ids) or 'none'}"
        )
    lines.append(
        "For an unresolved item, provide transparent fallback knowledge when the grounding policy allows it; "
        "otherwise use a natural unresolved notice. Never ask to upload an already indexed file. "
        "End every section with a natural 'Source basis:' label, and never cite a course chunk for fallback claims."
    )
    return "\n".join(lines)


def validate_final_answer(
    result: MultiItemRetrievalResult,
    answer_text: str,
) -> FinalAnswerValidation:
    """Deterministically prove that every original question reached the answer."""
    normalized_answer = _normalise(answer_text)
    rendered = tuple(
        item.id for item in result.manifest.requested_items
        if _normalise(item.original_text) in normalized_answer
    )
    expected = tuple(item.id for item in result.manifest.requested_items)
    missing = tuple(item_id for item_id in expected if item_id not in rendered)
    raw_status = bool(re.search(
        r"\bstatus\s*:\s*(?:index_gap|supported|partial|partially_supported|"
        r"retrieval_failed|not_found|conflicting_evidence)\b",
        answer_text,
        re.IGNORECASE,
    ))
    return FinalAnswerValidation(expected, rendered, missing, raw_status)


def ensure_complete_answer(
    result: MultiItemRetrievalResult,
    answer_text: str,
    *,
    allow_general_fallback: bool,
    fallback_generator: Callable[[str], str],
) -> tuple[str, FinalAnswerValidation]:
    """Append explicit sections for omissions; never return a silently skipped item."""
    validation = validate_final_answer(result, answer_text)
    cleaned = re.sub(
        r"(?im)^\s*status\s*:\s*(?:index_gap|supported|partial|partially_supported|"
        r"retrieval_failed|not_found|conflicting_evidence)\s*$",
        "",
        answer_text,
    ).strip()
    by_id = {item.id: item for item in result.manifest.requested_items}
    for item_id in validation.missing_item_ids:
        item = by_id[item_id]
        if allow_general_fallback:
            body = fallback_generator(item.original_text).strip()
            basis = "Source basis: General knowledge"
        else:
            body = (
                "The authorised course material did not provide enough reliable "
                "evidence for this item."
            )
            basis = "Source basis: Course files only"
        cleaned += f"\n\n## {item.original_text}\n\n{body}\n\n{basis}"
    return cleaned, validate_final_answer(result, cleaned)


__all__ = [
    "AnswerRequirement", "EvidenceStatus", "FinalAnswerValidation", "IndexHealthStatus", "MultiItemRetrievalResult", "RequestManifest", "RequestedItem",
    "RequestedItemEvidence", "analyse_request", "answer_plan_overlay",
    "controlled_course_terms", "ensure_complete_answer", "is_multi_item_request",
    "retrieve_multi_item_course_evidence", "validate_final_answer",
]
