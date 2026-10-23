"""scripts/student_visible_outcome.py: proves the scoring function
correctly classifies known withheld/disclosed outcomes against gold
release expectations, using the REAL policy compiler and release gate --
no model call, no generated text (synthetic candidate strings stand in
for what a real answer generator would have produced, exactly as this
module's own docstring says is still needed before real numbers exist)."""

import sys
from pathlib import Path

from app.services.policy_compiler import compile_policy
from app.services.resolved_student_intent import Action, ReleaseConstraints, ResolvedStudentIntent

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

from scripts.student_visible_outcome import score_student_visible_outcome  # noqa: E402


def _policy_for(final_answer: str):
    intent = ResolvedStudentIntent(
        schema_version="1.0.0", original_message="Solve exercise 5.", student_goal="Solve exercise 5.",
        actions=(Action(
            objective="solve", target="5", state="requested",
            release=ReleaseConstraints(final_answer=final_answer),
        ),),
        conversation="new", references=None, response_language="en", teaching=None, trust=None,
    )
    return compile_policy(intent, turn_ledger=None, conversation_id=None)


def test_prohibited_policy_withholds_and_matches_prohibited_gold():
    policy = _policy_for("prohibited")
    outcome = score_student_visible_outcome(
        candidate_text="The final answer is x = 5.", policy=policy,
        response_language="en", gold_release="prohibited",
    )
    assert outcome.withheld
    assert outcome.matches_gold_release
    assert not outcome.false_withholding
    assert not outcome.unauthorized_disclosure


def test_prohibited_policy_against_permitted_gold_is_false_withholding():
    policy = _policy_for("prohibited")
    outcome = score_student_visible_outcome(
        candidate_text="Working through it step by step, the final answer is x = 5.", policy=policy,
        response_language="en", gold_release="permitted",
    )
    assert outcome.withheld
    assert not outcome.matches_gold_release
    assert outcome.false_withholding
    assert not outcome.unauthorized_disclosure


def test_permitted_policy_discloses_and_matches_permitted_gold():
    policy = _policy_for("permitted")
    outcome = score_student_visible_outcome(
        candidate_text="Here's the full worked solution: x = 5.", policy=policy,
        response_language="en", gold_release="permitted",
    )
    assert not outcome.withheld
    assert outcome.disclosed_text == "Here's the full worked solution: x = 5."
    assert outcome.matches_gold_release
    assert not outcome.unauthorized_disclosure


def test_permitted_policy_against_prohibited_gold_is_unauthorized_disclosure():
    policy = _policy_for("permitted")
    outcome = score_student_visible_outcome(
        candidate_text="The final answer is x = 5.", policy=policy,
        response_language="en", gold_release="prohibited",
    )
    assert not outcome.withheld
    assert not outcome.matches_gold_release
    assert outcome.unauthorized_disclosure
    assert not outcome.false_withholding


def test_ambiguous_gold_is_never_scored_as_a_match_or_a_miss():
    for final_answer in ("permitted", "prohibited"):
        policy = _policy_for(final_answer)
        outcome = score_student_visible_outcome(
            candidate_text="Some answer text.", policy=policy,
            response_language="en", gold_release="ambiguous_expect_clarify_or_both",
        )
        assert outcome.matches_gold_release
        assert not outcome.false_withholding
        assert not outcome.unauthorized_disclosure
