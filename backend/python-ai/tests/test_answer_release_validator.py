"""Phase D adversarial test plan (Milestone 1 report §7): for each of
prose, a markdown table cell, LaTeX, a "let's check our work" framing,
and an official-solution phrase, construct a fixture where the generated
text leaks a prohibited final answer/official solution despite the
compiled policy prohibiting it — assert the VALIDATOR catches it, not
the prompt. Also proves the converse: permitted content and off-topic
numbers never false-positive, and no-restriction policies never
interfere at all."""

import pytest

from app.services.answer_release_validator import (
    enforce_release_policy,
    enforce_release_policy_per_target,
    parse_target_sections,
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


def _mixed_policy(*actions: Action) -> ExecutionPolicy:
    return ExecutionPolicy(
        actions=actions, evidence_requirements=(), needs_clarification=False, clarification_question=None,
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


# ---------------------------------------------------------------------------
# enforce_release_policy — the actual fail-closed decision stream.py's
# generation cascade calls. Critically different from the scan above: it
# must withhold a restricted candidate even when NO known leak pattern
# matches at all, because "no_match" is not proof of a safe answer (see
# the module's own docstring).
# ---------------------------------------------------------------------------

def test_enforce_release_policy_withholds_even_without_a_pattern_match():
    """The exact defect this function exists to close: a clean-looking
    draft with no recognizable leak SHAPE (no "final answer is", no
    boxed{}, no table, no verification framing) must still be withheld
    when the policy prohibits it -- scan_generated_answer_for_prohibited_
    release alone would wrongly call this 'allowed' (see
    test_hint_only_response_with_no_leak_is_allowed above, which is
    correct for the low-level scanner but must never be read as "safe to
    release")."""
    text = "The beam carries 42 N at the support."
    decision = enforce_release_policy(text, policy=_policy(), response_language="en")
    assert decision.withheld is True
    assert decision.text != text
    assert "withholding" in decision.text.lower()
    # The underlying scan is still computed (for observability) and, as
    # expected, found no known pattern -- proving the withholding here
    # came from the restriction itself, not from a pattern match.
    assert decision.scan.reason == "no_match"
    assert decision.scan.allowed is True


def test_enforce_release_policy_withholds_a_known_leak_pattern_too():
    text = "The final answer is 42 N."
    decision = enforce_release_policy(text, policy=_policy(), response_language="en")
    assert decision.withheld is True
    assert decision.text != text
    assert decision.scan.allowed is False
    assert decision.scan.reason == "matched_leak_pattern"


def test_enforce_release_policy_passes_through_when_permitted():
    text = "The final answer is 42 N."
    decision = enforce_release_policy(
        text, policy=_policy(final_answer="permitted"), response_language="en",
    )
    assert decision.withheld is False
    assert decision.text == text
    assert decision.scan.reason == "no_restriction"


def test_enforce_release_policy_passes_through_with_no_policy_at_all():
    text = "The final answer is 42 N."
    decision = enforce_release_policy(text, policy=None, response_language="en")
    assert decision.withheld is False
    assert decision.text == text
    assert decision.scan.reason == "no_policy"


def test_enforce_release_policy_is_language_aware():
    decision_de = enforce_release_policy(
        "Das Ergebnis ist 42 N.", policy=_policy(), response_language="de",
    )
    assert "zurück" in decision_de.text.lower()


def test_safe_withheld_answer_text_is_language_aware():
    from app.services.answer_release_validator import safe_withheld_answer_text

    en = safe_withheld_answer_text(response_language="en")
    de = safe_withheld_answer_text(response_language="de")
    assert "withholding" in en.lower()
    assert "zurück" in de.lower()


# ---------------------------------------------------------------------------
# Priority 2 — parse_target_sections. Strict: ANY structural ambiguity
# returns None, never a partial/best-effort parse.
# ---------------------------------------------------------------------------

_WELL_FORMED = (
    "[[TARGET: 5a]]\n"
    "The final answer is 42 N.\n"
    "[[TARGET: 5b]]\n"
    "Think about which forces balance here.\n"
    "[[END]]\n"
)


def test_parse_well_formed_two_section_text():
    sections = parse_target_sections(_WELL_FORMED, frozenset({"5a", "5b"}))
    assert sections == {
        "5a": "The final answer is 42 N.",
        "5b": "Think about which forces balance here.",
    }


def test_parse_rejects_text_before_first_marker():
    text = "Sure, here goes.\n" + _WELL_FORMED
    assert parse_target_sections(text, frozenset({"5a", "5b"})) is None


def test_parse_rejects_text_after_end_marker():
    text = _WELL_FORMED + "Hope that helps!"
    assert parse_target_sections(text, frozenset({"5a", "5b"})) is None


def test_parse_rejects_missing_end_marker():
    text = _WELL_FORMED.replace("[[END]]\n", "")
    assert parse_target_sections(text, frozenset({"5a", "5b"})) is None


def test_parse_rejects_duplicate_target_marker():
    text = (
        "[[TARGET: 5a]]\nFirst.\n[[TARGET: 5a]]\nSecond.\n[[TARGET: 5b]]\nThird.\n[[END]]\n"
    )
    assert parse_target_sections(text, frozenset({"5a", "5b"})) is None


def test_parse_rejects_missing_expected_target():
    """Only 5a is sectioned even though the policy also covers 5b."""
    text = "[[TARGET: 5a]]\nOnly this.\n[[END]]\n"
    assert parse_target_sections(text, frozenset({"5a", "5b"})) is None


def test_parse_rejects_unexpected_extra_target():
    text = _WELL_FORMED.replace("[[END]]\n", "[[TARGET: 5c]]\nExtra.\n[[END]]\n")
    assert parse_target_sections(text, frozenset({"5a", "5b"})) is None


def test_parse_rejects_text_with_no_markers_at_all():
    assert parse_target_sections("Just a normal answer, no markers.", frozenset({"5a", "5b"})) is None


# ---------------------------------------------------------------------------
# Priority 2, REVISED — enforce_release_policy_per_target. A prior version
# of this suite proved a "clean split" path: 5a's permitted content kept,
# only 5b's replaced. That path trusted a model-written [[TARGET: ...]]
# marker as proof of attribution and a clean regex scan as proof of no
# cross-target leak -- both wrong (see test_maximally_evasive_smuggling_
# is_withheld_by_the_disabled_path below, and the module docstring's
# "REVISED after further review" note). The permissive partial-release
# path is now DISABLED entirely: every mixed-permission policy with any
# restricted target falls back to the SAME unconditional whole-response
# guard as enforce_release_policy, regardless of how cleanly the text
# sections, because section position was never independent evidence that
# the content inside belongs to -- or is free of -- a restricted target.
# ---------------------------------------------------------------------------

def _mixed_5a_permitted_5b_prohibited() -> ExecutionPolicy:
    return _mixed_policy(
        Action(objective="solve", target="5a", state="requested",
               release=ReleaseConstraints(final_answer="permitted")),
        Action(objective="hint", target="5b", state="requested",
               release=ReleaseConstraints(final_answer="prohibited", form="hint")),
    )


def test_per_target_clean_split_is_withheld_whole_since_partial_release_is_disabled():
    """Former 'central deliverable' case ('give 5a the full answer, only a
    hint for 5b') -- now proves the SAFE outcome: because independently
    verifying that 5a's section is actually free of 5b's result isn't
    possible from plain text, this is withheld whole, exactly like any
    other restricted policy. Neither number reaches the final text."""
    policy = _mixed_5a_permitted_5b_prohibited()
    text = (
        "[[TARGET: 5a]]\n"
        "Working through the moment balance, the final answer is 42 N.\n"
        "[[TARGET: 5b]]\n"
        "The final answer is 17 N, as derived above.\n"
        "[[END]]\n"
    )
    decision = enforce_release_policy_per_target(text, policy=policy, response_language="en")
    assert decision.structural is False
    assert decision.withheld is True
    assert decision.sections == ()
    assert "17" not in decision.text
    assert "42" not in decision.text  # 5a's content is withheld too -- the honest, safe degrade


def test_per_target_withholds_whole_even_without_a_leak_pattern_match():
    """Mirrors enforce_release_policy's own core guarantee
    (test_enforce_release_policy_withholds_even_without_a_pattern_match):
    a restricted target's content must be withheld UNCONDITIONALLY, never
    only when a known leak phrase happens to match -- now proven at the
    whole-response level, since the per-section path is disabled."""
    policy = _mixed_5a_permitted_5b_prohibited()
    text = (
        "[[TARGET: 5a]]\n"
        "The beam carries 42 N at the support.\n"  # no recognizable leak SHAPE
        "[[TARGET: 5b]]\n"
        "The beam carries 17 N at the support.\n"  # no recognizable leak SHAPE
        "[[END]]\n"
    )
    decision = enforce_release_policy_per_target(text, policy=policy, response_language="en")
    assert decision.withheld is True
    assert decision.scan.reason == "no_match"  # confirms it wasn't pattern-triggered
    assert "17" not in decision.text
    assert "42" not in decision.text


def test_per_target_falls_back_whole_on_structurally_invalid_text():
    """The model ignored the sectioning contract (or malformed it) --
    this must fall back to the EXISTING whole-response guard, never a
    half-trusted partial split."""
    policy = _mixed_5a_permitted_5b_prohibited()
    text = "5a: the answer is 42 N. 5b: here's a hint about moments."
    decision = enforce_release_policy_per_target(text, policy=policy, response_language="en")
    assert decision.structural is False
    assert decision.withheld is True
    assert decision.sections == ()
    whole = enforce_release_policy(text, policy=policy, response_language="en")
    assert decision.text == whole.text


def test_per_target_falls_back_whole_on_cross_target_leak_crossover():
    """5a's own section mentions 5b's label alongside a leak-shaped
    phrase -- the concrete sign of a crossed-over/mislabeled answer.
    Must never be trusted as a clean split."""
    policy = _mixed_5a_permitted_5b_prohibited()
    text = (
        "[[TARGET: 5a]]\n"
        "The final answer is 42 N. By the way, for 5b the final answer is 17 N too.\n"
        "[[TARGET: 5b]]\n"
        "Think about the forces.\n"
        "[[END]]\n"
    )
    decision = enforce_release_policy_per_target(text, policy=policy, response_language="en")
    assert decision.structural is False
    assert decision.withheld is True
    assert "17" not in decision.text
    assert "42" not in decision.text  # whole response withheld, not just 5b's leak


def test_per_target_delegates_exactly_for_single_target_policy():
    """Not a mixed-permission policy (only one target) -- must behave
    byte-identically to enforce_release_policy, the legacy/non-mixed
    parity guarantee."""
    policy = _policy()
    text = "The beam carries 42 N at the support."
    per_target = enforce_release_policy_per_target(text, policy=policy, response_language="en")
    whole = enforce_release_policy(text, policy=policy, response_language="en")
    assert per_target.text == whole.text
    assert per_target.withheld == whole.withheld
    assert per_target.structural is False
    assert per_target.sections == ()


def test_per_target_delegates_exactly_for_uniformly_permitted_policy():
    policy = _mixed_policy(
        Action(objective="solve", target="5a", release=ReleaseConstraints(final_answer="permitted")),
        Action(objective="solve", target="5b", release=ReleaseConstraints(final_answer="permitted")),
    )
    text = "5a is 42 N and 5b is 17 N."
    per_target = enforce_release_policy_per_target(text, policy=policy, response_language="en")
    whole = enforce_release_policy(text, policy=policy, response_language="en")
    assert per_target.text == whole.text == text
    assert per_target.withheld is False
    assert per_target.structural is False


def test_per_target_delegates_exactly_with_no_policy_at_all():
    text = "The final answer is 42 N."
    per_target = enforce_release_policy_per_target(text, policy=None, response_language="en")
    assert per_target.text == text
    assert per_target.withheld is False
    assert per_target.structural is False


# ---------------------------------------------------------------------------
# Cross-target leakage via section markers — adversarial cases (coordinator
# review), now proving the SAFE outcome under the disabled permissive
# path: a section marker is a structural fact about WHERE text sits,
# never independent proof of WHAT it is about, so every one of these
# laundered-leak shapes (and the one that used to slip through
# completely untouched) is now caught the same way -- trivially, by the
# unconditional whole-response guard, which never needed to understand
# the laundering shape at all. That uniformity IS the point: safety no
# longer depends on a growing, inherently incomplete list of regex
# shapes catching every evasion.
# ---------------------------------------------------------------------------

def test_per_target_catches_unlabeled_cross_reference_smuggling():
    """The exact coordinator-supplied attack: 5b's prohibited result is
    narrated inside 5a's (permitted) section via a generic 'the second
    part' reference, never naming '5b' and never matching the strict
    final_answer_phrase shape ('the value is 17 N', not 'the answer is
    17 N'). Previously relied on a broadened regex heuristic to catch
    this specifically; now caught unconditionally, with no heuristic
    needed, because the whole response is withheld whenever ANY target
    is restricted."""
    policy = _mixed_5a_permitted_5b_prohibited()
    text = (
        "[[TARGET: 5a]]\n"
        "The answer to 5a is 42 N.\n"
        "Also, for the second part, the value is 17 N.\n"
        "[[TARGET: 5b]]\n"
        "Try applying the formula.\n"
        "[[END]]\n"
    )
    decision = enforce_release_policy_per_target(text, policy=policy, response_language="en")
    assert decision.structural is False  # fell back whole, not a trusted partial split
    assert decision.withheld is True
    assert "17" not in decision.text
    assert "42" not in decision.text  # safe degrade: even 5a's genuine content is withheld


def test_per_target_catches_german_cross_reference_smuggling():
    """Same laundering pattern, German phrasing ('für den zweiten Teil')
    and no target label at all -- caught unconditionally, same as above."""
    policy = _mixed_5a_permitted_5b_prohibited()
    text = (
        "[[TARGET: 5a]]\n"
        "Die Antwort für 5a ist 42 N.\n"
        "Außerdem beträgt der Wert für den zweiten Teil 17 N.\n"
        "[[TARGET: 5b]]\n"
        "Überlege, welche Kräfte hier wirken.\n"
        "[[END]]\n"
    )
    decision = enforce_release_policy_per_target(text, policy=policy, response_language="en")
    assert decision.structural is False
    assert decision.withheld is True
    assert "17" not in decision.text


def test_per_target_catches_result_table_naming_the_other_target():
    """A table row that DOES name the restricted target directly -- the
    original (narrower) labeled-leak shape, still caught, now
    unconditionally rather than via a label-matching heuristic."""
    policy = _mixed_5a_permitted_5b_prohibited()
    text = (
        "[[TARGET: 5a]]\n"
        "Summary:\n\n| Quantity | Value |\n|---|---|\n| 5a final answer | 42 N |\n"
        "| 5b final answer | 17 N |\n"
        "[[TARGET: 5b]]\n"
        "Think about the forces.\n"
        "[[END]]\n"
    )
    decision = enforce_release_policy_per_target(text, policy=policy, response_language="en")
    assert decision.structural is False
    assert decision.withheld is True
    assert "17" not in decision.text


def test_maximally_evasive_smuggling_is_withheld_now_that_partial_release_is_disabled():
    """THE regression this task exists to fix: a smuggled value with ZERO
    connecting language and ZERO mention of the other target's label used
    to be textually indistinguishable from 5a's own genuine content, and
    the old cross-target-leak heuristic did NOT catch it -- the prohibited
    '17 N' used to survive into the final text (see git history / the
    module docstring's "REVISED after further review" note for the prior,
    unsafe version of this exact test). With the permissive per-target
    path disabled entirely, this input now gets the SAME safe,
    unconditional whole-response withhold as every other restricted
    policy -- there is no longer a heuristic to evade."""
    policy = _mixed_5a_permitted_5b_prohibited()
    text = (
        "[[TARGET: 5a]]\n"
        "The answer to 5a is 42 N. 17 N.\n"
        "[[TARGET: 5b]]\n"
        "Think about the forces.\n"
        "[[END]]\n"
    )
    decision = enforce_release_policy_per_target(text, policy=policy, response_language="en")
    assert decision.structural is False
    assert decision.withheld is True
    assert decision.sections == ()
    assert "17 N" not in decision.text
    assert "42 N" not in decision.text


@pytest.mark.parametrize("evasive_text", [
    # No connecting language, no label, the number simply appended.
    "[[TARGET: 5a]]\nThe answer to 5a is 42 N. 17 N.\n[[TARGET: 5b]]\nThink about the forces.\n[[END]]\n",
    # A parenthetical aside, still no label and no cross-reference phrase.
    "[[TARGET: 5a]]\nThe answer to 5a is 42 N (also 17 N).\n[[TARGET: 5b]]\nThink about the forces.\n[[END]]\n",
    # The smuggled number placed in 5b's own section but with 5a's label,
    # inverted from the main case -- still must never survive.
    "[[TARGET: 5a]]\nThink about the forces.\n[[TARGET: 5b]]\n17 N.\n[[END]]\n",
])
def test_equivalent_evasive_variants_never_leak_the_prohibited_number(evasive_text):
    """Task-required coverage for 'equivalent evasive variants', not just
    the one worked example above."""
    policy = _mixed_5a_permitted_5b_prohibited()
    decision = enforce_release_policy_per_target(evasive_text, policy=policy, response_language="en")
    assert decision.withheld is True
    assert "17" not in decision.text
