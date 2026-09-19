"""Locks telc_c1_hochschule's listening parts' constraints — item/speaker/
option/play counts must not silently drift."""

from __future__ import annotations

import pytest

from app.services.german_exam_profiles import GermanExamProfileError, get_part, get_profile, list_parts, resolve_profile_id


def test_profile_exists_with_listening_reading_language_elements_and_writing_modules() -> None:
    profile = get_profile("telc_c1_hochschule")
    assert profile.family == "telc"
    assert profile.variant == "C1 Hochschule"
    assert profile.modules["listening"] is not None
    assert profile.modules["reading"] is not None
    assert profile.modules["language_elements"] is not None
    assert profile.modules["writing"] is not None
    assert profile.modules["speaking"] is not None


def test_schreiben_constraints_locked() -> None:
    part = get_part("telc_c1_hochschule", "writing", "schreiben_1")
    assert part.task_type == "choice_long_form_writing"
    assert part.constraints["topicChoiceCount"] == 2
    assert part.constraints["wordCountMin"] == 350
    assert part.time_limit_seconds == 70 * 60
    assert part.scoring is not None
    assert part.scoring.max_points == 48
    assert part.scoring.points_per_correct is None
    assert part.grading_dimensions == ("task_fulfilment", "correctness", "repertoire", "communicative_design")


def test_sprachbausteine_constraints_locked() -> None:
    part = get_part("telc_c1_hochschule", "language_elements", "sprachbausteine_1")
    assert part.task_type == "cloze_mc4_language_elements"
    assert part.constraints["itemCount"] == 22
    assert part.constraints["optionCount"] == 4
    assert part.constraints["grammarCountMin"] == 12
    assert part.constraints["grammarCountMax"] == 16
    assert part.constraints["lexicalCountMin"] == 4
    assert part.constraints["lexicalCountMax"] == 8
    assert part.constraints["orthographyCountMin"] == 1
    assert part.constraints["orthographyCountMax"] == 4
    assert part.scoring is not None
    assert part.scoring.max_points == 22


def test_hv1_constraints_locked() -> None:
    part = get_part("telc_c1_hochschule", "listening", "hv1")
    assert part.task_type == "speaker_statement_matching"
    assert part.constraints["speakerCount"] == 8
    assert part.constraints["statementCount"] == 10
    assert part.constraints["unusedStatements"] == 2
    assert part.constraints["playsAllowed"] == 1


def test_hv2_constraints_locked_and_speaker_count_is_a_minimum() -> None:
    part = get_part("telc_c1_hochschule", "listening", "hv2")
    assert part.task_type == "sentence_completion_mc3"
    assert part.constraints["itemCount"] == 10
    assert part.constraints["optionCount"] == 3
    # Deliberately a minimum, not an exact count — no verified source pins it at 2.
    assert "speakerCountMin" in part.constraints
    assert "speakerCount" not in part.constraints


def test_hv3_constraints_locked() -> None:
    part = get_part("telc_c1_hochschule", "listening", "hv3")
    assert part.task_type == "structured_note_completion"
    assert part.constraints["itemCount"] == 10


def test_list_parts_returns_all_three() -> None:
    parts = list_parts("telc_c1_hochschule", "listening")
    assert [p.part_id for p in parts] == ["hv1", "hv2", "hv3"]


def test_unknown_module_raises() -> None:
    with pytest.raises(GermanExamProfileError):
        list_parts("telc_c1_hochschule", "not_a_real_module")


def test_unknown_profile_raises() -> None:
    with pytest.raises(GermanExamProfileError):
        get_profile("does_not_exist")


def test_resolve_profile_id_matches_legacy_level() -> None:
    assert resolve_profile_id("telc", "C1 Hochschule") == "telc_c1_hochschule"


def test_resolve_profile_id_returns_none_when_unmatched() -> None:
    assert resolve_profile_id("telc", "B2") is None
    assert resolve_profile_id("TestDaF", "TDN 4") is None
