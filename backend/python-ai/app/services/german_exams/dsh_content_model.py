"""DSH content model and deterministic validators — data shapes only, no generation, no grading calls.

Three grading modes stay structurally separate (MPO §10(4), 2025):

  * HV / LV  -> CONTENT   (`OpenAnswerItem`, `score_content_item`): scored from content points a
                          grader decided were present. The scoring function does not receive the
                          learner's text at all, so grammar/spelling cannot influence it.
  * WS       -> LANGUAGE CORRECTNESS (`StructureItem`, `score_structure_item`): scored against
                          answer FAMILIES (several linguistically valid answers per item).
  * TP       -> CONTENT + LANGUAGE (rubric groups in dsh.py; language weighted higher).

An LLM/human grader that decides *which* content points a learner answer covers is FUTURE WORK; the
shapes here are what it will fill in.

LV and WS share ONE source text (`validate_lv_ws_bundle`): a WS bundle is bound to its LV bundle by
`sourceId` + a SHA-256 fingerprint of the text, and every WS item quotes the exact LV span it is about.
"""

from __future__ import annotations

import hashlib
import unicodedata
from dataclasses import dataclass
from fractions import Fraction
from typing import Any, Mapping

from .dsh import (
    ASSESSMENT,
    DSH_TASK_TYPES,
    TASK_TYPE_HV,
    TASK_TYPE_LV,
    TASK_TYPE_ORAL,
    TASK_TYPE_TP,
    TASK_TYPE_WS,
)
from .shared import GermanExamProfileError, PartBlueprint

GRADING_CONTENT = "content"
GRADING_LANGUAGE = "language_correctness"
GRADING_CONTENT_AND_LANGUAGE = "content_and_language"
GRADING_ORAL = "oral_rubric"
GRADING_MODES = (GRADING_CONTENT, GRADING_LANGUAGE, GRADING_CONTENT_AND_LANGUAGE, GRADING_ORAL)


class DshContentError(GermanExamProfileError):
    """Structurally invalid DSH content (a deterministic validation failure)."""


class DshSourceMismatch(DshContentError):
    """A WS bundle does not belong to the given LV source text."""


def _num(value: Any, label: str) -> Fraction:
    if isinstance(value, bool) or not isinstance(value, (int, float, Fraction)):
        raise DshContentError(f"{label} must be a number")
    fraction = Fraction(str(value)) if isinstance(value, float) else Fraction(value)
    if fraction <= 0:
        raise DshContentError(f"{label} must be positive")
    return fraction


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DshContentError(f"{label} must be a non-empty string")
    return value


# ---- Content-graded open answers (HV / LV) ---------------------------------------------------
@dataclass(frozen=True)
class ContentPoint:
    """One idea an answer may contain. `alternatives` are other acceptable ways to express it
    (content-level paraphrases for the grader), never spelling variants."""

    point_id: str
    description: str
    points: Fraction
    alternatives: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _text(self.point_id, "point_id")
        _text(self.description, "description")
        object.__setattr__(self, "points", _num(self.points, f"points of {self.point_id}"))
        if any(not isinstance(a, str) or not a.strip() for a in self.alternatives):
            raise DshContentError(f"{self.point_id}: alternatives must be non-empty strings")


@dataclass(frozen=True)
class OpenAnswerItem:
    """question / accepted content points (required + optional) / score / grading notes."""

    item_id: str
    task_form: str
    question: str
    max_points: Fraction
    required_points: tuple[ContentPoint, ...]
    optional_points: tuple[ContentPoint, ...] = ()
    grading_notes: str = ""
    # HV/LV are content-only (§10(4)1d, 2c). Constructing an item that penalises language is an error.
    assess_language: bool = False

    def __post_init__(self) -> None:
        _text(self.item_id, "item_id")
        _text(self.task_form, "task_form")
        _text(self.question, "question")
        object.__setattr__(self, "max_points", _num(self.max_points, "max_points"))
        if self.assess_language:
            raise DshContentError(f"{self.item_id}: HV/LV items are assessed on content, never on language")
        if not self.required_points:
            raise DshContentError(f"{self.item_id}: at least one required content point is needed")
        ids = [p.point_id for p in self.required_points + self.optional_points]
        if len(set(ids)) != len(ids):
            raise DshContentError(f"{self.item_id}: duplicate content point ids")
        if sum((p.points for p in self.required_points + self.optional_points), Fraction(0)) < self.max_points:
            raise DshContentError(f"{self.item_id}: content points cannot reach max_points")

    @property
    def grading_mode(self) -> str:
        return GRADING_CONTENT


def score_content_item(item: OpenAnswerItem, matched_point_ids: Any) -> Fraction:
    """Deterministic content score from the ids a grader judged present. Takes NO answer text."""
    by_id = {p.point_id: p for p in item.required_points + item.optional_points}
    matched = set(matched_point_ids)
    unknown = matched - set(by_id)
    if unknown:
        raise DshContentError(f"{item.item_id}: unknown content points {sorted(unknown)}")
    return min(item.max_points, sum((by_id[i].points for i in matched), Fraction(0)))


# ---- Language-graded structure items (WS) ----------------------------------------------------
@dataclass(frozen=True)
class AnswerFamily:
    """A group of interchangeable, linguistically correct answers to one WS item."""

    family_id: str
    accepted: tuple[str, ...]
    note: str = ""

    def __post_init__(self) -> None:
        _text(self.family_id, "family_id")
        if not self.accepted or any(not isinstance(a, str) or not a.strip() for a in self.accepted):
            raise DshContentError(f"{self.family_id}: accepted answers must be non-empty strings")


def normalize_answer(value: str) -> str:
    """Whitespace/Unicode normalisation only. Case and punctuation are kept: WS is graded on
    linguistic correctness, and German capitalisation and punctuation are part of it."""
    return " ".join(unicodedata.normalize("NFKC", value).split())


@dataclass(frozen=True)
class StructureItem:
    item_id: str
    task_form: str
    structure_category: str
    prompt: str
    source_span: tuple[int, int]  # [start, end) into the LV text this item is about
    families: tuple[AnswerFamily, ...]
    max_points: Fraction

    def __post_init__(self) -> None:
        _text(self.item_id, "item_id")
        _text(self.prompt, "prompt")
        object.__setattr__(self, "max_points", _num(self.max_points, "max_points"))
        start, end = self.source_span
        if not (isinstance(start, int) and isinstance(end, int)) or start < 0 or end <= start:
            raise DshContentError(f"{self.item_id}: invalid source span")
        if not self.families:
            raise DshContentError(f"{self.item_id}: at least one answer family is required")
        seen: dict[str, str] = {}
        for family in self.families:
            for answer in family.accepted:
                key = normalize_answer(answer)
                if key in seen and seen[key] != family.family_id:
                    raise DshContentError(f"{self.item_id}: {answer!r} is in two answer families")
                seen[key] = family.family_id

    @property
    def grading_mode(self) -> str:
        return GRADING_LANGUAGE


def match_answer_family(item: StructureItem, given: str) -> str | None:
    key = normalize_answer(given)
    for family in item.families:
        if any(normalize_answer(a) == key for a in family.accepted):
            return family.family_id
    return None


def score_structure_item(item: StructureItem, given: str) -> dict[str, Any]:
    """Full marks for an accepted family. NO match is NOT a verdict of 'wrong': the answer may be
    a correct variant the key did not anticipate, so it is flagged for (future) adjudication."""
    family = match_answer_family(item, given)
    if family is not None:
        return {"points": item.max_points, "familyId": family, "needsAdjudication": False}
    return {"points": Fraction(0), "familyId": None, "needsAdjudication": True}


# ---- Source binding (LV -> WS) ---------------------------------------------------------------
def source_fingerprint(text: str) -> str:
    return hashlib.sha256(normalize_answer(text).encode("utf-8")).hexdigest()


def _length_in_range(text: str, low: int, high: int, label: str) -> None:
    length = len(text)
    if length < low or length > high:
        raise DshContentError(f"{label}: {length} characters is outside the official {low}-{high}")


def validate_lv_ws_bundle(lv: Mapping[str, Any], ws: Mapping[str, Any], lv_part: PartBlueprint) -> None:
    """A WS bundle must belong to THIS LV text: same sourceId, same fingerprint, and every item
    quotes exactly the LV span it points at. Raises DshSourceMismatch otherwise."""
    validate_lv_content(lv, lv_part)
    ref = ws.get("sourceRef")
    if not isinstance(ref, Mapping):
        raise DshSourceMismatch("WS content has no sourceRef to an LV text")
    text = lv["source"]["text"]
    if ref.get("sourceId") != lv["sourceId"]:
        raise DshSourceMismatch("WS sourceId does not match the LV sourceId")
    if ref.get("sha256") != source_fingerprint(text):
        raise DshSourceMismatch("WS fingerprint does not match the LV text")
    items = ws.get("items")
    if not isinstance(items, list) or not items:
        raise DshContentError("WS content needs items")
    for item in items:
        span = item.get("sourceSpan") or {}
        start, end = span.get("start"), span.get("end")
        if not (isinstance(start, int) and isinstance(end, int)) or not 0 <= start < end <= len(text):
            raise DshSourceMismatch(f"{item.get('itemId')}: source span is outside the LV text")
        if text[start:end] != item.get("sourceSentence"):
            raise DshSourceMismatch(f"{item.get('itemId')}: quoted sentence is not the LV text at that span")


# ---- Structural validators per task type (content dicts a future generator must produce) ------
def _check_task_forms(tasks: Any, allowed: tuple[str, ...], label: str) -> None:
    if not isinstance(tasks, list) or not tasks:
        raise DshContentError(f"{label}: at least one task is required")
    for task in tasks:
        if task.get("form") not in allowed:
            raise DshContentError(f"{label}: task form {task.get('form')!r} is not an official form")
        items = task.get("items")
        if not isinstance(items, list) or not items:
            raise DshContentError(f"{label}: a task needs items")
        for item in items:
            if item.get("assessLanguage") is True:
                raise DshContentError(f"{label}: HV/LV items must not assess language")
            if not item.get("requiredPoints"):
                raise DshContentError(f"{label}: every item needs required content points")


def validate_hv_content(content: Mapping[str, Any], part: PartBlueprint) -> None:
    c = part.constraints
    _length_in_range(_text(content.get("lectureText"), "lectureText"), c["lectureCharsMin"], c["lectureCharsMax"], "HV lecture")
    _check_task_forms(content.get("tasks"), c["taskForms"], "HV")


def validate_lv_content(content: Mapping[str, Any], part: PartBlueprint) -> None:
    c = part.constraints
    _text(content.get("sourceId"), "sourceId")
    source = content.get("source")
    if not isinstance(source, Mapping):
        raise DshContentError("LV content needs a source")
    _length_in_range(_text(source.get("text"), "source.text"), c["textCharsMin"], c["textCharsMax"], "LV text")
    if source.get("graphic") is not None and not c.get("optionalGraphic"):
        raise DshContentError("LV graphic is not allowed")
    _check_task_forms(content.get("tasks"), c["taskForms"], "LV")


def validate_tp_content(content: Mapping[str, Any], part: PartBlueprint) -> None:
    c = part.constraints
    inputs = content.get("inputs")
    if not isinstance(inputs, list) or not inputs:
        raise DshContentError("TP needs at least one input (chart, table, keywords, quotation ...)")
    for entry in inputs:
        if entry.get("kind") not in c["inputKinds"]:
            raise DshContentError(f"TP input kind {entry.get('kind')!r} is not an official input")
    acts = content.get("languageActs")
    if not isinstance(acts, list) or not acts or any(a not in c["languageActs"] for a in acts):
        raise DshContentError("TP needs official language acts")
    _text(content.get("instructions"), "instructions")
    if content.get("wordCountApprox") != c["wordCountApprox"]:
        raise DshContentError("TP wordCountApprox must be the official approximate 250")
    # Not a free essay: the task must be anchored in the given inputs.
    refs = content.get("inputRefs")
    if not isinstance(refs, list) or not refs:
        raise DshContentError("TP must reference its inputs (it may not be a free essay)")


def validate_dsh_task_content(task_type: str, content: Mapping[str, Any], part: PartBlueprint) -> None:
    """Deterministic structural validation. WS is validated with its LV via validate_lv_ws_bundle."""
    if task_type not in DSH_TASK_TYPES:
        raise DshContentError(f"{task_type!r} is not a DSH task type")
    if part.task_type != task_type:
        raise DshContentError("part and task type do not match")
    if task_type == TASK_TYPE_HV:
        validate_hv_content(content, part)
    elif task_type == TASK_TYPE_LV:
        validate_lv_content(content, part)
    elif task_type == TASK_TYPE_TP:
        validate_tp_content(content, part)
    elif task_type == TASK_TYPE_WS:
        raise DshContentError("WS content is validated together with its LV: use validate_lv_ws_bundle")
    elif task_type == TASK_TYPE_ORAL:
        raise NotImplementedError("DSH oral content validation is not implemented")


def grading_mode_for_module(module: str) -> str:
    return ASSESSMENT[module]
