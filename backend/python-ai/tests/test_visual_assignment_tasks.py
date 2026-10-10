from app.services.answer_stream import (
    extract_numbered_assignments,
    is_visual_assignment_task,
    numbered_assignment_issues,
    required_number_range,
    verify_and_repair_visual_assignment,
)
from app.services.verification import verify_answer


def test_required_range_extraction() -> None:
    assert required_number_range(
        "Benennen Sie die Teile, die mit den Ziffern 1 bis 9 markiert sind",
        "",
    ) == list(range(1, 10))


def test_incomplete_answer_is_rejected() -> None:
    answer = (
        "3. Schließzylinder\n4. Formnest\n5. Auswerfer\n6. Schnecke\n"
        "7. Granulatzufuhr\n8. Anguss\n9. Angusskanal"
    )
    assert numbered_assignment_issues(answer, list(range(1, 10)))["missing"] == [1, 2]


def test_all_nine_assignments_pass() -> None:
    answer = (
        "1. Auswerferseite\n2. Düsenseite\n3. Schließzylinder\n4. Formnest\n"
        "5. Auswerfer\n6. Schnecke\n7. Granulatzufuhr\n8. Anguss\n9. Angusskanal"
    )
    assert extract_numbered_assignments(answer) == {
        1: "Auswerferseite",
        2: "Düsenseite",
        3: "Schließzylinder",
        4: "Formnest",
        5: "Auswerfer",
        6: "Schnecke",
        7: "Granulatzufuhr",
        8: "Anguss",
        9: "Angusskanal",
    }
    assert not any(numbered_assignment_issues(answer, list(range(1, 10))).values())


def test_duplicate_and_extra_numbers_fail() -> None:
    answer = "1. First\n1. Duplicate\n2. Second\n10. Extra"
    issues = numbered_assignment_issues(answer, [1, 2])
    assert issues["duplicates"] == [1]
    assert issues["extras"] == [10]


def test_visual_grid_classifier_requires_pixels() -> None:
    context = "Treffen Sie die Zuordnung. Ziffern 1 bis 9."
    assert is_visual_assignment_task("answer Aufgabe 14.1", context, True)
    assert not is_visual_assignment_task("answer Aufgabe 14.1", context, False)


def test_visual_callout_ids_do_not_trigger_number_misses() -> None:
    question = "Benennen Sie die Teile, die mit den Ziffern 1 bis 9 markiert sind."
    answer = "\n".join(f"{number}. Label" for number in range(1, 10))
    result = verify_answer(
        answer_text=answer,
        chunk_texts=["visible answer labels"],
        question=question,
        answer_mode="strong",
    )
    assert result.details["numberMisses"] == []
    assert result.details["criticalNumericalMismatch"] is False


def test_visual_verifier_failure_is_nonfatal_for_complete_draft() -> None:
    class FailingCompletions:
        @staticmethod
        def create(**_kwargs):
            raise TimeoutError("verifier timed out")

    class Client:
        class chat:
            completions = FailingCompletions()

    answer = "\n".join(f"{number}. Label {number}" for number in range(1, 10))
    final, verification = verify_and_repair_visual_assignment(
        client=Client(),
        model="gpt-4o",
        question="Ziffern 1 bis 9",
        answer=answer,
        required=list(range(1, 10)),
        image_parts=[{"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}],
        max_tokens=1000,
    )
    assert final == answer
    assert verification["status"] == "unavailable"
    assert verification["fatal"] is False
    assert verification["repairAttempts"] == 0
