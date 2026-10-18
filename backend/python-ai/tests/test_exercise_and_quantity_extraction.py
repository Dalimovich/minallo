"""Regression coverage for the two P0 task-grounding bugs in reliability.py:

A) _EXERCISE_REFERENCE_RE missed bare-integer exercise numbers ("Aufgabe 5")
   and false-positived on unprefixed decimals ("12.5 mm", "F = 12.5 N").
B) requested-quantity extraction captured the grammatical article right
   after a calculation verb ("Berechne die Kraft F." -> "die") instead of
   the symbol, which both weakened the INCLUDE_REQUESTED_QUANTITY obligation
   into a near-tautology and caused compare_task_identities() to flag a
   mathematically correct answer as a REQUESTED_QUANTITY mismatch.
"""

from __future__ import annotations

import pytest

from app.services.reliability import (
    GroundingMismatch,
    _EXERCISE_REFERENCE_RE,
    _own_exercise_segment,
    answer_obligations,
    classify_task_traits,
    compare_task_identities,
    identify_draft_task,
    identify_grounded_task,
    identity_is_sufficient,
)


# --- Bug A: exercise-reference regex -------------------------------------

@pytest.mark.parametrize(
    "text,expected",
    [
        ("Aufgabe 5", "5"),
        ("Aufgabe 2.3", "2.3"),
        ("Exercise 12", "12"),
        ("Problem 4", "4"),
        ("Question 7", "7"),
        ("Aufgabe 2.3 a)", "2.3"),
        ("Solve exercise 5 on this page", "5"),
        ("Berechne Aufgabe 5", "5"),
        # False positives the old optional-keyword pattern produced:
        ("12.5 mm", None),
        ("F = 12.5 N", None),
        ("page 3.2", None),
        ("the beam deflects by 12.5 mm", None),
    ],
)
def test_exercise_reference_regex(text: str, expected: str | None) -> None:
    match = _EXERCISE_REFERENCE_RE.search(text)
    assert (match.group(1) if match else None) == expected


def test_exercise_reference_with_surrounding_measurement_not_confused() -> None:
    # The brief's "message containing both an exercise number and a
    # numerical measurement" case: only the real exercise reference,
    # never the 12.5 mm measurement, must resolve.
    match = _EXERCISE_REFERENCE_RE.search(
        "For Aufgabe 5, the beam is 12.5 mm thick. Calculate F."
    )
    assert match is not None
    assert match.group(1) == "5"


def test_bare_followup_without_restated_exercise_has_no_reference() -> None:
    # A follow-up like "and the pressure?" with no explicit exercise number
    # must not hallucinate one; carrying the exercise forward across turns
    # is the dialogue layer's job, not this parser's.
    identity = identify_grounded_task(
        question="and the pressure?",
        current_page_text="",
        document_id="doc-1",
        filename="exam.pdf",
        page=3,
    )
    assert identity.exercise_reference is None


def test_integer_exercise_reference_gets_same_sufficiency_checks_as_decimal() -> None:
    """identity_is_sufficient()'s page-binding checks are gated on
    `identity.exercise_reference` being truthy. Before the fix, "Aufgabe 5"
    never set exercise_reference, so those checks were silently skipped
    for every integer-numbered exercise."""
    traits = classify_task_traits("Explain Aufgabe 5 on this page")
    identity = identify_grounded_task(
        question="Explain Aufgabe 5 on this page",
        current_page_text="Unrelated page text with no exercise 5 on it",
        document_id="doc-1",
        filename="exam.pdf",
        page=3,
        traits=traits,
    )
    assert identity.exercise_reference == "5"
    # The exercise isn't actually visible on this page -> must fail, not
    # silently pass because exercise_reference used to be None.
    assert not identity_is_sufficient(identity, traits=traits, page_bound_request=True)


# --- Bug B: requested-quantity extraction --------------------------------

@pytest.mark.parametrize(
    "question,expected",
    [
        ("Calculate the force F.", ["F"]),
        ("Berechne die Kraft F.", ["F"]),
        ("Bestimme den Druck p.", ["p"]),
        ("Ermittle die Geschwindigkeit v.", ["v"]),
        ("Find x.", ["x"]),
        ("Solve for y.", ["y"]),
        ("Gesucht: F", ["F"]),
        ("F = ?", ["F"]),
        ("Calculate F and M.", ["F", "M"]),
        ("Berechne F und M.", ["F", "M"]),
        ("Berechnen Sie die Kraft F.", ["F"]),
        ("What does Bezugsrahmen mean?", []),  # no calc verb -> no symbol
        # Named quantity with no explicit variable: nothing to invent.
        ("Calculate the force.", []),
        ("Berechne die Kraft.", []),
        # A label mentioned later ("at support B") must not displace the
        # symbol that actually sits next to the request.
        ("Berechne die Kraft F am Träger B.", ["F"]),
        # A second request-list segment with no symbol in it (an instruction,
        # not a quantity) must not contribute a fabricated entry.
        ("Calculate F and explain why.", ["F"]),
        ("Berechne F und erkläre warum.", ["F"]),
        # The symbol sits mid-clause; the trailing noun must not win.
        ("Solve for x in the following equation.", ["x"]),
        ("Determine the velocity v if t = 5 seconds", ["v"]),
        # "a"/"A" is a legitimate symbol (acceleration, area), not just the
        # English article -- it must not be discarded when it's the only
        # candidate the clause offers.
        ("Calculate the acceleration a.", ["a"]),
        ("Calculate area A.", ["A"]),
        ("Find the acceleration a given t.", ["a"]),
        # "a"/"A" as a LEADING article introducing a noun ("a force", "a
        # mass") is not the symbol -- only a TRAILING "a"/"A" with nothing
        # else in the clause can be the symbol itself.
        ("Calculate a force.", []),
        ("Calculate a mass.", []),
        # "<preposition> <noun> <letter>" names the object the quantity
        # belongs to ("beam B", "point B", "support A", "node C"), not the
        # requested quantity itself -- with no explicit symbol for the named
        # quantity, nothing should be invented from the label.
        ("Calculate the force on beam B.", []),
        ("Find the reaction at support A.", []),
        ("Determine the displacement of node C.", []),
        # A quantity noun directly followed by its symbol (no preposition
        # in between) is the request-plus-symbol pattern, not a label.
        ("Calculate the force F at point B.", ["F"]),
    ],
)
def test_requested_quantity_extraction(question: str, expected: list[str]) -> None:
    traits = classify_task_traits(question)
    identity = identify_grounded_task(
        question=question,
        current_page_text="",
        document_id="doc-1",
        filename="exam.pdf",
        page=1,
        traits=traits,
    )
    assert identity.requested_quantities == expected


def test_given_value_in_same_sentence_is_not_mistaken_for_the_ask() -> None:
    # "unrelated symbol in the surrounding context": L is *given*, not asked.
    traits = classify_task_traits("Calculate the force F, given L.")
    identity = identify_grounded_task(
        question="Calculate the force F, given L.",
        current_page_text="",
        document_id="doc-1",
        filename="exam.pdf",
        page=1,
        traits=traits,
    )
    assert identity.requested_quantities == ["F"]


def test_unrelated_exercise_on_the_same_page_does_not_leak_into_the_request() -> None:
    """A PDF page is evidence for resolving the task, not an independent
    source of what was asked. A separate exercise elsewhere on the visible
    page asking for p/v/M must not get attributed to a question that only
    asked about F."""
    traits = classify_task_traits("Calculate the force F.")
    identity = identify_grounded_task(
        question="Calculate the force F.",
        current_page_text=(
            "Aufgabe 2: Bestimme den Druck p.\n"
            "Aufgabe 3: Ermittle die Geschwindigkeit v.\n"
            "Gesucht: M"
        ),
        document_id="doc-1",
        filename="exam.pdf",
        page=1,
        traits=traits,
    )
    assert identity.requested_quantities == ["F"]


def test_selected_region_still_contributes_requested_quantity() -> None:
    """Unlike the rest of the page, the region the student actually
    selected reflects their own intent and should still count."""
    traits = classify_task_traits("What is being asked here?")
    identity = identify_grounded_task(
        question="What is being asked here?",
        current_page_text="Aufgabe 2: Bestimme den Druck p.",
        selected_region_text="Berechne die Kraft F.",
        document_id="doc-1",
        filename="exam.pdf",
        page=1,
        traits=traits,
    )
    assert identity.requested_quantities == ["F"]


def test_article_is_never_extracted_as_a_requested_quantity() -> None:
    for question in ("Calculate the force F.", "Berechne die Kraft F.", "Bestimme den Druck p."):
        traits = classify_task_traits(question)
        identity = identify_grounded_task(
            question=question, current_page_text="", document_id="d",
            filename="f.pdf", page=1, traits=traits,
        )
        for article in ("the", "die", "der", "den", "das"):
            assert article not in [q.casefold() for q in identity.requested_quantities]


# --- Downstream: false acceptance / false rejection on the repair path ---

def test_correct_german_imperative_answer_is_not_falsely_rejected() -> None:
    """This is the production-visible failure: compare_task_identities()
    used to flag REQUESTED_QUANTITY mismatch for a mathematically correct
    answer because requested_quantities held "die" instead of "F", and
    "die" never appears as an assignment symbol in any answer."""
    question = "Berechne die Kraft F."
    traits = classify_task_traits(question)
    identity = identify_grounded_task(
        question=question, current_page_text="", document_id="d",
        filename="f.pdf", page=1, traits=traits,
    )
    draft = identify_draft_task("F = 12 N")
    assert compare_task_identities(identity, draft, traits=traits) == []


def test_wrong_quantity_answer_is_still_rejected() -> None:
    """Guard against the opposite failure: fixing the article bug must not
    turn requested-quantity checking into a no-op. An answer that never
    mentions the real requested symbol must still be flagged."""
    question = "Berechne die Kraft F."
    traits = classify_task_traits(question)
    identity = identify_grounded_task(
        question=question, current_page_text="", document_id="d",
        filename="f.pdf", page=1, traits=traits,
    )
    draft = identify_draft_task("p = 12 N")  # answers a different symbol
    assert GroundingMismatch.REQUESTED_QUANTITY in compare_task_identities(
        identity, draft, traits=traits,
    )


def test_requested_quantity_obligation_rejects_answer_missing_the_symbol() -> None:
    question = "Berechne die Kraft F."
    traits = classify_task_traits(question)
    identity = identify_grounded_task(
        question=question, current_page_text="", document_id="d",
        filename="f.pdf", page=1, traits=traits,
    )
    obligations = answer_obligations(
        answer="The pressure is 12 N.", identity=identity, traits=traits,
    )
    quantity_obligation = next(
        o for o in obligations if o.obligation_type == "include_requested_quantity"
    )
    assert not quantity_obligation.satisfied


def test_requested_quantity_obligation_accepts_answer_with_the_symbol() -> None:
    question = "Berechne die Kraft F."
    traits = classify_task_traits(question)
    identity = identify_grounded_task(
        question=question, current_page_text="", document_id="d",
        filename="f.pdf", page=1, traits=traits,
    )
    obligations = answer_obligations(
        answer="F = 12 N.", identity=identity, traits=traits,
    )
    quantity_obligation = next(
        o for o in obligations if o.obligation_type == "include_requested_quantity"
    )
    assert quantity_obligation.satisfied


# --- Named quantity, no explicit variable: must not invent one and reject ---

def test_named_quantity_without_symbol_does_not_falsely_reject_correct_answer() -> None:
    """The original failure mode: "force"/"Kraft" used to be captured as the
    requested quantity, then INCLUDE_REQUESTED_QUANTITY demanded the literal
    word "force" appear in the answer -- which a correct "F = 12.5 N" never
    contains. With no reliable symbol, no obligation should be raised at
    all, so a correct answer is never rejected for lacking it."""
    for question in ("Calculate the force.", "Berechne die Kraft."):
        traits = classify_task_traits(question)
        identity = identify_grounded_task(
            question=question, current_page_text="", document_id="d",
            filename="f.pdf", page=1, traits=traits,
        )
        assert identity.requested_quantities == []
        draft = identify_draft_task("F = 12.5 N")
        assert compare_task_identities(identity, draft, traits=traits) == []
        obligations = answer_obligations(
            answer="F = 12.5 N", identity=identity, traits=traits,
        )
        assert not any(
            o.obligation_type == "include_requested_quantity" for o in obligations
        )


def test_label_mentioned_later_does_not_mask_a_wrong_symbol_answer() -> None:
    """compare_task_identities() must still reject an answer for the wrong
    symbol even when a same-looking label ("Träger B") appears later in the
    question; only the real requested symbol F should be tracked."""
    question = "Berechne die Kraft F am Träger B."
    traits = classify_task_traits(question)
    identity = identify_grounded_task(
        question=question, current_page_text="", document_id="d",
        filename="f.pdf", page=1, traits=traits,
    )
    assert identity.requested_quantities == ["F"]
    draft = identify_draft_task("B = 12 N")  # answers the label, not the ask
    assert GroundingMismatch.REQUESTED_QUANTITY in compare_task_identities(
        identity, draft, traits=traits,
    )


def test_object_label_without_explicit_symbol_does_not_falsely_reject_correct_answer() -> None:
    """"Calculate the force on beam B." never states a symbol for the force
    itself -- B names the beam. Treating B as the requested quantity would
    demand the literal letter B appear in the answer and would reject a
    correct "F = 12.5 N". With no reliable symbol, no such obligation
    should be raised."""
    question = "Calculate the force on beam B."
    traits = classify_task_traits(question)
    identity = identify_grounded_task(
        question=question, current_page_text="", document_id="d",
        filename="f.pdf", page=1, traits=traits,
    )
    assert identity.requested_quantities == []
    draft = identify_draft_task("F = 12.5 N")
    assert compare_task_identities(identity, draft, traits=traits) == []
    obligations = answer_obligations(
        answer="F = 12.5 N", identity=identity, traits=traits,
    )
    assert not any(
        o.obligation_type == "include_requested_quantity" for o in obligations
    )


def test_leading_article_a_does_not_falsely_reject_a_correct_answer() -> None:
    """"Calculate a force."/"Calculate a mass." never name a symbol for the
    quantity -- "a" there is the English article introducing "force"/"mass",
    not a variable. Treating "a" as the requested quantity would demand the
    letter "a" appear in the answer, which it trivially does inside almost
    any word, and would never meaningfully reject a wrong answer either."""
    for question in ("Calculate a force.", "Calculate a mass."):
        traits = classify_task_traits(question)
        identity = identify_grounded_task(
            question=question, current_page_text="", document_id="d",
            filename="f.pdf", page=1, traits=traits,
        )
        assert identity.requested_quantities == []
        draft = identify_draft_task("F = 12.5 N")
        assert compare_task_identities(identity, draft, traits=traits) == []
        obligations = answer_obligations(
            answer="F = 12.5 N", identity=identity, traits=traits,
        )
        assert not any(
            o.obligation_type == "include_requested_quantity" for o in obligations
        )


# --- Subexercise heading collision: "Aufgabe 5.3" is not "Aufgabe 5" -----

@pytest.mark.parametrize(
    "page_text,exercise_ref,expected",
    [
        # No heading for exercise 5 itself -- only its subexercise 5.3 --
        # must resolve to nothing, never to 5.3's own text.
        ("Aufgabe 5.3 Gesucht: p", "5", ""),
        # The subexercise's own heading still resolves correctly.
        ("Aufgabe 5.3 Gesucht: p", "5.3", " Gesucht: p"),
        # A real "Aufgabe 5" heading still resolves normally, including
        # when a differently-numbered subexercise sits right next to it.
        ("Aufgabe 5 Gesucht: F\nAufgabe 5.3 Gesucht: p", "5", " Gesucht: F\n"),
    ],
)
def test_own_exercise_segment_does_not_confuse_subexercise_headings(
    page_text: str, exercise_ref: str, expected: str,
) -> None:
    assert _own_exercise_segment(page_text, exercise_ref) == expected


def test_subexercise_heading_does_not_leak_into_a_different_exercise_number() -> None:
    """Downstream: a question referencing "Aufgabe 5" on a page that only
    has "Aufgabe 5.3" (no bare "Aufgabe 5" heading) must not pick up 5.3's
    "Gesucht: p" as if it were exercise 5's own requested quantity."""
    traits = classify_task_traits("Calculate Aufgabe 5")
    identity = identify_grounded_task(
        question="Calculate Aufgabe 5",
        current_page_text="Aufgabe 5.3 Gesucht: p",
        document_id="d", filename="f.pdf", page=1, traits=traits,
    )
    assert identity.exercise_reference == "5"
    assert identity.requested_quantities == []


# --- Token-aware single-letter quantity matching in answer_obligations ---

def test_single_letter_symbol_is_not_matched_as_a_substring_of_another_word() -> None:
    """A requested symbol "a" must be checked as its own token, not as a
    substring: "a" sits inside "mass", "answer", "page" etc. without the
    answer ever actually addressing the quantity "a"."""
    question = "Calculate the acceleration a."
    traits = classify_task_traits(question)
    identity = identify_grounded_task(
        question=question, current_page_text="", document_id="d",
        filename="f.pdf", page=1, traits=traits,
    )
    assert identity.requested_quantities == ["a"]
    obligations = answer_obligations(
        answer="The mass is 12 kg.", identity=identity, traits=traits,
    )
    quantity_obligation = next(
        o for o in obligations if o.obligation_type == "include_requested_quantity"
    )
    assert not quantity_obligation.satisfied


def test_single_letter_symbol_still_matches_as_its_own_token() -> None:
    """Guard against the opposite failure: tightening the match to be
    token-aware must not stop it from matching the symbol when it
    genuinely IS present as its own token."""
    question = "Calculate the acceleration a."
    traits = classify_task_traits(question)
    identity = identify_grounded_task(
        question=question, current_page_text="", document_id="d",
        filename="f.pdf", page=1, traits=traits,
    )
    obligations = answer_obligations(
        answer="a = 9.8 m/s^2", identity=identity, traits=traits,
    )
    quantity_obligation = next(
        o for o in obligations if o.obligation_type == "include_requested_quantity"
    )
    assert quantity_obligation.satisfied
