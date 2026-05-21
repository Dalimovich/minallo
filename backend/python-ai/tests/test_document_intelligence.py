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


def test_content_overrides_misleading_filename() -> None:
    """Review fix #12: when the filename hint and the content classifier
    disagree, the body wins. ``Aufgaben_blatt.pdf`` whose content is
    pure formula-density (no actual Aufgabe markers) was previously
    mis-classified as exercise_sheet — burying it under a Phase-8
    doc-type-mismatch penalty for any real exercise question. Now
    content-says-formula_sheet wins."""
    assert classify_document(
        "Aufgaben_blatt.pdf",
        "$$ a = b $$\n$$ c = d $$\n$$ x = y $$\n" * 20,
    ) == "formula_sheet"


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


# ── Classification confidence (Review fix #12) ──────────────────────────────


def test_classify_filename_and_content_agree_gives_high_confidence() -> None:
    """When filename hint and content hits agree on the same type, that's
    the unambiguous case — confidence should be near 1.0."""
    from app.services.document_intelligence import classify_document_with_confidence

    r = classify_document_with_confidence(
        file_name="Aufgabenblatt_3_Mechanik.pdf",
        sample_text=(
            "Aufgabe 1. Bestimmen Sie die Federrate. "
            "Aufgabe 2. Berechnen Sie die Spannung. "
            "Aufgabe 3. Untersuchen Sie das Trägheitsmoment. "
            "Aufgabe 4. Diskutieren Sie das Ergebnis."
        ),
    )
    assert r.document_type == "exercise_sheet"
    assert r.confidence >= 0.9
    assert any(s.startswith("filename:") for s in r.signals)
    assert any(s.startswith("content:") for s in r.signals)


def test_classify_misleading_filename_loses_to_content() -> None:
    """``Lösung.pdf`` with no solution markers in the body is the classic
    misleading-filename case. Content classifier sees exercises only;
    final verdict should be exercise_sheet, NOT solution_sheet, with
    reduced confidence + a 'disagreement' signal."""
    from app.services.document_intelligence import classify_document_with_confidence

    r = classify_document_with_confidence(
        file_name="Lösung.pdf",
        sample_text=(
            "Aufgabe 1. Bestimmen Sie die Schubspannung. "
            "Aufgabe 2. Berechnen Sie die Querschnittsfläche. "
            "Aufgabe 3. Diskutieren Sie das Versagensverhalten."
        ),
    )
    # Content sees only exercises; filename insists "solution_sheet" but
    # without any solution markers in the body it gets overridden.
    assert r.document_type == "exercise_sheet"
    assert r.confidence < 0.8
    assert "disagreement" in r.signals


def test_classify_generic_filename_uses_content() -> None:
    """Filename like ``scan.pdf`` carries no hint. Content classifier
    runs and gets benefit of the doubt at medium-high confidence."""
    from app.services.document_intelligence import classify_document_with_confidence

    r = classify_document_with_confidence(
        file_name="scan_2023.pdf",
        sample_text=(
            "Klausur: Grundlagen der Konstruktion. "
            "Prüfung: SS 2023. Klausur dauert 90 Minuten. "
            "Exam date: 15.07.2023."
        ),
    )
    assert r.document_type == "exam"
    assert 0.7 <= r.confidence <= 0.9
    assert all(not s.startswith("filename:") for s in r.signals)


def test_classify_filename_only_no_content_lower_confidence() -> None:
    """Filename hint with no content (empty / pre-OCR document) gets a
    medium confidence — we shouldn't fully trust the name without seeing
    the body, but it's better than 'unknown'."""
    from app.services.document_intelligence import classify_document_with_confidence

    r = classify_document_with_confidence(
        file_name="Formelsammlung_Mechanik.pdf",
        sample_text="",
    )
    assert r.document_type == "formula_sheet"
    # Filename-only case sits below the both-agree threshold.
    assert r.confidence < 0.8


def test_classify_no_signal_returns_unknown_zero_confidence() -> None:
    """Garbage filename + empty body → 'unknown' with confidence 0.
    Retrieval boosts that depend on document_type should treat this as
    'no class' rather than applying a default boost."""
    from app.services.document_intelligence import classify_document_with_confidence

    r = classify_document_with_confidence(
        file_name="document.pdf",
        sample_text="",
    )
    assert r.document_type == "unknown"
    assert r.confidence == 0.0
    assert r.signals == []


def test_legacy_classify_document_returns_just_the_type() -> None:
    """``classify_document(...)`` is the old single-string API kept for
    backward compatibility with the indexing pipeline. Must still return
    a plain document_type str — never the dataclass."""
    from app.services.document_intelligence import classify_document

    result = classify_document(
        "Formelsammlung_Mechanik.pdf",
        "π · d² / 4 = A    F = m · a    σ = M·y / I",
    )
    assert isinstance(result, str)
    assert result == "formula_sheet"
