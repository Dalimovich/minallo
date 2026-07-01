"""Validator + prompt rules for chatbot-generated Probeklausur exams.

Covers the failure modes that made generated exams unusable: an
incomplete/placeholder Kurzlösung, tasks with no model answer, intro-slide
questions, and the DIN 8580-vs-8593 classification mix-up.
"""
from __future__ import annotations

from app.services.answer import lint_exam_output
from app.services.answer_intent import AcademicIntent, intent_style_instruction

_CLEAN_EXAM = """# Probeklausur: Fertigungstechnik
**Time:** 90 Min  **Total:** 100 Punkte  **Allowed tools:** Formelsammlung
**Instructions:** Bearbeiten Sie alle Aufgaben.

## Aufgabe 1: Widerstandsschweißen — 6 Punkte
**Source:** [Source 1] — Kapitel_6.1.pdf
a) Beschreiben Sie den Prozessablauf.

## Aufgabe 2: Zerspanung — 6 Punkte
**Source:** [Source 2] — Kapitel_5.1.pdf
a) Erklären Sie den Spanwinkel.

## Kurzlösung

### Aufgabe 1
**a)**
- Zwei wassergekühlte Elektroden pressen die Bleche zusammen.
- Ein hoher Schweißstrom fließt kurzzeitig durch die Fügestelle.
- Nach dem Jouleschen Gesetz entsteht Wärme am Kontaktwiderstand.
- Es bildet sich eine Schweißlinse, die nach dem Abkühlen die Verbindung erzeugt.

### Aufgabe 2
**a)**
- Der Spanwinkel γ liegt zwischen Spanfläche und der Werkstücknormalen.
- Großer γ: leichter Spanabfluss, geringere Schnittkraft, schwächerer Keil.
- Kleiner γ: stabiler Schneidkeil für harte Werkstoffe.
"""


def test_clean_exam_has_no_issues():
    assert lint_exam_output(_CLEAN_EXAM) == []


def test_missing_kurzloesung_flagged():
    questions = _CLEAN_EXAM.split("## Kurzlösung", 1)[0]
    issues = lint_exam_output(questions)
    assert any("answer key is missing" in i for i in issues)


def test_placeholder_answer_flagged():
    bad = _CLEAN_EXAM.replace(
        "- Der Spanwinkel γ liegt zwischen Spanfläche und der Werkstücknormalen.\n"
        "- Großer γ: leichter Spanabfluss, geringere Schnittkraft, schwächerer Keil.\n"
        "- Kleiner γ: stabiler Schneidkeil für harte Werkstoffe.",
        "- für jede Aufgabe stichpunktartig ergänzen",
    )
    issues = lint_exam_output(bad)
    assert any("placeholder" in i for i in issues)


def test_bare_ellipsis_flagged():
    bad = _CLEAN_EXAM.replace(
        "- Der Spanwinkel γ liegt zwischen Spanfläche und der Werkstücknormalen.",
        "- …",
    )
    assert any("…" in i or "bare" in i for i in lint_exam_output(bad))


def test_task_without_answer_flagged():
    # Add an Aufgabe 3 in the questions that has no answer block.
    bad = _CLEAN_EXAM.replace(
        "## Kurzlösung",
        "## Aufgabe 3: Urformen — 6 Punkte\n**Source:** [Source 3] — Kapitel_2.pdf\na) X?\n\n## Kurzlösung",
    )
    issues = lint_exam_output(bad)
    assert any("Aufgabe 3 has no model answer" in i for i in issues)


def test_intro_slide_question_flagged():
    bad = _CLEAN_EXAM.replace(
        "a) Beschreiben Sie den Prozessablauf.",
        "a) Analysieren Sie die Kommunikationsstruktur der Infoveranstaltung und den QR-Code.",
    )
    issues = lint_exam_output(bad)
    assert any("non-technical" in i for i in issues)


def test_din8580_joining_mixup_flagged():
    bad = _CLEAN_EXAM.replace(
        "a) Erklären Sie den Spanwinkel.",
        "a) Ordnen Sie die Fügeverfahren der Hauptgruppe Fügen nach DIN 8580 ein.",
    )
    issues = lint_exam_output(bad)
    assert any("DIN 8593" in i for i in issues)


def test_din8593_joining_is_accepted():
    ok = _CLEAN_EXAM.replace(
        "a) Erklären Sie den Spanwinkel.",
        "a) Ordnen Sie die Verfahren den Untergruppen des Fügens nach DIN 8593 zu.",
    )
    assert not any("DIN 8593" in i for i in lint_exam_output(ok))


def test_over_skip_entfaellt_flagged():
    bad = _CLEAN_EXAM.replace(
        "a) Beschreiben Sie den Prozessablauf.",
        "_Entfällt — die Datei enthält nur eine Infoveranstaltungs-Folie, kein technischer Inhalt._",
    )
    assert any("dismissed as non-technical" in i for i in lint_exam_output(bad))


def test_only_literature_skip_flagged():
    bad = _CLEAN_EXAM.replace(
        "a) Erklären Sie den Spanwinkel.",
        "a) Diese Datei enthält nur Literatur und wird übersprungen.",
    )
    assert any("dismissed as non-technical" in i for i in lint_exam_output(bad))


_HIGH_POINT_EXAM = """# Probeklausur: Fertigungstechnik
**Total:** 17 Punkte

## Aufgabe 1: Kunststofftechnik — 17 Punkte
**Source:** [Source 1] — Kapitel_3.pdf
a) Beschreiben Sie den Spritzgießprozess. (17 P)

## Kurzlösung

### Aufgabe 1
**a)**
{answer}
"""


def test_high_point_thin_answer_flagged():
    bad = _HIGH_POINT_EXAM.format(
        answer="- Granulat plastifizieren.\n- In die Form einspritzen.\n- Abkühlen und auswerfen."
    )
    assert any("too thin for its 17 points" in i for i in lint_exam_output(bad))


def test_high_point_rich_answer_ok():
    rich = "\n".join(
        f"- Prozessschritt {i}: konkrete technische Beschreibung mit Fachbegriff." for i in range(1, 7)
    )
    ok = _HIGH_POINT_EXAM.format(answer=rich)
    assert not any("too thin" in i for i in lint_exam_output(ok))


def test_exam_prompt_carries_the_new_rules():
    prompt = intent_style_instruction(AcademicIntent.EXAM_GENERATION)
    # No-placeholder + complete Kurzlösung mandate.
    assert "NO PLACEHOLDERS" in prompt
    assert "MANDATORY" in prompt
    # DIN level guidance.
    assert "DIN 8593" in prompt and "DIN 8580" in prompt
    # Intro/admin slide exclusion.
    assert "QR" in prompt or "title page" in prompt
    # Page-level judgment — do NOT skip whole files; balanced smaller tasks.
    assert "PER SLIDE/PAGE" in prompt
    assert "entfällt" in prompt
    assert "10-17" in prompt
    # New: formula faithfulness + depth-to-points scaling.
    assert "FORMULA FAITHFULNESS" in prompt
    assert "SCALE ANSWER DEPTH" in prompt
