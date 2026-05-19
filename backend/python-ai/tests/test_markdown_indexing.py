"""Tests for services.markdown_indexing.

Covers: empty-page fallback, heading promotion (numbered + ALL-CAPS), formula
detection, bullet normalisation, document-level assembly, chunk wrapping, and
extraction-quality grading.
"""

from __future__ import annotations

import pytest

from app.services.markdown_indexing import (
    PageMarkdown,
    assemble_document_markdown,
    page_to_markdown,
    wrap_chunk_markdown,
)


# ── page_to_markdown ────────────────────────────────────────────────────────


def test_empty_page_returns_unclear_with_failed_quality():
    result = page_to_markdown("", page_number=3)
    assert result.markdown == "[unclear]"
    assert result.quality == "failed"
    assert result.page_number == 3


def test_whitespace_only_page_is_failed():
    result = page_to_markdown("   \n\n  \t  \n", page_number=1)
    assert result.markdown == "[unclear]"
    assert result.quality == "failed"


def test_normal_paragraph_keeps_text_and_grades_good():
    text = (
        "Newton's second law states that the net force on an object equals "
        "its mass times its acceleration. This relationship is foundational "
        "in classical mechanics and applies to all rigid bodies."
    )
    result = page_to_markdown(text, page_number=2)
    assert "Newton" in result.markdown
    assert result.quality == "good"


def test_numbered_heading_is_promoted():
    text = "1.2 Bending Moment\n\nThe bending moment M is defined as the product of force and lever arm."
    result = page_to_markdown(text, page_number=4)
    # Depth: "1.2" has one dot → ###
    assert result.markdown.startswith("### 1.2 Bending Moment")


def test_deeper_numbered_heading_gets_deeper_level():
    text = "2.3.1 Subcase\n\nThis subsection covers an edge case in detail with examples and step by step derivations."
    result = page_to_markdown(text, page_number=5)
    assert result.markdown.startswith("#### 2.3.1 Subcase")


def test_all_caps_short_line_is_heading():
    text = "INTRODUCTION\n\nThis chapter introduces the core concepts of statics and how they apply to engineering problems."
    result = page_to_markdown(text, page_number=1)
    assert result.markdown.startswith("## INTRODUCTION")


def test_formula_line_gets_display_math():
    text = "1.2 Bending Moment\n\nM = F * l\n\nUnit: [M] = Nm and the formula applies in static equilibrium under the given assumptions."
    result = page_to_markdown(text, page_number=4)
    assert "$$" in result.markdown
    assert "M = F * l" in result.markdown


def test_bullet_lines_normalised_to_dash():
    text = (
        "Required equipment for the experiment includes:\n\n"
        "* meter stick\n"
        "- stopwatch\n"
        "• mass set\n"
    )
    result = page_to_markdown(text, page_number=2)
    assert "- meter stick" in result.markdown
    assert "- stopwatch" in result.markdown
    assert "- mass set" in result.markdown
    # The original "*"/"•" markers should be gone.
    assert "* meter" not in result.markdown
    assert "• mass" not in result.markdown


def test_lettered_bullets_are_recognised():
    text = (
        "Possible answers are:\n\n"
        "(a) tension increases\n"
        "(b) tension decreases\n"
        "(c) tension stays the same\n"
    )
    result = page_to_markdown(text, page_number=2)
    assert "- tension increases" in result.markdown
    assert "- tension decreases" in result.markdown


def test_very_short_page_grades_weak():
    # Above the 20-char "failed" floor but below MIN_GOOD_CHARS → "weak".
    result = page_to_markdown("Page 7 of 24 — Appendix entry.", page_number=7)
    assert result.quality == "weak"


def test_wall_of_symbols_grades_weak():
    # Long string, no spaces → low space density, looks like OCR noise.
    text = "x" * 200
    result = page_to_markdown(text, page_number=9)
    assert result.quality == "weak"


def test_sentence_ending_with_period_not_treated_as_math():
    text = "The mass is constant. The acceleration is variable. The force is calculated using the standard equation."
    result = page_to_markdown(text, page_number=1)
    assert "$$" not in result.markdown


def test_quality_failed_when_only_punctuation():
    result = page_to_markdown("....", page_number=1)
    assert result.quality == "failed"


# ── assemble_document_markdown ──────────────────────────────────────────────


def test_assemble_includes_source_and_page_markers():
    pages = [
        PageMarkdown(page_number=1, markdown="## Intro\n\nFirst page body.", quality="good"),
        PageMarkdown(page_number=2, markdown="Second page body here.", quality="good"),
    ]
    md = assemble_document_markdown(pages, source_filename="EngMec.pdf")
    assert "<!-- source: EngMec.pdf -->" in md
    assert "<!-- page: 1 -->" in md
    assert "<!-- page: 2 -->" in md
    assert "First page body." in md
    assert "Second page body here." in md
    # Source comment appears once, before any page marker.
    assert md.index("<!-- source: EngMec.pdf -->") < md.index("<!-- page: 1 -->")


def test_assemble_with_no_pages_returns_empty_string():
    assert assemble_document_markdown([], source_filename="x.pdf") == ""


def test_assemble_keeps_unclear_pages():
    pages = [
        PageMarkdown(page_number=1, markdown="[unclear]", quality="failed"),
        PageMarkdown(page_number=2, markdown="Real content here.", quality="good"),
    ]
    md = assemble_document_markdown(pages, source_filename="x.pdf")
    assert "[unclear]" in md
    assert "Real content here." in md


# ── wrap_chunk_markdown ─────────────────────────────────────────────────────


def test_wrap_chunk_with_single_page():
    out = wrap_chunk_markdown(
        "Some chunk text",
        source_filename="EngMec.pdf",
        page_start=4,
        page_end=4,
        chunk_type="formula",
    )
    assert "<!-- source: EngMec.pdf -->" in out
    assert "<!-- page: 4 -->" in out
    assert "<!-- chunk_type: formula -->" in out
    assert "Some chunk text" in out


def test_wrap_chunk_with_page_range():
    out = wrap_chunk_markdown(
        "Spans two pages",
        source_filename="x.pdf",
        page_start=3,
        page_end=5,
        chunk_type="exercise",
    )
    assert "<!-- page: 3-5 -->" in out


def test_wrap_chunk_with_section_title():
    out = wrap_chunk_markdown(
        "body",
        source_filename="x.pdf",
        page_start=1,
        page_end=1,
        chunk_type="definition",
        section_title="1.2 Bending Moment",
    )
    assert "<!-- section: 1.2 Bending Moment -->" in out


def test_wrap_chunk_with_empty_text_falls_back_to_unclear():
    out = wrap_chunk_markdown(
        "",
        source_filename="x.pdf",
        page_start=1,
        page_end=1,
        chunk_type="general",
    )
    assert "[unclear]" in out


@pytest.mark.parametrize(
    "chunk_type",
    ["definition", "theorem", "formula", "example", "exercise", "solution", "general"],
)
def test_wrap_chunk_accepts_all_known_types(chunk_type):
    out = wrap_chunk_markdown(
        "body",
        source_filename="x.pdf",
        page_start=1,
        page_end=1,
        chunk_type=chunk_type,
    )
    assert f"<!-- chunk_type: {chunk_type} -->" in out
