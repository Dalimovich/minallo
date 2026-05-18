"""Tests for the Phase 4 document classification + extraction-quality rollup."""

from __future__ import annotations

import pytest

from app.services.document_intelligence import (
    DOCUMENT_TYPES,
    classify_document,
    rollup_extraction_quality,
)


# ── classify_document — filename signals (strong) ───────────────────────────


@pytest.mark.parametrize(
    "file_name, expected",
    [
        ("Aufgaben_Blatt_3.pdf", "exercise_sheet"),
        ("Loesungen_3.pdf", "solution_sheet"),
        ("Musterloesung.pdf", "solution_sheet"),
        ("EngMec2_Formelsammlung.pdf", "formula_sheet"),
        ("Klausur_2023.pdf", "exam"),
        ("Midterm-Spring.pdf", "exam"),
        ("Zusammenfassung_Kapitel5.pdf", "summary"),
        ("Vorlesung_03.pdf", "lecture"),
        ("Lecture-12-Slides.pdf", "lecture"),
        ("Cheatsheet_Final.pdf", "formula_sheet"),
        ("Übung_2.pdf", "exercise_sheet"),
    ],
)
def test_filename_classification(file_name: str, expected: str) -> None:
    assert classify_document(file_name, "ignored body") == expected


def test_filename_takes_precedence_over_content() -> None:
    # Filename screams exercise sheet; content is mostly formula-shaped.
    assert classify_document(
        "Aufgaben_blatt.pdf",
        "$$ a = b $$\n$$ c = d $$\n$$ x = y $$\n" * 20,
    ) == "exercise_sheet"


# ── classify_document — content signals (when filename is ambiguous) ────────


def test_content_classifies_solution_sheet() -> None:
    body = (
        "Aufgabe 1: Berechne die Kraft.\nLösung: F = m * a, daher 10 N.\n"
        "Aufgabe 2: Berechne das Moment.\nLösung: M = F * l, daher 20 Nm.\n"
        "Aufgabe 3: Bestimme die Spannung.\nMusterlösung: sigma = F/A.\n"
    )
    assert classify_document("anon.pdf", body) == "solution_sheet"


def test_content_classifies_exercise_sheet() -> None:
    body = "Exercise 1: Compute the area.\nExercise 2: Find the slope.\nExercise 3: State the law.\n"
    assert classify_document("anon.pdf", body) == "exercise_sheet"


def test_content_classifies_formula_sheet() -> None:
    body = "$$ F = m a $$\n$$ M = F l $$\n$$ \\sigma = F/A $$\n" * 20
    assert classify_document("anon.pdf", body) == "formula_sheet"


def test_content_classifies_exam() -> None:
    body = "Klausur Sommer 2023\nAufgabe 1 (3 Punkte): …\nExam date: 2023-07-12. Points: 30 total.\n"
    assert classify_document("anon.pdf", body) == "exam"


def test_content_classifies_summary() -> None:
    body = "Zusammenfassung Kapitel 5\nKey takeaways: derivatives are slopes.\nSummary of key points: …\n"
    assert classify_document("anon.pdf", body) == "summary"


def test_content_falls_back_to_lecture_for_prose() -> None:
    body = "In this chapter we discuss Newton's laws of motion. " * 80
    assert classify_document("anon.pdf", body) == "lecture"


def test_empty_inputs_return_unknown() -> None:
    assert classify_document("", "") == "unknown"
    assert classify_document(None, None) == "unknown"


def test_classify_result_is_in_enum() -> None:
    # Sanity: any classification must be a valid enum member or 'unknown'.
    cases = [
        ("Aufgabe.pdf", ""),
        ("", "Aufgabe 1 ... Aufgabe 2 ... Aufgabe 3 ..."),
        ("", ""),
        ("random_name.pdf", "noise text"),
    ]
    for fn, body in cases:
        assert classify_document(fn, body) in DOCUMENT_TYPES


# ── rollup_extraction_quality ───────────────────────────────────────────────


def test_rollup_all_good() -> None:
    r = rollup_extraction_quality(["good"] * 10)
    assert r.quality == "good"
    assert r.good_pages == 10
    assert r.ocr_recommended is False
    assert r.total_pages == 10


def test_rollup_all_failed_recommends_ocr() -> None:
    r = rollup_extraction_quality(["failed"] * 5)
    assert r.quality == "failed"
    assert r.failed_pages == 5
    assert r.ocr_recommended is True


def test_rollup_no_pages_is_failed_with_ocr() -> None:
    r = rollup_extraction_quality([])
    assert r.quality == "failed"
    assert r.total_pages == 0
    assert r.ocr_recommended is True


def test_rollup_any_failed_page_demotes_to_weak() -> None:
    # 9 good + 1 failed = 10% bad, but a single failed page is enough to
    # demote the document and trigger an OCR recommendation.
    r = rollup_extraction_quality(["good"] * 9 + ["failed"])
    assert r.quality == "weak"
    assert r.ocr_recommended is True


def test_rollup_thirty_percent_weak_demotes() -> None:
    # 7 good + 3 weak = 30% weak.
    r = rollup_extraction_quality(["good"] * 7 + ["weak"] * 3)
    assert r.quality == "weak"
    assert r.ocr_recommended is True


def test_rollup_below_thirty_percent_stays_good() -> None:
    # 9 good + 1 weak = 10% weak.
    r = rollup_extraction_quality(["good"] * 9 + ["weak"])
    assert r.quality == "good"
    assert r.ocr_recommended is False


def test_rollup_ignores_none_entries() -> None:
    r = rollup_extraction_quality(["good", None, "good", None])
    assert r.total_pages == 2
    assert r.quality == "good"


def test_rollup_ignores_unknown_tags() -> None:
    r = rollup_extraction_quality(["good", "splendid", "good"])
    # 'splendid' is counted toward total but not toward any bucket.
    assert r.total_pages == 3
    assert r.good_pages == 2
    assert r.quality == "good"
