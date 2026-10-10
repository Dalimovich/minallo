from types import SimpleNamespace

from app.services.exam_reference import (
    CourseContentMap,
    analyse_exam_text,
    build_course_content_overlay,
    build_exam_reference_overlay,
    is_similar_exam_request,
)


def test_similar_exam_intent_is_narrow() -> None:
    assert is_similar_exam_request("Create an exam like the one open but with different values")
    assert is_similar_exam_request("Erstelle eine ähnliche Klausur mit anderen Fragen")
    assert not is_similar_exam_request("Create a practice exam about thermodynamics")


def test_profile_extracts_authentic_structure() -> None:
    text = """Bearbeitungszeit: 90 min\nGesamtpunkte: 100
Teil A: Kurzfragenteil (45 Punkte)
Welche Aussage trifft zu? a) Eins b) Zwei c) Drei
Teil B: Rechenteil (55 Punkte)
Aufgabe 1 (20 Punkte)\nGegeben: p = 12 MPa\nBerechnen Sie die Kraft.
"""
    ref = analyse_exam_text("d1", "Klausur WS17 Variante A.pdf", text, page_count=9)
    assert ref.total_points == 100
    assert ref.duration_minutes == 90
    assert ref.multiple_choice_count >= 1
    assert ref.calculation_count >= 1
    assert ref.short_question_points == 45
    assert ref.calculation_points == 55
    assert ref.sections == ["A Kurzfragenteil (45 Punkte)", "B Rechenteil (55 Punkte)"]


def test_reference_overrides_generic_mix_and_requires_provenance() -> None:
    ref = SimpleNamespace(
        title="Fertigungstechnik WS17/18 – Variante A",
        multiple_choice_count=45, calculation_count=55, open_response_count=0,
        total_points=100, duration_minutes=90, page_count=12,
        short_question_points=45, calculation_points=55,
        sections=["A Kurzfragenteil", "B Rechenteil"],
    )
    overlay = build_exam_reference_overlay([ref])
    assert "overrides generic 70/30" in overlay
    assert "short-question (preserve the reference's MC/open formats) about 45%" in overlay
    assert "calculation about 55%" in overlay
    assert "Style confidence: High" in overlay
    assert "capacity >= requirement" in overlay


def test_no_reference_is_transparent() -> None:
    overlay = build_exam_reference_overlay([])
    assert "No authentic exam was found" in overlay
    assert "confidence LOW" in overlay
    assert "Never attribute it to the professor" in overlay


def test_current_uploads_control_exam_content() -> None:
    content = CourseContentMap(
        source_titles=["Vorlesung Zerspanung.pdf", "Übung Spritzguss.pdf"],
        topics=["Standzeit", "Schließkraft"],
        excerpts=[("Vorlesung Zerspanung.pdf", "Taylor-Gleichung und Standzeit")],
    )
    overlay = build_course_content_overlay(content)
    assert "reference controls FORMAT ONLY" in overlay
    assert "current uploaded non-exam materials control CONTENT" in overlay
    assert "Every generated question" in overlay
    assert "Do not test obsolete reference topics" in overlay
    assert "Vorlesung Zerspanung.pdf" in overlay


def test_missing_current_material_is_disclosed() -> None:
    overlay = build_course_content_overlay(CourseContentMap())
    assert "No non-exam uploaded course material was available" in overlay
    assert "do not claim" in overlay
