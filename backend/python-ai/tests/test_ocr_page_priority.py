from __future__ import annotations

from pathlib import Path

from app.services.extraction import extract_pages_text
from app.services.vision_ocr import rank_ocr_candidates


def test_real_26_page_pdf_spends_cap_on_content_pages() -> None:
    fixture = (
        Path(__file__).parent
        / "fixtures"
        / "public_eval"
        / "ocr_priority_26_pages.pdf"
    )
    pages = extract_pages_text(fixture.read_bytes())
    ranked = rank_ocr_candidates(pages, range(len(pages)))
    chosen = {item.page_index + 1 for item in ranked[:20]}
    assert chosen == set(range(7, 27))


def test_formula_and_diagram_signals_beat_front_matter() -> None:
    pages = [
        "Table of contents\n1 Introduction\n2 Methods",
        "F = m * a = 125 N; sigma = F / A = 12.5 MPa",
        "Figure 3: force diagram; D = 80 mm",
    ]
    ranked = rank_ocr_candidates(pages, range(3))
    assert ranked[0].page_index in {1, 2}
    assert ranked[-1].page_index == 0


def test_all_valuable_pages_still_respect_twenty_page_budget() -> None:
    pages = [
        f"Exercise {index + 1}: calculate F = {100 + index} N"
        for index in range(22)
    ]
    ranked = rank_ocr_candidates(pages, range(22))
    assert len(ranked[:20]) == 20
    assert len({item.page_index for item in ranked[:20]}) == 20
    assert all("educational_identifier" in item.reasons for item in ranked[:20])
