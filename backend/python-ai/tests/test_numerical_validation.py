from __future__ import annotations

import pytest

from app.services.numerical_validation import (
    detect_source_conflicts,
    extract_givens,
    parse_locale_number,
    validate_numerical_claims,
    validate_arithmetic_steps,
    restricted_expressions_equivalent,
    round_for_constraint,
    units_compatible,
)


def test_source_560_rejects_draft_580() -> None:
    result = validate_numerical_claims(
        answer_text="Given $v_c = 580 m/min$.",
        source_texts=["Active question: v_c = 560 m/min"],
    )
    assert not result.valid
    assert result.action == "regenerate"
    assert result.mismatched_givens[0].symbol == "v_c"


def test_lost_negative_sign_is_rejected() -> None:
    result = validate_numerical_claims(
        answer_text="Use k = 1.80.",
        source_texts=["The question states k = -1.80."],
    )
    assert not result.valid


def test_decimal_comma_is_equivalent_and_original_is_preserved() -> None:
    result = validate_numerical_claims(
        answer_text="Use k = 1.8.",
        source_texts=["Gegeben: k = 1,80."],
        locale_hint="de",
    )
    assert result.valid
    assert result.extracted_givens[0].original == "k = 1,80"
    assert result.extracted_givens[0].normalized_numeric_value == pytest.approx(1.8)


def test_changed_unit_is_rejected() -> None:
    result = validate_numerical_claims(
        answer_text="Given d = 50 m.",
        source_texts=["Given d = 50 mm."],
    )
    assert not result.valid
    assert result.unit_errors


def test_explicit_dimensionally_valid_conversion_is_accepted() -> None:
    result = validate_numerical_claims(
        answer_text="Conversion:\nd = 0.05 m  (50 / 1000)",
        source_texts=["Given d = 50 mm."],
    )
    assert result.valid


def test_same_numeric_value_with_scaled_unit_is_not_a_conversion() -> None:
    result = validate_numerical_claims(
        answer_text="Conversion:\nd = 50 m",
        source_texts=["Given d = 50 mm."],
    )
    assert not result.valid


def test_changed_scientific_exponent_is_rejected() -> None:
    result = validate_numerical_claims(
        answer_text="Use x = 3.2 × 10^3 m.",
        source_texts=["Given x = 3.2 × 10^-3 m."],
    )
    assert not result.valid


def test_active_question_value_has_priority_over_similar_example() -> None:
    givens = extract_givens([
        "CURRENT QUESTION: v_c = 560 m/min",
        "SIMILAR EXAMPLE: v_c = 580 m/min",
    ])
    assert givens[0].normalized_numeric_value == 560
    result = validate_numerical_claims(
        answer_text="Given v_c = 580 m/min.",
        source_texts=[
            "CURRENT QUESTION: v_c = 560 m/min",
            "SIMILAR EXAMPLE: v_c = 580 m/min",
        ],
    )
    assert not result.valid


def test_authoritative_source_conflict_preserves_both_values() -> None:
    conflicts = detect_source_conflicts([
        "EXAM STATEMENT: v_c = 560 m/min",
        "OFFICIAL SOLUTION: v_c = 580 m/min",
    ])
    assert len(conflicts) == 1
    assert "560" in conflicts[0]
    assert "580" in conflicts[0]


def test_german_and_english_grouping_are_locale_aware() -> None:
    assert parse_locale_number("1.000,50", locale_hint="de") == pytest.approx(1000.5)
    assert parse_locale_number("1,000.50", locale_hint="en") == pytest.approx(1000.5)


def test_wrong_model_arithmetic_is_rejected_deterministically() -> None:
    errors = validate_arithmetic_steps("$$200 \\cdot 0.5 = 90$$")
    assert errors == ["200*0.5 evaluates to 100, not 90"]
    result = validate_numerical_claims(
        answer_text="$$200 \\cdot 0.5 = 90$$",
        source_texts=["F = 200 N and l = 0.5 m"],
    )
    assert not result.valid
    assert result.action == "regenerate"
    assert result.arithmetic_errors


def test_correct_numeric_substitution_is_accepted() -> None:
    assert validate_arithmetic_steps("$$200 \\cdot 0.5 = 100$$") == []


def test_restricted_symbolic_equivalence_and_parser_safety() -> None:
    assert restricted_expressions_equivalent("F / A", "F * A ** -1")
    assert not restricted_expressions_equivalent("F / A", "F * A")
    with pytest.raises(ValueError):
        restricted_expressions_equivalent("__import__('os').system('x')", "1")


def test_constraint_driven_rounding_differs_from_ordinary_rounding() -> None:
    assert round_for_constraint(10.9, constraint="maximum") == 10
    assert round_for_constraint(10.1, constraint="minimum") == 11
    assert round_for_constraint(10.6, constraint="nearest") == 11


def test_dimension_compatibility_rejects_incompatible_units() -> None:
    assert units_compatible("mm", "m")
    assert units_compatible("kW", "W")
    assert not units_compatible("mm", "s")
