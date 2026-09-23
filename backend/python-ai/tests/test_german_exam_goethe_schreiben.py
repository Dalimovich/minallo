"""Goethe Schreiben Teil 1-2 — offline: fixtures only, no provider calls.

Covers forum_discussion_post / formal_context_message: profile wiring,
prompt builders, deterministic validator, and generic rubric-based grading
wiring in german_exam_writing_grading.py (banded scoring path)."""

from __future__ import annotations

from app.services import german_exam_writing as writing
from app.services import german_exam_semantic_verify as verify
from app.services.german_exam_validator import hard_issues, validate_content
from app.services.german_exam_writing_grading import _band_for_score, _banded_rubric_score
from app.services.german_exams import get_part, get_profile
from app.services.german_exams.task_types import is_task_type_implemented

PID = "goethe_c1"
SCHREIBEN_1 = get_part(PID, "writing", "schreiben_1")
SCHREIBEN_2 = get_part(PID, "writing", "schreiben_2")


def _issues(part, content: dict) -> list[str]:
    return [i.message for i in hard_issues(validate_content(part, content))]


def test_profile_wiring() -> None:
    for part, task_type in ((SCHREIBEN_1, "forum_discussion_post"), (SCHREIBEN_2, "formal_context_message")):
        assert part.task_type == task_type
        assert part.available is False, "Goethe parts stay unavailable until live qualification"
        assert is_task_type_implemented(task_type)
        assert task_type in writing._PROMPT_BUILDERS
        assert task_type in verify._VERIFY_PROMPT_BUILDERS


def test_prompts_are_built_from_the_blueprint() -> None:
    system, user = writing._prompt_forum_discussion_post(get_profile(PID), SCHREIBEN_1, [], {"topicId": "t", "label": "Studium"})
    assert "exactly ONE scenario" in system and "Exactly 4" in system and "forum discussion" in system

    system, _ = writing._prompt_formal_context_message(get_profile(PID), SCHREIBEN_2, [], {"topicId": "t", "label": "Studium"})
    assert "'Sie'" in system or "Sie" in system
    assert "addressForm" in system


def _schreiben1_content() -> dict:
    return {
        "questions": [{
            "questionId": "a", "title": "Vier-Tage-Woche", "communicativeSituation": "Ein Forumsbeitrag zur Diskussion über die Vier-Tage-Woche.",
            "contentPoints": ["Vorteile nennen", "Nachteile nennen", "eigene Meinung begründen", "ein Beispiel geben"],
            "taskInstructions": "Schreiben Sie einen Diskussionsbeitrag und gehen Sie auf alle vier Punkte ein.",
            "writingCoachTaskType": "stellungnahme",
        }],
    }


def _schreiben2_content() -> dict:
    c = _schreiben1_content()
    c["questions"][0]["addressForm"] = "Sie"
    c["questions"][0]["communicativeSituation"] = "Eine formelle Nachricht an eine Institution."
    return c


def test_schreiben1_valid_content_passes() -> None:
    assert _issues(SCHREIBEN_1, _schreiben1_content()) == []


def test_schreiben1_rejects_wrong_content_point_count() -> None:
    c = _schreiben1_content()
    c["questions"][0]["contentPoints"] = c["questions"][0]["contentPoints"][:2]
    assert any("contentPoints" in m for m in _issues(SCHREIBEN_1, c))


def test_schreiben1_rejects_more_than_one_task() -> None:
    c = _schreiben1_content()
    c["questions"].append(dict(c["questions"][0], questionId="b"))
    assert any("expected exactly 1" in m for m in _issues(SCHREIBEN_1, c))


def test_schreiben1_rejects_an_answer_key_field() -> None:
    c = _schreiben1_content()
    c["questions"][0]["modelAnswer"] = "..."
    assert any("no answer key" in m for m in _issues(SCHREIBEN_1, c))


def test_schreiben2_valid_content_passes() -> None:
    assert _issues(SCHREIBEN_2, _schreiben2_content()) == []


def test_schreiben2_requires_sie_address_form() -> None:
    c = _schreiben2_content()
    c["questions"][0]["addressForm"] = "du"
    assert any("addressForm must be" in m for m in _issues(SCHREIBEN_2, c))


# ── grading: banded rubric path (Goethe-only; telc's continuous path is untouched) ──


def test_band_for_score_boundaries() -> None:
    assert _band_for_score(95) == "A"
    assert _band_for_score(90) == "A"
    assert _band_for_score(89.9) == "B"
    assert _band_for_score(10) == "E"


def test_banded_rubric_score_uses_the_blueprint_criteria() -> None:
    dimension_scores = {"task_fulfilment": 95, "coherence": 80, "vocabulary": 60, "structures": 20}
    banded = _banded_rubric_score(SCHREIBEN_1, dimension_scores)
    assert banded is not None
    assert banded["perDimension"]["task_fulfilment"]["band"] == "A"
    assert banded["perDimension"]["structures"]["band"] == "E"
    assert banded["maxPoints"] == 60
    # task_fulfilment: 14*1.0=14, coherence(B): 14*0.75=10.5, vocabulary(C): 16*0.5=8, structures(E): 16*0=0
    assert banded["totalPoints"] == 32.5


def test_banded_rubric_score_falls_back_when_a_dimension_is_missing() -> None:
    assert _banded_rubric_score(SCHREIBEN_1, {"task_fulfilment": 90}) is None


def test_banded_rubric_score_is_none_for_profiles_without_band_fractions() -> None:
    telc_schreiben_1 = get_part("telc_c1_hochschule", "writing", "schreiben_1")
    assert _banded_rubric_score(telc_schreiben_1, {"task_fulfilment": 90, "correctness": 90, "repertoire": 90, "communicative_design": 90}) is None
