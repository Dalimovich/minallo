"""Tests for the Milestone 2 multi-action contract
(``app/services/resolved_student_intent.py``): dataclass shape, provenance
validation, and the legacy-field derivation bridge.

Nothing here makes a model/network call — this module is pure dataclasses
and regex-free predicate functions.
"""

import dataclasses

from app.services.answer_intent import AcademicIntent
from app.services.resolved_student_intent import (
    SCHEMA_VERSION,
    Action,
    Origin,
    ReleaseConstraints,
    ResolvedStudentIntent,
    derive_primary_task,
    derive_prohibited_tasks,
    validate_action_provenance,
    validate_intent_provenance,
    validate_origin,
)
from app.services.student_intent import StudentIntent


# ---------------------------------------------------------------------------
# StudentIntent is untouched — guards the "do not delete or change the
# meaning of any existing field" hard rule.
# ---------------------------------------------------------------------------

def test_old_student_intent_fields_are_unchanged():
    fields = {f.name for f in dataclasses.fields(StudentIntent)}
    assert fields == {
        "original_message", "student_goal", "primary_task", "prohibited_tasks",
        "depth", "teaching_style", "scope", "references_resolved",
        "references_unresolved", "visual_requirement", "follow_up_type",
        "confidence", "interpretation_source", "needs_clarification",
    }


# ---------------------------------------------------------------------------
# Origin provenance validation.
# ---------------------------------------------------------------------------

def test_current_message_origin_valid_span():
    origin = Origin(kind="current_message", span=(0, 4))
    assert validate_origin(origin, original_message="abcdefgh") is True


def test_current_message_origin_out_of_bounds_span_is_invalid():
    origin = Origin(kind="current_message", span=(5, 50))
    assert validate_origin(origin, original_message="short") is False


def test_current_message_origin_empty_span_is_invalid():
    origin = Origin(kind="current_message", span=(3, 3))
    assert validate_origin(origin, original_message="abcdefgh") is False


def test_current_message_origin_missing_span_is_invalid():
    origin = Origin(kind="current_message", span=None)
    assert validate_origin(origin, original_message="abcdefgh") is False


def test_conversation_turn_origin_resolves_against_ledger():
    ledger = {"turn-1": {"text": "no final result for 5a"}}
    origin = Origin(kind="conversation_turn", turn_id="turn-1")
    assert validate_origin(origin, original_message="x", turn_ledger=ledger) is True


def test_conversation_turn_origin_forged_turn_id_is_invalid():
    ledger = {"turn-1": {"text": "no final result for 5a"}}
    origin = Origin(kind="conversation_turn", turn_id="turn-forged-does-not-exist")
    assert validate_origin(origin, original_message="x", turn_ledger=ledger) is False


def test_conversation_turn_origin_without_ledger_is_invalid():
    origin = Origin(kind="conversation_turn", turn_id="turn-1")
    assert validate_origin(origin, original_message="x", turn_ledger=None) is False


def test_viewer_metadata_origin_resolves_against_trusted_context():
    viewer_context = {"open_file:123": {"page": 4}}
    origin = Origin(kind="viewer_metadata", context_ref="open_file:123")
    assert validate_origin(origin, original_message="x", viewer_context=viewer_context) is True


def test_viewer_metadata_origin_unresolvable_ref_is_invalid():
    viewer_context = {"open_file:123": {"page": 4}}
    origin = Origin(kind="viewer_metadata", context_ref="open_file:999")
    assert validate_origin(origin, original_message="x", viewer_context=viewer_context) is False


def test_unresolved_origin_is_never_valid():
    origin = Origin(kind="unresolved")
    assert validate_origin(origin, original_message="x", turn_ledger={}, viewer_context={}) is False


# ---------------------------------------------------------------------------
# Action-level downgrade: an action whose only provenance fails validation
# downgrades to state="unresolved" — never a guess.
# ---------------------------------------------------------------------------

def test_action_with_forged_turn_id_downgrades_to_unresolved():
    action = Action(
        objective="solve", target="5b", state="requested",
        release=ReleaseConstraints(final_answer="permitted"),
        provenance=(Origin(kind="conversation_turn", turn_id="turn-forged"),),
    )
    validated = validate_action_provenance(
        action, original_message="x", turn_ledger={"turn-1": {}},
    )
    assert validated.state == "unresolved"


def test_action_with_valid_turn_id_keeps_its_state():
    action = Action(
        objective="solve", target="5b", state="requested",
        release=ReleaseConstraints(final_answer="permitted"),
        provenance=(Origin(kind="conversation_turn", turn_id="turn-1"),),
    )
    validated = validate_action_provenance(
        action, original_message="x", turn_ledger={"turn-1": {}},
    )
    assert validated.state == "requested"


def test_action_with_no_provenance_is_left_alone():
    action = Action(objective="solve", target="5b", state="requested")
    validated = validate_action_provenance(action, original_message="x")
    assert validated.state == "requested"


def test_action_with_one_valid_and_one_invalid_origin_keeps_its_state():
    action = Action(
        objective="solve", target="5b", state="requested",
        provenance=(
            Origin(kind="conversation_turn", turn_id="turn-forged"),
            Origin(kind="current_message", span=(0, 3)),
        ),
    )
    validated = validate_action_provenance(action, original_message="abcdef", turn_ledger={})
    assert validated.state == "requested"


def test_validate_intent_provenance_applies_to_every_action():
    intent = ResolvedStudentIntent(
        schema_version=SCHEMA_VERSION, original_message="x", student_goal="x",
        actions=(
            Action(objective="solve", target="a", state="requested",
                   provenance=(Origin(kind="conversation_turn", turn_id="forged"),)),
            Action(objective="explain", target="b", state="requested"),
        ),
        conversation="new", references=None, response_language="en",
        teaching=None, trust=None,
    )
    validated = validate_intent_provenance(intent, turn_ledger={})
    assert validated.actions[0].state == "unresolved"
    assert validated.actions[1].state == "requested"


# ---------------------------------------------------------------------------
# Legacy derivation bridge.
# ---------------------------------------------------------------------------

def test_derive_primary_task_maps_first_action_objective():
    actions = (Action(objective="summarize", target="all"),)
    assert derive_primary_task(actions) is AcademicIntent.COURSE_SUMMARY


def test_derive_primary_task_empty_actions_falls_back_to_general_qa():
    assert derive_primary_task(()) is AcademicIntent.GENERAL_COURSE_QA


def test_derive_prohibited_tasks_collects_prohibited_actions_only():
    actions = (
        Action(objective="official_solution", target="5", state="prohibited"),
        Action(objective="hint", target="5", state="requested"),
        Action(objective="summarize", target="all", state="prohibited"),
    )
    prohibited = derive_prohibited_tasks(actions)
    assert AcademicIntent.MATH_PROBLEM in prohibited  # official_solution's mapping
    assert AcademicIntent.COURSE_SUMMARY in prohibited
    assert len(prohibited) == 2  # requested action never contributes
