"""Tests for the Phase 4 document classification + extraction-quality rollup."""

from __future__ import annotations

import pytest

from app.services.document_intelligence import (
    DOCUMENT_TYPES,
    classify_document,
    prefer_ocr_text,
    rollup_extraction_quality,
    score_extraction,
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
        # "Slides" is now its own type (still Lecture-Learning behaviour downstream).
        ("Lecture-12-Slides.pdf", "slides"),
        # Cheatsheet is now cheat_sheet (treated like formula_sheet downstream).
        ("Cheatsheet_Final.pdf", "cheat_sheet"),
        ("Übung_2.pdf", "exercise_sheet"),
        # New types from the Understanding Layer.
        ("Hausaufgabe_4.pdf", "assignment"),
        ("ML_Homework2.pdf", "assignment"),
        ("Vorlesung_Folien_05.pdf", "slides"),
        ("Lehrbuch_Kapitel3.pdf", "textbook_chapter"),
        # Abbreviated "ExN" exercise marker (EngMec2 series).
        ("EngMec2_Ex2.pdf", "exercise_sheet"),
        ("EngMec2_Ex10.pdf", "exercise_sheet"),
        ("Ex_3.pdf", "exercise_sheet"),
        # Must NOT fire inside a word — these have no real filename hint and
        # an empty-ish body, so they stay unknown.
        ("index2.pdf", "unknown"),
        ("complex_4.pdf", "unknown"),
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


# ── pdfminer-vs-OCR scoring ─────────────────────────────────────────────────


def test_score_extraction_empty_is_zero() -> None:
    assert score_extraction("") == 0.0
    assert score_extraction("   \n  ") == 0.0


def test_score_rewards_formula_blocks_and_headings() -> None:
    r"""Clean OCR markdown (headings + $$ blocks + \frac) must outscore the
    same content as flat formula-soup."""
    clean = (
        "## Schraubenberechnung\n\n"
        "$$ \\delta_K = \\frac{l'_K}{E_S \\cdot A_N} $$\n"
        "Nachgiebigkeit des Schraubenkopfes\n"
        "$$ \\delta_G = \\frac{0.5 \\cdot d}{E_S \\cdot A_3} $$\n"
        "Nachgiebigkeit des eingeschraubten Gewindeteils\n"
    )
    soup = "delta K lK ES AN delta G d ES A3 Nachgiebigkeit Schraubenkopfes Gewindeteils"
    assert score_extraction(clean) > score_extraction(soup)


def test_score_penalises_unclear_markers() -> None:
    base = "Eine vollständig lesbare Vorlesungsfolie mit ausreichend Inhalt."
    with_gaps = base + " [unclear] [unclear] [unclear]"
    assert score_extraction(with_gaps) < score_extraction(base)


def test_prefer_ocr_when_original_empty() -> None:
    """Scanned page: pdfminer got nothing, OCR got text → always take OCR."""
    assert prefer_ocr_text("", "## Heading\n\nReadable recovered content.")


def test_reject_empty_ocr() -> None:
    """OCR returned nothing usable → keep the original, never overwrite."""
    assert not prefer_ocr_text("some original prose with words", "")
    assert not prefer_ocr_text("some original prose with words", "   ")


def test_prefer_ocr_over_garbled_formula_soup() -> None:
    """The Formelzettel case: garbled pdfminer soup vs clean OCR markdown."""
    garbled = (
        "delta K lK ES AN delta i li ES Ai delta G d ES A3 "
        "Elastische Schraubennachgiebigkeit Nachgiebigkeit Schraubenkopfes"
    )
    ocr = (
        "## Schraubenberechnung\n\n"
        "$$ \\delta_K = \\frac{l'_K}{E_S \\cdot A_N} $$\n"
        "$$ \\delta_i = \\frac{l_i}{E_S \\cdot A_i} $$\n"
        "$$ \\delta_G = \\frac{0.5 d}{E_S \\cdot A_3} $$\n"
        "Elastische Schraubennachgiebigkeit\n"
    )
    assert prefer_ocr_text(garbled, ocr)


def test_keep_original_when_ocr_is_mostly_unclear() -> None:
    """OCR that came back as mostly [unclear] must not clobber a
    partially-readable original."""
    original = (
        "Eine teilweise lesbare Seite mit mehreren verständlichen Wörtern "
        "und Begriffen aus der Vorlesung über Maschinenelemente."
    )
    ocr = "[unclear]\n[unclear]\n[unclear]\n[unclear]\nFragment"
    assert not prefer_ocr_text(original, ocr)


# ── Document Understanding Layer (Stage 1) ──────────────────────────────────

from app.services.document_intelligence import (  # noqa: E402
    analyze_document,
    detect_content_flags,
    detect_language,
    effective_document_type,
    extract_subject_name,
    match_topic_area,
)


def test_exam_strong_admin_markers_classify_as_exam() -> None:
    body = (
        "Klausur Ingenieurmathematik. Bearbeitungszeit: 90 Minuten. "
        "Zugelassene Hilfsmittel: keine. Aufgabe 1 (10 Punkte). "
        "Teilaufgabe a) Berechnen Sie. Aufgabe 2 (15 Punkte)."
    )
    assert classify_document("scan.pdf", body) == "exam"


def test_numbered_tasks_without_exam_markers_are_not_exam() -> None:
    # Pure exercise sheet — many tasks, NO Bearbeitungszeit/Punkte/exam words.
    body = "Aufgabe 1. Zeigen Sie. Aufgabe 2. Berechnen Sie. Aufgabe 3. Diskutieren Sie."
    assert classify_document("blatt.pdf", body) == "exercise_sheet"


def test_content_flags_exam_has_tasks_not_theory_not_solutions() -> None:
    body = "Aufgabe 1 (5 Punkte). Aufgabe 2 (5 Punkte). Aufgabe 3 (10 Punkte)."
    flags = detect_content_flags(body)
    assert flags.has_tasks is True
    assert flags.has_solutions is False
    assert flags.has_theory is False
    assert flags.is_mixed is False


def test_content_flags_lecture_has_theory_and_examples() -> None:
    body = (
        "Definition: Eine Gruppe ist... Satz 1: ... Beweis: ... "
        "Zum Beispiel betrachten wir die Menge. Lecture 3 covers groups."
    )
    flags = detect_content_flags(body)
    assert flags.has_theory is True
    assert flags.has_examples is True
    assert flags.has_tasks is False


def test_content_flags_mixed_when_tasks_and_theory() -> None:
    body = (
        "Definition: stetige Funktion. Satz: Zwischenwertsatz. Beweis folgt. "
        "Aufgabe 1. Zeigen Sie die Stetigkeit. Aufgabe 2. Berechnen Sie."
    )
    flags = detect_content_flags(body)
    assert flags.has_tasks is True
    assert flags.has_theory is True
    assert flags.is_mixed is True


def test_content_flags_empty_text_all_false() -> None:
    flags = detect_content_flags("")
    assert (flags.has_tasks, flags.has_theory, flags.has_solutions,
            flags.has_examples, flags.is_mixed) == (False, False, False, False, False)


def test_language_detection_german_from_umlauts_and_stopwords() -> None:
    body = "Die Lösung der Aufgabe ist für die Übung mit den Funktionen über R."
    assert detect_language("anon.pdf", body) == "de"


def test_language_detection_english_from_stopwords() -> None:
    body = "The solution of the exercise is computed with these functions and that rule."
    assert detect_language("anon.pdf", body) == "en"


def test_language_detection_filename_hint_breaks_tie() -> None:
    assert detect_language("Loesung_3.pdf", "") == "de"
    assert detect_language("Exam_Final.pdf", "") == "en"


def test_language_detection_falls_back_when_no_signal() -> None:
    assert detect_language("scan.pdf", "", fallback="de") == "de"
    assert detect_language("scan.pdf", "") == "unknown"


def test_effective_document_type_override_wins() -> None:
    assert effective_document_type("lecture", "exam") == "exam"
    assert effective_document_type("unknown", "solution_sheet") == "solution_sheet"


def test_effective_document_type_classifier_then_source_then_unknown() -> None:
    assert effective_document_type("lecture", None) == "lecture"
    assert effective_document_type("unknown", None, source_type="formula_sheet") == "formula_sheet"
    assert effective_document_type(None, None) == "unknown"
    assert effective_document_type("unknown", None) == "unknown"


def test_extract_subject_name_from_filename_stem() -> None:
    # Type/term noise stripped; the real subject survives.
    assert extract_subject_name("Ingenieurmathematik_Klausur_WS23.pdf", "") == "Ingenieurmathematik"
    # Pure noise → None.
    assert extract_subject_name("Loesung_3.pdf", "") is None


def test_match_topic_area_picks_most_mentioned() -> None:
    text = "Taylor series. Taylor expansion. The Taylor polynomial. Limits appear once."
    assert match_topic_area(text, ["Limits", "Taylor", "Integrals"]) == "Taylor"
    assert match_topic_area(text, None) is None
    assert match_topic_area("nothing relevant", ["Taylor"]) is None


def test_analyze_document_end_to_end_exam() -> None:
    u = analyze_document(
        "Klausur_Analysis1_2023.pdf",
        "Bearbeitungszeit: 120 Minuten. Aufgabe 1 (10 Punkte). Teilaufgabe a).",
        fallback_language="en",
        course_topics=["Analysis", "Algebra"],
    )
    assert u.document_type == "exam"
    assert u.document_type_confidence > 0.5
    assert u.detected_language == "de"
    assert u.content_flags.has_tasks is True
    payload = u.to_json()
    assert set(payload) == {
        "document_type", "document_type_confidence", "document_type_signals",
        "detected_language", "subject_name", "topic_area", "content_flags",
    }
    assert set(payload["content_flags"]) == {
        "has_tasks", "has_theory", "has_solutions", "has_examples", "is_mixed",
    }


def test_analyze_document_result_type_in_enum() -> None:
    from app.services.document_intelligence import DOCUMENT_TYPES
    for fn, body in [
        ("Folien_03.pdf", "slides about graphs"),
        ("Hausaufgabe.pdf", "Aufgabe 1. Aufgabe 2."),
        ("random.pdf", ""),
    ]:
        assert analyze_document(fn, body).document_type in DOCUMENT_TYPES
