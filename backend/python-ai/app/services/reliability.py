"""Task-grounding and evidence policy primitives for reliable RAG answers."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any, Literal


class VisualTaskKind(StrEnum):
    NONE = "none"
    TEXT_EXPLANATION = "text_explanation"
    DIAGRAM_EXPLANATION = "diagram_explanation"
    FORMULA_EXPLANATION = "formula_explanation"
    NUMERICAL_CALCULATION = "numerical_calculation"
    CHECKBOX_EXTRACTION = "checkbox_extraction"
    LABELLED_DIAGRAM = "labelled_diagram"
    TECHNICAL_DRAWING_MAPPING = "technical_drawing_mapping"
    VISUAL_TRANSCRIPTION = "visual_transcription"


class GroundedTaskKind(StrEnum):
    EXPLANATION = "explanation"
    NUMERICAL_CALCULATION = "numerical_calculation"
    CHECKBOX_CALCULATION = "checkbox_calculation"
    CHECKBOX_EXTRACTION = "checkbox_extraction"
    DIAGRAM_LABELLING = "diagram_labelling"
    TECHNICAL_DRAWING_MAPPING = "technical_drawing_mapping"
    FORMULA_EXPLANATION = "formula_explanation"
    DOCUMENT_EXTRACTION = "document_extraction"
    SHORT_ANSWER = "short_answer"


class VisualIdentityBinding(StrEnum):
    EXACT_EXERCISE_MATCH = "exact_exercise_match"
    CURRENT_PAGE_SINGLE_TASK = "current_page_single_task"
    SELECTED_REGION_BOUND = "selected_region_bound"
    AMBIGUOUS = "ambiguous"
    CONFLICTING_EXERCISE = "conflicting_exercise"


class CalculationContext(StrEnum):
    TEXT_ONLY = "text_only"
    CURRENT_PAGE = "current_page"
    DIAGRAM_BASED = "diagram_based"
    CHECKBOX_BASED = "checkbox_based"
    TECHNICAL_DRAWING = "technical_drawing"


class IdentityEvidenceSource(StrEnum):
    USER_QUERY = "user_query"
    CURRENT_PAGE_TEXT = "current_page_text"
    VISION = "vision"
    SELECTED_REGION = "selected_region"
    ACTIVE_DOCUMENT_RETRIEVAL = "active_document_retrieval"


class IdentityResolutionMethod(StrEnum):
    USER_REFERENCE_ONLY = "user_reference_only"
    CURRENT_PAGE_TEXT = "current_page_text"
    CURRENT_PAGE_VISION = "current_page_vision"
    SELECTED_REGION = "selected_region"
    ACTIVE_DOCUMENT_SEARCH = "active_document_search"
    COURSE_RETRIEVAL = "course_retrieval"


class AnswerObligationType(StrEnum):
    INCLUDE_REQUESTED_QUANTITY = "include_requested_quantity"
    INCLUDE_FINAL_NUMERIC_VALUE = "include_final_numeric_value"
    INCLUDE_COMPATIBLE_UNIT = "include_compatible_unit"
    SELECT_VISIBLE_OPTION = "select_visible_option"
    MAP_ALL_IDENTIFIERS = "map_all_identifiers"
    USE_VISIBLE_LABELS = "use_visible_labels"
    EXPLAIN_VISIBLE_FORMULA = "explain_visible_formula"


@dataclass(frozen=True)
class GroundedFieldEvidence:
    value: str
    source: IdentityEvidenceSource
    page: int | None = None
    confidence: float = 0.0


@dataclass(frozen=True, eq=False)
class VisibleAnswerOption:
    text: str
    label: str | None = None
    selected: bool | None = None
    page: int | None = None
    source: str = "current_page_text"
    confidence: float = 0.0

    def __eq__(self, other: object) -> bool:
        if isinstance(other, str):
            return self.text == other
        if isinstance(other, VisibleAnswerOption):
            return asdict(self) == asdict(other)
        return False


@dataclass(frozen=True)
class AllowedMappingLabel:
    canonical: str
    aliases: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class LayoutTextSpan:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float


@dataclass(frozen=True)
class CheckboxGeometry:
    x0: float
    y0: float
    x1: float
    y1: float
    selected: bool | None


@dataclass(frozen=True)
class TaskTraits:
    visual_kind: VisualTaskKind
    requires_visual_evidence: bool
    requires_spatial_reasoning: bool
    requires_numerical_validation: bool
    requires_complete_mapping: bool
    requires_pre_display_verification: bool
    allows_text_fallback: bool
    calculation_context: CalculationContext | None = None


_CALCULATION_RE = re.compile(
    r"\b(calculate|compute|solve|final value|berechne|bestimme|ermittle|"
    r"l[öo]se|ergebnis)\b",
    re.IGNORECASE,
)
_CHECKBOX_RE = re.compile(
    r"\b(checkbox|checked|marked|selected option|ankreuzen|angekreuzt|markiert)\b",
    re.IGNORECASE,
)
_MAPPING_RE = re.compile(
    r"\b(label(?:led)? diagram|callouts?|(?:numbers?|labels?)\s+\d+\s*(?:to|-|–)\s*\d+|"
    r"beschrifte|zuordnen|ziffern?\s+\d+\s*(?:bis|-|–)\s*\d+)\b",
    re.IGNORECASE,
)
_DIAGRAM_RE = re.compile(r"\b(diagram|drawing|figure|sketch|abbildung|zeichnung)\b", re.IGNORECASE)
_FORMULA_RE = re.compile(r"\b(formula|equation|symbol|variable|formel|gleichung)\b", re.IGNORECASE)
_TRANSCRIBE_RE = re.compile(r"\b(transcribe|read exactly|abschreiben|wortlaut)\b", re.IGNORECASE)


_VISIBLE_REFERENCE_RE = re.compile(
    r"\b((?:this|that)\s+(?:page|figure|diagram|formula|exercise|problem)|"
    r"shown|above|current page|visible page|hier|"
    r"diese[rmns]?\s+(?:seite|abbildung|formel|aufgabe)|"
    r"gezeigt|oben|aktuelle[rmns]?\s+seite)\b",
    re.IGNORECASE,
)
_EXERCISE_WITH_NUMBER_RE = re.compile(
    r"\b(?:Aufgabe|Exercise|Question|Problem)\s+\d+(?:\.\d+)*\b",
    re.IGNORECASE,
)


def is_page_bound_request(
    question: str,
    *,
    has_selected_region: bool = False,
    active_document_id: str | None = None,
) -> bool:
    return bool(
        has_selected_region
        or _VISIBLE_REFERENCE_RE.search(question or "")
        or (active_document_id and _EXERCISE_WITH_NUMBER_RE.search(question or ""))
    )


def classify_task_traits(
    question: str,
    *,
    visible_text: str = "",
    has_visible_image: bool = False,
    active_document_id: str | None = None,
) -> TaskTraits:
    """Classify independent risk traits; an attached image is not itself risk."""
    text = question or ""
    if _CHECKBOX_RE.search(text):
        return TaskTraits(
            VisualTaskKind.CHECKBOX_EXTRACTION, True, True, False, True, True, False,
        )
    if _MAPPING_RE.search(text):
        return TaskTraits(
            VisualTaskKind.TECHNICAL_DRAWING_MAPPING, True, True, False, True, True, False,
        )
    if _CALCULATION_RE.search(text):
        visible_dependency = bool(
            has_visible_image
            or _VISIBLE_REFERENCE_RE.search(text)
            or (
                active_document_id
                and _EXERCISE_WITH_NUMBER_RE.search(text)
            )
            or (
                active_document_id
                and visible_text.strip()
                and _EXERCISE_REFERENCE_RE.search(text)
            )
        )
        return TaskTraits(
            VisualTaskKind.NUMERICAL_CALCULATION,
            visible_dependency,
            False,
            True,
            False,
            True,
            True,
            (
                CalculationContext.CURRENT_PAGE
                if visible_dependency
                else CalculationContext.TEXT_ONLY
            ),
        )
    if _TRANSCRIBE_RE.search(text):
        return TaskTraits(
            VisualTaskKind.VISUAL_TRANSCRIPTION, True, False, False, True, True, True,
        )
    if _DIAGRAM_RE.search(text):
        return TaskTraits(
            VisualTaskKind.DIAGRAM_EXPLANATION, True, True, False, False, False, False,
        )
    if _FORMULA_RE.search(text):
        return TaskTraits(
            VisualTaskKind.FORMULA_EXPLANATION, True, False, False, False, False, True,
        )
    return TaskTraits(
        VisualTaskKind.TEXT_EXPLANATION, False, False, False, False, False, True,
    )


def assess_text_quality(text: str) -> float:
    clean = (text or "").strip()
    if not clean:
        return 0.0
    printable = sum(char.isprintable() for char in clean) / max(1, len(clean))
    words = re.findall(r"\w+", clean, re.UNICODE)
    replacement_penalty = min(0.5, clean.count("\ufffd") / max(1, len(clean)) * 20)
    length_score = min(1.0, len(clean) / 240)
    lexical_score = min(1.0, len(words) / 35)
    return max(0.0, min(1.0, printable * 0.25 + length_score * 0.35 + lexical_score * 0.4 - replacement_penalty))


def evidence_requirement(
    *,
    traits: TaskTraits,
    current_page_text: str,
    text_quality: float,
    image_count: int,
) -> Literal["image_required", "image_preferred", "text_sufficient"]:
    del image_count  # Availability affects enforcement, not the requirement.
    if traits.requires_spatial_reasoning:
        return "image_required"
    if (
        traits.visual_kind in {
            VisualTaskKind.FORMULA_EXPLANATION,
            VisualTaskKind.TEXT_EXPLANATION,
        }
        and current_page_text.strip()
        and text_quality >= 0.80
    ):
        return "text_sufficient"
    if traits.requires_visual_evidence:
        return "image_preferred"
    return "text_sufficient"


class NumberRole(StrEnum):
    QUANTITY = "quantity"
    DERIVED_RESULT = "derived_result"
    EXERCISE_IDENTIFIER = "exercise_identifier"
    CALLOUT_IDENTIFIER = "callout_identifier"
    PAGE_IDENTIFIER = "page_identifier"
    SOURCE_IDENTIFIER = "source_identifier"
    LIST_MARKER = "list_marker"
    FIGURE_IDENTIFIER = "figure_identifier"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class ClassifiedNumber:
    value: str
    role: NumberRole
    start: int
    end: int


_NUMBER_RE = re.compile(r"(?<![\w])\d+(?:[.,]\d+)*(?![\w])")
_IDENTIFIER_PATTERNS = (
    (NumberRole.EXERCISE_IDENTIFIER, re.compile(r"\b(?:Aufgabe|Exercise|Question|Problem)\s+(\d+(?:\.\d+)*)", re.I)),
    (NumberRole.PAGE_IDENTIFIER, re.compile(r"\b(?:page|seite)\s+(\d+)\b", re.I)),
    (NumberRole.SOURCE_IDENTIFIER, re.compile(r"\b(?:source|quelle)\s+(\d+)\b", re.I)),
    (NumberRole.FIGURE_IDENTIFIER, re.compile(r"\b(?:figure|fig\.?|abbildung)\s+(\d+)\b", re.I)),
)
_NUMBERED_LINE_RE = re.compile(r"(?m)^\s*(\d{1,3})\s*[\.\):\-]\s+\S")
_CALLOUT_RANGE_RE = re.compile(
    r"\b(?:ziffern?|nummern?|numbers?|labels?|callouts?)\s+"
    r"(\d+)\s*(?:bis|to|-|–)\s*(\d+)\b",
    re.IGNORECASE,
)
_UNIT_AFTER_RE = re.compile(
    r"^\s*(?:mm|cm|m|km|s|min|h|N|kN|Pa|kPa|MPa|GPa|rpm|%)(?:\^?[23]|[²³])?\b",
    re.IGNORECASE,
)


def classify_number_roles(text: str) -> list[ClassifiedNumber]:
    """Classify every numeric token before it can enter copied-given checks."""
    source = text or ""
    roles: dict[tuple[int, int], NumberRole] = {}
    for role, pattern in _IDENTIFIER_PATTERNS:
        for match in pattern.finditer(source):
            span = match.span(1)
            roles[span] = role
    for match in _NUMBERED_LINE_RE.finditer(source):
        roles[match.span(1)] = NumberRole.LIST_MARKER
    for match in _CALLOUT_RANGE_RE.finditer(source):
        start, end = (int(match.group(1)), int(match.group(2)))
        for number_match in _NUMBER_RE.finditer(source, match.start(), match.end()):
            if number_match.group(0).isdigit() and start <= int(number_match.group(0)) <= end:
                roles[number_match.span()] = NumberRole.CALLOUT_IDENTIFIER
    result: list[ClassifiedNumber] = []
    for match in _NUMBER_RE.finditer(source):
        role = roles.get(match.span())
        if role is None:
            prefix = source[max(0, match.start() - 24):match.start()]
            suffix = source[match.end():match.end() + 16]
            if _UNIT_AFTER_RE.match(suffix) or re.search(r"[A-Za-z][\w{}]*\s*=\s*$", prefix):
                role = NumberRole.QUANTITY
            else:
                role = NumberRole.UNKNOWN
        result.append(ClassifiedNumber(match.group(0), role, match.start(), match.end()))
    return result


def numerical_role_metadata(text: str) -> dict[str, list[dict[str, str]]]:
    classified = classify_number_roles(text)
    return {
        "verifiedQuantities": [],
        "unverifiedQuantities": [
            {"value": item.value, "role": item.role.value}
            for item in classified
            if item.role in {NumberRole.QUANTITY, NumberRole.DERIVED_RESULT}
        ],
        "ignoredIdentifiers": [
            {"value": item.value, "role": item.role.value}
            for item in classified
            if item.role not in {
                NumberRole.QUANTITY,
                NumberRole.DERIVED_RESULT,
                NumberRole.UNKNOWN,
            }
        ],
    }


@dataclass
class GroundedTaskIdentity:
    document_id: str | None = None
    filename: str | None = None
    page: int | None = None
    visible_page: int | None = None
    resolved_task_page: int | None = None
    exercise_reference: str | None = None
    domain: str | None = None
    requested_quantities: list[str] = field(default_factory=list)
    task_kind: GroundedTaskKind = GroundedTaskKind.SHORT_ANSWER
    task_summary: str | None = None
    visible_values: list[str] = field(default_factory=list)
    visible_answer_options: list[VisibleAnswerOption | str] = field(default_factory=list)
    visible_mapping_labels: list[str] = field(default_factory=list)
    visible_formula_symbols: list[str] = field(default_factory=list)
    exercise_visible_on_page: bool = False
    exercise_visible_on_visible_page: bool = False
    exercise_found_on_resolved_page: bool = False
    identity_resolution_method: IdentityResolutionMethod = (
        IdentityResolutionMethod.USER_REFERENCE_ONLY
    )
    identity_evidence_pages: list[int] = field(default_factory=list)
    field_evidence: dict[str, list[GroundedFieldEvidence]] = field(default_factory=dict)
    source_confidence: float = 0.0
    visual_identity_binding: VisualIdentityBinding | None = None
    regrounding_required: bool = False

    def fingerprint(self) -> str:
        payload = json.dumps(asdict(self), sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def option_texts(self) -> list[str]:
        return [item.text if isinstance(item, VisibleAnswerOption) else item
                for item in self.visible_answer_options]


@dataclass
class DraftTaskIdentity:
    exercise_reference: str | None = None
    domain: str | None = None
    answered_quantities: list[str] = field(default_factory=list)
    answer_type: str | None = None


class GroundingMismatch(StrEnum):
    EXERCISE_REFERENCE = "exercise_reference_mismatch"
    DOMAIN = "domain_mismatch"
    REQUESTED_QUANTITY = "requested_quantity_mismatch"
    ANSWER_TYPE = "answer_type_mismatch"
    PAGE = "source_page_mismatch"
    ANSWER_OPTION = "answer_option_mismatch"
    VISIBLE_LABEL = "visible_label_mismatch"
    MISSING_DRAFT_DOMAIN = "missing_draft_domain"
    MISSING_REQUESTED_QUANTITY = "missing_requested_quantity_answer"
    MISSING_ANSWER_OPTION = "missing_answer_option"


class IdentityComparisonState(StrEnum):
    MATCH = "match"
    MISMATCH = "mismatch"
    MISSING_REQUIRED_FIELD = "missing_required_field"
    UNKNOWN = "unknown"


MIN_IDENTITY_CONFIDENCE = 0.72


_LEGACY_TASK_KIND_MAP = {
    "calculation": GroundedTaskKind.NUMERICAL_CALCULATION,
    "matching": GroundedTaskKind.TECHNICAL_DRAWING_MAPPING,
    "labelled_diagram": GroundedTaskKind.DIAGRAM_LABELLING,
    "diagram_labeling": GroundedTaskKind.DIAGRAM_LABELLING,
    "checkbox-calculation": GroundedTaskKind.CHECKBOX_CALCULATION,
    "calculation_checkbox": GroundedTaskKind.CHECKBOX_CALCULATION,
    "multiple_choice_calculation": GroundedTaskKind.CHECKBOX_CALCULATION,
}


def normalise_legacy_task_kind(value: str | None) -> GroundedTaskKind | None:
    if not value:
        return None
    folded = value.strip().casefold().replace(" ", "_")
    try:
        return GroundedTaskKind(folded)
    except ValueError:
        return _LEGACY_TASK_KIND_MAP.get(folded)


def _normalise_exercise_id(value: str | None) -> str:
    return re.sub(r"[^0-9.]", "", value or "").strip(".")


def bind_visual_identity(
    *,
    requested_exercise: str | None,
    visual_identity: Any,
    visible_page: int | None,
    has_selected_region: bool,
    detected_task_count: int | None,
) -> VisualIdentityBinding:
    visual_exercise = getattr(visual_identity, "exercise_reference", None)
    confidence = float(getattr(visual_identity, "confidence", 0.0) or 0.0)
    evidence_page = getattr(visual_identity, "evidence_page", None)
    requested = _normalise_exercise_id(requested_exercise)
    visual = _normalise_exercise_id(visual_exercise)
    if requested and visual and requested == visual:
        return VisualIdentityBinding.EXACT_EXERCISE_MATCH
    if requested and visual and requested != visual:
        return VisualIdentityBinding.CONFLICTING_EXERCISE
    if has_selected_region and confidence >= 0.8:
        return VisualIdentityBinding.SELECTED_REGION_BOUND
    if not requested and detected_task_count == 1 and evidence_page == visible_page:
        return VisualIdentityBinding.CURRENT_PAGE_SINGLE_TASK
    return VisualIdentityBinding.AMBIGUOUS


@dataclass(frozen=True)
class RetrievalScope:
    document_ids: list[str] | None
    preferred_pages: list[int]
    exercise_reference: str | None
    allow_course_fallback: bool


@dataclass(frozen=True)
class AnswerObligation:
    obligation_type: str
    expected_values: list[str]
    satisfied: bool


@dataclass(frozen=True)
class DerivedGroundingState:
    identity: GroundedTaskIdentity
    retrieval_scope: RetrievalScope
    retrieval_document_ids: list[str] | None
    answer_obligations: list[AnswerObligation]
    allowed_mapping_labels: list[AllowedMappingLabel]
    reliability_fingerprint: str
    cache_grounding_payload: str


def derive_grounding_state(
    *,
    identity: GroundedTaskIdentity,
    traits: TaskTraits,
    active_document_id: str | None,
    visible_page: int | None,
    fallback_document_ids: list[str] | None,
    question: str,
    has_valid_selected_region: bool,
    document_revision: str | None,
    visible_page_text: str,
    image_hashes: list[str],
) -> DerivedGroundingState:
    """Build every identity-derived value as one internally consistent unit."""
    scope = build_retrieval_scope(
        active_document_id=active_document_id,
        visible_page=visible_page,
        identity=identity,
        traits=traits,
        fallback_document_ids=fallback_document_ids,
        question=question,
        has_valid_selected_region=has_valid_selected_region,
    )
    obligations = answer_obligations(answer="", identity=identity, traits=traits)
    labels = build_allowed_mapping_labels(identity.visible_mapping_labels)
    fingerprint = task_aware_cache_key(
        task_type=identity.task_kind,
        identity=identity,
        active_document=active_document_id,
        visible_page=visible_page,
        document_revision=document_revision,
        visible_page_text=visible_page_text,
        image_hashes=image_hashes,
        task_traits=traits,
    )
    grounding_payload = json.dumps({
        "identityFingerprint": identity.fingerprint(),
        "retrievalScope": {
            "documentIds": scope.document_ids,
            "preferredPages": scope.preferred_pages,
            "exerciseReference": scope.exercise_reference,
            "allowCourseFallback": scope.allow_course_fallback,
        },
        "answerObligations": [
            {"type": item.obligation_type, "expected": item.expected_values}
            for item in obligations
        ],
        "allowedMappingLabels": [item.canonical for item in labels],
    }, sort_keys=True, ensure_ascii=False)
    return DerivedGroundingState(
        identity=identity,
        retrieval_scope=scope,
        retrieval_document_ids=scope.document_ids,
        answer_obligations=obligations,
        allowed_mapping_labels=labels,
        reliability_fingerprint=fingerprint,
        cache_grounding_payload=grounding_payload,
    )


@dataclass(frozen=True)
class GroundedRequestContext:
    request_id: str
    task_traits: TaskTraits
    task_identity: GroundedTaskIdentity
    retrieval_scope: RetrievalScope
    evidence_requirement: str
    answer_obligations: list[AnswerObligation]
    allowed_mapping_labels: list[AllowedMappingLabel]
    visible_answer_options: list[VisibleAnswerOption | str]
    source_fingerprint: str

    def prompt_overlay(self) -> str:
        identity = self.task_identity
        return (
            "\nIMMUTABLE GROUNDED REQUEST CONTEXT (server-validated):\n"
            f"- Exercise: {identity.exercise_reference or 'unknown'}\n"
            f"- Resolution: {identity.identity_resolution_method.value}\n"
            f"- Evidence pages: {identity.identity_evidence_pages}\n"
            f"- Domain: {identity.domain or 'unknown'}\n"
            f"- Requested quantities: {identity.requested_quantities}\n"
            f"- Task kind: {identity.task_kind}\n"
            f"- Visible options: {identity.option_texts()}\n"
            f"- Allowed mapping labels: {[item.canonical for item in self.allowed_mapping_labels]}\n"
            f"- Required answer obligations: {[item.obligation_type for item in self.answer_obligations]}\n"
            "Use only this task identity for generation and repair; do not substitute a prior answer's identity.\n"
        )


@dataclass(frozen=True)
class RepairedAnswerValidation:
    accepted: bool
    mismatches: list[GroundingMismatch]
    obligations: list[AnswerObligation]
    verification_rejected: bool = False


def compare_task_identities(
    source: GroundedTaskIdentity,
    draft: DraftTaskIdentity,
    *,
    traits: TaskTraits | None = None,
) -> list[GroundingMismatch]:
    mismatches: list[GroundingMismatch] = []
    if source.exercise_reference and draft.exercise_reference:
        if source.exercise_reference.casefold() != draft.exercise_reference.casefold():
            mismatches.append(GroundingMismatch.EXERCISE_REFERENCE)
    if source.domain:
        if draft.domain and source.domain.casefold() != draft.domain.casefold():
            mismatches.append(GroundingMismatch.DOMAIN)
        elif source.source_confidence >= 0.8 and not draft.domain:
            mismatches.append(GroundingMismatch.MISSING_DRAFT_DOMAIN)
    requested = {item.casefold() for item in source.requested_quantities}
    answered = {item.casefold() for item in draft.answered_quantities}
    if requested and answered and not requested.intersection(answered):
        mismatches.append(GroundingMismatch.REQUESTED_QUANTITY)
    elif requested and traits and traits.requires_numerical_validation and not answered:
        mismatches.append(GroundingMismatch.MISSING_REQUESTED_QUANTITY)
    if source.task_kind.startswith("checkbox") and draft.answer_type:
        if "checkbox" not in draft.answer_type.casefold() and "option" not in draft.answer_type.casefold():
            mismatches.append(GroundingMismatch.ANSWER_TYPE)
    if (
        source.task_kind.startswith("checkbox")
        and source.visible_answer_options
        and (not draft.answer_type or draft.answer_type == "narrative")
    ):
        mismatches.append(GroundingMismatch.MISSING_ANSWER_OPTION)
    return mismatches


def identity_is_sufficient(
    identity: GroundedTaskIdentity,
    *,
    traits: TaskTraits,
    page_bound_request: bool = False,
) -> bool:
    if identity.source_confidence < MIN_IDENTITY_CONFIDENCE:
        return False
    if identity.exercise_reference and not identity.document_id:
        return False
    if page_bound_request and identity.exercise_reference:
        if not (
            identity.exercise_visible_on_visible_page
            or identity.exercise_visible_on_page
        ):
            return False
        resolved_page = identity.resolved_task_page or identity.page
        if resolved_page is None or resolved_page not in identity.identity_evidence_pages:
            return False
        if identity.visual_identity_binding in {
            VisualIdentityBinding.AMBIGUOUS,
            VisualIdentityBinding.CONFLICTING_EXERCISE,
        }:
            return False
    if identity.exercise_reference and not (
        identity.domain
        or identity.requested_quantities
        or identity.visible_answer_options
        or identity.visible_mapping_labels
        or identity.visible_values
    ):
        return False
    if (
        traits.requires_numerical_validation
        and traits.calculation_context is not CalculationContext.TEXT_ONLY
        and not identity.requested_quantities
    ):
        return False
    if traits.requires_complete_mapping and not (
        identity.visible_mapping_labels or identity.visible_answer_options
    ):
        return False
    return True


def build_retrieval_scope(
    *,
    active_document_id: str | None,
    visible_page: int | None,
    identity: GroundedTaskIdentity,
    traits: TaskTraits,
    fallback_document_ids: list[str] | None,
    question: str = "",
    has_valid_selected_region: bool = False,
) -> RetrievalScope:
    refers_to_current_page = bool(re.search(
        r"\b(?:(?:this|that|current|visible|shown)\s+"
        r"(?:page|figure|diagram|formula|exercise|problem)|above|here|"
        r"diese[rs]?\s+(?:seite|abbildung|formel|aufgabe)|"
        r"aktuelle[rs]?\s+seite|sichtbare[rs]?\s+(?:seite|abbildung)|hier)\b",
        question or "",
        re.IGNORECASE,
    ))
    exact_active_task = bool(
        active_document_id
        and (
            identity.exercise_reference
            or traits.requires_visual_evidence
            or refers_to_current_page
            or has_valid_selected_region
        )
    )
    task_page = identity.resolved_task_page or identity.page or visible_page
    pages = (
        [page for page in (task_page - 1, task_page, task_page + 1) if page >= 1]
        if task_page else []
    )
    return RetrievalScope(
        document_ids=[active_document_id] if exact_active_task else fallback_document_ids,
        preferred_pages=pages,
        exercise_reference=identity.exercise_reference,
        allow_course_fallback=not exact_active_task,
    )


_GERMAN_ARTICLE_RE = re.compile(
    r"^(?:der|die|das|den|dem|des|ein|eine)\s+", re.IGNORECASE,
)
_EXPLANATION_SEPARATOR_RE = re.compile(r"(?:\s*[\u2013\u2014:,]\s+|\s+\()")
_QUANTITY_WITH_UNIT_RE = re.compile(
    r"(?<![\w.])(?P<value>[+\u2212-]?\d+(?:[.,]\d+)?)\s*"
    r"(?P<unit>N\s*/\s*mm\s*(?:\^?\s*2|[Â²])|m\s*/\s*s|1\s*/\s*min|"
    r"mm(?:\s*(?:\^?\s*[23]|[Â²Â³]))?|cm(?:\s*(?:\^?\s*[23]|[Â²Â³]))?|"
    r"m(?:\s*(?:\^?\s*[23]|[Â²Â³]))?|kN|N|GPa|MPa|kPa|Pa|kg|g|rpm|"
    r"kW|W|J|°C|%|min|s)(?=$|[\s,.;:)])",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ParsedQuantity:
    value: float
    unit_raw: str
    unit_canonical: str
    unit_family: str
    precision: int | None
    base_value: float


_UNIT_DEFINITIONS: dict[str, tuple[str, float]] = {
    "mm": ("length", 1.0), "cm": ("length", 10.0), "m": ("length", 1000.0),
    "mm2": ("area", 1.0), "cm2": ("area", 100.0), "m2": ("area", 1_000_000.0),
    "mm3": ("volume", 1.0), "cm3": ("volume", 1000.0), "m3": ("volume", 1_000_000_000.0),
    "s": ("time", 1.0), "min": ("time", 60.0),
    "n": ("force", 1.0), "kn": ("force", 1000.0),
    "pa": ("pressure", 0.000001), "kpa": ("pressure", 0.001),
    "mpa": ("pressure", 1.0), "gpa": ("pressure", 1000.0),
    "n_per_mm2": ("pressure", 1.0),
    "g": ("mass", 1.0), "kg": ("mass", 1000.0),
    "m_per_s": ("speed", 1.0), "per_minute": ("rotational_speed", 1.0),
    "j": ("energy", 1.0), "w": ("power", 1.0), "kw": ("power", 1000.0),
    "celsius": ("temperature", 1.0), "percent": ("percentage", 1.0),
}


def _canonical_engineering_unit(raw: str) -> str | None:
    unit = re.sub(r"\s+", "", (raw or "").replace("Â", ""))
    unit = unit.replace("²", "2").replace("³", "3").replace("^", "")
    folded = unit.casefold()
    aliases = {
        "n/mm2": "n_per_mm2", "m/s": "m_per_s", "1/min": "per_minute",
        "rpm": "per_minute", "°c": "celsius", "%": "percent",
    }
    return aliases.get(folded, folded if folded in _UNIT_DEFINITIONS else None)


def parse_engineering_quantities(text: str) -> list[ParsedQuantity]:
    clean = (text or "").replace("Â", "")
    parsed: list[ParsedQuantity] = []
    for match in _QUANTITY_WITH_UNIT_RE.finditer(clean):
        raw_value = match.group("value").replace("\u2212", "-")
        canonical = _canonical_engineering_unit(match.group("unit"))
        if not canonical:
            continue
        try:
            value = float(raw_value.replace(",", "."))
        except ValueError:
            continue
        decimal = re.split(r"[.,]", raw_value.lstrip("+-"), maxsplit=1)
        precision = len(decimal[1]) if len(decimal) == 2 else 0
        family, scale = _UNIT_DEFINITIONS[canonical]
        parsed.append(ParsedQuantity(
            value=value,
            unit_raw=match.group("unit"),
            unit_canonical=canonical,
            unit_family=family,
            precision=precision,
            base_value=value * scale,
        ))
    return parsed


def normalise_mapping_label(value: str) -> str:
    folded = _GERMAN_ARTICLE_RE.sub("", (value or "").strip())
    folded = folded.replace("-", "").replace("\u2013", " ").replace("\u2014", " ")
    return re.sub(r"[^\w]+", " ", folded, flags=re.UNICODE).casefold().strip()


def _primary_mapping_label(value: str) -> str:
    match = _EXPLANATION_SEPARATOR_RE.search(value or "")
    return (value[:match.start()] if match else value).strip(" .;:-")


def build_allowed_mapping_labels(values: list[str]) -> list[AllowedMappingLabel]:
    result: list[AllowedMappingLabel] = []
    for raw in values:
        canonical = (raw or "").strip()
        if not canonical:
            continue
        aliases = [canonical]
        aliases.extend(part.strip() for part in canonical.split("/") if part.strip())
        result.append(AllowedMappingLabel(canonical, list(dict.fromkeys(aliases))))
    return result


def source_label_matches(answer_label: str, allowed_label: AllowedMappingLabel | str) -> bool:
    candidate = (
        allowed_label if isinstance(allowed_label, AllowedMappingLabel)
        else AllowedMappingLabel(allowed_label, [allowed_label])
    )
    answer = normalise_mapping_label(_primary_mapping_label(answer_label))
    if not answer:
        return False
    for alias in candidate.aliases or [candidate.canonical]:
        allowed = normalise_mapping_label(alias)
        if not allowed:
            continue
        if answer == allowed:
            return True
        # Only tolerate extra explanatory words after the complete technical
        # label; never accept a merely related or shorter generic noun.
        if answer.startswith(allowed + " "):
            return True
        answer_tokens, allowed_tokens = set(answer.split()), set(allowed.split())
        if allowed_tokens and allowed_tokens.issubset(answer_tokens):
            overlap = len(answer_tokens & allowed_tokens) / len(answer_tokens | allowed_tokens)
            if overlap >= 0.88:
                return True
    return False


def _source_unit_families(values: list[str]) -> set[str]:
    return {
        quantity.unit_family
        for value in values
        for quantity in parse_engineering_quantities(value)
    }


def _answer_quantity_values(answer: str) -> list[ParsedQuantity]:
    return parse_engineering_quantities(answer)


def _has_final_numeric_result(answer: str, identity: GroundedTaskIdentity) -> bool:
    """Require a requested assignment or an explicitly labelled final-result line."""
    quantity_pattern = "|".join(
        re.escape(value) for value in identity.requested_quantities if value
    )
    for line in (answer or "").splitlines():
        if not parse_engineering_quantities(line):
            continue
        has_assignment = bool(re.search(
            r"(?:=|\u2248|\bis\b|betr(?:ä|ae)gt)", line, re.IGNORECASE,
        ))
        has_requested = bool(quantity_pattern and re.search(
            rf"(?:{quantity_pattern})\b", line, re.IGNORECASE,
        ))
        labelled_final = bool(re.search(
            r"\b(?:final(?: result)?|result|ergebnis|endwert)\b", line, re.IGNORECASE,
        ))
        if (has_requested and has_assignment) or labelled_final:
            return True
    return bool(
        str(identity.task_kind).startswith("checkbox")
        and selected_result_matches_visible_option(
            answer=answer, options=identity.visible_answer_options,
        )
    )


def selected_result_matches_visible_option(
    *, answer: str, options: list[VisibleAnswerOption | str],
) -> bool:
    answer_values = _answer_quantity_values(answer)
    if not answer_values:
        return False
    matches: set[int] = set()
    for index, option in enumerate(options):
        text = option.text if isinstance(option, VisibleAnswerOption) else option
        option_values = _answer_quantity_values(text)
        for answer_quantity in answer_values:
            for option_quantity in option_values:
                if answer_quantity.unit_family != option_quantity.unit_family:
                    continue
                decimals = option_quantity.precision or 0
                unit_scale = (
                    abs(option_quantity.base_value / option_quantity.value)
                    if option_quantity.value else 1.0
                )
                tolerance = max(
                    0.5 * (10 ** -decimals) * unit_scale,
                    abs(option_quantity.base_value) * 1e-6,
                )
                if abs(answer_quantity.base_value - option_quantity.base_value) <= tolerance:
                    matches.add(index)
    return len(matches) == 1


def pair_coordinate_answer_options(
    *,
    checkboxes: list[CheckboxGeometry],
    text_spans: list[LayoutTextSpan],
    page: int,
    max_horizontal_gap: float = 80.0,
) -> list[VisibleAnswerOption]:
    """Pair separated checkbox geometry with same-row text in canonical page coordinates."""
    options: list[VisibleAnswerOption] = []
    for box in checkboxes:
        box_mid = (box.y0 + box.y1) / 2
        candidates: list[tuple[float, LayoutTextSpan]] = []
        for span in text_spans:
            span_mid = (span.y0 + span.y1) / 2
            row_tolerance = max(3.0, (box.y1 - box.y0 + span.y1 - span.y0) / 2)
            if abs(span_mid - box_mid) > row_tolerance:
                continue
            if span.x0 >= box.x1:
                gap = span.x0 - box.x1
            elif span.x1 <= box.x0:
                gap = box.x0 - span.x1
            else:
                gap = 0.0
            if gap <= max_horizontal_gap and span.text.strip():
                candidates.append((gap, span))
        if not candidates:
            continue
        nearest_gap, nearest = min(candidates, key=lambda item: item[0])
        options.append(VisibleAnswerOption(
            text=nearest.text.strip(),
            selected=box.selected,
            page=page,
            source="coordinate_pairing",
            confidence=max(0.55, 0.98 - min(0.4, nearest_gap / max_horizontal_gap * 0.4)),
        ))
    return options


def answer_obligations(
    *,
    answer: str,
    identity: GroundedTaskIdentity,
    traits: TaskTraits,
    required_identifiers: list[str] | None = None,
) -> list[AnswerObligation]:
    folded = (answer or "").casefold()
    obligations: list[AnswerObligation] = []
    if identity.requested_quantities:
        obligations.append(AnswerObligation(
            AnswerObligationType.INCLUDE_REQUESTED_QUANTITY.value,
            identity.requested_quantities,
            any(value.casefold() in folded for value in identity.requested_quantities),
        ))
    option_texts = identity.option_texts()
    if option_texts and identity.task_kind.startswith("checkbox"):
        obligations.append(AnswerObligation(
            AnswerObligationType.SELECT_VISIBLE_OPTION.value,
            option_texts,
            selected_result_matches_visible_option(answer=answer, options=identity.visible_answer_options),
        ))
    if traits.requires_numerical_validation:
        obligations.append(AnswerObligation(
            AnswerObligationType.INCLUDE_FINAL_NUMERIC_VALUE.value,
            identity.visible_values or option_texts,
            _has_final_numeric_result(answer, identity),
        ))
        expected_units = _source_unit_families(identity.visible_values + option_texts)
        obligations.append(AnswerObligation(
            AnswerObligationType.INCLUDE_COMPATIBLE_UNIT.value,
            sorted(expected_units),
            bool(_source_unit_families([answer]).intersection(expected_units))
            if expected_units else bool(parse_engineering_quantities(answer)),
        ))
    identifiers = required_identifiers or []
    if traits.requires_complete_mapping and identifiers:
        obligations.append(AnswerObligation(
            "complete_mapping",
            identifiers,
            all(re.search(rf"\b{re.escape(value)}\b", answer or "") for value in identifiers),
        ))
    if traits.visual_kind is VisualTaskKind.FORMULA_EXPLANATION and identity.visible_values:
        symbols = [
            match.group(1) for value in identity.visible_values
            if (match := _ASSIGNMENT_VALUE_RE.search(value))
        ]
        obligations.append(AnswerObligation(
            AnswerObligationType.EXPLAIN_VISIBLE_FORMULA.value,
            symbols,
            bool(symbols and any(symbol.casefold() in folded for symbol in symbols)),
        ))
    return obligations


def validate_repaired_answer(
    *,
    answer: str,
    identity: GroundedTaskIdentity,
    traits: TaskTraits,
    required_identifiers: list[str] | None = None,
    allowed_source_labels: list[str] | None = None,
    verification_rejected: bool = False,
) -> RepairedAnswerValidation:
    draft = identify_draft_task(answer)
    mismatches = compare_task_identities(identity, draft, traits=traits)
    obligations = answer_obligations(
        answer=answer,
        identity=identity,
        traits=traits,
        required_identifiers=required_identifiers,
    )
    source_labels = allowed_source_labels or identity.visible_mapping_labels
    if traits.requires_complete_mapping and source_labels:
        allowed = build_allowed_mapping_labels(source_labels)
        extracted = [
            _primary_mapping_label(match.group(1))
            for match in re.finditer(
                r"(?m)^\s*\d{1,2}\s*(?:[-.):=]|->|\u2192)\s*([^\n|]+)",
                answer or "",
            )
        ]
        invalid = [label for label in extracted if not any(
            source_label_matches(label, candidate) for candidate in allowed
        )]
        obligations.append(AnswerObligation(
            "allowed_mapping_labels",
            source_labels,
            bool(extracted) and not invalid,
        ))
    return RepairedAnswerValidation(
        accepted=bool(
            answer.strip()
            and not mismatches
            and all(item.satisfied for item in obligations)
            and not verification_rejected
        ),
        mismatches=mismatches,
        obligations=obligations,
        verification_rejected=verification_rejected,
    )


_EXERCISE_REFERENCE_RE = re.compile(
    r"\b(?:Aufgabe|Exercise|Question|Problem)?\s*(\d+(?:\.\d+)+)\b",
    re.IGNORECASE,
)
_ASSIGNMENT_VALUE_RE = re.compile(
    r"\b([A-Za-z][A-Za-z0-9_{}]*)\s*=\s*"
    r"([+\-−]?\d+(?:[.,]\d+)?\s*(?:mm|cm|m|s|min|N|Pa|MPa|cm[³3]|mm[²³23])?)",
    re.IGNORECASE,
)


def extract_text_visible_options(text: str, page: int | None) -> list[VisibleAnswerOption]:
    patterns = (
        (r"(?m)^\s*(?P<mark>[\u2610\u2611\u2713\u2714]|\[\s?[xX\u2713\u2714]?\s?\])\s*(?P<text>.+)$", "text_leading_marker"),
        (r"(?m)^\s*(?P<text>.+?)\s*(?P<mark>[\u2610\u2611\u2713\u2714]|\[\s?[xX\u2713\u2714]?\s?\])\s*$", "text_trailing_marker"),
    )
    by_text: dict[str, VisibleAnswerOption] = {}
    for pattern, source in patterns:
        for match in re.finditer(pattern, text or ""):
            option_text = match.group("text").strip()
            marker = match.group("mark")
            selected = bool(re.search(r"[xX\u2611\u2713\u2714]", marker))
            key = re.sub(r"\s+", " ", option_text.casefold())
            candidate = VisibleAnswerOption(
                text=option_text, selected=selected, page=page,
                source=source, confidence=0.9,
            )
            if key not in by_text or (selected and not by_text[key].selected):
                by_text[key] = candidate
    return list(by_text.values())


def identify_grounded_task(
    *,
    question: str,
    current_page_text: str,
    document_id: str | None,
    filename: str | None,
    page: int | None,
    traits: TaskTraits | None = None,
    selected_region_text: str = "",
) -> GroundedTaskIdentity:
    """Resolve task identity from active-document evidence before retrieval."""
    evidence = "\n".join([
        question or "", selected_region_text or "", current_page_text or "",
    ])
    exercise = _EXERCISE_REFERENCE_RE.search(question or "")
    if exercise is None and (
        _VISIBLE_REFERENCE_RE.search(question or "")
        or (traits is not None and traits.requires_visual_evidence)
    ):
        exercise = _EXERCISE_REFERENCE_RE.search(
            selected_region_text or current_page_text or ""
        )
    assignments = list(_ASSIGNMENT_VALUE_RE.finditer(evidence))
    requested: list[str] = []
    for pattern in (
        r"\b(?:calculate|compute|find|determine|berechne|bestimme|ermittle)\s+([A-Za-z][\w{}]*)",
        r"\b(?:for|für)\s+([A-Za-z][\w{}]*)\b",
    ):
        match = re.search(pattern, question or "", re.IGNORECASE)
        if match:
            requested.append(match.group(1))
    sought = re.search(
        r"\b(?:gesucht|requested|determine|bestimme)\s*:?\s*([A-Za-z][\w{}]*)",
        evidence,
        re.IGNORECASE,
    )
    if sought:
        requested.append(sought.group(1))
    for match in re.finditer(
        r"\b([A-Za-z][A-Za-z0-9_{}]*)\s*=\s*\?",
        evidence,
    ):
        requested.append(match.group(1))
    for match in re.finditer(
        r"\b(?:calculate|compute|determine|berechnen|bestimmen|ermitteln)"
        r"\b[^\n.:;]{0,80}\b([A-Za-z][A-Za-z0-9_{}]*)\b",
        evidence,
        re.IGNORECASE,
    ):
        candidate = match.group(1)
        if candidate.casefold() not in {
            "the", "a", "an", "sie", "den", "die", "das", "value", "wert",
        }:
            requested.append(candidate)
    domain = None
    domain_patterns = {
        "injection_moulding": r"\b(injection mould|spritzguss|spritzgie|V_Spritz)\b",
        "machining": r"\b(cutting speed|tool life|schnittgeschwindigkeit|standzeit|T_min)\b",
        "thermodynamics": r"\b(thermodynamic|enthalpy|entropy|wärmelehre)\b",
    }
    for candidate, pattern in domain_patterns.items():
        if re.search(pattern, evidence, re.IGNORECASE):
            domain = candidate
            break
    visual_traits = traits or classify_task_traits(question)
    kind_map = {
        VisualTaskKind.NUMERICAL_CALCULATION: GroundedTaskKind.NUMERICAL_CALCULATION,
        VisualTaskKind.CHECKBOX_EXTRACTION: GroundedTaskKind.CHECKBOX_EXTRACTION,
        VisualTaskKind.LABELLED_DIAGRAM: GroundedTaskKind.DIAGRAM_LABELLING,
        VisualTaskKind.TECHNICAL_DRAWING_MAPPING: GroundedTaskKind.TECHNICAL_DRAWING_MAPPING,
        VisualTaskKind.TEXT_EXPLANATION: GroundedTaskKind.EXPLANATION,
        VisualTaskKind.FORMULA_EXPLANATION: GroundedTaskKind.FORMULA_EXPLANATION,
        VisualTaskKind.DIAGRAM_EXPLANATION: GroundedTaskKind.EXPLANATION,
    }
    leading_options = [
        match.group(1).strip()
        for match in re.finditer(
            r"(?m)^\s*(?:[☐☑✓✔]|\[\s?[xX✓]?\s?\]|\([A-Da-d]\))\s*(.+)$",
            current_page_text or "",
        )
        if match.group(1).strip()
    ]
    trailing_options = [
        match.group(1).strip()
        for match in re.finditer(
            r"(?m)^\s*(.+?)\s*(?:[\u2611\u2713\u2714]|"
            r"\[\s?[xX\u2713\u2714]\s?\])\s*$",
            current_page_text or "",
        )
        if match.group(1).strip()
    ]
    visible_option_texts = list(dict.fromkeys(leading_options + trailing_options))
    visible_options = [VisibleAnswerOption(
        text=value,
        selected=bool(re.search(r"(?:[â˜‘âœ“âœ”]|\[\s?[xXâœ“âœ”]\s?\])", value)),
        page=page,
        source="current_page_text",
        confidence=0.82,
    ) for value in visible_option_texts]
    # Preserve selection state and provenance; the legacy regex lists above
    # remain only as a compatibility parse for unusual extracted glyphs.
    structured_text_options = extract_text_visible_options(
        "\n".join([selected_region_text or "", current_page_text or ""]), page,
    )
    if structured_text_options:
        visible_options = structured_text_options
    mapping_labels: list[str] = []
    if visual_traits.requires_complete_mapping:
        mapping_labels = [
            match.group(1).strip()
            for match in re.finditer(
                r"(?m)^\s*\d{1,2}\s*(?:[-.):=]|->|\u2192)\s*([^\n|,;]+)",
                "\n".join([selected_region_text or "", current_page_text or ""]),
            )
            if match.group(1).strip()
        ]
    resolved_kind = kind_map.get(visual_traits.visual_kind, GroundedTaskKind.SHORT_ANSWER)
    if (
        visual_traits.visual_kind is VisualTaskKind.NUMERICAL_CALCULATION
        and visible_options
    ):
        resolved_kind = GroundedTaskKind.CHECKBOX_CALCULATION
    exercise_reference = exercise.group(1) if exercise else None
    exercise_in_region = bool(
        exercise_reference
        and re.search(
            rf"(?<![\d.]){re.escape(exercise_reference)}(?![\d.])",
            selected_region_text or "",
        )
    )
    exercise_visible = exercise_in_region or bool(
        exercise_reference
        and re.search(
            rf"(?<![\d.]){re.escape(exercise_reference)}(?![\d.])",
            current_page_text or "",
        )
    )
    evidence_pages = [page] if exercise_visible and page is not None else []
    resolution_method = (
        IdentityResolutionMethod.SELECTED_REGION if exercise_in_region
        else IdentityResolutionMethod.CURRENT_PAGE_TEXT if exercise_visible
        else IdentityResolutionMethod.USER_REFERENCE_ONLY
    )
    confidence = 0.0
    confidence += 0.10 if document_id else 0.0
    confidence += 0.10 if page else 0.0
    confidence += 0.15 if exercise_reference else 0.0
    confidence += 0.25 if exercise_visible else 0.0
    confidence += 0.15 if domain else 0.0
    confidence += 0.15 if requested else 0.0
    confidence += 0.10 if visible_options else 0.0
    question_terms = {
        token for token in re.findall(r"[A-Za-zÄÖÜäöüß_]{4,}", question or "")
        if token.casefold() not in {
            "this", "that", "calculate", "compute", "solve", "aufgabe",
            "exercise", "question", "problem", "please", "explain",
        }
    }
    page_terms = {
        token.casefold()
        for token in re.findall(r"[A-Za-zÄÖÜäöüß_]{4,}", current_page_text or "")
    }
    semantic_overlap = (
        len({term.casefold() for term in question_terms}.intersection(page_terms))
        / max(1, len(question_terms))
    )
    confidence += 0.20 if question_terms and semantic_overlap >= 0.25 else 0.0
    return GroundedTaskIdentity(
        document_id=document_id,
        filename=filename,
        page=page,
        visible_page=page,
        resolved_task_page=page if exercise_visible else None,
        exercise_reference=exercise_reference,
        domain=domain,
        requested_quantities=list(dict.fromkeys(requested)),
        task_kind=resolved_kind,
        visible_values=[match.group(0) for match in assignments],
        visible_answer_options=visible_options,
        visible_mapping_labels=mapping_labels,
        visible_formula_symbols=list(dict.fromkeys(match.group(1) for match in assignments)),
        exercise_visible_on_page=exercise_visible,
        exercise_visible_on_visible_page=exercise_visible,
        exercise_found_on_resolved_page=bool(
            exercise_visible and page is not None and page in evidence_pages
        ),
        identity_resolution_method=resolution_method,
        identity_evidence_pages=evidence_pages,
        field_evidence={
            "exercise_reference": ([GroundedFieldEvidence(
                exercise_reference,
                IdentityEvidenceSource.SELECTED_REGION if exercise_in_region
                else IdentityEvidenceSource.CURRENT_PAGE_TEXT if exercise_visible
                else IdentityEvidenceSource.USER_QUERY,
                page if exercise_visible else None,
                0.95 if exercise_visible else 0.2,
            )] if exercise_reference else []),
            "domain": ([GroundedFieldEvidence(
                domain, IdentityEvidenceSource.CURRENT_PAGE_TEXT, page, 0.82,
            )] if domain else []),
            "requested_quantities": [GroundedFieldEvidence(
                value, IdentityEvidenceSource.CURRENT_PAGE_TEXT, page, 0.82,
            ) for value in requested],
            "visible_answer_options": [GroundedFieldEvidence(
                option.text, IdentityEvidenceSource.CURRENT_PAGE_TEXT, page,
                option.confidence,
            ) for option in visible_options],
            "visible_mapping_labels": [GroundedFieldEvidence(
                value, IdentityEvidenceSource.CURRENT_PAGE_TEXT, page, 0.78,
            ) for value in mapping_labels],
        },
        source_confidence=min(1.0, confidence),
    )


def merge_grounded_task_identity(
    *,
    user_identity: GroundedTaskIdentity,
    text_identity: GroundedTaskIdentity,
    visual_identity: Any | None,
    has_selected_region: bool = False,
    detected_task_count: int | None = None,
) -> GroundedTaskIdentity:
    """Merge identity fields without flattening vision evidence into prose."""
    if visual_identity is None:
        return text_identity
    visual_page = getattr(visual_identity, "evidence_page", None)
    visual_confidence = float(getattr(visual_identity, "confidence", 0.0) or 0.0)
    visual_exercise = getattr(visual_identity, "exercise_reference", None)
    requested_exercise = (
        user_identity.exercise_reference or text_identity.exercise_reference
    )
    binding = bind_visual_identity(
        requested_exercise=requested_exercise,
        visual_identity=visual_identity,
        visible_page=text_identity.visible_page or text_identity.page,
        has_selected_region=has_selected_region,
        detected_task_count=detected_task_count,
    )
    trusted = binding in {
        VisualIdentityBinding.EXACT_EXERCISE_MATCH,
        VisualIdentityBinding.SELECTED_REGION_BOUND,
        VisualIdentityBinding.CURRENT_PAGE_SINGLE_TASK,
    }
    conflicting = binding is VisualIdentityBinding.CONFLICTING_EXERCISE
    exercise = requested_exercise or (visual_exercise if trusted else None)
    current_visual = trusted and visual_page == (text_identity.visible_page or text_identity.page)
    options = list(text_identity.visible_answer_options)
    for raw in (getattr(visual_identity, "visible_answer_options", []) or []) if trusted else []:
        option = VisibleAnswerOption(
            text=str(getattr(raw, "text", "") or ""),
            label=getattr(raw, "label", None),
            selected=getattr(raw, "selected", None),
            page=getattr(raw, "page", None) or visual_page,
            source="vision",
            confidence=float(getattr(raw, "confidence", visual_confidence) or 0.0),
        )
        if option.text and normalise_mapping_label(option.text) not in {
            normalise_mapping_label(value.text if isinstance(value, VisibleAnswerOption) else value)
            for value in options
        }:
            options.append(option)
    labels = list(dict.fromkeys(
        text_identity.visible_mapping_labels
        + (list(getattr(visual_identity, "visible_mapping_labels", []) or []) if trusted else [])
    ))
    values = list(dict.fromkeys(
        text_identity.visible_values
        + (list(getattr(visual_identity, "visible_values", []) or []) if trusted else [])
    ))
    quantities = list(dict.fromkeys(
        text_identity.requested_quantities
        + (list(getattr(visual_identity, "requested_quantities", []) or []) if trusted else [])
    ))
    symbols = list(dict.fromkeys(
        text_identity.visible_formula_symbols
        + (list(getattr(visual_identity, "visible_formula_symbols", []) or []) if trusted else [])
    ))
    evidence_pages = list(dict.fromkeys(
        text_identity.identity_evidence_pages
        + ([visual_page] if trusted and visual_page is not None else [])
    ))
    resolution = text_identity.identity_resolution_method
    if current_visual:
        resolution = IdentityResolutionMethod.CURRENT_PAGE_VISION
    elif trusted:
        resolution = IdentityResolutionMethod.ACTIVE_DOCUMENT_SEARCH
    field_evidence = dict(text_identity.field_evidence)
    if visual_exercise:
        field_evidence.setdefault("exercise_reference", []).append(GroundedFieldEvidence(
            str(visual_exercise), IdentityEvidenceSource.VISION, visual_page, visual_confidence,
        ))
    if trusted:
        for field_name, values_to_record in (
            ("domain", [getattr(visual_identity, "domain", None)]),
            ("requested_quantities", getattr(visual_identity, "requested_quantities", []) or []),
            ("visible_mapping_labels", getattr(visual_identity, "visible_mapping_labels", []) or []),
            ("visible_formula_symbols", getattr(visual_identity, "visible_formula_symbols", []) or []),
        ):
            field_evidence.setdefault(field_name, []).extend(
                GroundedFieldEvidence(
                    str(value), IdentityEvidenceSource.VISION, visual_page, visual_confidence,
                )
                for value in values_to_record if value
            )
    visual_weight = {
        VisualIdentityBinding.EXACT_EXERCISE_MATCH: 1.0,
        VisualIdentityBinding.SELECTED_REGION_BOUND: 0.9,
        VisualIdentityBinding.CURRENT_PAGE_SINGLE_TASK: 0.75,
        VisualIdentityBinding.AMBIGUOUS: 0.2,
        VisualIdentityBinding.CONFLICTING_EXERCISE: 0.0,
    }[binding]
    agreement_score = 1.0 if binding is VisualIdentityBinding.EXACT_EXERCISE_MATCH else 0.0
    combined_confidence = (
        text_identity.source_confidence * 0.55
        + visual_confidence * visual_weight * 0.35
        + agreement_score * 0.10
    )
    if binding is VisualIdentityBinding.AMBIGUOUS:
        combined_confidence = min(combined_confidence, MIN_IDENTITY_CONFIDENCE - 0.01)
    resolved_page = text_identity.resolved_task_page or text_identity.page
    if trusted and visual_page is not None:
        resolved_page = visual_page
    return GroundedTaskIdentity(
        document_id=text_identity.document_id or user_identity.document_id,
        filename=text_identity.filename or user_identity.filename,
        page=resolved_page,
        visible_page=text_identity.visible_page or text_identity.page,
        resolved_task_page=resolved_page,
        exercise_reference=exercise,
        domain=text_identity.domain or (getattr(visual_identity, "domain", None) if trusted else None),
        requested_quantities=quantities,
        task_kind=(normalise_legacy_task_kind(
            getattr(visual_identity, "task_kind", None) if trusted else None
        ) or normalise_legacy_task_kind(str(text_identity.task_kind))
                   or GroundedTaskKind.SHORT_ANSWER),
        task_summary=(getattr(visual_identity, "task_summary", None) if trusted else None),
        visible_values=values,
        visible_answer_options=options,
        visible_mapping_labels=labels,
        visible_formula_symbols=symbols,
        exercise_visible_on_page=(
            text_identity.exercise_visible_on_visible_page
            or text_identity.exercise_visible_on_page
            or current_visual
        ),
        exercise_visible_on_visible_page=(
            text_identity.exercise_visible_on_visible_page
            or text_identity.exercise_visible_on_page
            or current_visual
        ),
        exercise_found_on_resolved_page=bool(
            resolved_page is not None and resolved_page in evidence_pages
        ),
        identity_resolution_method=resolution,
        identity_evidence_pages=evidence_pages,
        field_evidence=field_evidence,
        source_confidence=min(1.0, combined_confidence),
        visual_identity_binding=binding,
        regrounding_required=conflicting,
    )


def identify_draft_task(draft: str) -> DraftTaskIdentity:
    exercise = _EXERCISE_REFERENCE_RE.search(draft or "")
    assignments = [match.group(1) for match in _ASSIGNMENT_VALUE_RE.finditer(draft or "")]
    assignments.extend(
        match.group(1)
        for match in re.finditer(
            r"\b([A-Za-z][A-Za-z0-9_{}]*_[A-Za-z0-9_{}]+)\b",
            draft or "",
        )
    )
    checkbox = bool(re.search(
        r"(?:\[[xX\u2713\u2714]\]|[\u2611\u2713\u2714])|"
        r"\b(?:checkbox|option|angekreuzt|kästchen)\b",
        draft or "",
        re.IGNORECASE,
    ))
    domain = None
    for candidate, pattern in {
        "injection_moulding": r"\b(injection mould|spritzguss|spritzgie|V_Spritz)\b",
        "machining": r"\b(cutting speed|tool life|schnittgeschwindigkeit|standzeit|T_min)\b",
    }.items():
        if re.search(pattern, draft or "", re.IGNORECASE):
            domain = candidate
            break
    return DraftTaskIdentity(
        exercise_reference=exercise.group(1) if exercise else None,
        domain=domain,
        answered_quantities=list(dict.fromkeys(assignments)),
        answer_type="checkbox" if checkbox else "narrative",
    )


def task_aware_cache_key(
    *,
    task_type: str,
    identity: GroundedTaskIdentity | None,
    active_document: str | None,
    visible_page: int | None,
    document_revision: str | None,
    visible_page_text: str,
    image_hashes: list[str],
    task_traits: TaskTraits | None = None,
) -> str:
    payload: dict[str, Any] = {
        "taskType": task_type,
        "taskIdentityHash": identity.fingerprint() if identity else None,
        "activeDocument": active_document,
        "visiblePage": visible_page,
        "documentRevision": document_revision,
        "visiblePageTextHash": hashlib.sha256(visible_page_text.encode()).hexdigest(),
        "imageHashes": image_hashes,
        "taskTraits": (
            {
                **asdict(task_traits),
                "visual_kind": task_traits.visual_kind.value,
                "calculation_context": (
                    task_traits.calculation_context.value
                    if task_traits.calculation_context else None
                ),
            }
            if task_traits else None
        ),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


__all__ = [
    "AllowedMappingLabel",
    "AnswerObligationType",
    "ClassifiedNumber",
    "CalculationContext",
    "CheckboxGeometry",
    "AnswerObligation",
    "DraftTaskIdentity",
    "DerivedGroundingState",
    "GroundedTaskIdentity",
    "GroundedTaskKind",
    "GroundedFieldEvidence",
    "GroundedRequestContext",
    "GroundingMismatch",
    "IdentityComparisonState",
    "IdentityEvidenceSource",
    "IdentityResolutionMethod",
    "LayoutTextSpan",
    "NumberRole",
    "TaskTraits",
    "RetrievalScope",
    "RepairedAnswerValidation",
    "VisualTaskKind",
    "VisualIdentityBinding",
    "ParsedQuantity",
    "VisibleAnswerOption",
    "assess_text_quality",
    "answer_obligations",
    "build_retrieval_scope",
    "bind_visual_identity",
    "build_allowed_mapping_labels",
    "classify_number_roles",
    "classify_task_traits",
    "compare_task_identities",
    "derive_grounding_state",
    "evidence_requirement",
    "extract_text_visible_options",
    "identify_draft_task",
    "identify_grounded_task",
    "identity_is_sufficient",
    "is_page_bound_request",
    "merge_grounded_task_identity",
    "normalise_legacy_task_kind",
    "parse_engineering_quantities",
    "numerical_role_metadata",
    "pair_coordinate_answer_options",
    "selected_result_matches_visible_option",
    "source_label_matches",
    "task_aware_cache_key",
    "validate_repaired_answer",
]
