"""Phase 11 — measure_ocr_need / OcrAssessment."""

from __future__ import annotations

import pytest

from app.services.document_intelligence import measure_ocr_need


_FULL_PROSE = " ".join(["A reasonably long paragraph of normal academic prose."] * 8)


def test_empty_document_recommends_ocr() -> None:
    r = measure_ocr_need([])
    assert r.total_pages == 0
    assert r.ocr_recommended is True


def test_all_blank_pages_recommend_ocr() -> None:
    r = measure_ocr_need(["", "", ""])
    assert r.pages_likely_scanned == 3
    assert r.ocr_recommended is True


def test_clean_text_does_not_recommend_ocr() -> None:
    pages = [_FULL_PROSE] * 10
    r = measure_ocr_need(pages)
    assert r.pages_with_text == 10
    assert r.pages_likely_scanned == 0
    assert r.ocr_recommended is False


def test_thirty_percent_bad_pages_triggers_ocr() -> None:
    # 7 good + 3 with letters < 40 (almost_no_text bucket)
    pages = [_FULL_PROSE] * 7 + ["short " * 5] * 3
    r = measure_ocr_need(pages)
    assert r.pages_almost_no_text + r.pages_image_heavy + r.pages_likely_scanned >= 3
    assert r.ocr_recommended is True


def test_image_heavy_bucketing() -> None:
    # 40 ≤ letters < 80 → image_heavy
    medium = "a " * 60  # 60 letters, mixed with spaces
    pages = [_FULL_PROSE] * 6 + [medium] * 4
    r = measure_ocr_need(pages)
    assert r.pages_image_heavy == 4
    assert r.ocr_recommended is True


def test_high_chars_low_letters_triggers_ocr() -> None:
    # A page full of symbols/numbers but very few letters — typical OCR
    # garbage signature even when the total char count looks OK.
    garbled = "1234567890" * 30 + "abc"  # 303 chars, ~3 letters
    pages = [_FULL_PROSE] * 9 + [garbled]
    r = measure_ocr_need(pages)
    assert r.ocr_recommended is True


def test_to_json_shape() -> None:
    payload = measure_ocr_need([_FULL_PROSE]).to_json()
    expected_keys = {
        "totalPages", "pagesWithText", "pagesAlmostNoText",
        "pagesLikelyScanned", "pagesImageHeavy", "avgCharsPerPage",
        "formulaCountEstimate", "ocrRecommended",
    }
    assert set(payload.keys()) == expected_keys
    assert payload["totalPages"] == 1


def test_formula_count_estimate() -> None:
    pages = ["Here is $$ a = b $$ and $$ c = d $$.", _FULL_PROSE]
    r = measure_ocr_need(pages)
    assert r.formula_count_estimate == 2


def test_almost_no_text_bucketing() -> None:
    # < 40 letters but > 0 → almost_no_text
    pages = [_FULL_PROSE] * 8 + ["a b c d"] * 2
    r = measure_ocr_need(pages)
    assert r.pages_almost_no_text == 2
