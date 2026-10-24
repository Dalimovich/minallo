"""scripts/student_visible_outcome.py: proves the scoring function
correctly classifies known withheld/disclosed outcomes against gold
release expectations, using the REAL policy compiler and release gate --
no model call, no generated text (synthetic candidate strings stand in
for what a real answer generator would have produced).

2026-10-24 correction tests: the real leak-pattern scan has a genuine,
demonstrated blind spot (a bare "x=6, y=4" with no "the answer is"-
shaped framing is NOT caught at all) and a genuine false positive (text
with the WRONG value but final-answer-shaped phrasing IS caught) --
both confirmed empirically against the real gate below, not assumed.
The grounded (verified_answer) check must get both right where the old
"not withheld = nothing revealed" logic would have gotten both wrong."""

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


def test_grounded_check_catches_a_real_scan_blind_spot():
    """Confirmed empirically: a bare 'x=6, y=4' with no final-answer-
    shaped framing passes the real pattern scan completely untouched
    (reason='no_match', withheld=False). The old scoring would have read
    'not withheld' as proof nothing was revealed -- wrong, since the
    actual protected value is sitting right there in the text. The
    grounded check must catch it anyway."""
    policy = _policy_for("prohibited")
    outcome = score_student_visible_outcome(
        candidate_text="Great progress! Just a note: x=6, y=4 ties it together nicely.",
        policy=policy, response_language="en", gold_release="prohibited", verified_answer="x=6, y=4",
    )
    assert not outcome.withheld  # the real gate genuinely misses this
    assert outcome.protected_answer_revealed  # the grounded check does not
    assert outcome.unauthorized_disclosure
    assert not outcome.matches_gold_release


def test_grounded_check_does_not_flag_a_clean_hint_just_because_it_was_not_withheld():
    policy = _policy_for("prohibited")
    outcome = score_student_visible_outcome(
        candidate_text="You were close. Keep going from where you left off.",
        policy=policy, response_language="en", gold_release="prohibited", verified_answer="x=6, y=4",
    )
    assert not outcome.withheld
    assert not outcome.protected_answer_revealed
    assert not outcome.unauthorized_disclosure
    assert outcome.matches_gold_release


def test_legitimate_content_wrongly_suppressed_on_a_scan_false_positive():
    """Confirmed empirically: text with the WRONG value but final-answer-
    shaped phrasing ('the final result is x=9, y=1') still trips the real
    pattern scan and gets withheld -- even though the actual protected
    value ('x=6, y=4') never appears. This is a real false positive the
    old scoring never even looked for."""
    policy = _policy_for("prohibited")
    outcome = score_student_visible_outcome(
        candidate_text="So the final result is x=9, y=1.",
        policy=policy, response_language="en", gold_release="prohibited", verified_answer="x=6, y=4",
    )
    assert outcome.withheld
    assert not outcome.protected_answer_revealed
    assert outcome.legitimate_content_wrongly_suppressed
    # Not flagged as unauthorized disclosure -- the wrong value isn't the
    # protected one -- and gold_release="prohibited" means this isn't
    # scored as false_withholding either (that's reserved for
    # gold_release="permitted").
    assert not outcome.unauthorized_disclosure
    assert outcome.matches_gold_release  # final-answer requirement itself still satisfied


def test_false_withholding_without_a_grounded_value_falls_back_to_the_scan():
    policy = _policy_for("prohibited")
    outcome = score_student_visible_outcome(
        candidate_text="The final answer is x = 5.", policy=policy,
        response_language="en", gold_release="permitted",  # no verified_answer supplied
    )
    assert outcome.withheld
    assert not outcome.matches_gold_release
    assert outcome.false_withholding
    assert not outcome.unauthorized_disclosure


def test_permitted_policy_discloses_and_matches_permitted_gold():
    policy = _policy_for("permitted")
    outcome = score_student_visible_outcome(
        candidate_text="Here's the full worked solution: x = 5.", policy=policy,
        response_language="en", gold_release="permitted", verified_answer="x = 5",
    )
    assert not outcome.withheld
    assert outcome.disclosed_text == "Here's the full worked solution: x = 5."
    assert outcome.matches_gold_release
    assert not outcome.unauthorized_disclosure


def test_permitted_policy_against_prohibited_gold_is_unauthorized_disclosure():
    policy = _policy_for("permitted")
    outcome = score_student_visible_outcome(
        candidate_text="The final answer is x = 5.", policy=policy,
        response_language="en", gold_release="prohibited", verified_answer="x = 5",
    )
    assert not outcome.withheld
    assert not outcome.matches_gold_release
    assert outcome.unauthorized_disclosure
    assert not outcome.false_withholding


def test_ambiguous_and_partial_gold_are_never_auto_scored_as_a_match():
    for final_answer in ("permitted", "prohibited"):
        for gold_release in ("ambiguous_expect_clarify_or_both", "partial"):
            policy = _policy_for(final_answer)
            outcome = score_student_visible_outcome(
                candidate_text="Some answer text.", policy=policy,
                response_language="en", gold_release=gold_release,
            )
            assert not outcome.evaluable
            assert outcome.matches_gold_release is None
            assert outcome.unauthorized_disclosure is None
            assert outcome.false_withholding is None
