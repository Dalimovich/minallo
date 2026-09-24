"""Tests for the pdfminer text cleaner (CID-artifact stripping, whitespace)
and the text-block / bbox capture."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.extraction import (
    TextBlock,
    _clean_block_text,
    _clean_page_text,
    _normalise_bbox,
    extract_pages_text,
    extract_pages_with_blocks,
)


def test_strips_cid_glyph_artifacts() -> None:
    """pdfminer emits '(cid:NN)' for unmapped glyphs (∫, vector arrows,
    ligature fonts). They must not survive into the cleaned text."""
    raw = "dv = a dt (cid:90)(cid:90) dv = a dt the vector (cid:126)r describes"
    cleaned = _clean_page_text(raw)
    assert "(cid:" not in cleaned
    assert "dv = a dt" in cleaned
    # The vector name 'r' immediately follows its dropped arrow artifact.
    assert "vector r describes" in cleaned


def test_clean_page_text_collapses_whitespace_and_blanks() -> None:
    raw = "foo    bar\t\tbaz\n\n\n\nnext"
    cleaned = _clean_page_text(raw)
    assert "foo bar baz" in cleaned
    assert "\n\n\n" not in cleaned


def test_clean_page_text_empty() -> None:
    assert _clean_page_text("") == ""


# ── text-block / bbox capture ───────────────────────────────────────────────


def test_normalise_bbox_flips_to_top_left_and_normalises() -> None:
    """pdfminer is bottom-left; we store top-left 0..1. A block in the top-left
    quarter of a 200x100 page should come back near (0, 0, 0.5, 0.5)."""
    # x0=0,x1=100 → left 0, right 0.5 ; y spans the TOP half: y0=50,y1=100
    # → top=(100-100)/100=0, bottom=(100-50)/100=0.5
    assert _normalise_bbox(0, 50, 100, 100, 200, 100) == (0.0, 0.0, 0.5, 0.5)


def test_normalise_bbox_bottom_right_block() -> None:
    # Bottom-right quarter: x 100..200, y 0..50 on a 200x100 page.
    assert _normalise_bbox(100, 0, 200, 50, 200, 100) == (0.5, 0.5, 1.0, 1.0)


def test_normalise_bbox_clamps_and_handles_zero_size() -> None:
    # Out-of-range coords clamp to [0,1]; zero width/height must not divide by 0.
    out = _normalise_bbox(-10, -10, 9999, 9999, 0, 0)
    assert all(0.0 <= v <= 1.0 for v in out)


def test_clean_block_text_single_line_no_cid() -> None:
    assert _clean_block_text("dv =\n a dt (cid:90)\n") == "dv = a dt"


def test_textblock_to_json_shape() -> None:
    b = TextBlock("F = m a", (0.1, 0.2, 0.3, 0.4))
    assert b.to_json() == {"t": "F = m a", "bbox": [0.1, 0.2, 0.3, 0.4]}


# ── fixture-gated end-to-end (self-skips when the PDFs aren't present) ───────

_FIXTURES = sorted(
    (Path(__file__).parent / "fixtures" / "extraction_eval").glob("*.pdf")
)


@pytest.mark.skipif(not _FIXTURES, reason="no extraction_eval fixture PDFs present")
def test_blocks_text_matches_extract_pages_text() -> None:
    """extract_pages_with_blocks must produce IDENTICAL page text to
    extract_pages_text — they share the cleaning but assemble separately, so
    this locks them together against drift."""
    pdf = next(p for p in _FIXTURES if not p.stem.startswith("_"))
    data = pdf.read_bytes()
    assert extract_pages_with_blocks(data)[0] == extract_pages_text(data)


@pytest.mark.skipif(not _FIXTURES, reason="no extraction_eval fixture PDFs present")
def test_blocks_have_valid_normalised_bboxes() -> None:
    """A text-layer fixture yields blocks with in-range, well-ordered bboxes."""
    # Pick a clean text-layer doc (the solution sheets extract real text).
    candidates = [p for p in _FIXTURES if "Solutions" in p.stem]
    pdf = candidates[0] if candidates else next(
        p for p in _FIXTURES if not p.stem.startswith("_")
    )
    _, blocks_per_page = extract_pages_with_blocks(pdf.read_bytes())
    all_blocks = [b for page in blocks_per_page for b in page]
    assert all_blocks, "expected some text blocks from a text-layer PDF"
    for b in all_blocks:
        left, top, right, bottom = b.bbox
        assert 0.0 <= left <= right <= 1.0
        assert 0.0 <= top <= bottom <= 1.0
        assert b.text.strip()
