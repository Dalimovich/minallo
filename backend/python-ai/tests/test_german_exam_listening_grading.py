"""german_exam_listening_grading — pure functions: what a learner-facing generate response may
keep (strip_listening_answer_key), what gets held server-side instead (build_grading_content),
and how a submitted answer is compared against that server-held state (grade_answer). No
network, no database — these are exercised directly against representative content shaped like
german_exam_listening.py's own documented output for each task type."""

from __future__ import annotations

import pytest

from app.services import german_exam_listening_grading as grading


def _matching_content() -> dict:
    return {
        "segments": [{"id": "s1", "speakerId": "speaker_1"}, {"id": "s2", "speakerId": "speaker_2"}],
        "questions": [
            {"questionId": "q1", "prompt": "Quelle 1 sagt X.",
             "matching": {"correctSpeakerId": "speaker_2", "isDistractor": False, "evidenceSegmentIds": ["s2"]}},
            {"questionId": "q2", "prompt": "Niemand sagt das.",
             "matching": {"correctSpeakerId": None, "isDistractor": True, "evidenceSegmentIds": []}},
        ],
    }


def _mc3_content() -> dict:
    return {
        "questions": [
            {"questionId": "q1",
             "mc3": {"stem": "Was sagt der Sprecher?", "options": ["A", "B", "C"], "correctIndex": 1,
                     "evidenceSegmentIds": ["s3"]}},
        ],
    }


def _note_content() -> dict:
    return {
        "questions": [
            {"questionId": "q1",
             "note": {"fieldLabel": "Datum", "outlineContext": "...", "correctFill": "12. März",
                       "evidenceSegmentIds": ["s4"]}},
        ],
    }


def _tristate_content() -> dict:
    return {
        "questions": [
            {"questionId": "q1", "statement": "Die Miete steigt.",
             "tristate": {"answer": "falsch", "evidenceSegmentIds": ["s2"]}},
        ],
    }


# ---- strip_listening_answer_key: never ship the answer, keep everything else ------------------

def test_strip_removes_matching_answer_and_evidence_but_keeps_prompt() -> None:
    stripped = grading.strip_listening_answer_key("speaker_statement_matching", _matching_content())
    q1 = stripped["questions"][0]
    assert "correctSpeakerId" not in q1["matching"]
    assert "evidenceSegmentIds" not in q1["matching"]
    assert "isDistractor" in q1["matching"]  # not an answer-key field, stays
    assert q1["prompt"] == "Quelle 1 sagt X."
    assert stripped["segments"] == _matching_content()["segments"]


def test_strip_removes_mc3_correct_index_but_keeps_options() -> None:
    stripped = grading.strip_listening_answer_key("sentence_completion_mc3", _mc3_content())
    q1 = stripped["questions"][0]
    assert "correctIndex" not in q1["mc3"]
    assert "evidenceSegmentIds" not in q1["mc3"]
    assert q1["mc3"]["options"] == ["A", "B", "C"]
    assert q1["mc3"]["stem"] == "Was sagt der Sprecher?"


def test_strip_removes_note_correct_fill_but_keeps_field_label() -> None:
    stripped = grading.strip_listening_answer_key("structured_note_completion", _note_content())
    q1 = stripped["questions"][0]
    assert "correctFill" not in q1["note"]
    assert q1["note"]["fieldLabel"] == "Datum"


def test_strip_removes_tristate_answer_but_keeps_statement() -> None:
    stripped = grading.strip_listening_answer_key("listening_tristate", _tristate_content())
    q1 = stripped["questions"][0]
    assert "answer" not in q1["tristate"]
    assert "evidenceSegmentIds" not in q1["tristate"]
    assert q1["statement"] == "Die Miete steigt."


def test_strip_does_not_mutate_the_original_content() -> None:
    original = _matching_content()
    grading.strip_listening_answer_key("speaker_statement_matching", original)
    assert original["questions"][0]["matching"]["correctSpeakerId"] == "speaker_2"


# ---- build_grading_content: exactly what grade_answer needs, nothing else ---------------------

def test_build_grading_content_matching_includes_no_match_sentinel_as_none() -> None:
    content = grading.build_grading_content("speaker_statement_matching", _matching_content())
    assert content["q1"] == {"taskType": "speaker_statement_matching", "correct": "speaker_2", "evidenceSegmentIds": ["s2"]}
    assert content["q2"] == {"taskType": "speaker_statement_matching", "correct": None}


def test_build_grading_content_mc3() -> None:
    content = grading.build_grading_content("sentence_completion_mc3", _mc3_content())
    assert content["q1"]["correct"] == 1
    assert content["q1"]["evidenceSegmentIds"] == ["s3"]


def test_build_grading_content_note() -> None:
    content = grading.build_grading_content("structured_note_completion", _note_content())
    assert content["q1"]["correct"] == "12. März"


def test_build_grading_content_tristate() -> None:
    content = grading.build_grading_content("listening_tristate", _tristate_content())
    assert content["q1"]["correct"] == "falsch"


def test_build_grading_content_skips_questions_without_an_id() -> None:
    content = grading.build_grading_content("sentence_completion_mc3", {"questions": [{"mc3": {"correctIndex": 0}}]})
    assert content == {}


# ---- grade_answer: the exact comparison practice.js's LS_GRADERS used to do client-side -------

@pytest.mark.parametrize(
    "task_type,correct,selected,expected",
    [
        ("speaker_statement_matching", "speaker_2", "speaker_2", True),
        ("speaker_statement_matching", "speaker_2", "speaker_1", False),
        ("speaker_statement_matching", None, "no_match", True),  # distractor item: no_match sentinel
        ("sentence_completion_mc3", 1, 1, True),
        ("sentence_completion_mc3", 1, "1", True),  # frontend sends parseInt'd ints, but tolerate strings too
        ("sentence_completion_mc3", 1, 0, False),
        ("structured_note_completion", "12. März", "12. märz", True),  # case-insensitive
        ("structured_note_completion", "12. März", "  12. März  ", True),  # whitespace-insensitive too
        ("structured_note_completion", "12. März", "13. März", False),
        ("listening_tristate", "falsch", "falsch", True),
        ("listening_tristate", "falsch", "richtig", False),
    ],
)
def test_grade_answer_matches_the_original_client_side_comparisons(task_type, correct, selected, expected) -> None:
    assert grading.grade_answer(task_type, correct, selected) is expected


def test_grade_answer_mc3_non_numeric_selected_is_false_not_a_crash() -> None:
    assert grading.grade_answer("sentence_completion_mc3", 1, "not-a-number") is False


def test_grade_answer_unknown_task_type_raises() -> None:
    with pytest.raises(grading.UnknownListeningTaskTypeError):
        grading.grade_answer("some_future_type", "x", "x")
