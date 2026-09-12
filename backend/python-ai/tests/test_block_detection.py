"""Tests for services.block_detection — exercise + formula extraction."""

from __future__ import annotations

from app.services.block_detection import (
    detect_exercises,
    detect_formulas,
)


# ── Exercise detection ──────────────────────────────────────────────────────


def test_detect_single_exercise():
    pages = [(1, "Aufgabe 1.2\n\nA rod of mass 2 kg hangs from a hinge. Find the bending moment at the hinge.")]
    blocks = detect_exercises(pages)
    assert len(blocks) == 1
    b = blocks[0]
    assert b.exercise_number == "1.2"
    assert b.subpart is None
    assert b.page_start == 1
    assert b.page_end == 1
    assert "rod of mass" in b.statement_markdown
    assert b.solution_markdown is None


def test_detect_english_example_label():
    """Lecture/exercise decks (the EngMec2 series) label worked problems
    'Example 1.2' — the English equivalent of the German 'Beispiel'. The
    detector recognised Beispiel but not Example, so vision-OCR'd slides whose
    only exercise marker was 'Example N' produced zero exercise blocks even
    after the figure text was recovered. Markdown-heading form too ('# ...')."""
    pages = [
        (4, "# Example 1.2\n\nA particle moves so that v = alpha x."),
        (5, "## Example 1.3\n\nGiven the acceleration field, find the path."),
    ]
    blocks = detect_exercises(pages)
    assert {b.exercise_number for b in blocks} == {"1.2", "1.3"}


def test_detect_exercise_with_subpart():
    pages = [(2, "Exercise 3.1 (a)\n\nDerive Newton's second law from first principles.")]
    blocks = detect_exercises(pages)
    assert len(blocks) == 1
    assert blocks[0].exercise_number == "3.1"
    assert blocks[0].subpart == "a"


def test_detect_exercise_with_solution():
    pages = [(1, (
        "Aufgabe 2.1\n\n"
        "Calculate the force needed to lift a 10 kg mass.\n\n"
        "Lösung\n\n"
        "F = m * g = 10 * 9.81 = 98.1 N."
    ))]
    blocks = detect_exercises(pages)
    assert len(blocks) == 1
    b = blocks[0]
    assert "Calculate the force" in b.statement_markdown
    assert b.solution_markdown is not None
    assert "98.1" in b.solution_markdown


def test_multiple_exercises_in_sequence():
    pages = [(1, (
        "Aufgabe 1.1\n\nFirst problem statement here.\n\n"
        "Aufgabe 1.2\n\nSecond problem statement here.\n\n"
        "Aufgabe 1.3\n\nThird problem statement here."
    ))]
    blocks = detect_exercises(pages)
    assert [b.exercise_number for b in blocks] == ["1.1", "1.2", "1.3"]
    assert "First problem" in blocks[0].statement_markdown
    assert "Second problem" in blocks[1].statement_markdown
    assert "Third problem" in blocks[2].statement_markdown
    # No statement should leak into the next.
    assert "Second problem" not in blocks[0].statement_markdown


def test_exercise_spans_multiple_pages():
    pages = [
        (1, "Aufgabe 4.2\n\nA long problem statement that\ncontinues onto the next page."),
        (2, "and includes more body text and a final calculation step."),
        (3, "Aufgabe 4.3\n\nNew exercise on page 3."),
    ]
    blocks = detect_exercises(pages)
    assert len(blocks) == 2
    assert blocks[0].exercise_number == "4.2"
    assert blocks[0].page_start == 1
    assert blocks[0].page_end == 2
    assert "continues onto" in blocks[0].statement_markdown
    assert "final calculation" in blocks[0].statement_markdown
    assert blocks[1].exercise_number == "4.3"
    assert blocks[1].page_start == 3


def test_exercise_with_german_lsg_abbrev():
    pages = [(5, (
        "Übung 2.3\n\nGiven a beam under load P.\n\n"
        "Lsg.\n\nM = P * L."
    ))]
    blocks = detect_exercises(pages)
    assert len(blocks) == 1
    assert blocks[0].solution_markdown is not None
    assert "M = P * L" in blocks[0].solution_markdown


def test_exercise_header_with_markdown_heading_prefix():
    pages = [(1, "## Aufgabe 5.1\n\nProblem text follows here on the next line.")]
    blocks = detect_exercises(pages)
    assert len(blocks) == 1
    assert blocks[0].exercise_number == "5.1"


def test_no_exercises_returns_empty():
    pages = [(1, "Just a regular paragraph with no exercise marker.")]
    blocks = detect_exercises(pages)
    assert blocks == []


def test_exercise_at_end_of_doc_terminates_cleanly():
    pages = [(7, "Aufgabe 7.5\n\nFinal exercise of the document.\n\nMore detail here.")]
    blocks = detect_exercises(pages)
    assert len(blocks) == 1
    assert "Final exercise" in blocks[0].statement_markdown
    assert "More detail" in blocks[0].statement_markdown


# ── "Solution for Exercise N" mid-line detection (flattened markdown) ───────


def test_detect_solution_for_exercise_midline():
    """Real EM2 case: pages flatten into one paragraph line, so the exercise
    header sits mid-line as 'Solution for Exercise 1.4'. Must still be found,
    captured as a solution, and not fire on the bare 'Exercise 3' sheet ref."""
    pages = [(
        1,
        "Institute for Acoustics EngMec 2 | Exercise 3 "
        "Solution for Exercise 1.4 Searched: a, r Given: v = const.",
    )]
    blocks = detect_exercises(pages)
    assert len(blocks) == 1
    assert blocks[0].exercise_number == "1.4"
    assert blocks[0].solution_markdown and "Searched" in blocks[0].solution_markdown


def test_detect_multiple_solution_for_exercises_across_pages():
    pages = [
        (1, "blah Solution for Exercise 1.4 first solution body"),
        (2, "Solution for Exercise 1.5 second solution body"),
    ]
    nums = [b.exercise_number for b in detect_exercises(pages)]
    assert nums == ["1.4", "1.5"]


def test_solution_for_exercise_german_and_subpart():
    pages = [(3, "... Lösung zu Aufgabe 2 a) der Lösungsweg folgt")]
    blocks = detect_exercises(pages)
    assert len(blocks) == 1
    assert blocks[0].exercise_number == "2"
    assert blocks[0].subpart == "a"


def test_bare_exercise_crossref_does_not_trigger():
    """A cross-reference like 'see Exercise 2 for details' (no 'Solution
    for' prefix, not line-start) must NOT be detected as an exercise."""
    pages = [(1, "Some prose, see Exercise 2 for details, then more prose.")]
    assert detect_exercises(pages) == []


# ── Formula detection ──────────────────────────────────────────────────────


def test_detect_inline_display_math():
    pages = [(4, "## Bending Moment\n\n$$ M = F * l $$\n\nUnit: Nm.")]
    blocks = detect_formulas(pages)
    assert len(blocks) == 1
    f = blocks[0]
    assert f.formula_name == "Bending Moment"
    assert f.page_number == 4
    assert "M = F * l" in f.formula_markdown
    assert f.formula_markdown.startswith("$$")
    assert f.formula_markdown.endswith("$$")


def test_detect_multiline_display_math():
    pages = [(2, "## Newton's Second Law\n\n$$\nF = m \\cdot a\n$$\n\nThe canonical form.")]
    blocks = detect_formulas(pages)
    assert len(blocks) == 1
    assert blocks[0].formula_name == "Newton's Second Law"
    assert "F = m" in blocks[0].formula_markdown


def test_multiple_formulas_attach_to_nearest_heading():
    pages = [(1, (
        "## Section A\n\n"
        "$$ x = y $$\n\n"
        "## Section B\n\n"
        "$$ a = b $$"
    ))]
    blocks = detect_formulas(pages)
    assert len(blocks) == 2
    assert blocks[0].formula_name == "Section A"
    assert blocks[1].formula_name == "Section B"


def test_formula_without_heading_has_no_name():
    pages = [(1, "$$ E = mc^2 $$")]
    blocks = detect_formulas(pages)
    assert len(blocks) == 1
    assert blocks[0].formula_name is None
    assert "E = mc^2" in blocks[0].formula_markdown


def test_formula_extracts_symbols():
    pages = [(1, "## Test\n\n$$ M = F * l $$")]
    blocks = detect_formulas(pages)
    assert len(blocks) == 1
    assert "M" in blocks[0].symbols
    assert "F" in blocks[0].symbols
    assert "l" in blocks[0].symbols


def test_formula_skips_common_unit_tokens():
    pages = [(1, "## Energy\n\n$$ E = kg * m / s $$")]
    blocks = detect_formulas(pages)
    assert "E" in blocks[0].symbols
    assert "kg" not in blocks[0].symbols
    assert "s" not in blocks[0].symbols


def test_no_formulas_returns_empty():
    pages = [(1, "Just normal text with no math fences.")]
    assert detect_formulas(pages) == []


def test_empty_dollar_block_is_ignored():
    pages = [(1, "## Empty\n\n$$\n\n$$\n\nText after.")]
    assert detect_formulas(pages) == []


def test_pages_with_no_markdown_are_skipped():
    pages = [(1, ""), (2, None), (3, "$$ x = 1 $$")]
    blocks = detect_formulas(pages)  # type: ignore[arg-type]
    assert len(blocks) == 1
    assert blocks[0].page_number == 3
