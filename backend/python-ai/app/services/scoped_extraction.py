"""Correctness model for exhaustive, document-scoped retrieval jobs.

This module owns request meaning, immutable manifest validation, item state, and
the sole authoritative completion calculation. Retrieval, streaming and UI code
consume these types; they do not redefine completeness.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Iterable


class RetrievalMode(str, Enum):
    RELEVANCE = "relevance"
    COVERAGE = "coverage"


class CoverageIntent(str, Enum):
    SINGLE = "single"
    ALL = "all"


class DiscoveryStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"
    NO_ITEMS_FOUND = "no_items_found"


class ScopeItemStatus(str, Enum):
    DISCOVERED = "discovered"
    PENDING = "pending"
    PROCESSING = "processing"
    ANSWERED = "answered"
    UNRESOLVED = "unresolved"
    FAILED = "failed"


class StructuralIndexStatus(str, Enum):
    STRUCTURED_READY = "structured_ready"
    STRUCTURAL_INDEXING = "structural_indexing"
    STRUCTURAL_REINDEX_REQUIRED = "structural_reindex_required"
    STRUCTURAL_INDEX_FAILED = "structural_index_failed"


@dataclass(frozen=True)
class ScopedRequestSpec:
    retrieval_mode: RetrievalMode
    coverage_intent: CoverageIntent
    target_type: str
    canonical_target: str
    include_answers: bool
    include_explanations: bool


# The one authoritative "did the student ask for everything, not just one
# thing" pattern. document_extraction.py's own classify_document_extraction()
# used to keep a second, independently-drifted copy of this same idea: this
# module's version was missing "full list", "without missing", "vollständig",
# "gesamte", "komplett"; document_extraction's was missing "whole", "rest",
# "remaining", "jede[rs]?" (only had bare "jede"), "restlichen?", and the
# "don't leave any out" / "leave nothing out" / "without omitting" phrasings
# entirely. A genuinely extraction-shaped request like "make sure you don't
# leave any exercises out" or "list the remaining questions, komplett" could
# name questions/exercises explicitly and still fail to route into the
# exhaustive engine purely because it phrased "all of them" in the half of
# the vocabulary the OTHER module happened to recognize. Merged here so
# there's exactly one, most-complete definition of "exhaustive" both modules
# agree on.
EXHAUSTIVE_COVERAGE_RE = re.compile(
    r"\b(?:all|every|complete|whole|rest|entire|remaining|full\s+list|"
    r"alle|jede[rs]?|sämtliche|restlichen?|vollständig|gesamte|komplett)\b|"
    r"\b(?:do\s+not|don't|dont)\s+leave\s+(?:any|one)(?:\s+\w+){0,5}\s+out\b|"
    r"\b(?:leave\s+nothing\s+out|without\s+omitting|without\s+missing|"
    r"keine\s+auslassen)\b",
    re.I,
)
_ALL = EXHAUSTIVE_COVERAGE_RE
_KURZFRAGEN = re.compile(r"kurzfragen?|short\s+questions?", re.I)


def classify_scoped_request(text: str) -> ScopedRequestSpec:
    normalized = " ".join((text or "").split())
    # "all questions in exercise/section 12" is complete coverage of one
    # explicitly bounded target, not a whole-document extraction. The old
    # keyword-only classifier sent the Standzeit request to the exhaustive
    # manifest worker merely because it contained "all the questions".
    exact_bounded_target = bool(re.search(
        r"(?:^\s*\d{1,3}(?:\.\d{1,3})?\s*[.):-]?\s+.{2,}|"
        r"\b(?:section|chapter|exercise|problem|task|aufgabe)\s+"
        r"\d{1,3}(?:\.\d{1,3})?\b|"
        r"\b\d{1,3}\.\d{1,3}\b)",
        normalized, re.I,
    ))
    exhaustive = bool(_ALL.search(normalized)) and not exact_bounded_target
    canonical_target = "kurzfragen" if _KURZFRAGEN.search(normalized) else "questions"
    return ScopedRequestSpec(
        retrieval_mode=RetrievalMode.COVERAGE if exhaustive else RetrievalMode.RELEVANCE,
        coverage_intent=CoverageIntent.ALL if exhaustive else CoverageIntent.SINGLE,
        target_type=("focused_numbered_target" if exact_bounded_target else
                     "section_family" if canonical_target == "kurzfragen" else "document_items"),
        canonical_target=canonical_target,
        include_answers=bool(re.search(r"answer|solve|beantwort|lös(?:e|en)|loes", normalized, re.I)),
        include_explanations=bool(re.search(r"explain|erklär|erklaer", normalized, re.I)),
    )


_FOCUSED_FOLLOWUP = re.compile(
    r"\b(?:continue|finish|resume|previous\s+(?:calculation|solution|exercise)|"
    r"missing\s+information|popup\s+request|fortsetzen|weiterrechnen)\b",
    re.I,
)


def resolve_scoped_request(
    text: str,
    previous_turns: Iterable[dict[str, str]] | None = None,
) -> ScopedRequestSpec:
    """Keep an explicit bounded target across short continuation answers."""
    current = classify_scoped_request(text)
    if current.target_type == "focused_numbered_target":
        return current
    if current.retrieval_mode is RetrievalMode.COVERAGE or not _FOCUSED_FOLLOWUP.search(text or ""):
        return current
    for turn in reversed(list(previous_turns or [])):
        if str(turn.get("role") or "").casefold() != "user":
            continue
        inherited = classify_scoped_request(str(turn.get("text") or turn.get("content") or ""))
        if inherited.target_type == "focused_numbered_target":
            return inherited
    return current


@dataclass
class ScopeItem:
    id: str
    stable_key: str
    document_id: str
    document_revision_id: str
    item_number: str | None
    label: str
    block_type: str
    section_number: str | None
    section_title: str | None
    page_start: int | None
    page_end: int | None
    document_order: int
    parent_id: str | None = None
    source_block_ids: list[str] = field(default_factory=list)
    previous_stable_keys: list[str] = field(default_factory=list)
    status: ScopeItemStatus = ScopeItemStatus.DISCOVERED
    attempts: int = 0
    error_code: str | None = None
    error_message: str | None = None


@dataclass
class RequestScopeManifest:
    id: str
    job_id: str
    document_revision_id: str
    discovery_status: DiscoveryStatus
    manifest_sealed: bool
    manifest_verified: bool
    included_section_numbers: list[str]
    excluded_section_numbers: list[str]
    question_pages: list[int]
    items: list[ScopeItem]
    source_fingerprint: str
    scope_fingerprint: str
    extractor_schema_version: str
    out_of_scope_items_rejected: list[str] = field(default_factory=list)
    detected_headings: list[DetectedHeading] = field(default_factory=list)
    version: int = 1
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def discovered_ids(self) -> list[str]:
        return [item.item_number or item.id for item in self.items]


@dataclass(frozen=True)
class DetectedHeading:
    number: str
    title: str
    page: int
    y_position: float | None
    document_order: int
    method: str
    confidence: float


@dataclass
class StructuralUnit:
    stable_block_id: str
    document_id: str
    document_revision_id: str
    block_type: str
    document_order: int
    page_start: int
    page_end: int
    source_text: str
    question_number: str | None = None
    parent_question: str | None = None
    section_number: str | None = None
    section_title: str | None = None
    continues_on_next_page: bool = False
    answer_format: str | None = None
    has_diagram: bool = False
    diagram_region_ids: list[str] = field(default_factory=list)
    solution_block_ids: list[str] = field(default_factory=list)
    ocr_confidence: float | None = None
    extraction_confidence: float | None = None
    previous_stable_keys: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ManifestQuality:
    discovery_complete: bool
    manifest_sealed: bool
    section_count: int
    question_page_count: int
    discovered_count: int
    valid_in_scope_count: int
    out_of_scope_count: int
    failed_sections: tuple[str, ...] = ()


@dataclass(frozen=True)
class ManifestPromotionResult:
    active_manifest: RequestScopeManifest | None
    candidate_rejected: bool
    reason: str | None = None


class ExtractionInvariantError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def stable_scope_key(
    document_revision_id: str,
    block_type: str,
    item_number: str | None,
    page_start: int | None,
    region_order: int,
) -> str:
    if item_number:
        return f"{document_revision_id}:{block_type}:{item_number}"
    raw = f"{document_revision_id}:{block_type}:{page_start}:{region_order}"
    return f"{document_revision_id}:{block_type}:{hashlib.sha256(raw.encode()).hexdigest()[:20]}"


def validate_manifest(manifest: RequestScopeManifest) -> tuple[list[ScopeItem], list[str]]:
    accepted: list[ScopeItem] = []
    rejected: list[str] = []
    allowed = set(manifest.included_section_numbers)
    for item in manifest.items:
        if item.section_number in allowed:
            accepted.append(item)
        else:
            rejected.append(item.item_number or item.id)
    return accepted, rejected


def item_belongs_to_manifest(item: ScopeItem, manifest: RequestScopeManifest) -> bool:
    return item.section_number in set(manifest.included_section_numbers)


def assert_result_invariants(*, question_pages_total: int, discovered_count: int) -> None:
    if question_pages_total == 0 and discovered_count > 0:
        raise ExtractionInvariantError("questions_without_resolved_question_pages")


def manifest_quality(manifest: RequestScopeManifest) -> ManifestQuality:
    accepted, rejected = validate_manifest(manifest)
    represented = {item.section_number for item in accepted if item.section_number}
    return ManifestQuality(
        discovery_complete=(
            manifest.discovery_status is DiscoveryStatus.COMPLETE
            and manifest.manifest_sealed
            and bool(manifest.items)
        ),
        manifest_sealed=manifest.manifest_sealed,
        section_count=len(represented),
        question_page_count=len(set(manifest.question_pages)),
        discovered_count=len(manifest.items),
        valid_in_scope_count=len(accepted),
        out_of_scope_count=len(rejected),
        failed_sections=tuple(
            number for number in manifest.included_section_numbers if number not in represented
        ),
    )


def promote_manifest(
    existing: RequestScopeManifest | None,
    candidate: RequestScopeManifest,
) -> ManifestPromotionResult:
    """Promote an immutable candidate only when it cannot regress verified scope."""
    quality = manifest_quality(candidate)
    if not quality.discovery_complete:
        return ManifestPromotionResult(existing, True, "discovery_incomplete")
    if quality.question_page_count == 0:
        return ManifestPromotionResult(existing, True, "zero_question_pages")
    if quality.out_of_scope_count or candidate.out_of_scope_items_rejected:
        return ManifestPromotionResult(existing, True, "out_of_scope_items")
    if quality.failed_sections:
        return ManifestPromotionResult(existing, True, "section_coverage_regression")
    if existing and existing.manifest_verified:
        old_ids, new_ids = set(existing.discovered_ids), set(candidate.discovered_ids)
        if existing.document_revision_id == candidate.document_revision_id:
            if not old_ids.issubset(new_ids):
                return ManifestPromotionResult(existing, True, "same_revision_lost_ids")
            if not set(existing.included_section_numbers).issubset(
                candidate.included_section_numbers
            ):
                return ManifestPromotionResult(existing, True, "section_membership_regression")
            old_pages = {
                item.item_number: (item.page_start, item.page_end)
                for item in existing.items if item.item_number
            }
            new_pages = {
                item.item_number: (item.page_start, item.page_end)
                for item in candidate.items if item.item_number
            }
            if any(new_pages.get(item_id) != pages for item_id, pages in old_pages.items()):
                return ManifestPromotionResult(existing, True, "source_page_regression")
    candidate.manifest_verified = True
    candidate.updated_at = datetime.now(timezone.utc)
    return ManifestPromotionResult(candidate, False)


@dataclass(frozen=True)
class ScopedJobState:
    discovery_status: DiscoveryStatus
    manifest_sealed: bool
    discovered_count: int
    pending_count: int = 0
    processing_count: int = 0
    answered_count: int = 0
    unresolved_count: int = 0
    failed_count: int = 0

    @property
    def discovery_complete(self) -> bool:
        return (
            self.discovery_status is DiscoveryStatus.COMPLETE
            and self.manifest_sealed
            and self.discovered_count > 0
        )

    @property
    def processing_finished(self) -> bool:
        terminal = self.answered_count + self.unresolved_count + self.failed_count
        return (
            self.discovery_complete
            and self.pending_count == 0
            and self.processing_count == 0
            and terminal == self.discovered_count
        )

    @property
    def all_answers_verified(self) -> bool:
        return (
            self.processing_finished
            and self.answered_count == self.discovered_count
            and self.unresolved_count == 0
            and self.failed_count == 0
        )


def finalise_scoped_job(manifest: RequestScopeManifest) -> ScopedJobState:
    assert_result_invariants(
        question_pages_total=len(set(manifest.question_pages)),
        discovered_count=len(manifest.items),
    )
    counts = {status: 0 for status in ScopeItemStatus}
    for item in manifest.items:
        counts[item.status] += 1
    return ScopedJobState(
        discovery_status=manifest.discovery_status,
        manifest_sealed=manifest.manifest_sealed,
        discovered_count=len(manifest.items),
        pending_count=counts[ScopeItemStatus.DISCOVERED] + counts[ScopeItemStatus.PENDING],
        processing_count=counts[ScopeItemStatus.PROCESSING],
        answered_count=counts[ScopeItemStatus.ANSWERED],
        unresolved_count=counts[ScopeItemStatus.UNRESOLVED],
        failed_count=counts[ScopeItemStatus.FAILED],
    )


@dataclass(frozen=True)
class BatchPersistenceResult:
    items: tuple[ScopeItem, ...]
    missing_ids: tuple[str, ...]


def persist_batch_results(
    items: Iterable[ScopeItem],
    *,
    requested_ids: Iterable[str],
    returned_ids: Iterable[str],
) -> BatchPersistenceResult:
    """Apply exact returned IDs; missing model outputs remain non-terminal."""
    requested = tuple(dict.fromkeys(requested_ids))
    returned = set(returned_ids)
    updated: list[ScopeItem] = []
    for item in items:
        number = item.item_number or item.id
        if number in requested and number in returned:
            item.status = ScopeItemStatus.ANSWERED
            item.attempts += 1
            item.error_code = None
            item.error_message = None
        updated.append(item)
    return BatchPersistenceResult(
        tuple(updated), tuple(number for number in requested if number not in returned),
    )


def reconcile_structural_units(
    existing: Iterable[StructuralUnit],
    candidate: Iterable[StructuralUnit],
) -> list[StructuralUnit]:
    merged = {unit.stable_block_id: unit for unit in existing}
    for unit in candidate:
        previous = merged.get(unit.stable_block_id)
        if previous:
            unit.previous_stable_keys = list(dict.fromkeys(
                previous.previous_stable_keys + unit.previous_stable_keys
            ))
        merged[unit.stable_block_id] = unit
    return sorted(merged.values(), key=lambda unit: unit.document_order)


def retrieve_units(
    units: Iterable[StructuralUnit],
    *,
    mode: RetrievalMode,
    configured_limit: int,
    section_numbers: set[str] | None = None,
) -> list[StructuralUnit]:
    """Coverage enumerates structure; relevance remains explicitly bounded."""
    ordered = sorted(units, key=lambda unit: unit.document_order)
    if section_numbers is not None:
        ordered = [unit for unit in ordered if unit.section_number in section_numbers]
    if mode is RetrievalMode.COVERAGE:
        return ordered
    return ordered[:max(0, configured_limit)]


def deduplicate_scope_items(items: Iterable[ScopeItem]) -> list[ScopeItem]:
    """Resume/restart merge: stable keys are authoritative and ordered."""
    merged: dict[str, ScopeItem] = {}
    for item in items:
        current = merged.get(item.stable_key)
        if current is None or item.attempts >= current.attempts:
            merged[item.stable_key] = item
    return sorted(merged.values(), key=lambda item: item.document_order)


def scoped_state_payload(
    *, job_id: str, manifest_id: str, state: ScopedJobState,
) -> dict[str, object]:
    """One transport-neutral representation shared by stream and polling."""
    return {
        "job_id": job_id,
        "manifest_id": manifest_id,
        "manifest_sealed": state.manifest_sealed,
        "discovery_complete": state.discovery_complete,
        "processing_finished": state.processing_finished,
        "all_answers_verified": state.all_answers_verified,
        "discovered_count": state.discovered_count,
        "pending_count": state.pending_count,
        "processing_count": state.processing_count,
        "answered_count": state.answered_count,
        "unresolved_count": state.unresolved_count,
        "failed_count": state.failed_count,
    }


CANONICAL_KURZFRAGEN_IDS = tuple(
    [f"2.{n}" for n in range(1, 5)]
    + [f"3.{n}" for n in range(1, 5)]
    + [f"4.{n}" for n in range(1, 5)]
    + [f"5.{n}" for n in range(1, 20)]
    + [f"6.{n}" for n in range(1, 5)]
    + [f"7.{n}" for n in range(1, 4)]
    + ["8.1"]
    + [f"9.{n}" for n in range(1, 4)]
    + ["10.1", "10.2", "11.1"]
)
