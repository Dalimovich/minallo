"""Phase D adversarial test plan (Milestone 1 report §7): for each of
prose, a markdown table cell, LaTeX, a "let's check our work" framing,
and an official-solution phrase, construct a fixture where the generated
text leaks a prohibited final answer/official solution despite the
compiled policy prohibiting it — assert the VALIDATOR catches it, not
the prompt. Also proves the converse: permitted content and off-topic
numbers never false-positive, and no-restriction policies never
interfere at all."""

from app.services.answer_release_validator import (
    scan_generated_answer_for_prohibited_release,
)
from app.services.policy_compiler import ExecutionPolicy
from app.services.resolved_student_intent import Action, ReleaseConstraints


def _policy(final_answer="prohibited", official_solution="unspecified", target="5a") -> ExecutionPolicy:
    return ExecutionPolicy(
        actions=(Action(
            objective="solve", target=target,
            release=ReleaseConstraints(final_answer=final_answer, official_solution=official_solution),
        ),),
        evidence_requirements=(), needs_clarification=False, clarification_question=None,
        response_language="en", response_language_reason="default", platform_policy_applied=(),
        policy_version="1.0.0", compiler_version="1.0.0", policy_hash="deadbeef",
    )


def test_leak_in_plain_prose_is_caught():
    text = "Let's work through the method step by step. The final answer is 42 N, as derived above."
    result = scan_generated_answer_for_prohibited_release(text, policy=_policy())
    assert result.allowed is False
    assert "final_answer_phrase" in result.matched_patterns


def test_leak_in_markdown_table_cell_is_caught():
    text = "Here is a summary:\n\n| Quantity | Value |\n|---|---|\n| Final Answer | 42 N |\n"
    result = scan_generated_answer_for_prohibited_release(text, policy=_policy())
    assert result.allowed is False
    assert "result_table_row" in result.matched_patterns


def test_leak_in_latex_boxed_result_is_caught():
    text = r"After simplifying, we get \boxed{42\,\text{N}}."
    result = scan_generated_answer_for_prohibited_release(text, policy=_policy())
    assert result.allowed is False
    assert "boxed_or_labeled_result" in result.matched_patterns


def test_leak_via_verification_framing_is_caught():
    text = "Let's check our work: plugging back in gives 42 N, which matches."
    result = scan_generated_answer_for_prohibited_release(text, policy=_policy())
    assert result.allowed is False
    assert "verification_framing_with_number" in result.matched_patterns


def test_official_solution_phrase_is_caught_when_prohibited():
    text = "Here is the official solution to this exercise, as provided by the instructor."
    result = scan_generated_answer_for_prohibited_release(
        text, policy=_policy(final_answer="unspecified", official_solution="prohibited"),
    )
    assert result.allowed is False
    assert "official_solution_phrase" in result.matched_patterns


def test_german_leak_phrase_is_caught():
    text = "Das Ergebnis ist 42 N, wie oben berechnet."
    result = scan_generated_answer_for_prohibited_release(text, policy=_policy())
    assert result.allowed is False


def test_hint_only_response_with_no_leak_is_allowed():
    text = "Think about which forces act on the beam. What equation balances moments here?"
    result = scan_generated_answer_for_prohibited_release(text, policy=_policy())
    assert result.allowed is True
    assert result.matched_patterns == ()


def test_permitted_final_answer_is_never_scanned():
    """A policy that PERMITS the final answer must never trigger this
    scan at all, regardless of what the text contains."""
    text = "The final answer is 42 N."
    result = scan_generated_answer_for_prohibited_release(
        text, policy=_policy(final_answer="permitted"),
    )
    assert result.allowed is True
    assert result.reason == "no_restriction"


def test_no_policy_is_never_scanned():
    text = "The final answer is 42 N."
    result = scan_generated_answer_for_prohibited_release(text, policy=None)
    assert result.allowed is True
    assert result.reason == "no_policy"


def test_unrelated_numbers_do_not_false_positive():
    """A number appearing for an unrelated reason (e.g. referencing a
    page or equation number) must not trip the scan on its own -- only
    the specific leak-shaped patterns should."""
    text = "See equation 4.2 on page 12 for the general method; apply it to this exercise."
    result = scan_generated_answer_for_prohibited_release(text, policy=_policy())
    assert result.allowed is True


def test_safe_withheld_answer_text_is_language_aware():
    from app.services.answer_release_validator import safe_withheld_answer_text

    en = safe_withheld_answer_text(response_language="en")
    de = safe_withheld_answer_text(response_language="de")
    assert "withholding" in en.lower()
    assert "zurück" in de.lower()
