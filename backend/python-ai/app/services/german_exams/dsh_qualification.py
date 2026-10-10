"""Provider-agnostic qualification gates for DSH content — the tests AI-generated content must pass.

Nothing here talks to a model. The two AI-dependent judgements are INJECTED callables, so the same gates run
today against deterministic fakes (offline tests) and later against a real model without changing a line here:

    blind_solver(item)                              -> the answer a solver gives to a WS item WITHOUT the key
    content_matcher(question, answer, points)       -> the ids of the content points the answer covers

A gate is "passed", "failed" or "skipped". A gate that needs an injected judgement but got none is SKIPPED,
never passed: a report is `qualified` only when every gate ran and passed. Even `qualified` is only the
automated part of content qualification; manual review and live UI validation are still required before any
DSH part may be made available, so nothing here can flip an availability flag.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Any

from .dsh_content_model import (
    AnswerFamily,
    ContentPoint,
    DshContentError,
    OpenAnswerItem,
    StructureItem,
    match_answer_family,
    normalize_answer,
    score_content_item,
    validate_lv_content,
    validate_lv_ws_bundle,
    validate_tp_content,
    validate_dsh_task_content,
)
from .dsh import written_topic_set_is_valid
from .shared import PartBlueprint

BlindSolver = Callable[[Mapping[str, Any]], str]
ContentMatcher = Callable[[str, str, Sequence[ContentPoint]], "set[str]"]

PASSED, FAILED, SKIPPED = "passed", "failed", "skipped"

# TP prompts that make the task a free essay (MPO §10(4)3a forbids it). A heuristic, deliberately narrow:
# a hit is a definite failure, a miss is NOT proof of quality (semantic review still applies).
FREE_ESSAY_MARKERS = ("aufsatz", "freier text", "schreiben sie alles", "erzählen sie frei", "was denken sie über")
LANGUAGE_ACT_STEMS = ("beschreib", "darstell", "vergleich", "erläuter", "begründ", "bewert", "stellung", "zusammenfass", "erklär")


@dataclass
class QualificationReport:
    subject: str
    gates: list[dict[str, str]] = field(default_factory=list)

    def add(self, name: str, status: str, detail: str = "") -> None:
        self.gates.append({"name": name, "status": status, "detail": detail})

    def gate(self, name: str, check: Callable[[], str | None]) -> None:
        """Run a deterministic check; a DshContentError (or any ValueError) becomes a FAILED gate."""
        try:
            self.add(name, PASSED, check() or "")
        except (DshContentError, ValueError, KeyError, TypeError) as exc:
            self.add(name, FAILED, str(exc) or type(exc).__name__)

    @property
    def failed(self) -> list[str]:
        return [g["name"] for g in self.gates if g["status"] == FAILED]

    @property
    def skipped(self) -> list[str]:
        return [g["name"] for g in self.gates if g["status"] == SKIPPED]

    @property
    def status(self) -> str:
        if self.failed:
            return "failed"
        return "incomplete" if self.skipped else "qualified"


def _structure_item(raw: Mapping[str, Any]) -> StructureItem:
    return StructureItem(
        item_id=raw["itemId"], task_form=raw["form"], structure_category=raw["category"], prompt=raw["prompt"],
        source_span=(raw["sourceSpan"]["start"], raw["sourceSpan"]["end"]),
        families=tuple(AnswerFamily(f["familyId"], tuple(f["accepted"]), f.get("note", "")) for f in raw["families"]),
        max_points=Fraction(str(raw["maxPoints"])),
    )


def _points(raw: Sequence[Mapping[str, Any]]) -> tuple[ContentPoint, ...]:
    return tuple(ContentPoint(p["pointId"], p["description"], Fraction(str(p["points"])), tuple(p.get("alternatives", ()))) for p in raw)


def open_item(raw: Mapping[str, Any], task_form: str) -> OpenAnswerItem:
    return OpenAnswerItem(
        item_id=raw["itemId"], task_form=task_form, question=raw["question"], max_points=Fraction(str(raw["maxPoints"])),
        required_points=_points(raw["requiredPoints"]), optional_points=_points(raw.get("optionalPoints", ())),
        grading_notes=raw.get("gradingNotes", ""), assess_language=bool(raw.get("assessLanguage", False)),
    )


# ---- LV + WS -----------------------------------------------------------------------------------
def qualify_lv_ws(lv: Mapping[str, Any], ws: Mapping[str, Any], lv_part: PartBlueprint, ws_part: PartBlueprint,
                  *, blind_solver: BlindSolver | None = None) -> QualificationReport:
    report = QualificationReport("lv+ws")
    report.gate("lv_structure", lambda: validate_lv_content(lv, lv_part))
    report.gate("source_binding", lambda: validate_lv_ws_bundle(lv, ws, lv_part))

    items: list[StructureItem] = []

    def well_formed() -> str:
        allowed_forms, allowed_categories = ws_part.constraints["taskForms"], ws_part.constraints["structureCategories"]
        for raw in ws["items"]:
            if raw["form"] not in allowed_forms:
                raise DshContentError(f"{raw['itemId']}: {raw['form']!r} is not an official WS task form")
            if raw["category"] not in allowed_categories:
                raise DshContentError(f"{raw['itemId']}: {raw['category']!r} is not an official WS structure category")
            items.append(_structure_item(raw))
        return f"{len(items)} items"

    report.gate("ws_items_well_formed", well_formed)

    def key_not_leaked() -> None:
        for item in items:
            for family in item.families:
                for answer in family.accepted:
                    if len(answer) > 3 and normalize_answer(answer) in normalize_answer(item.prompt):
                        raise DshContentError(f"{item.item_id}: the prompt already contains the answer {answer!r}")

    report.gate("ws_key_not_leaked_in_prompt", key_not_leaked)

    if blind_solver is None:
        report.add("ws_blind_solver", SKIPPED, "no blind solver supplied")
        return report
    if len(items) != len(ws.get("items") or ()):
        report.add("ws_blind_solver", SKIPPED, "blocked: the items are not well formed")
        return report

    # The solver sees the task exactly as a candidate does: the prompt and nothing else. The key (`families`) and
    # the bookkeeping that quotes the source sentence (`sourceSentence`, `sourceSpan`) stay hidden — for a completion
    # item the quoted sentence IS the answer. (Stricter than the exam, where the candidate also has the LV text,
    # so passing this gate is harder, never easier.)
    hidden = {"families", "sourceSentence", "sourceSpan"}

    def solve() -> str:
        misses = []
        for raw in ws["items"]:
            blind = {k: v for k, v in raw.items() if k not in hidden}
            item = next(i for i in items if i.item_id == raw["itemId"])
            if match_answer_family(item, blind_solver(blind)) is None:
                misses.append(item.item_id)
        if misses:
            raise DshContentError(f"blind solver disagrees with the key on {misses}")
        return f"{len(items)}/{len(items)} solved"

    report.gate("ws_blind_solver", solve)
    return report


# ---- HV / LV open tasks ----------------------------------------------------------------------------
def qualify_open_tasks(content: Mapping[str, Any], part: PartBlueprint,
                       *, content_matcher: ContentMatcher | None = None) -> QualificationReport:
    report = QualificationReport(f"open-tasks:{part.part_id}")
    report.gate("structure", lambda: validate_dsh_task_content(part.task_type, content, part))
    items: list[tuple[OpenAnswerItem, Mapping[str, Any]]] = []

    def well_formed() -> str:
        for task in content["tasks"]:
            for raw in task["items"]:
                if not str(raw.get("referenceAnswer", "")).strip():
                    raise DshContentError(f"{raw['itemId']}: a reference answer is required to validate the key")
                items.append((open_item(raw, task["form"]), raw))
        return f"{len(items)} items"

    report.gate("items_well_formed", well_formed)

    if content_matcher is None:
        for name in ("grading_reference_reaches_full_marks", "grading_empty_answer_scores_zero", "grading_ignores_language_errors"):
            report.add(name, SKIPPED, "no content matcher supplied")
        return report

    def all_points(item: OpenAnswerItem) -> tuple[ContentPoint, ...]:
        return item.required_points + item.optional_points

    def reference_full_marks() -> str:
        for item, raw in items:
            got = score_content_item(item, content_matcher(item.question, raw["referenceAnswer"], all_points(item)))
            if got < item.max_points:
                raise DshContentError(f"{item.item_id}: the reference answer only reaches {got}/{item.max_points}")
        return "reference answers reach full marks"

    def empty_scores_zero() -> str:
        for item, _ in items:
            if score_content_item(item, content_matcher(item.question, "", all_points(item))) != 0:
                raise DshContentError(f"{item.item_id}: an empty answer must not score")
        return "empty answers score 0"

    def language_errors_ignored() -> str | None:
        checked = 0
        for item, raw in items:
            variant = raw.get("errorfulVariant")
            if not variant:
                continue
            checked += 1
            a = content_matcher(item.question, raw["referenceAnswer"], all_points(item))
            b = content_matcher(item.question, variant, all_points(item))
            if a != b:  # HV/LV are content-graded (§10(4)1d, 2c): errors of form must not change the result
                raise DshContentError(f"{item.item_id}: language errors changed the content score")
        if not checked:
            raise DshContentError("no item supplies an errorful variant, so language-independence is unproven")
        return f"{checked} variants"

    report.gate("grading_reference_reaches_full_marks", reference_full_marks)
    report.gate("grading_empty_answer_scores_zero", empty_scores_zero)
    report.gate("grading_ignores_language_errors", language_errors_ignored)
    return report


# ---- TP and topics ----------------------------------------------------------------------------------
def qualify_tp(tp: Mapping[str, Any], part: PartBlueprint) -> QualificationReport:
    report = QualificationReport("tp")
    report.gate("structure", lambda: validate_tp_content(tp, part))

    def not_free_essay() -> None:
        text = str(tp.get("instructions", "")).lower()
        hit = next((m for m in FREE_ESSAY_MARKERS if m in text), None)
        if hit:
            raise DshContentError(f"instructions read like a free essay ({hit!r})")
        if not any(stem in text for stem in LANGUAGE_ACT_STEMS):
            raise DshContentError("instructions name no language act (describe, compare, justify, evaluate ...)")
        if len(text) < 40:
            raise DshContentError("instructions are too short to constrain the text")

    report.gate("prompt_is_not_a_free_essay", not_free_essay)
    return report


def qualify_topics(hv_topic_id: str, lv_topic_id: str, tp_topic_id: str) -> QualificationReport:
    report = QualificationReport("topics")

    def two_areas() -> None:
        if not written_topic_set_is_valid(hv_topic_id, lv_topic_id, tp_topic_id):
            raise DshContentError("the written sub-tests need >= 2 topic areas and no repeated topic")

    report.gate("two_topic_areas_no_repeats", two_areas)
    return report
