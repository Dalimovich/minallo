"""Deterministic validator: hand-written valid + deliberately-broken fixtures
for telc_c1_hochschule Schreiben (choice_long_form_writing). This validator
checks structural well-formedness and a HARD identical-text duplicate guard
only — genuine near-duplicate/answerability/register judgment is
german_exam_semantic_verify.py's job, covered in a separate test file."""

from __future__ import annotations

from app.services.german_exam_profiles import get_part
from app.services.german_exam_validator import hard_issues, validate_content

SCHREIBEN = get_part("telc_c1_hochschule", "writing", "schreiben_1")


def _valid_content() -> dict:
    return {
        "questions": [
            {
                "questionId": "a",
                "title": "Digitalisierung im Studium",
                "statements": ["Digitale Lehrveranstaltungen erm?glichen allen Studierenden flexibles Lernen unabh?ngig vom Wohnort und pers?nlichen Verpflichtungen.", "Pr?senzunterricht bleibt unverzichtbar, weil pers?nlicher Austausch das gemeinsame Lernen und soziale Beziehungen entscheidend st?rkt."],
                "communicativeSituation": "Sie schreiben einen Beitrag für das Studierendenmagazin Ihrer Hochschule.",
                "taskInstructions": "Beschreiben Sie Vor- und Nachteile digitaler Lehrformate und nehmen Sie klar Stellung.",
                "writingCoachTaskType": "stellungnahme",
            },
            {
                "questionId": "b",
                "title": "Nachhaltigkeit am Campus",
                "statements": ["Hochschulen sollten verbindliche ?kologische Regeln einf?hren und dadurch gesellschaftliche Verantwortung im Alltag sichtbar ?bernehmen.", "Freiwillige Initiativen ?berzeugen Studierende langfristig besser als zus?tzliche Vorschriften, die pers?nliche Entscheidungen unn?tig einschr?nken."],
                "communicativeSituation": "Sie schreiben einen Diskussionsbeitrag für ein Hochschulforum.",
                "taskInstructions": "Erörtern Sie, welche Maßnahmen Hochschulen ergreifen sollten, um nachhaltiger zu werden.",
                "writingCoachTaskType": "argumentation",
            },
        ]
    }


def test_valid_fixture_passes() -> None:
    issues = hard_issues(validate_content(SCHREIBEN, _valid_content()))
    assert issues == []


def test_wrong_topic_count_fails() -> None:
    content = _valid_content()
    content["questions"] = content["questions"][:1]
    issues = hard_issues(validate_content(SCHREIBEN, content))
    assert any("expected 2 topics" in i.message for i in issues)


def test_missing_title_fails() -> None:
    content = _valid_content()
    content["questions"][0]["title"] = ""
    issues = hard_issues(validate_content(SCHREIBEN, content))
    assert any("title is missing" in i.message for i in issues)


def test_missing_communicative_situation_fails() -> None:
    content = _valid_content()
    content["questions"][0]["communicativeSituation"] = ""
    issues = hard_issues(validate_content(SCHREIBEN, content))
    assert any("communicativeSituation" in i.message for i in issues)


def test_too_short_task_instructions_fails() -> None:
    content = _valid_content()
    content["questions"][0]["taskInstructions"] = "Kurz."
    issues = hard_issues(validate_content(SCHREIBEN, content))
    assert any("taskInstructions" in i.message for i in issues)


def test_invalid_writing_coach_task_type_fails() -> None:
    content = _valid_content()
    content["questions"][0]["writingCoachTaskType"] = "email"  # not in the telc-realistic subset
    issues = hard_issues(validate_content(SCHREIBEN, content))
    assert any("writingCoachTaskType" in i.message for i in issues)


def test_identical_titles_fails() -> None:
    content = _valid_content()
    content["questions"][1]["title"] = content["questions"][0]["title"]
    issues = hard_issues(validate_content(SCHREIBEN, content))
    assert any("identical titles" in i.message for i in issues)


def test_identical_instructions_fails() -> None:
    content = _valid_content()
    content["questions"][1]["taskInstructions"] = content["questions"][0]["taskInstructions"]
    issues = hard_issues(validate_content(SCHREIBEN, content))
    assert any("identical taskInstructions" in i.message for i in issues)


def test_no_answer_key_fields_required() -> None:
    """Sanity check that the generated content shape genuinely has no
    correct-answer concept — unlike every other module's validator, there is
    no correctIndex/correctCandidateId/correctSectionId check here at all."""
    content = _valid_content()
    for q in content["questions"]:
        assert "correctIndex" not in q
        assert "correctCandidateId" not in q
    issues = hard_issues(validate_content(SCHREIBEN, content))
    assert issues == []


def test_model_solution_and_answer_keys_are_rejected():
    content = _valid_content()
    content["questions"][0]["modelAnswer"] = "An answer must not be exposed."
    assert hard_issues(validate_content(SCHREIBEN, content))
    content = _valid_content()
    content["answerKey"] = {"a": "sample answer"}
    assert hard_issues(validate_content(SCHREIBEN, content))


def test_malformed_field_and_duplicate_ids_are_rejected():
    content = _valid_content()
    content["questions"][0]["title"] = ["not a string"]
    assert hard_issues(validate_content(SCHREIBEN, content))


def test_statement_count_duplicates_and_input_length():
    for statements in ([], ["one"], ["one", "two", "three"], ["", "two"], ["same", "SAME"]):
        content = _valid_content()
        content["questions"][0]["statements"] = statements
        assert hard_issues(validate_content(SCHREIBEN, content))
    content = _valid_content()
    content["questions"][0]["statements"][0] = "word " * 56
    assert hard_issues(validate_content(SCHREIBEN, content))


def test_noncontrasting_positions_fail_even_when_verifier_claims_pass():
    from app.services.german_exam_semantic_verify import _parse_result, _apply_audits
    content = _valid_content()
    raw = {"passed": True, "partWideIssues": [], "items": [
        {"questionId": q["questionId"], "passed": True, "issues": [], "audit": {
            "duplicateItemIds": [], "contrastingStatements": False, "engagesBothStatements": True}}
        for q in content["questions"]]}
    assert not _apply_audits(_parse_result(raw, {"a", "b"}), raw, SCHREIBEN, content).passed
    content = _valid_content()
    content["questions"][1]["questionId"] = "a"
    assert hard_issues(validate_content(SCHREIBEN, content))
