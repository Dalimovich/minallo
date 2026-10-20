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


def test_quiz_with_resolvable_target_sets_wait_for_student_explicitly():
    """Fixed (2026-10-20 correction pass): for a quiz request whose
    target DOES resolve (a recognized exercise label, e.g. "5a"),
    adapt_deterministic_intent now sets wait_for_student=True as an
    explicit, trusted value whenever the deterministic classifier's
    primary_task is QUIZ_GENERATION -- independent of whether the
    target resolves -- not left to the "unresolved target" safety net
    that only coincidentally covered the literal AB-24 message (see
    the companion test below, now a non-regression check for that same
    safety net on top of this explicit value)."""
    policy = _compile_for("Quiz me on exercise 5a.", authorized_exercise_labels=frozenset({"5a"}))
    action = policy.actions[0]
    assert action.objective == "hint"
    assert action.state == "requested"
    assert action.release.final_answer == "prohibited"
    assert action.release.wait_for_student is True
    assert action.release.form == "guided_questions"  # item 3's fix, not the shared "hint" default


def test_quiz_with_unresolved_target_gets_wait_for_student_via_the_safety_net():
    """The EXACT AB-24 message ("Frag mich die Lagerkraft R_A ab.") has
    no recognized exercise-label target ("R_A" is a quantity name, not
    an exercise label) and no prior active_question, so it resolves
    state="unresolved" -- policy_compiler's pre-existing unresolved-state
    fallback forces EVERY field to its most-restrictive legal value,
    including wait_for_student=True, regardless of objective. Now
    doubly covered: adapt_deterministic_intent's explicit quiz
    wait_for_student=True (see the companion test above) would carry
    this target even if it DID resolve -- this test pins the
    unresolved-target case specifically, so neither mechanism's removal
    regresses the other."""
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

def test_quiz_short_answer_attempt_preserves_active_target_in_isolation():
    """Fixed (2026-10-20 correction pass): dialogue_state.py now
    recognizes a bare numeric/short guess ("Ist es 40 N?") as a
    CONTINUATION (DialogueAct.CHECK_ANSWER, reused rather than a new
    act) when there is an active exercise/question in play, instead of
    the default NEW_TOPIC classification that used to trigger the
    unrelated-topic isolation guard and discard the target. Target
    continuity is now correctly preserved by the dialogue layer itself.

    Taken alone (bare adapt_deterministic_intent, no cross-turn
    persistence), this message's own objective ("answer_subquestion",
    not "hint"/"explain") would compile to final_answer="permitted" --
    see the companion real-orchestrator test below for why that is NOT
    what actually happens end to end: this isolated call is not
    representative of a real multi-turn request, which always goes
    through semantic_intent_orchestrator's persisted-restriction merge."""
    turns = [
        {"role": "user", "text": "Frag mich Aufgabe 5a ab."},
        {"role": "assistant", "text": "Welche Kraft wirkt entlang der Ebene fuer Aufgabe 5a? Versuche es mal."},
    ]
    policy = _compile_for(
        "Ist es 40 N?", previous_turns=turns, authorized_exercise_labels=frozenset({"5a"}),
    )
    action = policy.actions[0]
    assert action.target == "5a"
    assert action.state == "requested"
    assert action.release.final_answer == "permitted"  # the isolated-call risk, explained above


def test_quiz_wrong_then_right_answer_stays_disclosure_safe_through_real_orchestrator():
    """The REAL, full 3-turn exchange (what actually runs in production)
    via semantic_intent_orchestrator.interpret_turn_authoritatively,
    with each turn's persisted restriction (extract_persistable_
    restrictions) fed back in as the next turn's durable history --
    exactly how app/routers/stream.py uses this module. Turn 1 opens the
    quiz (final_answer=prohibited, wait_for_student=True, target "5a").
    Turn 2 is a wrong guess ("Ist es 40 N?"); turn 3 is the correct
    value ("Ist es 75 N?"). Both turns 2 and 3 now correctly resolve
    target="5a" (the dialogue_state.py fix) AND, despite each turn's own
    classified objective being "answer_subquestion" (not "hint"), the
    persisted turn-1 restriction for "5a" is found and wins via policy_
    compiler's existing cross-turn recency rule -- final_answer stays
    prohibited and wait_for_student stays true for BOTH the wrong and
    the correct guess.

    Honest limitation, not fixed here (out of this pass's scope --
    would need real numeric-correctness grading, not a keyword patch):
    the deterministic layer has no notion of whether "75 N" is actually
    correct, so it does not auto-relax to final_answer="permitted" on
    the correct guess either. Whether the actual generated reply
    correctly confirms a right answer and correctly declines to confirm
    a wrong one is a model-generation question this offline pass cannot
    answer -- it needs a real model call."""
    from app.services.dialogue_state import resolve_dialogue
    from app.services.semantic_intent_orchestrator import interpret_turn_authoritatively

    labels = frozenset({"5a"})

    def _turn(question, *, preflight, rows):
        dialogue = resolve_dialogue(question, previous_turns=preflight)
        return interpret_turn_authoritatively(
            question=question, dialogue_base=dialogue, preflight_turns=preflight,
            user_id="u1", conversation_id="conv-1",
            validate_ownership=lambda **_: True, get_messages=lambda **_: rows,
            resolved_access=None, has_visible_context=False,
            authorized_exercise_labels=labels,
        )

    result1 = _turn("Frag mich Aufgabe 5a ab.", preflight=[], rows=[])
    a1 = result1.execution_policy.actions[0]
    assert a1.target == "5a" and a1.release.final_answer == "prohibited" and a1.release.wait_for_student is True
    row1 = {"client_message_id": "t1", "request_snapshot": {"policyByTarget": result1.compiled_policy_by_target}}

    turns_after_1 = [
        {"role": "user", "text": "Frag mich Aufgabe 5a ab."},
        {"role": "assistant", "text": "Welche Kraft wirkt entlang der Ebene fuer Aufgabe 5a? Versuche es mal."},
    ]
    result2 = _turn("Ist es 40 N?", preflight=turns_after_1, rows=[row1])
    a2 = result2.execution_policy.actions[0]
    assert a2.target == "5a", "wrong-guess turn must not lose the quiz target"
    assert a2.release.final_answer == "prohibited", "a wrong guess must not be confirmed or leak the real answer"
    row2 = {"client_message_id": "t2", "request_snapshot": {"policyByTarget": result2.compiled_policy_by_target}}

    turns_after_2 = turns_after_1 + [
        {"role": "user", "text": "Ist es 40 N?"},
        {"role": "assistant", "text": "Nicht ganz, versuch es nochmal."},
    ]
    result3 = _turn("Ist es 75 N?", preflight=turns_after_2, rows=[row1, row2])
    a3 = result3.execution_policy.actions[0]
    assert a3.target == "5a", "correct-guess turn must still resolve the same quiz target"
    assert a3.release.final_answer == "prohibited"  # see docstring: no numeric grading in this layer


# ---------------------------------------------------------------------------
# 3. Does the new intent policy's prompt overlay agree with, or
#    contradict, the existing QUIZ_CONTRACT overlay?
# ---------------------------------------------------------------------------

def test_policy_overlay_and_quiz_contract_no_longer_contradict():
    """Fixed (2026-10-20 correction pass): render_execution_policy_
    overlay's output and QUIZ_CONTRACT are still both appended
    unconditionally (app/services/answer_stream.py, ~lines 1891/2143 --
    neither is gated on the other, by design: this fix resolves the
    CONTENT conflict, not by adding a mutual-exclusion guard between two
    overlays that have other legitimate reasons to coexist). What
    changed is the CONTENT: a quiz action's form is now explicitly
    "guided_questions" (not the shared hint-objective fallback's
    "hint"), which renders as "respond with guiding questions, not a
    direct answer" -- compatible with QUIZ_CONTRACT's "build a quiz"
    instruction, not contradicting it. The old contradictory phrase
    ("respond with a HINT only, not a worked solution") no longer
    appears for a quiz action at all.

    This test proves the system PROMPT TEXT is now internally
    consistent; it does not, and cannot without a live model call,
    prove how a real model behaves given that consistent prompt."""
    policy = _compile_for("Quiz me on exercise 5a.", authorized_exercise_labels=frozenset({"5a"}))
    overlay = render_execution_policy_overlay(policy)
    assert "respond with guiding questions, not a direct answer" in overlay
    assert "respond with a HINT only" not in overlay

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
    assert "respond with a HINT only" not in combined
    assert "respond with guiding questions" in combined and "BUILD IT INLINE" in combined


def test_quiz_output_is_release_scanned_at_the_router_layer_not_bypassed():
    """CORRECTION to this session's earlier verification pass, which
    wrongly concluded the quiz lane "bypasses the release validator
    entirely" from reading only app/services/answer_stream.py's
    `elif is_quiz_request:` branch (~600 chars: true in isolation --
    that branch itself never calls the validator). That was incomplete:
    app/routers/stream.py's OUTER consumption loop buffers and scans
    `full_text_buf` whenever `policy_has_release_restriction` is true
    (derived purely from `execution_policy`, with NO is_quiz_request
    awareness at that layer at all -- confirmed by grep, zero matches),
    for every token any inner lane (quiz, exam, ordinary) yields. Since
    a quiz action now correctly compiles final_answer="prohibited"
    (this session's items 1/3 fixes), quiz output DOES reach the real
    release gate -- confirmed here by source inspection of BOTH layers
    together, and by test_inline_quiz_block_explanation_is_not_treated_
    as_a_leak / test_leaky_intro_before_an_inline_quiz_block_is_still_
    caught in test_answer_release_validator.py, which prove the actual
    scan behavior (item 4's fix: a ```minallo-quiz fenced block's own
    legitimate explanation text is excluded from the leak scan, while a
    leaky intro sentence before it is still caught)."""
    import inspect
    from app.routers import stream as stream_router

    router_source = inspect.getsource(stream_router)
    assert "is_quiz_request" not in router_source, (
        "router layer must stay lane-agnostic -- the fix lives in the "
        "shared scan (quiz-fence stripping), not a new is_quiz_request "
        "branch in the router"
    )
    assert "policy_has_release_restriction" in router_source
    assert "buffer_answer_output" in router_source
    assert "enforce_release_policy_single_target" in router_source
