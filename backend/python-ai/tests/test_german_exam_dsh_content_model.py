"""DSH open-answer model, WS answer families and the LV<->WS source binding.

Hand-written fixtures only — nothing here generates content or calls a model. These prove the data model
keeps the three grading modes apart (HV/LV content, WS language correctness, TP content+language) and
that a WS bundle can only ever belong to the LV text it quotes."""

from __future__ import annotations

from fractions import Fraction

import pytest

from app.services.german_exams import GermanExamProfileError, get_part
from app.services.german_exams.dsh_content_model import (
    GRADING_CONTENT, GRADING_CONTENT_AND_LANGUAGE, GRADING_LANGUAGE, GRADING_ORAL, AnswerFamily, ContentPoint,
    DshContentError, DshSourceMismatch, OpenAnswerItem, StructureItem, grading_mode_for_module, match_answer_family,
    score_content_item, score_structure_item, source_fingerprint, validate_dsh_task_content, validate_hv_content,
    validate_lv_content, validate_lv_ws_bundle, validate_tp_content,
)

LV_PART = get_part("dsh", "reading", "lv_1")
HV_PART = get_part("dsh", "listening", "hv_1")
TP_PART = get_part("dsh", "writing", "tp_1")
WS_PART = get_part("dsh", "scientific_structures", "ws_1")

SENTENCE = "Die Untersuchung wurde von den Forschenden durchgeführt, weil die Datenlage unklar war."
LV_TEXT = (SENTENCE + " ") * 60  # ~5,300 chars: inside 4,500..6,000
assert 4500 <= len(LV_TEXT) <= 6000


def _points() -> tuple[ContentPoint, ...]:
    return (ContentPoint("p1", "Ursache", Fraction(2)), ContentPoint("p2", "Folge", Fraction(2)))


def _lv(text: str = LV_TEXT, source_id: str = "src-1") -> dict:
    item = {"requiredPoints": ["p1"]}
    return {"sourceId": source_id, "source": {"text": text}, "tasks": [{"form": "questions", "items": [item]}]}


def _ws(lv: dict, start: int = 0, end: int = len(SENTENCE), **over) -> dict:
    text = lv["source"]["text"]
    ws = {"sourceRef": {"sourceId": lv["sourceId"], "sha256": source_fingerprint(text)},
          "items": [{"itemId": "w1", "sourceSpan": {"start": start, "end": end}, "sourceSentence": text[start:end]}]}
    ws.update(over)
    return ws


# ---- grading modes stay separate ---------------------------------------------------------------
def test_grading_modes_per_module_are_the_official_ones() -> None:
    assert grading_mode_for_module("listening") == grading_mode_for_module("reading") == GRADING_CONTENT
    assert grading_mode_for_module("scientific_structures") == GRADING_LANGUAGE
    assert grading_mode_for_module("writing") == GRADING_CONTENT_AND_LANGUAGE
    assert grading_mode_for_module("speaking") == GRADING_ORAL


def test_content_items_can_never_penalise_language() -> None:
    with pytest.raises(DshContentError):
        OpenAnswerItem("i", "questions", "Warum?", Fraction(2), _points(), assess_language=True)
    item = OpenAnswerItem("i", "questions", "Warum?", Fraction(2), _points())
    assert item.grading_mode == GRADING_CONTENT and item.assess_language is False


def test_content_score_takes_no_answer_text_and_is_capped() -> None:
    item = OpenAnswerItem("i", "questions", "Warum?", Fraction(3), _points(), optional_points=(ContentPoint("o1", "Beispiel", Fraction(1)),))
    assert score_content_item(item, []) == 0
    assert score_content_item(item, ["p1"]) == 2
    assert score_content_item(item, ["p1", "p2"]) == 3  # capped at max_points
    assert score_content_item(item, ["p1", "p1"]) == 2  # duplicates count once
    with pytest.raises(DshContentError):
        score_content_item(item, ["nope"])
    import inspect
    assert list(inspect.signature(score_content_item).parameters) == ["item", "matched_point_ids"]  # no learner text


def test_open_item_validation() -> None:
    with pytest.raises(DshContentError):
        OpenAnswerItem("i", "questions", "Warum?", Fraction(2), ())  # no required point
    with pytest.raises(DshContentError):
        OpenAnswerItem("i", "questions", "Warum?", Fraction(9), _points())  # points cannot reach max
    with pytest.raises(DshContentError):
        OpenAnswerItem("i", "questions", "Warum?", Fraction(2), (ContentPoint("p", "a", Fraction(2)), ContentPoint("p", "b", Fraction(2))))
    with pytest.raises(DshContentError):
        ContentPoint("p", "a", Fraction(0))
    with pytest.raises(DshContentError):
        ContentPoint("", "a", Fraction(1))


# ---- WS answer families -------------------------------------------------------------------------
def _structure_item() -> StructureItem:
    return StructureItem(
        "w1", "transformation", "morphological", "Die Untersuchung der Daten ... -> Man untersucht die Daten.", (0, 40),
        (AnswerFamily("nominal", ("wird untersucht",)), AnswerFamily("active", ("man untersucht", "untersucht man"))), Fraction(2))


def test_several_answers_can_be_correct() -> None:
    item = _structure_item()
    assert item.grading_mode == GRADING_LANGUAGE
    assert match_answer_family(item, "  man   untersucht ") == "active"
    assert match_answer_family(item, "untersucht man") == "active"
    assert match_answer_family(item, "wird untersucht") == "nominal"
    assert score_structure_item(item, "wird untersucht") == {"points": Fraction(2), "familyId": "nominal", "needsAdjudication": False}


def test_ws_is_graded_on_correctness_so_case_is_kept_and_no_match_is_flagged_not_failed() -> None:
    item = _structure_item()
    assert match_answer_family(item, "Man untersucht") is None  # capitalisation is part of correctness
    miss = score_structure_item(item, "irgendwas anderes")
    assert miss["points"] == 0 and miss["needsAdjudication"] is True  # an unanticipated correct variant is not "wrong"


def test_families_must_be_unambiguous() -> None:
    with pytest.raises(DshContentError):
        StructureItem("w", "completion", "lexical", "p", (0, 5), (AnswerFamily("a", ("x",)), AnswerFamily("b", ("x",))), Fraction(1))
    with pytest.raises(DshContentError):
        StructureItem("w", "completion", "lexical", "p", (0, 5), (), Fraction(1))
    with pytest.raises(DshContentError):
        StructureItem("w", "completion", "lexical", "p", (5, 5), (AnswerFamily("a", ("x",)),), Fraction(1))
    with pytest.raises(DshContentError):
        AnswerFamily("a", ("",))


# ---- LV <-> WS source binding ----------------------------------------------------------------------
def test_a_ws_bundle_bound_to_its_own_lv_text_is_valid() -> None:
    lv = _lv()
    validate_lv_ws_bundle(lv, _ws(lv), LV_PART)


def test_ws_cannot_reference_a_different_lv_source_id() -> None:
    lv = _lv()
    ws = _ws(lv)
    ws["sourceRef"]["sourceId"] = "some-other-lv"
    with pytest.raises(DshSourceMismatch):
        validate_lv_ws_bundle(lv, ws, LV_PART)


def test_ws_cannot_reference_a_different_lv_text_even_with_the_same_id() -> None:
    lv_a = _lv(LV_TEXT)
    lv_b = _lv(LV_TEXT.replace("Untersuchung", "Erhebung"))
    ws_for_a = _ws(lv_a)
    with pytest.raises(DshSourceMismatch):
        validate_lv_ws_bundle(lv_b, ws_for_a, LV_PART)  # same sourceId "src-1", different text -> fingerprint differs


def test_ws_items_must_quote_the_lv_text_exactly() -> None:
    lv = _lv()
    ws = _ws(lv)
    ws["items"][0]["sourceSentence"] = "Ein Satz, der nicht im Lesetext steht."
    with pytest.raises(DshSourceMismatch):
        validate_lv_ws_bundle(lv, ws, LV_PART)
    ws = _ws(lv, start=0, end=len(LV_TEXT) + 10)
    with pytest.raises(DshSourceMismatch):
        validate_lv_ws_bundle(lv, ws, LV_PART)


def test_ws_without_a_source_reference_is_rejected() -> None:
    lv = _lv()
    with pytest.raises(DshSourceMismatch):
        validate_lv_ws_bundle(lv, {"items": [{}]}, LV_PART)


# ---- deterministic structural validators ------------------------------------------------------------
def test_lv_text_length_is_the_official_range() -> None:
    validate_lv_content(_lv(), LV_PART)
    for bad in ("kurz", "x" * 6001, "x" * 4499):
        with pytest.raises(DshContentError):
            validate_lv_content(_lv(bad), LV_PART)
    validate_lv_content(_lv("x" * 4500), LV_PART)
    validate_lv_content(_lv("x" * 6000), LV_PART)


def test_hv_lecture_length_and_task_forms() -> None:
    task = {"form": "structure_sketch", "items": [{"requiredPoints": ["a"]}]}
    validate_hv_content({"lectureText": "x" * 5500, "tasks": [task]}, HV_PART)
    validate_hv_content({"lectureText": "x" * 7000, "tasks": [task]}, HV_PART)
    for length in (5499, 7001):
        with pytest.raises(DshContentError):
            validate_hv_content({"lectureText": "x" * length, "tasks": [task]}, HV_PART)
    with pytest.raises(DshContentError):
        validate_hv_content({"lectureText": "x" * 6000, "tasks": [{"form": "multiple_choice", "items": [{"requiredPoints": ["a"]}]}]}, HV_PART)
    with pytest.raises(DshContentError):  # HV must not assess language
        validate_hv_content({"lectureText": "x" * 6000, "tasks": [{"form": "questions", "items": [{"requiredPoints": ["a"], "assessLanguage": True}]}]}, HV_PART)
    with pytest.raises(DshContentError):  # every item needs content points
        validate_hv_content({"lectureText": "x" * 6000, "tasks": [{"form": "questions", "items": [{"requiredPoints": []}]}]}, HV_PART)


def _tp(**over) -> dict:
    tp = {"inputs": [{"kind": "diagram"}, {"kind": "quotation"}], "languageActs": ["describe", "take_position"],
          "instructions": "Beschreiben Sie die Grafik und nehmen Sie zum Zitat Stellung.", "wordCountApprox": 250, "inputRefs": ["i1"]}
    tp.update(over)
    return tp


def test_tp_must_be_input_bound_and_not_a_free_essay() -> None:
    validate_tp_content(_tp(), TP_PART)
    for bad in (_tp(inputs=[]), _tp(inputs=[{"kind": "essay_topic"}]), _tp(languageActs=["narrate"]), _tp(languageActs=[]),
                _tp(instructions=" "), _tp(wordCountApprox=400), _tp(inputRefs=[])):
        with pytest.raises(DshContentError):
            validate_tp_content(bad, TP_PART)


def test_dispatcher_routes_by_task_type_and_refuses_the_rest() -> None:
    validate_dsh_task_content(TP_PART.task_type, _tp(), TP_PART)
    with pytest.raises(DshContentError):
        validate_dsh_task_content(WS_PART.task_type, {}, WS_PART)  # WS is validated with its LV
    with pytest.raises(DshContentError):
        validate_dsh_task_content("cloze_mc4_language_elements", {}, TP_PART)  # another exam's type
    with pytest.raises(DshContentError):
        validate_dsh_task_content(LV_PART.task_type, _lv(), TP_PART)  # part/type mismatch
    with pytest.raises(NotImplementedError):
        validate_dsh_task_content("dsh_oral_presentation_conversation", {}, get_part("dsh", "speaking", "sprechen_1"))


def test_errors_are_engine_errors() -> None:
    assert issubclass(DshContentError, GermanExamProfileError) and issubclass(DshSourceMismatch, DshContentError)
