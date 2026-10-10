"""Goethe Sprechen Teil 1-2 — offline: fixtures only, no provider calls.

presentation_with_followup / guided_pair_discussion reuse german_exam_speaking.py's
existing (already part_id-driven, exam-agnostic) generator, and
german_exam_validator.validate_speaking generalized to cover both task_type
name pairs (telc's presentation_summary_followup/quote_guided_discussion and
Goethe's presentation_with_followup/guided_pair_discussion)."""

from __future__ import annotations

from app.services import german_exam_semantic_verify as verify
from app.services.german_exam_speaking import DISCUSSION_GUIDING_POINTS
from app.services.german_exam_validator import hard_issues, validate_content
from app.services.german_exams import get_part
from app.services.german_exams.task_types import is_task_type_implemented

PID = "goethe_c1"
SPRECHEN_1 = get_part(PID, "speaking", "sprechen_1")
SPRECHEN_2 = get_part(PID, "speaking", "sprechen_2")


def _issues(part, content: dict) -> list[str]:
    return [i.message for i in hard_issues(validate_content(part, content))]


def test_profile_wiring() -> None:
    for part, task_type in ((SPRECHEN_1, "presentation_with_followup"), (SPRECHEN_2, "guided_pair_discussion")):
        assert part.task_type == task_type
        assert part.available is False, "Goethe parts stay unavailable until live qualification"
        assert is_task_type_implemented(task_type)
        assert task_type in verify._VERIFY_PROMPT_BUILDERS


def test_sprechen1_valid_presentation_content_passes() -> None:
    content = {"questions": [
        {"questionId": "a", "title": "Thema A", "taskInstructions": "Halten Sie einen Vortrag zu Thema A."},
        {"questionId": "b", "title": "Thema B", "taskInstructions": "Halten Sie einen Vortrag zu Thema B."},
    ]}
    assert _issues(SPRECHEN_1, content) == []


def test_sprechen1_rejects_duplicate_choices() -> None:
    content = {"questions": [
        {"questionId": "a", "title": "Thema A", "taskInstructions": "Gleicher Text."},
        {"questionId": "b", "title": "Thema A", "taskInstructions": "Gleicher Text."},
    ]}
    assert any("distinct" in m for m in _issues(SPRECHEN_1, content))


def test_sprechen1_rejects_non_pair_topic_count() -> None:
    content = {"questions": [{"questionId": "a", "title": "Thema A", "taskInstructions": "..."}]}
    assert any("exactly two" in m for m in _issues(SPRECHEN_1, content))


def test_sprechen2_valid_discussion_content_passes() -> None:
    content = {
        "quote": "Wer nicht wagt, der nicht gewinnt.",
        "sourceLabel": "Generiertes Übungszitat (keine reale Quelle)",
        "guidingPoints": DISCUSSION_GUIDING_POINTS,
    }
    assert _issues(SPRECHEN_2, content) == []


def test_sprechen2_requires_the_standard_label_and_guiding_points() -> None:
    content = {"quote": "Zitat.", "sourceLabel": "Ein echtes Zitat", "guidingPoints": DISCUSSION_GUIDING_POINTS}
    assert any("labelled generated practice material" in m for m in _issues(SPRECHEN_2, content))


def test_generate_speaking_part_dispatches_by_part_id_not_profile() -> None:
    """generate_speaking_part() already branches on part.part_id, which is
    identical between telc and Goethe ("sprechen_1"/"sprechen_2") — no
    Goethe-specific change was needed to make it work for this profile."""
    from app.services.german_exam_speaking import generate_speaking_part
    import inspect
    source = inspect.getsource(generate_speaking_part)
    assert 'part.part_id == "sprechen_1"' in source


# ── Grading stays blocked: per-criterion weights AND turn-structure are both unresolved ──
# (see audit/exam-correctness/GRADING_AUDIT.md's 2026-10-04 follow-up). Neither existing speaking
# grading path may silently absorb Goethe without a deliberate decision — these pin that exactly,
# so generalizing either path makes ONE of these fail first, not production.


def test_goethe_speaking_task_types_are_not_the_testdaf_independent_recording_shape() -> None:
    from app.services.german_exam_productive import SPEAKING_TYPES

    assert "presentation_with_followup" not in SPEAKING_TYPES
    assert "guided_pair_discussion" not in SPEAKING_TYPES


def test_goethe_not_in_either_speaking_gradable_allowlist() -> None:
    from app.services.german_exam_speaking_practice import GRADABLE_SPEAKING_PROFILE_IDS
    from app.services.german_exam_testdaf_speaking import GRADABLE_SPEAKING_RECORDING_PROFILE_IDS

    assert "goethe_c1" not in GRADABLE_SPEAKING_PROFILE_IDS
    assert "goethe_c1" not in GRADABLE_SPEAKING_RECORDING_PROFILE_IDS


def test_goethe_sprechen_parts_declare_no_official_point_scale() -> None:
    """Confirms the profile still deliberately omits per-criterion weights (Modellsatz
    Prüferblätter not in this repo) — scoring=None, unlike Goethe's own Schreiben parts which do
    have criteria_max_points once their rubric IS officially sourced."""
    for part in (SPRECHEN_1, SPRECHEN_2):
        assert part.scoring is None
