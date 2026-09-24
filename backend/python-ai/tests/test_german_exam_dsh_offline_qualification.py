"""Offline qualification suite for AI-generated DSH content — no OpenAI, no network, no cost.

These are the tests a generated DSH task will have to pass. The two AI-dependent judgements (a blind solver for
WS, a content matcher for open-answer grading) are injected, and here they are deterministic fakes. Every gate is
exercised twice: golden content must pass, and a deliberately broken mutation must fail the RIGHT gate.
A tripwire on socket connections proves that nothing in this file can reach a provider."""

from __future__ import annotations

import json
import socket

import pytest

from app.services.german_exams import get_part
from app.services.german_exams.dsh_content_model import ContentPoint, score_content_item
from app.services.german_exams.dsh_qualification import (
    FAILED, PASSED, SKIPPED, open_item, qualify_lv_ws, qualify_open_tasks, qualify_topics, qualify_tp,
)
import dsh_golden_content as g

HV = get_part("dsh", "listening", "hv_1")
LV = get_part("dsh", "reading", "lv_1")
WS = get_part("dsh", "scientific_structures", "ws_1")
TP = get_part("dsh", "writing", "tp_1")


@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*a, **k):
        raise AssertionError("the offline qualification suite must never open a network connection")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)


# ---- deterministic stand-ins for the model ------------------------------------------------------------
REFERENCES = {raw["referenceAnswer"] for task in g.HV_CONTENT["tasks"] + g.LV_CONTENT["tasks"] for raw in task["items"]}


def keyword_matcher(question, answer, points):
    """A content matcher: a point counts when one of its stem keywords appears (content only, form ignored)."""
    text = answer.lower()
    return {p.point_id for p in points if any(alt.lower() in text for alt in p.alternatives)}


def lenient_matcher(question, answer, points):
    return {p.point_id for p in points}  # gives credit for anything, even an empty answer


def grammar_strict_matcher(question, answer, points):
    """A BAD content matcher: it punishes form. Only a model-perfect sentence earns credit."""
    return keyword_matcher(question, answer, points) if answer in REFERENCES else set()


def stingy_matcher(question, answer, points):
    return set()


class RecordingSolver:
    def __init__(self, answers):
        self.answers, self.seen = answers, []

    def __call__(self, item):
        self.seen.append(item)
        return self.answers[item["itemId"]]


def solver(**overrides):
    return RecordingSolver({**g.WS_SOLVER_ANSWERS, **overrides})


def statuses(report):
    return {gate["name"]: gate["status"] for gate in report.gates}


# ---- fixture sanity -------------------------------------------------------------------------------------
def test_golden_texts_are_inside_the_official_length_ranges() -> None:
    assert 4500 <= len(g.LV_TEXT) <= 6000
    assert 5500 <= len(g.HV_TEXT) <= 7000


# ---- LV + WS ------------------------------------------------------------------------------------------------
def test_golden_lv_and_ws_qualify_with_a_competent_blind_solver() -> None:
    report = qualify_lv_ws(g.LV_CONTENT, g.WS_CONTENT, LV, WS, blind_solver=solver())
    assert report.status == "qualified", report.gates
    assert set(statuses(report).values()) == {PASSED}


def test_without_a_solver_the_report_is_incomplete_never_qualified() -> None:
    report = qualify_lv_ws(g.LV_CONTENT, g.WS_CONTENT, LV, WS)
    assert report.status == "incomplete" and report.skipped == ["ws_blind_solver"] and report.failed == []


def test_the_blind_solver_never_sees_the_key() -> None:
    s = solver()
    qualify_lv_ws(g.LV_CONTENT, g.WS_CONTENT, LV, WS, blind_solver=s)
    assert [seen["itemId"] for seen in s.seen] == ["ws_1", "ws_2", "ws_3", "ws_4"]
    for seen in s.seen:
        assert not {"families", "sourceSentence", "sourceSpan"} & set(seen)
        blob = json.dumps(seen, ensure_ascii=False)
        for raw in g.WS_CONTENT["items"]:
            if raw["itemId"] == seen["itemId"]:
                for family in raw["families"]:
                    for answer in family["accepted"]:
                        assert answer not in blob, "the accepted answer leaked to the blind solver"


def test_a_solver_that_disagrees_with_the_key_fails_the_gate_and_names_the_item() -> None:
    report = qualify_lv_ws(g.LV_CONTENT, g.WS_CONTENT, LV, WS, blind_solver=solver(ws_3="Die Reparatur wird erschwert."))
    assert report.status == "failed" and report.failed == ["ws_blind_solver"]
    assert "ws_3" in next(x for x in report.gates if x["name"] == "ws_blind_solver")["detail"]


def test_a_second_valid_family_is_accepted_but_an_unlisted_variant_is_not() -> None:
    assert qualify_lv_ws(g.LV_CONTENT, g.WS_CONTENT, LV, WS, blind_solver=solver(ws_1="Weiterverwendung")).status == "qualified"
    assert qualify_lv_ws(g.LV_CONTENT, g.WS_CONTENT, LV, WS, blind_solver=solver(ws_4="Bedeutung")).failed == ["ws_blind_solver"]


@pytest.mark.parametrize("mutate,gate", [
    (lambda lv, ws: ws["sourceRef"].update(sourceId="another-text"), "source_binding"),
    (lambda lv, ws: ws["sourceRef"].update(sha256="0" * 64), "source_binding"),
    (lambda lv, ws: ws["items"][0].update(sourceSentence="Ein Satz, den der Lesetext nicht enthält."), "source_binding"),
    (lambda lv, ws: ws["items"][1]["sourceSpan"].update(end=10**6), "source_binding"),
    (lambda lv, ws: ws.pop("sourceRef"), "source_binding"),
    (lambda lv, ws: lv["source"].update(text=lv["source"]["text"][:1000]), "lv_structure"),
    (lambda lv, ws: lv["source"].update(text=lv["source"]["text"] * 2), "lv_structure"),
])
def test_lv_ws_structural_mutations_fail_the_right_gate(mutate, gate) -> None:
    lv, ws = g.fresh(g.LV_CONTENT), g.fresh(g.WS_CONTENT)
    mutate(lv, ws)
    report = qualify_lv_ws(lv, ws, LV, WS, blind_solver=solver())
    assert gate in report.failed and report.status == "failed", report.gates


@pytest.mark.parametrize("mutate", [
    lambda ws: ws["items"][0].update(category="pragmatic"),          # not an official structure category
    lambda ws: ws["items"][0].update(form="multiple_choice"),        # not an official WS task form
    lambda ws: ws["items"][0].update(families=[]),                   # no answer family
    lambda ws: ws["items"][3].update(families=[{"familyId": "a", "accepted": ["Rolle"]}, {"familyId": "b", "accepted": ["Rolle"]}]),
    lambda ws: ws["items"][0].update(maxPoints=0),
    lambda ws: ws["items"][0].update(prompt=" "),
])
def test_malformed_ws_items_fail_well_formedness(mutate) -> None:
    ws = g.fresh(g.WS_CONTENT)
    mutate(ws)
    report = qualify_lv_ws(g.LV_CONTENT, ws, LV, WS, blind_solver=solver())
    assert "ws_items_well_formed" in report.failed, report.gates


def test_a_prompt_that_contains_the_answer_is_a_leaked_key() -> None:
    ws = g.fresh(g.WS_CONTENT)
    ws["items"][0]["prompt"] += " (Lösung: Wiederverwendung)"
    assert "ws_key_not_leaked_in_prompt" in qualify_lv_ws(g.LV_CONTENT, ws, LV, WS, blind_solver=solver()).failed


# ---- HV / LV open tasks ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("part,content", [(HV, g.HV_CONTENT), (LV, g.LV_CONTENT)], ids=["hv", "lv"])
def test_golden_open_tasks_qualify_with_a_content_only_matcher(part, content) -> None:
    report = qualify_open_tasks(content, part, content_matcher=keyword_matcher)
    assert report.status == "qualified", report.gates
    assert len(report.gates) == 5


@pytest.mark.parametrize("part,content", [(HV, g.HV_CONTENT), (LV, g.LV_CONTENT)], ids=["hv", "lv"])
def test_without_a_matcher_grading_gates_are_skipped_not_passed(part, content) -> None:
    report = qualify_open_tasks(content, part)
    assert report.status == "incomplete"
    assert set(report.skipped) == {"grading_reference_reaches_full_marks", "grading_empty_answer_scores_zero", "grading_ignores_language_errors"}
    assert statuses(report)["structure"] == PASSED and statuses(report)["items_well_formed"] == PASSED


def test_a_lenient_matcher_is_caught_by_the_empty_answer_gate() -> None:
    report = qualify_open_tasks(g.HV_CONTENT, HV, content_matcher=lenient_matcher)
    assert report.failed == ["grading_empty_answer_scores_zero"]


def test_a_matcher_that_punishes_language_errors_is_caught() -> None:
    """HV/LV are graded on content, not on form (MPO §10(4)1d, 2c)."""
    report = qualify_open_tasks(g.LV_CONTENT, LV, content_matcher=grammar_strict_matcher)
    assert report.failed == ["grading_ignores_language_errors"]


def test_a_stingy_matcher_cannot_reach_full_marks_on_the_reference_answer() -> None:
    assert "grading_reference_reaches_full_marks" in qualify_open_tasks(g.HV_CONTENT, HV, content_matcher=stingy_matcher).failed


def test_a_key_whose_own_reference_answer_misses_a_required_point_is_broken() -> None:
    content = g.fresh(g.HV_CONTENT)
    content["tasks"][0]["items"][0]["referenceAnswer"] = "Er unterscheidet nur den Tiefschlaf."
    assert "grading_reference_reaches_full_marks" in qualify_open_tasks(content, HV, content_matcher=keyword_matcher).failed


@pytest.mark.parametrize("mutate,gate", [
    (lambda c: c["tasks"][0]["items"][0].pop("referenceAnswer"), "items_well_formed"),
    (lambda c: c["tasks"][0]["items"][0].update(requiredPoints=[]), "structure"),
    (lambda c: c["tasks"][0]["items"][0].update(assessLanguage=True), "structure"),
    (lambda c: c["tasks"][0].update(form="multiple_choice"), "structure"),
    (lambda c: c.update(lectureText="zu kurz"), "structure"),
    (lambda c: c["tasks"][0]["items"][0].update(maxPoints=99), "items_well_formed"),
])
def test_open_task_mutations_fail_the_right_gate(mutate, gate) -> None:
    content = g.fresh(g.HV_CONTENT)
    mutate(content)
    assert gate in qualify_open_tasks(content, HV, content_matcher=keyword_matcher).failed


def test_language_independence_must_be_demonstrated_not_assumed() -> None:
    content = g.fresh(g.HV_CONTENT)
    for task in content["tasks"]:
        for item in task["items"]:
            item.pop("errorfulVariant")
    assert "grading_ignores_language_errors" in qualify_open_tasks(content, HV, content_matcher=keyword_matcher).failed


def test_item_scores_follow_the_key_and_ignore_form() -> None:
    raw = g.LV_CONTENT["tasks"][0]["items"][0]
    item = open_item(raw, "questions")
    points = item.required_points
    full = score_content_item(item, keyword_matcher(item.question, raw["referenceAnswer"], points))
    assert full == item.max_points == 2
    assert score_content_item(item, keyword_matcher(item.question, raw["errorfulVariant"], points)) == full  # form ignored
    half = score_content_item(item, keyword_matcher(item.question, "Produkte werden entsorgt.", points))
    assert half == 1
    assert score_content_item(item, keyword_matcher(item.question, "", points)) == 0


# ---- TP and topics -----------------------------------------------------------------------------------------------------
def test_golden_tp_qualifies() -> None:
    report = qualify_tp(g.TP_CONTENT, TP)
    assert report.status == "qualified", report.gates


@pytest.mark.parametrize("mutate,gate", [
    (lambda t: t.update(instructions="Schreiben Sie einen Aufsatz über Ihr Studium und Ihre Ziele im Leben."), "prompt_is_not_a_free_essay"),
    (lambda t: t.update(instructions="Schreiben Sie etwas zu dem Thema, das Sie interessiert, in ganzen Sätzen."), "prompt_is_not_a_free_essay"),
    (lambda t: t.update(instructions="Bitte schreiben."), "prompt_is_not_a_free_essay"),
    (lambda t: t.update(inputRefs=[]), "structure"),
    (lambda t: t.update(inputs=[]), "structure"),
    (lambda t: t.update(inputs=[{"kind": "essay_topic", "id": "i1"}]), "structure"),
    (lambda t: t.update(wordCountApprox=500), "structure"),
    (lambda t: t.update(languageActs=["narrate"]), "structure"),
])
def test_tp_mutations_fail_the_right_gate(mutate, gate) -> None:
    tp = g.fresh(g.TP_CONTENT)
    mutate(tp)
    assert gate in qualify_tp(tp, TP).failed


def test_topic_gate() -> None:
    t = g.TOPICS
    assert qualify_topics(t["listening"], t["reading"], t["writing"]).status == "qualified"
    assert qualify_topics("hv_urban_heat", "lv_diet_health", "tp_sports_health").status == "failed"  # one area only
    assert qualify_topics("hv_sleep_learning", "hv_sleep_learning", "tp_study_duration").status == "failed"
    assert qualify_topics("unknown", t["reading"], t["writing"]).status == "failed"


# ---- the whole exam through fake "providers" ------------------------------------------------------------------------------
class FakeGenerator:
    """Stands in for a future model-backed generator: returns fixed content. No I/O."""

    def __init__(self, **broken):
        self.broken = broken

    def hv(self):
        return g.fresh(g.HV_CONTENT) if "hv" not in self.broken else self.broken["hv"](g.fresh(g.HV_CONTENT))

    def lv(self):
        return g.fresh(g.LV_CONTENT) if "lv" not in self.broken else self.broken["lv"](g.fresh(g.LV_CONTENT))

    def ws(self):
        return g.fresh(g.WS_CONTENT)

    def tp(self):
        return g.fresh(g.TP_CONTENT)


def run_exam(gen: FakeGenerator):
    return {
        "topics": qualify_topics(g.TOPICS["listening"], g.TOPICS["reading"], g.TOPICS["writing"]),
        "hv": qualify_open_tasks(gen.hv(), HV, content_matcher=keyword_matcher),
        "lv+ws": qualify_lv_ws(gen.lv(), gen.ws(), LV, WS, blind_solver=solver()),
        "lv": qualify_open_tasks(gen.lv(), LV, content_matcher=keyword_matcher),
        "tp": qualify_tp(gen.tp(), TP),
    }


def test_a_complete_offline_exam_is_qualified_and_nothing_becomes_available() -> None:
    reports = run_exam(FakeGenerator())
    assert {name: r.status for name, r in reports.items()} == {name: "qualified" for name in reports}
    # Automated qualification is necessary, never sufficient: it cannot flip availability by itself.
    assert all(p.available is False for parts in __import__("app.services.german_exams", fromlist=["get_profile"]).get_profile("dsh").modules.values() for p in parts)


def test_a_broken_generation_is_stopped_at_the_matching_gate() -> None:
    def short_lv(lv):
        lv["source"]["text"] = lv["source"]["text"][:800]
        return lv

    reports = run_exam(FakeGenerator(lv=short_lv))
    assert reports["lv+ws"].status == "failed" and "lv_structure" in reports["lv+ws"].failed
    assert reports["lv"].status == "failed"
    assert reports["hv"].status == reports["tp"].status == reports["topics"].status == "qualified"


def test_every_gate_name_is_unique_per_report_and_statuses_are_known() -> None:
    for report in run_exam(FakeGenerator()).values():
        names = [x["name"] for x in report.gates]
        assert len(names) == len(set(names))
        assert {x["status"] for x in report.gates} <= {PASSED, FAILED, SKIPPED}


def test_content_points_reject_bad_shapes() -> None:
    with pytest.raises(Exception):
        ContentPoint("", "x", 1)
