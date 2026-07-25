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


@dataclass(frozen=True)
class TaskTraits:
    visual_kind: VisualTaskKind
    requires_visual_evidence: bool
    requires_spatial_reasoning: bool
    requires_numerical_validation: bool
    requires_complete_mapping: bool
    requires_pre_display_verification: bool
    allows_text_fallback: bool


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
    r"\b(label(?:led)? diagram|callouts?|numbers?\s+\d+\s*(?:to|-|–)\s*\d+|"
    r"beschrifte|zuordnen|ziffern?\s+\d+\s*(?:bis|-|–)\s*\d+)\b",
    re.IGNORECASE,
)
_DIAGRAM_RE = re.compile(r"\b(diagram|drawing|figure|sketch|abbildung|zeichnung)\b", re.IGNORECASE)
_FORMULA_RE = re.compile(r"\b(formula|equation|symbol|variable|formel|gleichung)\b", re.IGNORECASE)
_TRANSCRIBE_RE = re.compile(r"\b(transcribe|read exactly|abschreiben|wortlaut)\b", re.IGNORECASE)


def classify_task_traits(question: str) -> TaskTraits:
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
        return TaskTraits(
            VisualTaskKind.NUMERICAL_CALCULATION, True, True, True, False, True, True,
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
    exercise_reference: str | None = None
    domain: str | None = None
    requested_quantities: list[str] = field(default_factory=list)
    task_kind: str = "short_answer"
    visible_values: list[str] = field(default_factory=list)
    visible_answer_options: list[str] = field(default_factory=list)
    source_confidence: float = 0.0

    def fingerprint(self) -> str:
        payload = json.dumps(asdict(self), sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


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


def compare_task_identities(
    source: GroundedTaskIdentity,
    draft: DraftTaskIdentity,
) -> list[GroundingMismatch]:
    mismatches: list[GroundingMismatch] = []
    if source.exercise_reference and draft.exercise_reference:
        if source.exercise_reference.casefold() != draft.exercise_reference.casefold():
            mismatches.append(GroundingMismatch.EXERCISE_REFERENCE)
    if source.domain and draft.domain and source.domain.casefold() != draft.domain.casefold():
        mismatches.append(GroundingMismatch.DOMAIN)
    requested = {item.casefold() for item in source.requested_quantities}
    answered = {item.casefold() for item in draft.answered_quantities}
    if requested and answered and not requested.intersection(answered):
        mismatches.append(GroundingMismatch.REQUESTED_QUANTITY)
    if source.task_kind.startswith("checkbox") and draft.answer_type:
        if "checkbox" not in draft.answer_type.casefold() and "option" not in draft.answer_type.casefold():
            mismatches.append(GroundingMismatch.ANSWER_TYPE)
    return mismatches


_EXERCISE_REFERENCE_RE = re.compile(
    r"\b(?:Aufgabe|Exercise|Question|Problem)?\s*(\d+(?:\.\d+)+)\b",
    re.IGNORECASE,
)
_ASSIGNMENT_VALUE_RE = re.compile(
    r"\b([A-Za-z][A-Za-z0-9_{}]*)\s*=\s*"
    r"([+\-−]?\d+(?:[.,]\d+)?\s*(?:mm|cm|m|s|min|N|Pa|MPa|cm[³3]|mm[²³23])?)",
    re.IGNORECASE,
)


def identify_grounded_task(
    *,
    question: str,
    current_page_text: str,
    document_id: str | None,
    filename: str | None,
    page: int | None,
    traits: TaskTraits | None = None,
) -> GroundedTaskIdentity:
    """Resolve task identity from active-document evidence before retrieval."""
    evidence = "\n".join([question or "", current_page_text or ""])
    exercise = _EXERCISE_REFERENCE_RE.search(evidence)
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
        VisualTaskKind.NUMERICAL_CALCULATION: "calculation",
        VisualTaskKind.CHECKBOX_EXTRACTION: "checkbox_calculation",
        VisualTaskKind.LABELLED_DIAGRAM: "diagram_labelling",
        VisualTaskKind.TECHNICAL_DRAWING_MAPPING: "matching",
        VisualTaskKind.TEXT_EXPLANATION: "explanation",
        VisualTaskKind.FORMULA_EXPLANATION: "explanation",
        VisualTaskKind.DIAGRAM_EXPLANATION: "explanation",
    }
    confidence_parts = [
        bool(document_id),
        bool(page),
        bool(exercise),
        bool((current_page_text or "").strip()),
    ]
    return GroundedTaskIdentity(
        document_id=document_id,
        filename=filename,
        page=page,
        exercise_reference=exercise.group(1) if exercise else None,
        domain=domain,
        requested_quantities=list(dict.fromkeys(requested)),
        task_kind=kind_map.get(visual_traits.visual_kind, "short_answer"),
        visible_values=[match.group(0) for match in assignments],
        source_confidence=sum(confidence_parts) / len(confidence_parts),
    )


def identify_draft_task(draft: str) -> DraftTaskIdentity:
    exercise = _EXERCISE_REFERENCE_RE.search(draft or "")
    assignments = [match.group(1) for match in _ASSIGNMENT_VALUE_RE.finditer(draft or "")]
    checkbox = bool(re.search(r"\b(?:checkbox|option|angekreuzt|kästchen)\b", draft or "", re.I))
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
) -> str:
    payload: dict[str, Any] = {
        "taskType": task_type,
        "taskIdentityHash": identity.fingerprint() if identity else None,
        "activeDocument": active_document,
        "visiblePage": visible_page,
        "documentRevision": document_revision,
        "visiblePageTextHash": hashlib.sha256(visible_page_text.encode()).hexdigest(),
        "imageHashes": image_hashes,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


__all__ = [
    "ClassifiedNumber",
    "DraftTaskIdentity",
    "GroundedTaskIdentity",
    "GroundingMismatch",
    "NumberRole",
    "TaskTraits",
    "VisualTaskKind",
    "assess_text_quality",
    "classify_number_roles",
    "classify_task_traits",
    "compare_task_identities",
    "evidence_requirement",
    "identify_draft_task",
    "identify_grounded_task",
    "numerical_role_metadata",
    "task_aware_cache_key",
]
