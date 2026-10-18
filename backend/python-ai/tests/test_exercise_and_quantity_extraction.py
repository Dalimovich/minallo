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
