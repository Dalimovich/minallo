"""Narrowly-scoped verification pass (2026-10-20), run against the already-
committed AB-24/AB-02/AB-03/Gate-6 stabilization fixes on this branch
(answer_intent.py's _QUIZ_RE fix, diagnostic_policy.py's QUIZ_GENERATION ->
"hint" mapping, policy_compiler.py's explain-objective fallback,
answer_release_validator.py's scan-gate split).

Scope, per the coordinator's explicit request: confirm what ACTUALLY
happens for a quiz request end to end -- real quiz question + wait
behavior (not just withholding), a full wrong-then-right exchange, policy/
QUIZ_CONTRACT agreement, and the explicit-full-solution fix -- using only
existing code and zero-cost, pure/deterministic calls. No new production
code changes accompany this file; where a gap is found, it is documented
as a gap (matching this codebase's existing convention, e.g.
test_single_target_disguised_leak_with_no_known_shape_is_a_known_gap in
test_answer_release_validator.py), not silently patched over.
"""

from __future__ import annotations

import pytest

from app.services.answer import pick_system_prompt
from app.services.answer_intent import AcademicIntent, classify_academic_intent
from app.services.answer_stream import QUIZ_CONTRACT
from app.services.diagnostic_policy import adapt_deterministic_intent
from app.services.dialogue_state import resolve_dialogue
from app.services.policy_compiler import compile_policy
from app.services.policy_prompt_rendering import render_execution_policy_overlay
from app.services.student_intent import interpret_student_intent


def _compile_for(question: str, *, previous_turns=None, authorized_exercise_labels=frozenset()):
    dialogue = resolve_dialogue(question, previous_turns=previous_turns or [])
    student_intent = interpret_student_intent(
        question, dialogue=dialogue, resolved_access=None, mode="off",
    )
    resolved_intent = adapt_deterministic_intent(
        message=question, dialogue=dialogue, student_intent=student_intent,
        authorized_exercise_labels=authorized_exercise_labels,
    )
    return compile_policy(resolved_intent)


# ---------------------------------------------------------------------------
# 1. "Frag mich die Lagerkraft R_A ab." -> an actual quiz question, with
#    wait_for_student behavior, not merely a withheld answer.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("question", [
    "Frag mich die Lagerkraft R_A ab.",
    "Kannst du mich zu Aufgabe 1 abfragen, nicht einfach die Antwort geben?",
    "Quiz me on R_A.",
    "Test me on the reaction force R_A, don't just tell me.",
])
def test_quiz_phrasings_route_to_quiz_generation_not_mere_withholding(question):
    """These 4 of the independent eval's 5 quiz phrasings correctly
    classify as QUIZ_GENERATION via the fixed deterministic classifier
    (answer_intent.py), which is what answer_stream.py's is_quiz_request
    reads to add QUIZ_CONTRACT (build an inline quiz block) to the
    prompt -- this is a real quiz-question mechanism, not "withhold the
    plain answer and say nothing else"."""
    assert classify_academic_intent(question) == AcademicIntent.QUIZ_GENERATION


def test_implicit_ask_me_phrasing_is_a_known_residual_gap():
    """The eval's 5th phrasing has no recognizable lexical anchor
    ("quiz"/"test me"/"abfragen"/"frag...mich...ab") at all -- a purely
    implicit paraphrase of being quizzed. Confirmed NOT caught by the
    deterministic classifier; this is the class of case selective
    semantic escalation exists for, not a defect in this session's
    fixes. Documented here so it can't silently regress further, not
    silently patched with another ad hoc regex per this verification's
    explicit scope."""
    question = "Can you ask me for R_A instead of just telling me the value?"
    assert classify_academic_intent(question) != AcademicIntent.QUIZ_GENERATION


def test_quiz_with_resolvable_target_closes_final_answer_but_not_wait_for_student():
    """Confirmed gap: for a quiz request whose target DOES resolve (a
    recognized exercise label, e.g. "5a"), the QUIZ_GENERATION -> "hint"
    mapping correctly closes final_answer/form via policy_compiler's
    existing hint-objective fallback, but wait_for_student stays at its
    ordinary tutoring default (False) -- the mapping only overrides
    final_answer/form, not wait_for_student. The compiled policy's
    prompt overlay would say "respond with a HINT only" but NOT "stop
    here and wait for the student's own attempt" for this case."""
    policy = _compile_for("Quiz me on exercise 5a.", authorized_exercise_labels=frozenset({"5a"}))
    action = policy.actions[0]
    assert action.objective == "hint"
    assert action.state == "requested"
    assert action.release.final_answer == "prohibited"
    assert action.release.wait_for_student is False  # the confirmed gap


def test_quiz_with_unresolved_target_gets_wait_for_student_via_the_safety_net():
    """The EXACT AB-24 message ("Frag mich die Lagerkraft R_A ab.") has
    no recognized exercise-label target ("R_A" is a quantity name, not
    an exercise label) and no prior active_question, so it resolves
    state="unresolved" -- which, independent of (and unaffected by) the
    QUIZ_GENERATION->"hint" mapping, already gets EVERY field forced to
    its most-restrictive legal value via policy_compiler's pre-existing
    unresolved-state fallback, including wait_for_student=True. This is
    why the literal AB-24 message DOES get genuine wait_for_student
    semantics today -- coincidentally, via the unresolved-target safety
    net, not because the quiz mapping itself sets it."""
    policy = _compile_for("Frag mich die Lagerkraft R_A ab.")
    action = policy.actions[0]
    assert action.state == "unresolved"
    assert action.release.wait_for_student is True
    assert action.release.final_answer == "prohibited"


# ---------------------------------------------------------------------------
# 2. A full quiz exchange: initial question, incorrect attempt, correct
#    attempt. The intent-layer side of this (target continuity), not
#    actual generated tutoring text (which needs a real model call).
# ---------------------------------------------------------------------------

def test_quiz_wrong_attempt_turn_loses_explicit_target_but_stays_disclosure_safe():
    """Turn 2 of a quiz exchange ("Ist es 40 N?", a terse confirmatory
    reply to the tutor's own question) is classified relation=NEW_TOPIC
    by the deterministic dialogue resolver (no lexical continuation
    signal of its own), which triggers the existing new-topic history
    isolation guard and discards the carried-over active_question
    ("5a") for grounding purposes -- the resolved target degrades to the
    "current_request" placeholder, state="unresolved". This is a real,
    confirmed CONTINUITY gap (the intent layer does not reliably know
    turn 2 is still about "5a"), but NOT a disclosure-safety gap: an
    unresolved state still forces final_answer="prohibited" and
    wait_for_student=True via the same safety net proven above, so the
    wrong attempt is not confirmed and the real answer is not leaked
    purely from the intent-layer side. Whether the GENERATED reply
    correctly says "not quite, try again" rather than something else
    depends on the model's own use of conversation history, same
    prompt-only enforcement level as the rest of this layer -- not
    verifiable without a real model call."""
    turns = [
        {"role": "user", "text": "Frag mich Aufgabe 5a ab."},
        {"role": "assistant", "text": "Welche Kraft wirkt entlang der Ebene fuer Aufgabe 5a? Versuche es mal."},
    ]
    policy = _compile_for(
        "Ist es 40 N?", previous_turns=turns, authorized_exercise_labels=frozenset({"5a"}),
    )
    action = policy.actions[0]
    assert action.target == "current_request"
    assert action.state == "unresolved"
    assert action.release.final_answer == "prohibited"
    assert action.release.wait_for_student is True


# ---------------------------------------------------------------------------
# 3. Does the new intent policy's prompt overlay agree with, or
#    contradict, the existing QUIZ_CONTRACT overlay?
# ---------------------------------------------------------------------------

def test_policy_overlay_and_quiz_contract_coexist_with_no_mutual_exclusion_guard():
    """Confirmed by direct code reading (app/services/answer_stream.py):
    render_execution_policy_overlay's output is appended unconditionally
    whenever execution_policy is not None (line ~1891, BEFORE
    is_quiz_request is even computed), and QUIZ_CONTRACT is appended
    unconditionally whenever a workspace_block exists and the request
    isn't problem_solver mode (line ~2143) -- neither is gated on the
    other's presence or absence. For a quiz request with a resolvable
    target, this means the SAME system prompt simultaneously carries
    "respond with a HINT only, not a worked solution" (the compiled
    policy's hint-objective fallback) and "BUILD IT INLINE... end your
    answer with ONE fenced quiz block" (QUIZ_CONTRACT) with its
    multi-question-with-explanations shape. These are in real tension --
    a hint-only instruction with no worked content, versus an
    instruction to construct complete MCQ questions with explanations
    grounded in the material. This test proves the coexistence (both
    instructions are demonstrably present together); it does not,
    and cannot without a live model call, prove how a real model
    resolves that tension in practice."""
    policy = _compile_for("Quiz me on exercise 5a.", authorized_exercise_labels=frozenset({"5a"}))
    overlay = render_execution_policy_overlay(policy)
    assert "respond with a HINT only" in overlay

    academic_intent = classify_academic_intent("Quiz me on exercise 5a.")
    system_prompt, _label = pick_system_prompt(
        "Quiz me on exercise 5a.", "strong", [], tutor_mode="explain", intent=academic_intent,
    )
    assert "quiz generation" in system_prompt.lower()
    assert "BUILD IT INLINE" in QUIZ_CONTRACT

    # Concatenated in the same order app/services/answer_stream.py actually
    # builds it: pick_system_prompt's own blocks, then the policy overlay,
    # then (unconditionally, elsewhere) QUIZ_CONTRACT.
    combined = system_prompt + overlay + QUIZ_CONTRACT
    assert "respond with a HINT only" in combined and "BUILD IT INLINE" in combined


def test_quiz_lane_bypasses_the_release_validator_entirely():
    """Confirmed by direct code reading: app/services/answer_stream.py's
    `elif is_quiz_request:` branch runs its OWN independent re-derivation
    (quiz.py's verify_and_correct_inline_quiz, checking MCQ answer-key
    correctness) and streams the result directly -- it never calls
    enforce_release_policy_single_target/enforce_release_policy_per_
    target/scan_generated_answer_for_prohibited_release at all. So the
    compiled execution_policy's final_answer/wait_for_student fields
    (items 1-2 above) currently only ever reach the model as PROMPT TEXT
    for a quiz request -- there is no independent, deterministic backstop
    checking that a quiz's own prose (outside the MCQ block's hidden
    answer index) didn't separately leak the result, the way there is
    for every other single/multi-target policy. This is the same
    "prompt-overlay only" enforcement level the rest of this layer
    already documents as a known limitation (see answer_release_
    validator.py's own module docstring) -- not a new regression, and
    not fixed here (verification-only pass, no quiz-lane code change)."""
    import inspect
    from app.services import answer_stream

    source = inspect.getsource(answer_stream)
    quiz_branch_start = source.index("elif is_quiz_request:")
    # The next ~600 chars of the quiz branch (verify_and_correct_inline_quiz
    # call + streaming loop) contain no release-validator call.
    quiz_branch = source[quiz_branch_start:quiz_branch_start + 600]
    assert "verify_and_correct_inline_quiz" in quiz_branch
    assert "enforce_release_policy" not in quiz_branch
    assert "scan_generated_answer_for_prohibited_release" not in quiz_branch
