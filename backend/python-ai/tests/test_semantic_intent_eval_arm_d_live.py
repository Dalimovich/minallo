"""Offline proof for scripts/semantic_intent_eval_arm_d_live.py's pure
escalation-decision function -- no network, no cost. Arm D itself cannot
be run yet (no qualifying real Jev report exists), but the DECISION LOGIC
that will gate it is fully testable today with synthetic inputs."""

import sys
from pathlib import Path

# See test_qa_budget.py for why this guarded reimport exists.
_BACKEND_ROOT = str(Path(__file__).resolve().parents[1])
_scripts_pkg = sys.modules.get("scripts")
_scripts_already_correct = _scripts_pkg is not None and any(
    Path(p).resolve() == Path(_BACKEND_ROOT, "scripts") for p in getattr(_scripts_pkg, "__path__", [])
)
if not _scripts_already_correct:
    if _BACKEND_ROOT in sys.path:
        sys.path.remove(_BACKEND_ROOT)
    sys.path.insert(0, _BACKEND_ROOT)
    for _name in [n for n in sys.modules if n == "scripts" or n.startswith("scripts.")]:
        del sys.modules[_name]

from scripts.semantic_intent_eval_arm_d_live import main, should_escalate_to_milestone4  # noqa: E402


def test_mandatory_permission_change_escalates_regardless_of_confidence():
    escalate, reason = should_escalate_to_milestone4(
        jev_turn={"target_confidence": 0.99, "objective_confidence": 0.99},
        gold_form="full_solution", category="changing_instructions_more_help", turn_index=1,
        target_unverified=False, confidence_threshold=0.1,
    )
    assert escalate and reason.startswith("mandatory:permission_change_untestable")


def test_mandatory_unverified_target_escalates_regardless_of_confidence():
    escalate, reason = should_escalate_to_milestone4(
        jev_turn={"target_confidence": 0.99, "objective_confidence": 0.99},
        gold_form="full_solution", category="indirect_reference", turn_index=0,
        target_unverified=True, confidence_threshold=0.1,
    )
    assert escalate and reason == "mandatory:target_unverified"


def test_mandatory_unsupported_objective_escalates_regardless_of_confidence():
    escalate, reason = should_escalate_to_milestone4(
        jev_turn={"target_confidence": 0.99, "objective_confidence": 0.99},
        gold_form="quiz_start", category="quiz_wait_for_answer", turn_index=0,
        target_unverified=False, confidence_threshold=0.1,
    )
    assert escalate and reason == "mandatory:objective_unsupported"


def test_low_confidence_escalates_even_without_a_mandatory_reason():
    escalate, reason = should_escalate_to_milestone4(
        jev_turn={"target_confidence": 0.4, "objective_confidence": 0.9},
        gold_form="full_solution", category="natural_informal_no_keyword", turn_index=0,
        target_unverified=False, confidence_threshold=0.5,
    )
    assert escalate and reason.startswith("confidence:")


def test_high_confidence_and_no_mandatory_reason_does_not_escalate():
    escalate, reason = should_escalate_to_milestone4(
        jev_turn={"target_confidence": 0.9, "objective_confidence": 0.9},
        gold_form="full_solution", category="natural_informal_no_keyword", turn_index=0,
        target_unverified=False, confidence_threshold=0.5,
    )
    assert not escalate and reason == "jev_sufficient"


def test_turn_index_zero_of_a_permission_category_is_not_mandatory():
    """Only turn index > 0 of a permission-dependent category depends on
    prior-turn state -- turn 0 has nothing prior to depend on."""
    escalate, reason = should_escalate_to_milestone4(
        jev_turn={"target_confidence": 0.9, "objective_confidence": 0.9},
        gold_form="full_solution", category="changing_instructions_more_help", turn_index=0,
        target_unverified=False, confidence_threshold=0.5,
    )
    assert not escalate and reason == "jev_sufficient"


def test_main_refuses_without_live(capsys):
    import pytest

    with pytest.raises(SystemExit):
        sys.argv = [
            "arm_d", "--jev-report", "nonexistent.json",
            "--confidence-threshold", "0.5", "--output", "out.json",
        ]
        main()
    assert "requires --live" in capsys.readouterr().err


def test_main_refuses_a_missing_jev_report(capsys):
    import pytest

    with pytest.raises(SystemExit):
        sys.argv = [
            "arm_d", "--live", "--jev-report", "definitely_does_not_exist.json",
            "--confidence-threshold", "0.5", "--output", "out.json",
        ]
        main()
    assert "does not exist" in capsys.readouterr().err
