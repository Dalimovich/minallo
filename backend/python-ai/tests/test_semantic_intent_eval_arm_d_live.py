"""Offline proof for scripts/semantic_intent_eval_arm_d_live.py's pure
escalation-decision function -- no network, no cost. Arm D itself cannot
be run yet (no qualifying real Jev report exists), but the DECISION LOGIC
that will gate it is fully testable today with synthetic inputs.

2026-10-24 correction: the function's signature changed to remove every
gold-derived argument (gold_form, benchmark category, turn_index-as-
category-proxy) -- a deployed system never has those. These tests use
only the inference-time signals the corrected function actually takes:
Jev's own objective/confidences, target_unverified (a structural check
against real document labels), and dialogue_relation (the real,
deterministic resolve_dialogue classification)."""

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


def test_mandatory_unverified_target_escalates_regardless_of_confidence():
    escalate, reason = should_escalate_to_milestone4(
        jev_objective="solve", target_unverified=True, dialogue_relation="new_topic", has_prior_turns=False,
        target_confidence=0.99, objective_confidence=0.99, confidence_threshold=0.1,
    )
    assert escalate and reason == "mandatory:target_unverified"


def test_mandatory_ambiguous_jev_objective_escalates_regardless_of_confidence():
    escalate, reason = should_escalate_to_milestone4(
        jev_objective="other", target_unverified=False, dialogue_relation="new_topic", has_prior_turns=False,
        target_confidence=0.99, objective_confidence=0.99, confidence_threshold=0.1,
    )
    assert escalate and reason == "mandatory:jev_objective_ambiguous"


def test_mandatory_history_dependent_relation_with_prior_turns_escalates():
    escalate, reason = should_escalate_to_milestone4(
        jev_objective="solve", target_unverified=False, dialogue_relation="correction", has_prior_turns=True,
        target_confidence=0.99, objective_confidence=0.99, confidence_threshold=0.1,
    )
    assert escalate and reason == "mandatory:history_dependent_relation:correction"


def test_history_dependent_relation_without_prior_turns_does_not_escalate():
    """A relation value that LOOKS history-dependent but with no actual
    prior turns (shouldn't happen in practice, but the function must not
    trust the label alone) must not force escalation."""
    escalate, reason = should_escalate_to_milestone4(
        jev_objective="solve", target_unverified=False, dialogue_relation="correction", has_prior_turns=False,
        target_confidence=0.99, objective_confidence=0.99, confidence_threshold=0.1,
    )
    assert not escalate and reason == "jev_sufficient"


def test_low_confidence_escalates_even_without_a_mandatory_reason():
    escalate, reason = should_escalate_to_milestone4(
        jev_objective="solve", target_unverified=False, dialogue_relation="new_topic", has_prior_turns=False,
        target_confidence=0.4, objective_confidence=0.9, confidence_threshold=0.5,
    )
    assert escalate and reason.startswith("confidence:")


def test_high_confidence_and_no_mandatory_reason_does_not_escalate():
    escalate, reason = should_escalate_to_milestone4(
        jev_objective="solve", target_unverified=False, dialogue_relation="new_topic", has_prior_turns=False,
        target_confidence=0.9, objective_confidence=0.9, confidence_threshold=0.5,
    )
    assert not escalate and reason == "jev_sufficient"


def test_missing_confidences_treated_as_zero_and_escalate():
    escalate, reason = should_escalate_to_milestone4(
        jev_objective="solve", target_unverified=False, dialogue_relation="new_topic", has_prior_turns=False,
        target_confidence=None, objective_confidence=None, confidence_threshold=0.1,
    )
    assert escalate and reason.startswith("confidence:")


def test_function_signature_has_no_gold_derived_parameter():
    """Static contract check: fails loudly if a future edit reintroduces
    gold_form/category/turn_index -- the exact 2026-10-24 leak."""
    import inspect

    params = set(inspect.signature(should_escalate_to_milestone4).parameters)
    forbidden = {"gold_form", "category", "turn_index"}
    leaked = params & forbidden
    assert not leaked, f"gold-derived parameter(s) reintroduced: {leaked}"


def test_main_refuses_without_live(capsys):
    import pytest

    with pytest.raises(SystemExit):
        sys.argv = [
            "arm_d", "--jev-report", "nonexistent.json",
            "--confidence-threshold", "0.5", "--output", "out.json",
            "--max-requests", "1", "--max-cost-usd", "0.1",
        ]
        main()
    assert "requires --live" in capsys.readouterr().err


def test_main_refuses_a_missing_jev_report(capsys):
    import pytest

    with pytest.raises(SystemExit):
        sys.argv = [
            "arm_d", "--live", "--jev-report", "definitely_does_not_exist.json",
            "--confidence-threshold", "0.5", "--output", "out.json",
            "--max-requests", "1", "--max-cost-usd", "0.1",
        ]
        main()
    assert "does not exist" in capsys.readouterr().err
