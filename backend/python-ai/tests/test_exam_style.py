"""Subject-aware exam style: calculation-heavy exams for exercise/solution
sheets (Technische Mechanik, Mathe, Physik) vs theory exams for lecture slides.

Regression for the TM2 bug: 'generate an exam similar to the Übungen' over
mechanics exercise sheets produced a theory-heavy Fertigungstechnik-style exam.
"""

from __future__ import annotations

import sys
import types
from types import SimpleNamespace

import pytest

# answer.py imports the supabase client + embeddings lazily; stub them so the
# module imports cleanly under test (detect_exam_style with doc_ids=None never
# touches the DB anyway).
_fake_sb = types.ModuleType("app.supabase_client")
_fake_sb.get_supabase = lambda: None
sys.modules.setdefault("app.supabase_client", _fake_sb)
_fake_emb = types.ModuleType("app.services.embeddings")
_fake_emb.embed_texts = lambda texts: [[0.0] * 1536 for _ in texts]
sys.modules.setdefault("app.services.embeddings", _fake_emb)

from app.services.answer import (  # noqa: E402
    build_exam_style_overlay,
    detect_exam_style,
)
from app.services.answer_intent import AcademicIntent, classify_academic_intent  # noqa: E402


def _chunk(text: str, chunk_type: str) -> SimpleNamespace:
    return SimpleNamespace(document_id="d1", text=text, chunk_type=chunk_type, similarity=0.9)


_TM2_SOLUTION_CHUNKS = [
    _chunk(
        "Aufgabe 3: Gegeben sind m = 2 kg, a = 4 m/s^2, h = 1.2 m. "
        "Berechnen Sie die Geschwindigkeit v. Loesung: v = sqrt(2 g h).",
        "solution",
    ),
    _chunk(
        "Eine Schwungscheibe wird mit n = 1000 1/min beschleunigt. "
        "Bestimmen Sie die Winkelbeschleunigung alpha = dw/dt.",
        "exercise",
    ),
]
_FERTIGUNGSTECHNIK_LECTURE_CHUNKS = [
    _chunk(
        "Erklaeren Sie die sechs Hauptgruppen nach DIN 8580. Beschreiben Sie "
        "das Verfahren Urformen. Nennen Sie Beispiele.",
        "lecture",
    ),
    _chunk(
        "Vergleichen Sie Spritzgiessen und Extrusion. Diskutieren Sie die Vorteile.",
        "lecture",
    ),
]


def test_user_phrase_is_exam_generation() -> None:
    q = "generate an exam that has questions similar to the ones in the uebungen I had selected"
    assert classify_academic_intent(q) == AcademicIntent.EXAM_GENERATION


def test_exercise_sheets_request_routes_to_quantitative() -> None:
    q = "generate an exam that has questions similar to the ones in the uebungen I had selected"
    assert detect_exam_style(q, _TM2_SOLUTION_CHUNKS, doc_ids=None) == "quantitative"


def test_lecture_slides_stay_theory() -> None:
    # The existing Fertigungstechnik / lecture behaviour must not change.
    q = "create an exam from my selected files"
    assert detect_exam_style(q, _FERTIGUNGSTECHNIK_LECTURE_CHUNKS, doc_ids=None) == "theory"


def test_calc_request_over_theory_sources_is_hybrid() -> None:
    q = "make a calculation-style exam"
    assert detect_exam_style(q, _FERTIGUNGSTECHNIK_LECTURE_CHUNKS, doc_ids=None) == "hybrid"


def test_formula_and_given_values_alone_route_quantitative() -> None:
    # Even with a neutral "make an exam" prompt, exercise chunks with formulas
    # and given values mean a calculation exam.
    q = "make a practice exam"
    assert detect_exam_style(q, _TM2_SOLUTION_CHUNKS, doc_ids=None) == "quantitative"


def test_quantitative_overlay_demands_rechenaufgaben_not_theory() -> None:
    q = "generate an exam similar to the selected Übungen"
    overlay = build_exam_style_overlay(q, _TM2_SOLUTION_CHUNKS, doc_ids=None)
    assert "Rechenaufgaben" in overlay
    assert "Kurzfragen" in overlay
    assert "Gegeben" in overlay
    # Must forbid giving the result away and mandate new numbers + unit checks.
    assert "GENERATE NEW PROBLEMS" in overlay
    assert "min⁻¹" in overlay  # the unit-conversion guard that the bug needed


def test_theory_overlay_is_noop() -> None:
    # Theory exams keep the existing prompt — the override must be empty.
    q = "create an exam from my selected files"
    assert build_exam_style_overlay(q, _FERTIGUNGSTECHNIK_LECTURE_CHUNKS, doc_ids=None) == ""


def test_filename_signal_overrides_misleading_retrieval() -> None:
    # The selected files are exercise sheets, but retrieval surfaced recap/theory
    # chunks. The filename signal (robust without the doc-understanding migration)
    # must keep it quantitative; lecture filenames must keep it theory.
    q = "generate an exam"
    assert detect_exam_style(
        q, _FERTIGUNGSTECHNIK_LECTURE_CHUNKS, doc_ids=None,
        file_names=["EngMec2_Ex3_Solutions.pdf", "Uebung_4.pdf", "TM2_Aufgabenblatt_2.pdf"],
    ) == "quantitative"
    assert detect_exam_style(
        q, _FERTIGUNGSTECHNIK_LECTURE_CHUNKS, doc_ids=None,
        file_names=["Kapitel_3_Kunststoff.pdf", "Vorlesung_Umformen.pdf"],
    ) == "theory"


def test_exam_lint_blocking_separates_hard_failures() -> None:
    from app.services.answer import exam_lint_blocking, lint_exam_output

    # Missing Kurzlösung is a hard failure → must be blocking.
    bad = "# Probeklausur\n## Aufgabe 1: Kinematik — 15 Punkte\na) Berechnen Sie v."
    blocking = exam_lint_blocking(lint_exam_output(bad))
    assert any("answer key is missing" in b for b in blocking)
    # A clean exam yields no blocking issues.
    assert exam_lint_blocking([]) == []
