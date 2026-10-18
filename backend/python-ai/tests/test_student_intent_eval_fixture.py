"""Semantic Student Intent Interpreter (PR 2) — offline evaluation fixture
runner.

These tests are deterministic guards on the fixture and the typed
interpretation/fallback/execution-plan-compatibility contract — NOT a live
answer-quality evaluation of the actual semantic model's judgment. No test
in this file makes a network call: cases that are expected to escalate
(`expectedEscalates: true`) have the model call itself monkeypatched to
either fail (per `simulateModelFailure`) or decline (return None), so the
fallback path — not live model accuracy — is what gets exercised here.

Live evaluation of whether the REAL model's primaryTask/prohibitedTasks
judgment matches `expectedPrimaryTask` on these same cases requires a
configured OpenAI key and separate authorization for paid calls; it is
intentionally not wired up in this repo yet (see docs/semantic-intent-
layer-map.md's PR 2 section and the PR 2 report's "Evaluation coverage"
notes for how to add a `scripts/run_student_intent_eval.py` companion,
mirroring `scripts/run_math_eval.py`, once that's authorized).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services import student_intent as si
from app.services.answer_intent import AcademicIntent
from app.services.dialogue_state import resolve_dialogue
from app.services.execution_router import ExecutionPlan, resolve_execution_plan
from app.services.grounding_contract import ResolvedDocumentAccess
from app.services.student_intent import interpret_student_intent

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "student_intent_eval_cases.json"

_ALLOWED_CATEGORIES = {
    "positive_instruction", "negative_instruction", "contradictory_instruction",
    "german", "english", "mixed_language", "follow_up", "correction",
    "diagram_reference", "page_reference", "quiz", "hint", "solve", "explain",
    "compare", "summarize", "missing_context", "malformed_model_output", "timeout",
}
_REQUIRED_FIELDS = (
    "id", "category", "message", "resolvedAccess", "expectedPrimaryTask",
    "expectedProhibitedTasks", "expectedNeedsClarification", "expectedEscalates",
    "expectedBehavior",
)
# expectedAnswerConstraints is optional per case (PR3) — most cases carry no
# answer-release/pacing constraint at all, so omitting it defaults to "none
# active" rather than forcing all 23 entries to spell out three explicit
# False values.
_DEFAULT_ANSWER_CONSTRAINTS = {
    "withholdAnswer": False, "hintOnly": False, "oneQuestionAtATime": False,
}


def _expected_answer_constraints(case: dict) -> tuple[bool, bool, bool]:
    expected = {**_DEFAULT_ANSWER_CONSTRAINTS, **case.get("expectedAnswerConstraints", {})}
    return (
        expected["withholdAnswer"], expected["hintOnly"], expected["oneQuestionAtATime"],
    )
_ACCESS_BY_NAME = {
    "relevance": ResolvedDocumentAccess.RELEVANCE,
    "visible_page": ResolvedDocumentAccess.VISIBLE_PAGE,
    "full_document": ResolvedDocumentAccess.FULL_DOCUMENT,
}
_FAILURE_BY_NAME = {
    "malformed": lambda: ValueError("malformed structured-output response"),
    "timeout": lambda: TimeoutError("semantic classifier exceeded its budget"),
}


def _load_cases() -> list[dict]:
    with _FIXTURE_PATH.open(encoding="utf-8") as f:
        data = json.load(f)
    return data["cases"]


_CASES = _load_cases()


def _resolve(case: dict):
    turns = case.get("previousTurns") or []
    dialogue = resolve_dialogue(case["message"], previous_turns=turns)
    access = _ACCESS_BY_NAME[case["resolvedAccess"]]
    return dialogue, access, turns


# ── Schema validation (mirrors tests/test_math_eval_fixture.py's pattern) ──


def test_fixture_loads_and_has_min_cases() -> None:
    assert len(_CASES) >= 20, "PR 2 brief calls for broad category coverage; don't fall below 20"


def test_fixture_ids_are_unique() -> None:
    ids = [c["id"] for c in _CASES]
    assert len(ids) == len(set(ids)), "duplicate case ids in fixture"


@pytest.mark.parametrize("case", _CASES, ids=lambda c: c["id"])
def test_case_has_required_fields(case: dict) -> None:
    for field in _REQUIRED_FIELDS:
        assert field in case, f"case {case.get('id')!r} missing {field!r}"
    assert case["category"] in _ALLOWED_CATEGORIES, (
        f"case {case['id']!r} has unknown category {case['category']!r}"
    )
    assert case["resolvedAccess"] in _ACCESS_BY_NAME
    assert AcademicIntent(case["expectedPrimaryTask"])
    for prohibited in case["expectedProhibitedTasks"]:
        assert AcademicIntent(prohibited)
    if case.get("simulateModelFailure") is not None:
        assert case["simulateModelFailure"] in _FAILURE_BY_NAME
        assert case["expectedEscalates"] is True, (
            f"case {case['id']!r} sets simulateModelFailure but never escalates "
            "— the failure path would never be exercised"
        )
    if "expectedAnswerConstraints" in case:
        assert set(case["expectedAnswerConstraints"]) <= set(_DEFAULT_ANSWER_CONSTRAINTS), (
            f"case {case['id']!r} has an unknown expectedAnswerConstraints key"
        )
        assert all(isinstance(v, bool) for v in case["expectedAnswerConstraints"].values())


def test_fixture_covers_every_required_category() -> None:
    covered = {c["category"] for c in _CASES}
    missing = _ALLOWED_CATEGORIES - covered
    assert not missing, f"fixture lost coverage for categories: {missing}"


def test_fixture_includes_the_historical_bwl_page6_case() -> None:
    case = next(c for c in _CASES if c["id"] == "historical-bwl-page6")
    assert case["message"] == "Explain the concept on this page in detail. Do not summarize it."


# ── Typed interpretation: the deterministic adapter, zero model calls ──────


@pytest.mark.parametrize("case", _CASES, ids=lambda c: c["id"])
def test_deterministic_classification_matches_expected(case: dict) -> None:
    dialogue, access, turns = _resolve(case)
    intent = interpret_student_intent(
        case["message"], dialogue=dialogue, resolved_access=access,
        has_visible_context=case.get("hasVisibleContext", False),
        mode="off", previous_turns=turns,
    )
    assert intent.primary_task.value == case["expectedPrimaryTask"], case["expectedBehavior"]
    assert [p.value for p in intent.prohibited_tasks] == case["expectedProhibitedTasks"], case["expectedBehavior"]
    assert intent.needs_clarification == case["expectedNeedsClarification"], case["expectedBehavior"]
    assert (
        intent.answer_constraints.withhold_answer,
        intent.answer_constraints.hint_only,
        intent.answer_constraints.one_question_at_a_time,
    ) == _expected_answer_constraints(case), case["expectedBehavior"]
    assert intent.interpretation_source == "deterministic"


@pytest.mark.parametrize("case", _CASES, ids=lambda c: c["id"])
def test_escalation_trigger_matches_expected(case: dict) -> None:
    dialogue, _access, _turns = _resolve(case)
    assert si._needs_semantic_path(case["message"], dialogue) == case["expectedEscalates"], (
        case["expectedBehavior"]
    )


# ── Fallback behavior: escalating cases, model call monkeypatched to never
# reach the network — either declines (returns None) or fails per
# simulateModelFailure — must reproduce the deterministic fields exactly. ──


@pytest.mark.parametrize(
    "case", [c for c in _CASES if c["expectedEscalates"]], ids=lambda c: c["id"],
)
def test_fallback_reproduces_deterministic_fields(case: dict, monkeypatch) -> None:
    failure_name = case.get("simulateModelFailure")
    if failure_name is not None:
        def _fail(*, message, dialogue, previous_turns, base, user_id):
            raise _FAILURE_BY_NAME[failure_name]()
        monkeypatch.setattr(si, "_semantic_model_call", _fail)
    else:
        monkeypatch.setattr(
            si, "_semantic_model_call",
            lambda *, message, dialogue, previous_turns, base, user_id: None,
        )
    dialogue, access, turns = _resolve(case)
    intent = interpret_student_intent(
        case["message"], dialogue=dialogue, resolved_access=access,
        has_visible_context=case.get("hasVisibleContext", False),
        mode="shadow", previous_turns=turns,
    )
    assert intent.interpretation_source == "fallback"
    assert intent.primary_task.value == case["expectedPrimaryTask"]
    assert [p.value for p in intent.prohibited_tasks] == case["expectedProhibitedTasks"]
    assert intent.needs_clarification == case["expectedNeedsClarification"]
    assert (
        intent.answer_constraints.withhold_answer,
        intent.answer_constraints.hint_only,
        intent.answer_constraints.one_question_at_a_time,
    ) == _expected_answer_constraints(case)


# ── Downstream execution-plan compatibility ─────────────────────────────────


@pytest.mark.parametrize("case", _CASES, ids=lambda c: c["id"])
def test_execution_plan_compatibility(case: dict) -> None:
    dialogue, access, turns = _resolve(case)
    intent = interpret_student_intent(
        case["message"], dialogue=dialogue, resolved_access=access,
        has_visible_context=case.get("hasVisibleContext", False),
        mode="off", previous_turns=turns,
    )
    _profile, plan = resolve_execution_plan(
        question=dialogue.resolved_request, resolved_access=access,
        processing_pipeline="relevance", resolved_turn=dialogue,
        student_intent=intent,
    )
    assert isinstance(plan, ExecutionPlan)
    assert "semantic_intent_available" in plan.signals
    assert plan.to_api()  # must serialize without raising (SSE payload shape)
