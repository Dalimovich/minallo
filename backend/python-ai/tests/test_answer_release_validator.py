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
    extract_protected_values_from_evidence,
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


def test_leak_as_markdown_heading_with_bullet_assignments_is_caught():
    """Confirmed disguised-leak shape (independent A/B eval, AB-02/AB-03
    forensic pass, 2026-10-20): a "### Results"-style heading followed
    by bullet-point variable assignments carried none of the other
    patterns' prose cues and passed this scan completely uncaught
    before this fix (one of the eval's six documented xfails -- an
    answer-release enforcement gap, not a semantic-escalation one)."""
    text = "### Results\n- R_A = 75 N\n- R_B = 25 N\n\nThis follows from the equilibrium equations."
    result = scan_generated_answer_for_prohibited_release(text, policy=_policy())
    assert result.allowed is False
    assert "markdown_heading_bullet_result" in result.matched_patterns


def test_bare_bullet_list_of_given_values_under_unrelated_heading_is_not_a_false_positive():
    """Non-regression: the new heading+bullet pattern requires a
    RESULT-shaped heading specifically -- an innocent bullet list of a
    problem's GIVEN values (not a result), under no heading or an
    unrelated one, must not trip it."""
    text = "Let's list the givens:\n- m = 10 kg\n- g = 9.81 m/s^2\n- angle = 30 degrees\nNow find F_parallel."
    result = scan_generated_answer_for_prohibited_release(text, policy=_policy())
    assert result.allowed is True
    assert "markdown_heading_bullet_result" not in result.matched_patterns


# ===========================================================================
# Value-grounded detection (2026-10-20 comprehensive remediation). All
# three real disclosures in the five-scenario live evaluation (AB-24,
# AB-03, the 3-turn quiz scenario) stated the protected result as an
# ordinary concluding sentence or a LaTeX expression with no trigger word
# any existing pattern looks for -- confirmed to pass this scan
# completely uncaught. A narrower "symbol ≈ number" pattern was tried and
# rejected (confirmed, by direct test, to false-positive on ordinary
# physical-constant restatements like "g ≈ 9.81 m/s^2"). This is the
# independent, value-grounded signal added instead.
# ===========================================================================

_MECH1_EVIDENCE = (
    "[Aufgabe 1] Balken AB, 4 m lang, Lager A (fest) und B (Rolle), "
    "Einzellast 100 N bei 1 m ab A. Gesucht: R_A, R_B. "
    "Lösung: R_A = 75 N, R_B = 25 N (ΣM_A: R_B*4=100*1 -> R_B=25N; ΣF_v: R_A=100-25=75N)"
)


def test_extract_protected_values_reads_only_the_solution_segment():
    values = extract_protected_values_from_evidence(_MECH1_EVIDENCE)
    assert "75" in values and "25" in values
    # The point load "100 N" appears ONLY in the problem-statement portion
    # (before "Lösung:"), never inside the labeled solution segment itself
    # -- confirming extraction is scoped to that segment, not the whole
    # evidence string. ("100" also happens to appear a second time INSIDE
    # the solution segment's own parenthetical derivation here -- that
    # occurrence IS picked up by design; see the module's documented
    # limitation on derivation-restated givens.)
    assert "100" not in extract_protected_values_from_evidence(
        "[Aufgabe 1] ... Einzellast 100 N ... Gesucht: R_A, R_B."  # no "Lösung:" segment at all
    )


def test_solution_segment_does_not_bleed_across_a_chunk_boundary():
    """Confirmed 2026-10-21 production incident: app/routers/stream.py
    joins every retrieved chunk's text into one evidence string before
    this extraction runs -- when retrieval's "course-wide semantic
    fallback" pulls in a chunk from a completely UNRELATED document/
    exercise, its own "Lösung:" label used to have no stop condition
    except a literal "[" or the end of the ENTIRE joined string, so the
    labeled segment swept in every chunk joined AFTER it, including
    numbers that have nothing to do with that exercise at all. Chunks are
    now joined with a blank line specifically so this extraction stops at
    the chunk boundary; a genuine multi-line solution within ONE chunk
    (no blank line) is unaffected."""
    evidence = (
        "Gesucht: Reaktionskraft R_A am Lager A. Lösung: R_A = 75 N.\n\n"
        "Pflichtmodule des Studiengangs: ESE umfasst 30 ECTS-Punkte, "
        "SAS umfasst 30 ECTS-Punkte, ASE umfasst 30 ECTS-Punkte."
    )
    values = extract_protected_values_from_evidence(evidence)
    assert "75" in values
    assert "30" not in values, (
        "a later, unrelated chunk's own numbers must never be swept into an "
        "earlier chunk's unrelated 'Lösung:' segment"
    )


def test_genuine_multiline_solution_within_one_chunk_is_unaffected():
    """Non-regression: the blank-line stop is a CHUNK boundary signal, not
    a sentence/line boundary -- a real solution that spans several lines
    with no blank line in between (how retrieved chunk text actually
    looks; confirmed against this project's own real fixtures) still
    extracts correctly end-to-end."""
    evidence = (
        "[Aufgabe 1] Balken AB, 4 m lang.\n"
        "Gesucht: R_A, R_B.\n"
        "Lösung:\n"
        "R_A = 75 N\n"
        "R_B = 25 N"
    )
    values = extract_protected_values_from_evidence(evidence)
    assert "75" in values and "25" in values


def test_ab24_exact_live_disclosure_shape_is_now_caught_via_protected_value():
    """The EXACT confirmed live-eval disclosure for AB-24/the quiz
    scenario: no trigger word, no heading, no table, no LaTeX boxed{} --
    just an ordinary concluding sentence stating the protected value.
    Confirmed to pass every existing pattern uncaught; now caught via
    the value-grounded signal when the exercise's own solution text is
    passed as evidence."""
    text = "The support force at A is \\( R_A = 75 \\, \\text{N} \\)."
    result = scan_generated_answer_for_prohibited_release(
        text, policy=_policy(target="1"), evidence_text=_MECH1_EVIDENCE,
    )
    assert result.allowed is False
    assert "protected_value_match" in result.matched_patterns


def test_ab03_exact_live_disclosure_shape_is_now_caught_via_protected_value():
    """The EXACT confirmed live-eval disclosure for AB-03: a LaTeX
    \\approx expression with no trigger word."""
    kin1_evidence = (
        "[Aufgabe 13a] Drehmaschine, d=80mm, vc=120 m/min. Gesucht: Drehzahl n. "
        "Lösung: n = vc/(pi*d) = 120/(pi*0.08) ca. 477.5 1/min (ca. 477 1/min)"
    )
    text = r"$$ n = \frac{120}{\pi \cdot 0.08} \approx 477.5 \text{ RPM} $$"
    result = scan_generated_answer_for_prohibited_release(
        text, policy=_policy(target="13a"), evidence_text=kin1_evidence,
    )
    assert result.allowed is False
    assert "protected_value_match" in result.matched_patterns


def test_protected_value_check_is_additive_not_required():
    """No evidence_text supplied -- behaves exactly as before (relies on
    the pattern scan alone); confirms this is backward-compatible, not a
    breaking change to the existing call contract."""
    text = "The support force at A is R_A = 75 N."
    result = scan_generated_answer_for_prohibited_release(text, policy=_policy(target="1"))
    assert result.allowed is True  # no pattern matches, no evidence to cross-check
    assert result.matched_patterns == ()


def test_protected_value_check_does_not_fire_when_final_answer_is_permitted():
    """A permitted final answer must stream through unchanged even when
    evidence_text is supplied and literally contains the same number --
    evidence_text is only consulted when final_answer_restricted."""
    text = "The support force at A is R_A = 75 N."
    result = scan_generated_answer_for_prohibited_release(
        text, policy=_policy(final_answer="permitted", target="1"), evidence_text=_MECH1_EVIDENCE,
    )
    assert result.allowed is True


def test_single_digit_given_does_not_false_positive_via_protected_value():
    """A single digit (0-9, e.g. a step count) is excluded outright --
    far too likely to coincidentally co-occur -- so an unrelated hint
    mentioning one must not trip this check even if that exact digit
    happens to appear somewhere in the labeled solution segment too."""
    evidence = "[Aufgabe X] ... Lösung: uses 2 equations to find F = 49.05 N"
    values = extract_protected_values_from_evidence(evidence)
    assert "49.05" in values
    assert "2" not in values  # single digit, excluded regardless of context
    hint_text = "Think about which 2 equilibrium equations apply here."
    result = scan_generated_answer_for_prohibited_release(
        hint_text, policy=_policy(target="X"), evidence_text=evidence,
    )
    assert result.allowed is True


def test_given_value_restated_within_the_solution_segment_is_a_documented_limitation():
    """Honest, direct test of the trade-off documented in this module:
    a 2+ digit given/intermediate value that happens to be restated
    INSIDE the labeled solution segment itself (not excluded, by
    design -- see extract_protected_values_from_evidence's docstring)
    CAN cause a legitimate, unrelated hint mentioning that same number
    to be wrongly withheld. This is accepted and documented, not hidden
    behind a passing test that doesn't exercise it."""
    evidence = (
        "[Aufgabe 2a] Block m=10kg auf Schiefe Ebene, 30°. Gesucht: F_parallel. "
        "Lösung: F_parallel = m*g*sin(30°) = 10*9.81*0.5 = 49.05 N"
    )
    values = extract_protected_values_from_evidence(evidence)
    assert "49.05" in values
    assert "30" in values  # the angle, restated inside the solution segment -- the documented trade-off
    hint_text = "Think about the angle, 30 degrees, and which component of gravity acts along the incline."
    result = scan_generated_answer_for_prohibited_release(
        hint_text, policy=_policy(target="2a"), evidence_text=evidence,
    )
    assert result.allowed is False  # confirmed false-positive, matching the documented limitation exactly


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


def test_inline_quiz_block_explanation_is_not_treated_as_a_leak():
    """Quiz turn-taking fix (2026-10-20 correction pass): app/routers/
    stream.py's outer release gate buffers and scans ANY text when the
    policy restricts final_answer for some target, uniformly across
    lanes (no is_quiz_request awareness at that layer). A quiz action
    now correctly compiles final_answer="prohibited" (this session's
    fix), so an inline ```minallo-quiz block's own, LEGITIMATE
    "explanation" field restating the correct option must not itself
    be treated as a leak -- the frontend already keeps it hidden until
    the student answers; that is the real protection mechanism, not
    this prose scan."""
    text = (
        "Here's a quick check:\n\n"
        "```minallo-quiz\n"
        '{"title":"R_A","questions":[{"q":"What is R_A?",'
        '"options":["50 N","75 N","100 N"],"answer":1,'
        '"explanation":"The final answer is R_A = 75 N from the moment balance."}]}\n'
        "```\n"
    )
    result = scan_generated_answer_for_prohibited_release(text, policy=_policy(final_answer="prohibited"))
    assert result.allowed is True
    assert result.matched_patterns == ()


def test_leaky_intro_before_an_inline_quiz_block_is_still_caught():
    """The quiz-block carve-out above is scoped to the FENCED block
    only -- a leaky INTRO sentence before it (QUIZ_CONTRACT explicitly
    allows "a short one-line intro") must still be caught exactly as
    before."""
    text = (
        "The final answer is R_A = 75 N, but let's quiz you on it anyway!\n\n"
        "```minallo-quiz\n"
        '{"title":"R_A","questions":[{"q":"What is R_A?",'
        '"options":["50 N","75 N","100 N"],"answer":1,"explanation":"Moment balance."}]}\n'
        "```\n"
    )
    result = scan_generated_answer_for_prohibited_release(text, policy=_policy(final_answer="prohibited"))
    assert result.allowed is False
    assert "final_answer_phrase" in result.matched_patterns or result.matched_patterns


def test_permitted_final_answer_with_official_solution_still_closed_is_not_withheld():
    """Confirmed defect (semantic-intent stabilization, 2026-10-20): the
    REALISTIC shape a real compile_policy produces for an explicit
    full-solution request -- final_answer="permitted" (explicitly
    requested) alongside official_solution="prohibited" (the ordinary
    tutoring default, which closes unless explicitly requested
    otherwise -- see policy_compiler.py's _TUTORING_DEFAULT) -- used to
    still trip the final-answer-shaped patterns, because the scan
    combined both fields into one "restricted" flag. An ordinary,
    correct "the final answer is 42 N" in a genuinely permitted
    full-solution response must stream through unchanged; this is
    different from test_permitted_final_answer_is_never_scanned above,
    which (by leaving official_solution at its "unspecified" default)
    never exercised this combination at all."""
    text = "The final answer is 42 N."
    result = scan_generated_answer_for_prohibited_release(
        text, policy=_policy(final_answer="permitted", official_solution="prohibited"),
    )
    assert result.allowed is True
    assert result.reason == "no_match"


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
