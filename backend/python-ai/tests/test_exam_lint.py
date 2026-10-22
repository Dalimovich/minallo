"""Validator + prompt rules for chatbot-generated Probeklausur exams.

Covers the failure modes that made generated exams unusable: an
incomplete/placeholder Kurzlösung, tasks with no model answer, intro-slide
questions, and the DIN 8580-vs-8593 classification mix-up.
"""
from __future__ import annotations

from app.services.answer import lint_exam_output
from app.services import answer as answer_service
from app.services.answer_intent import AcademicIntent, intent_style_instruction
from app.services.exam_solution_validation import (
    answer_has_question_specific_result,
    solution_is_only_procedural_instruction,
)

_CLEAN_EXAM = """# Probeklausur: Fertigungstechnik
**Time:** 90 Min  **Total:** 12 Punkte  **Allowed tools:** Formelsammlung
**Instructions:** Bearbeiten Sie alle Aufgaben.

## Aufgabe 1: Widerstandsschweißen — 6 Punkte
**Based on / inspired by:** [Source 1] — Kapitel_6.1.pdf
a) Beschreiben Sie den Prozessablauf.

## Aufgabe 2: Zerspanung — 6 Punkte
**Based on / inspired by:** [Source 2] — Kapitel_5.1.pdf
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


def test_incident_procedural_kurzloesung_is_blocking() -> None:
    bad = """# Probeklausur: TM3
## Aufgabe 1: Gauß — 20 Punkte
**Based on / inspired by:** [Source 1] — Probeklausur.pdf
a) Formulate the theorem. (10 points)
b) Calculate both sides for v(x)=(x_1,x_2)^T. (10 points)

## Aufgabe 2: Wave equation — 20 Punkte
**Based on / inspired by:** [Source 2] — Probeklausur_3.pdf
a) Determine the resulting function. (20 points)

## Kurzlösung
### Aufgabe 1
**a)** Describe the significance of the integrals.
**b)** Calculate both sides using the specified vector field and confirm equality.
### Aufgabe 2
**a)** Use separation of variables and apply the boundary conditions.
"""
    issues = lint_exam_output(bad)
    assert any("Aufgabe 1a" in issue and "procedural-only" in issue for issue in issues)
    assert any("Aufgabe 1b" in issue and "procedural-only" in issue for issue in issues)
    assert any("Aufgabe 2a" in issue and "procedural-only" in issue for issue in issues)


def test_actual_numeric_and_conceptual_answers_pass_result_gate() -> None:
    assert answer_has_question_specific_result(
        "Calculate the bending stress.",
        r"$M_b=756000\,\mathrm{Nmm}$ and $\sigma_b=M_b/W=795.8\,\mathrm{N/mm^2}$.",
    )
    assert answer_has_question_specific_result(
        "Describe the physical meaning of the Gauss theorem.",
        "The boundary flux equals the integral of the divergence inside the region.",
    )
    assert solution_is_only_procedural_instruction("Solve using the method of characteristics.")


def test_procedural_math_tokens_and_numbers_are_not_results() -> None:
    rejected = [
        ("Calculate both sides.", "Calculate both sides and confirm equality."),
        ("Solve using separation of variables.", "Use separation of variables and apply the boundary conditions."),
        ("Solve using characteristics.", "Solve the equation using the method of characteristics."),
        ("Sketch the characteristics.", "Sketch the characteristics in the time-space diagram."),
        ("Calculate the result.", "Use equation 2 and calculate the result."),
        ("Determine the constants.", r"Use $\sin(\pi x)$ and solve for the constants."),
    ]
    assert all(not answer_has_question_specific_result(question, answer) for question, answer in rejected)


def test_result_bearing_pde_and_integral_answers_pass() -> None:
    accepted = [
        ("Solve the wave equation.", r"u(t,x)=\frac{4}{\pi c}\sin(\pi ct/2)\sin(\pi x/2)."),
        ("Evaluate both integrals.", "\u222bΩ div(v)dΩ = 2πR² and \u222e∂Ω v·n ds = 2πR²."),
        ("Solve using characteristics.", "x(t)=x0+ct."),
        ("Sketch the characteristics.", "Characteristics are straight lines with slope dx/dt = c."),
    ]
    assert all(answer_has_question_specific_result(question, answer) for question, answer in accepted)


def test_generated_variant_cannot_claim_literal_source() -> None:
    bad = _CLEAN_EXAM.replace("**Based on / inspired by:**", "**Source:**", 1)
    assert any("inspired by" in issue for issue in lint_exam_output(bad))


def test_exam_and_subquestion_point_totals_must_match() -> None:
    bad_header = _CLEAN_EXAM.replace("**Total:** 12 Punkte", "**Total:** 100 Punkte")
    assert any("exam point total is inconsistent" in issue for issue in lint_exam_output(bad_header))
    bad_parts = _CLEAN_EXAM.replace(
        "a) Beschreiben Sie den Prozessablauf.",
        "a) Beschreiben Sie den Prozessablauf. (4 Punkte)\nb) Nennen Sie ein Merkmal. (1 Punkt)",
    ).replace(
        "- Es bildet sich eine Schweißlinse, die nach dem Abkühlen die Verbindung erzeugt.",
        "- Es bildet sich eine Schweißlinse, die nach dem Abkühlen die Verbindung erzeugt.\n"
        "**b)** Das Merkmal ist eine stoffschlüssige Verbindung.",
    )
    assert any("Aufgabe 1 point total is inconsistent" in issue for issue in lint_exam_output(bad_parts))


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
**Based on / inspired by:** [Source 1] — Kapitel_3.pdf
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


def test_exam_finalization_checks_before_and_after_semantic_verifier(monkeypatch) -> None:
    events: list[tuple[str, str]] = []

    def lint(text: str) -> list[str]:
        events.append(("lint", text))
        return []

    def verify(**kwargs) -> str:
        events.append(("verify", kwargs["draft"]))
        return "verified"

    monkeypatch.setattr(answer_service, "lint_exam_output", lint)
    monkeypatch.setattr(answer_service, "verify_exam_output", verify)

    result, issues = answer_service.validate_and_finalize_exam_output(
        system_prompt="system", user_message="user", draft="draft",
        client=object(), model="model", max_tokens=100,
    )

    assert result == "verified"
    assert issues == []
    assert events == [("lint", "draft"), ("verify", "draft"),
                      ("lint", "verified")]


def test_exam_finalization_repairs_once_and_rejects_invalid_repair(monkeypatch) -> None:
    repairs = 0

    monkeypatch.setattr(
        answer_service, "lint_exam_output",
        lambda text: [] if text == "draft" else ["empty output"],
    )
    monkeypatch.setattr(
        answer_service, "verify_exam_output", lambda **_kwargs: "regressed",
    )

    def repair(**_kwargs) -> str:
        nonlocal repairs
        repairs += 1
        return "still-invalid"

    monkeypatch.setattr(answer_service, "repair_exam_output", repair)
    result, issues = answer_service.validate_and_finalize_exam_output(
        system_prompt="system", user_message="user", draft="draft",
        client=object(), model="model", max_tokens=100,
    )

    assert result == "still-invalid"
    assert issues == ["empty output"]
    assert repairs == 1


def test_result_gate_rejects_procedure_with_incidental_assignment() -> None:
    assert not answer_has_question_specific_result(
        "Determine x.",
        "Use x = 2 in the next equation and solve for the constants.",
    )
